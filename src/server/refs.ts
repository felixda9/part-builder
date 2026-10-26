// Reference images: generation, the user's own pictures, slicing, segmentation, normalization to
// studs, consistency checks, measurement, part close-ups.
//
// Files in projects/<name>/refs/:
//   hero_N.png            hero candidates (3/4 view)
//   sheet.png             4:1 turnaround (front | right | back | left)
//   raw_<view>.png        a view as generated (sliced from the sheet, or its own call)
//   norm_<view>.png       normalized: cropped, scaled to ppu, transparent background
//   mask_<view>.png       subject mask at the normalized scale
//   refs.json             RefsState (what the editor shows)
//   internal.json         key color, interaction ids, frames, etc.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { type OrthoFrame, type OrthoView, viewAxes } from '../core/raster';
import { extractLines, findDarkSpots, findSpots, imageEdges, interior, luminanceOf, mergeSpots } from './likeness';
import { type RefFrame, type RefView, type RefImage, REF_VIEWS, viewLabel } from '../core/protocol';
import { poseRefFile } from './body';
import { fakeCloseup, fakeHero, fakeSheet, fakeView } from './fake';
import { comfyConfig } from './comfy';
import { type RefInput, MODELS } from './gemini';
import { type GenRequest, type GenResult, type Provider, fakeMode, generateImage, pickProvider, totalCost } from './imagegen';
import { contactSheet, gridSvg } from './images';
import {
  type Lab, type Mask, type RGBImage, boundary, deltaE, estimateBackground, flipX, hexToRgb, maskArea, maskBBox, palette,
  coreCenter, despill, rgbToLab, segmentKey, symmetryAxis,
} from './imaging';
import { type CloseupView, type KeyColor, KEY_COLORS, closeupPrompt, editPrompt, heroFromPosePrompt, heroPrompt, sheetPrompt, stylePrompt, viewPrompt } from './prompts';
import type { Session } from './session';
import { loadStyle } from './styles';

export type Box = { min: [number, number, number]; max: [number, number, number] };
/** How a view is made: the normal prompt (any image source), or Qwen camera angles (local GPU). */
export type ViewMethod = 'prompt' | 'qwen-angles';

interface Internal {
  key: KeyColor;
  interactions: Record<string, string>; // image id -> interaction id (for edits)
  frames: Partial<Record<RefView, RefFrame>>;
  axis: Partial<Record<RefView, number>>;
  /** Close-ups per part: the world box they show, and their frames once fitted onto the views. */
  closeups?: Record<string, { box: Box; notes?: string; frames: Partial<Record<RefView, RefFrame>> }>;
}

const ASPECTS = ['1:1', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9'];
/** The supported aspect ratio closest to w/h. */
function nearestAspect(r: number): string {
  const val = (a: string) => { const [w, h] = a.split(':').map(Number); return w / h; };
  return ASPECTS.reduce((b, a) => (Math.abs(Math.log(val(a) / r)) < Math.abs(Math.log(val(b) / r)) ? a : b));
}

/** Panels of the turnaround sheet, left to right: front | side | back (no left view: it is the mirrored side). */
const SHEET_VIEWS: RefView[] = ['front', 'right', 'back'];

export async function loadRGB(file: string | Buffer): Promise<RGBImage> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

export async function loadMask(file: string): Promise<Mask> {
  const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
  const m = new Uint8Array(info.width * info.height);
  for (let i = 0; i < m.length; i++) m[i] = data[i * info.channels] > 127 ? 1 : 0;
  return { width: info.width, height: info.height, data: m };
}

async function saveMask(m: Mask, file: string): Promise<void> {
  const px = Buffer.alloc(m.width * m.height);
  for (let i = 0; i < px.length; i++) px[i] = m.data[i] ? 255 : 0;
  await sharp(px, { raw: { width: m.width, height: m.height, channels: 1 } }).png().toFile(file);
}

const keyRGB = (k: KeyColor) => hexToRgb(k.hex);

/** The key color furthest from every color of the subject. */
function farthestKey(subject: Lab[], fallback: KeyColor): KeyColor {
  if (!subject.length) return fallback;
  let best = fallback, bestD = -1;
  for (const k of KEY_COLORS) {
    const lab = rgbToLab(...keyRGB(k));
    const d = Math.min(...subject.map((p) => deltaE(p, lab)));
    if (d > bestD + 5) { bestD = d; best = k; }
  }
  return best;
}

export type ImportTarget = { kind: 'hero' } | { kind: 'view'; view: RefView };

/** Layout guide for the turnaround sheet: four columns with ground/top lines on the key color. */
export async function sheetTemplate(key: KeyColor): Promise<Buffer> {
  const W = 2100, H = 900, col = W / 3;
  const lines: string[] = [];
  for (let i = 1; i < 3; i++) lines.push(`<line x1="${i * col}" y1="0" x2="${i * col}" y2="${H}" stroke="#333" stroke-width="3"/>`);
  lines.push(`<line x1="0" y1="${H * 0.92}" x2="${W}" y2="${H * 0.92}" stroke="#333" stroke-width="2" stroke-dasharray="12 8"/>`);
  lines.push(`<line x1="0" y1="${H * 0.1}" x2="${W}" y2="${H * 0.1}" stroke="#333" stroke-width="2" stroke-dasharray="12 8"/>`);
  ['FRONT', 'SIDE (facing right)', 'BACK'].forEach((t, i) =>
    lines.push(`<text x="${i * col + col / 2}" y="40" font-family="Arial" font-size="30" text-anchor="middle" fill="#333">${t}</text>`));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${key.hex}"/>${lines.join('')}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export class Refs {
  constructor(private s: Session) {}

  private file(...p: string[]): string {
    return this.s.path('refs', ...p);
  }
  private get logFile(): string {
    return this.s.path('gemini-log.jsonl');
  }

  internal(): Internal {
    const f = this.file('internal.json');
    const d: Internal = { key: this.defaultKey(), interactions: {}, frames: {}, axis: {} };
    return fs.existsSync(f) ? { ...d, ...JSON.parse(fs.readFileSync(f, 'utf8')) } : d;
  }
  private saveInternal(i: Internal): void {
    fs.writeFileSync(this.file('internal.json'), JSON.stringify(i, null, 2));
  }

  private defaultKey(): KeyColor {
    const idea = this.s.meta.idea.toLowerCase();
    return /pink|magenta|purple|violet|fuchsia/.test(idea) ? KEY_COLORS[1] : KEY_COLORS[0];
  }

  /** Key color furthest from the subject's colors (from the picked hero). */
  private async chooseKeyFromHero(heroFile: string, heroKey: KeyColor): Promise<KeyColor> {
    const img = await loadRGB(heroFile);
    const { mask } = segmentKey(img, keyRGB(heroKey));
    const pal = palette(img, mask, 8).map((p) => rgbToLab(...hexToRgb(p.hex)));
    let best = heroKey, bestD = -1;
    for (const k of KEY_COLORS) {
      const lab = rgbToLab(...hexToRgb(k.hex));
      const d = Math.min(...pal.map((p) => deltaE(p, lab)));
      if (d > bestD + 5) { bestD = d; best = k; }
    }
    return best;
  }

  private styleRefs(): { inputs: RefInput[]; model: string } {
    const { preset, images } = loadStyle(this.s.meta.style);
    return {
      inputs: images.map((im, i) => ({ label: `STYLE EXAMPLE ${i + 1} (copy its style, not its subject)`, data: im.data, mime: im.mime })),
      model: preset.model === 'pro' ? MODELS.pro : MODELS.flash,
    };
  }

  private async gen(tag: string, req: GenRequest): Promise<GenResult> {
    const { preset } = loadStyle(this.s.meta.style);
    return generateImage({ negative: preset.avoid, ...req, tag, logFile: this.logFile });
  }

  private heroFile(): string {
    const id = this.s.refs.hero.picked;
    if (!id) throw new Error('No hero picked yet. Ask the user to pick one (editor References panel, or in chat -> refs_pick).');
    return this.file(`${id}.png`);
  }

  cost(): string {
    const c = totalCost(this.logFile);
    return `${c.calls} image call(s) so far (${c.local} on the local GPU), $${c.usd.toFixed(3)} spent`;
  }

  // ------------------------------------------------------------------ generation

  async styleTest(subject: string, count = 2, model?: 'flash' | 'pro', provider?: Provider): Promise<string[]> {
    const { preset } = loadStyle(this.s.meta.style);
    const st = this.styleRefs();
    const key = this.defaultKey();
    const files: string[] = [];
    for (let i = 0; i < count; i++) {
      const r = await this.gen('style_test', {
        prompt: stylePrompt(subject, preset, key, st.inputs.length > 0), refs: st.inputs, aspectRatio: '1:1', imageSize: '1K',
        model: model ? MODELS[model] : st.model, provider, fake: () => fakeHero(keyRGB(key)),
      });
      const f = this.file(`style_test_${Date.now()}_${i + 1}.png`);
      fs.writeFileSync(f, r.image);
      files.push(f);
    }
    return files;
  }

  async generateHero(count = 3, extra = '', model?: 'flash' | 'pro', provider?: Provider): Promise<string[]> {
    const { preset } = loadStyle(this.s.meta.style);
    const st = this.styleRefs();
    const internal = this.internal();
    internal.key = this.defaultKey();
    const poseRef = poseRefFile(this.s.body);
    // Local GPU with a pose mannequin: Qwen-Image-2.1 redraws the mannequin as the subject, which
    // holds the stance; otherwise the mannequin goes along as a reference image.
    const fromPose = !!poseRef && pickProvider(provider) === 'comfyui';
    const prompt = fromPose
      ? heroFromPosePrompt(this.s.meta.idea, preset, internal.key, extra, this.s.body)
      : heroPrompt(this.s.meta.idea, preset, internal.key, st.inputs.length > 0, extra, this.s.body, !!poseRef);
    const poseInput = poseRef ? [{ label: 'POSE REFERENCE (copy only the stance and camera angle)', data: fs.readFileSync(poseRef), mime: 'image/png' }] : [];
    const refs = fromPose ? poseInput : [...st.inputs, ...poseInput];
    const files: string[] = [];
    let n = this.s.refs.hero.candidates.length;
    for (let i = 0; i < count; i++) {
      const r = await this.gen('hero', {
        prompt, refs, aspectRatio: '1:1', imageSize: '1K', model: model ? MODELS[model] : st.model, provider, fake: () => fakeHero(keyRGB(internal.key)),
        ...(fromPose ? { workflow: 'qwen-edit.json', keyColor: keyRGB(internal.key) } : {}),
      });
      const id = `hero_${++n}`;
      const f = this.file(`${id}.png`);
      fs.writeFileSync(f, r.image);
      if (r.interactionId) internal.interactions[id] = r.interactionId;
      this.s.refs.hero.candidates.push({ id, url: this.s.url(f), label: `Hero ${n}` });
      files.push(f);
    }
    this.saveInternal(internal);
    if (this.s.meta.stage === 'new') this.s.meta.stage = 'hero';
    this.s.saveMeta();
    this.s.saveRefs();
    return files;
  }

  /**
   * Replace every hero candidate with new ones. The old images move to
   * refs/archive/ and are never deleted; the pick and the view approval are reset.
   */
  async remakeHeroes(count = 3, extra = '', provider?: Provider): Promise<string[]> {
    const old = this.s.refs.hero.candidates;
    if (old.length) {
      const dir = this.file('archive', `heroes_${new Date().toISOString().replace(/[:.]/g, '-')}`);
      fs.mkdirSync(dir, { recursive: true });
      for (const c of old) {
        const f = this.file(`${c.id}.png`);
        if (fs.existsSync(f)) fs.renameSync(f, path.join(dir, `${c.id}.png`));
      }
      const internal = this.internal();
      for (const c of old) delete internal.interactions[c.id];
      this.saveInternal(internal);
    }
    this.s.refs.hero = { candidates: [], picked: null };
    this.s.meta.checkpoints.hero = null;
    this.s.refs.viewsApproved = false;
    this.s.meta.checkpoints.viewsApproved = false;
    this.s.refs.feedback.push({ text: `remade all hero candidates${extra ? ` - wanted: ${extra}` : ''}`, time: new Date().toISOString() });
    this.s.saveRefs();
    return this.generateHero(count, extra, undefined, provider);
  }

  pickHero(id: string): void {
    this.s.handleUi({ type: 'ui', action: 'pick_hero', id });
  }

  approveViews(): void {
    this.s.handleUi({ type: 'ui', action: 'approve_views' });
  }

  async generateSheet(extra = '', model?: 'flash' | 'pro', provider?: Provider): Promise<string> {
    const hero = this.heroFile();
    const internal = this.internal();
    internal.key = await this.chooseKeyFromHero(hero, internal.key);
    const { preset } = loadStyle(this.s.meta.style);
    const st = this.styleRefs();
    // Local edit models tend to copy a template's lines and labels, so only Gemini gets one.
    const withTemplate = pickProvider(provider) === 'gemini';
    const refs: RefInput[] = [
      { label: 'HERO DESIGN', data: fs.readFileSync(hero), mime: 'image/png' },
      ...(withTemplate ? [{ label: 'LAYOUT TEMPLATE (placement only)', data: await sheetTemplate(internal.key), mime: 'image/png' }] : []),
      ...st.inputs.slice(0, 2),
    ];
    const r = await this.gen('sheet', {
      prompt: sheetPrompt(this.s.meta.idea, preset, internal.key, st.inputs.length > 0, extra, withTemplate, this.s.body), refs, aspectRatio: '21:9', imageSize: '2K',
      model: model ? MODELS[model] : st.model, provider, fake: () => fakeSheet(keyRGB(internal.key)),
    });
    const f = this.file('sheet.png');
    fs.writeFileSync(f, r.image);
    if (r.interactionId) internal.interactions.sheet = r.interactionId;
    this.saveInternal(internal);
    this.s.refs.sheet = { id: 'sheet', url: this.s.url(f), label: 'Turnaround sheet' };
    await this.sliceSheet();
    return f;
  }

  /** Cut the 4:1 sheet into four equal panels. */
  private async sliceSheet(): Promise<void> {
    const f = this.file('sheet.png');
    const meta = await sharp(f).metadata();
    const pw = Math.floor(meta.width! / SHEET_VIEWS.length);
    for (let i = 0; i < SHEET_VIEWS.length; i++) {
      const out = this.file(`raw_${SHEET_VIEWS[i]}.png`);
      await sharp(f).extract({ left: i * pw, top: 0, width: pw, height: meta.height! }).png().toFile(out);
      this.setRaw(SHEET_VIEWS[i], out);
    }
    this.s.refs.viewsApproved = false;
    this.s.meta.checkpoints.viewsApproved = false;
    this.s.saveMeta();
    this.s.saveRefs();
  }

  private setRaw(view: RefView, file: string): void {
    const v = this.s.refs.views[view] ?? { url: this.s.url(file) };
    v.rawUrl = this.s.url(file);
    if (!fs.existsSync(this.file(`norm_${view}.png`))) v.url = v.rawUrl;
    this.s.refs.views[view] = v;
  }

  async generateView(view: RefView, extra = '', model?: 'flash' | 'pro', provider?: Provider, method?: ViewMethod): Promise<string> {
    // Default: Qwen camera angles on ComfyUI; prompts for Gemini.
    const m = method ?? (pickProvider(provider) === 'comfyui' ? 'qwen-angles' : 'prompt');
    if (m === 'qwen-angles') return this.generateAngleView(view);
    const hero = this.heroFile();
    const internal = this.internal();
    const { preset } = loadStyle(this.s.meta.style);
    const st = this.styleRefs();
    const refs: RefInput[] = [{ label: 'HERO DESIGN', data: fs.readFileSync(hero), mime: 'image/png' }];
    // Give the model the other views too, so the new one stays consistent with them.
    for (const v of SHEET_VIEWS) {
      const raw = this.file(`raw_${v}.png`);
      if (v !== view && fs.existsSync(raw)) refs.push({ label: `EXISTING ${v.toUpperCase()} VIEW`, data: fs.readFileSync(raw), mime: 'image/png' });
    }
    const r = await this.gen(`view_${view}`, {
      prompt: viewPrompt(view, this.s.meta.idea, preset, internal.key, st.inputs.length > 0, extra, this.s.body), refs: [...refs, ...st.inputs.slice(0, 1)],
      aspectRatio: view === 'top' ? '1:1' : '3:4', imageSize: '2K', model: model ? MODELS[model] : st.model, provider,
      fake: () => fakeView(view as OrthoView, keyRGB(internal.key)),
    });
    const f = this.file(`raw_${view}.png`);
    if (fs.existsSync(f)) fs.copyFileSync(f, this.file(`raw_${view}.prev.png`));
    fs.writeFileSync(f, r.image);
    if (r.interactionId) internal.interactions[view] = r.interactionId;
    this.saveInternal(internal);
    this.setRaw(view, f);
    this.s.refs.viewsApproved = false;
    this.s.meta.checkpoints.viewsApproved = false;
    this.s.saveMeta();
    this.s.saveRefs();
    return f;
  }

  /**
   * A view made by rotating the camera around the hero with Qwen-Image-2.1 + the Multiple-Angles
   * LoRA (comfy/workflows/qwen-angles.json, local GPU only). The LoRA takes its own prompt format.
   */
  private async generateAngleView(view: RefView): Promise<string> {
    const hero = this.heroFile();
    const internal = this.internal();
    // The LoRA names views by where the camera stands: its "left side view" is our side view
    // (the subject's right side, facing image-right). Checked on the fox, 2026-10-24.
    const shot: Record<RefView, string> = {
      front: 'front view, eye-level shot',
      right: 'left side view, eye-level shot',
      back: 'back view, eye-level shot',
      left: 'right side view, eye-level shot',
      top: 'front view, top-down shot',
    };
    // It sometimes swaps the key-color background for a grey studio one, which makes cutting out
    // white parts unreliable: retry a couple of times and keep the closest background.
    const key = keyRGB(internal.key);
    const keyLab = rgbToLab(key[0], key[1], key[2]);
    let best: { image: Buffer; dE: number } | null = null;
    for (let attempt = 0; attempt < 3 && !(best && best.dE < 25); attempt++) {
      const r = await this.gen(`view_${view}_angles`, {
        prompt: `<mva> ${shot[view]}`, rawPrompt: true, workflow: 'qwen-angles.json', provider: 'comfyui', keyColor: key,
        refs: [{ label: 'HERO', data: fs.readFileSync(hero), mime: 'image/png' }], aspectRatio: '1:1', imageSize: '1K',
        fake: () => fakeView(view as OrthoView, key),
      });
      const bg = estimateBackground(await loadRGB(r.image));
      const dE = deltaE(rgbToLab(bg[0], bg[1], bg[2]), keyLab);
      if (!best || dE < best.dE) best = { image: r.image, dE };
    }
    const f = this.file(`raw_${view}.png`);
    if (fs.existsSync(f)) fs.copyFileSync(f, this.file(`raw_${view}.prev.png`));
    fs.writeFileSync(f, best!.image);
    this.setRaw(view, f);
    this.s.refs.viewsApproved = false;
    this.s.meta.checkpoints.viewsApproved = false;
    this.s.saveMeta();
    this.s.saveRefs();
    return f;
  }

  /**
   * Put a raw view's subject back on the project's key color with BiRefNet (comfy/workflows/
   * rembg.json, local GPU) - for images whose background came out pale or grey, where white
   * parts of the subject can't be told from the background.
   */
  async rekeyView(view: RefView): Promise<string> {
    const f = this.file(`raw_${view}.png`);
    if (!fs.existsSync(f)) throw new Error(`no ${viewLabel(view)} view yet`);
    const meta = await sharp(f).metadata();
    const r = await this.gen(`rekey_${view}`, {
      prompt: '', workflow: 'rembg.json', provider: 'comfyui', keyColor: keyRGB(this.internal().key),
      refs: [{ label: 'IMAGE', data: fs.readFileSync(f), mime: 'image/png' }],
      // Keep the image size: the key-color canvas must match it.
      aspectRatio: `${meta.width}:${meta.height}`, imageSize: (meta.width ?? 0) * (meta.height ?? 0) > 1.3e6 ? '2K' : '1K',
      fake: async () => fs.readFileSync(f),
    });
    fs.copyFileSync(f, this.file(`raw_${view}.prev.png`));
    fs.writeFileSync(f, await sharp(r.image).resize({ width: meta.width, height: meta.height, fit: 'fill' }).png().toBuffer());
    this.setRaw(view, f);
    this.s.saveRefs();
    return f;
  }

  /** Mirror a raw view left-to-right (a side view generated facing the wrong way). */
  async flip(view: RefView): Promise<string> {
    const f = this.file(`raw_${view}.png`);
    if (!fs.existsSync(f)) throw new Error(`no ${view} view yet`);
    fs.copyFileSync(f, this.file(`raw_${view}.prev.png`));
    fs.writeFileSync(f, await sharp(f).flop().png().toBuffer());
    this.setRaw(view, f);
    this.s.refs.viewsApproved = false;
    this.s.meta.checkpoints.viewsApproved = false;
    this.s.saveMeta();
    this.s.saveRefs();
    return f;
  }

  // ------------------------------------------------------------------ your own pictures

  /**
   * Use a picture from elsewhere (a drawing, a photo, another AI tool) as the hero or as a view.
   * The subject is cut out and put on a key color like a generated image, so everything after
   * this treats it the same. A hero is picked right away.
   */
  async importImage(src: Buffer, target: ImportTarget): Promise<{ file: string; how: string }> {
    const { img, mask, alpha, how } = await this.cutOut(src);
    const internal = this.internal();
    const key = farthestKey(palette(img, mask, 8).map((p) => rgbToLab(...hexToRgb(p.hex))), internal.key);
    const k = keyRGB(key);

    // Crop to the subject with a margin; heroes are square like generated ones.
    const bb = maskBBox(mask)!;
    const pad = Math.round(Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) * 0.08) + 4;
    let x0 = bb.minX - pad, y0 = bb.minY - pad, w = bb.maxX - bb.minX + 1 + 2 * pad, h = bb.maxY - bb.minY + 1 + 2 * pad;
    if (target.kind === 'hero') {
      const s = Math.max(w, h);
      x0 -= Math.floor((s - w) / 2); y0 -= Math.floor((s - h) / 2); w = h = s;
    }
    const out = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = x0 + x, sy = y0 + y, o = (y * w + x) * 3;
      const inside = sx >= 0 && sy >= 0 && sx < img.width && sy < img.height;
      const i = sy * img.width + sx;
      const a = !inside ? 0 : alpha ? alpha[i] / 255 : mask.data[i];
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(a * (inside ? img.data[i * 3 + c] : 0) + (1 - a) * k[c]);
    }
    const png = await sharp(out, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();

    if (target.kind === 'hero') {
      const id = `hero_${this.s.refs.hero.candidates.length + 1}`;
      const f = this.file(`${id}.png`);
      fs.writeFileSync(f, png);
      internal.key = key;
      delete internal.interactions[id];
      this.saveInternal(internal);
      this.s.refs.hero.candidates.push({ id, url: this.s.url(f), label: 'Your picture' });
      this.s.refs.hero.picked = id;
      this.s.meta.checkpoints.hero = id;
      this.s.meta.stage = 'views';
      this.s.saveMeta();
      this.s.saveRefs();
      return { file: f, how };
    }
    const { view } = target;
    const f = this.file(`raw_${view}.png`);
    if (fs.existsSync(f)) fs.copyFileSync(f, this.file(`raw_${view}.prev.png`));
    fs.writeFileSync(f, png);
    delete internal.interactions[view];
    this.saveInternal(internal);
    this.setRaw(view, f);
    this.s.refs.viewsApproved = false;
    this.s.meta.checkpoints.viewsApproved = false;
    this.s.saveMeta();
    this.s.saveRefs();
    return { file: f, how };
  }

  /** Find the subject: transparency, else a plain background, else BiRefNet on ComfyUI. */
  private async cutOut(src: Buffer): Promise<{ img: RGBImage; mask: Mask; alpha: Uint8Array | null; how: string }> {
    const { data, info } = await sharp(src).rotate().resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const n = info.width * info.height;
    const rgb = new Uint8Array(n * 3), alpha = new Uint8Array(n);
    let clear = 0;
    for (let i = 0; i < n; i++) {
      rgb[i * 3] = data[i * 4]; rgb[i * 3 + 1] = data[i * 4 + 1]; rgb[i * 3 + 2] = data[i * 4 + 2];
      alpha[i] = data[i * 4 + 3];
      if (alpha[i] < 128) clear++;
    }
    const img: RGBImage = { width: info.width, height: info.height, data: rgb };
    const usable = (m: Mask) => !!maskBBox(m) && maskArea(m) > n * 0.01 && maskArea(m) < n * 0.97;

    if (clear > n * 0.02) {
      const mask: Mask = { width: info.width, height: info.height, data: alpha.map((a) => (a >= 128 ? 1 : 0)) };
      if (usable(mask)) return { img, mask, alpha, how: 'transparent background' };
    }
    // A plain background: most of the border is one color. The cut-off follows how flat it is,
    // so a light grey part on a white background survives.
    const bg = estimateBackground(img);
    const bgLab = rgbToLab(...bg);
    const near: number[] = [];
    let border = 0;
    const at = (x: number, y: number) => {
      const i = (y * img.width + x) * 3;
      border++;
      const d = deltaE(rgbToLab(rgb[i], rgb[i + 1], rgb[i + 2]), bgLab);
      if (d < 20) near.push(d);
    };
    for (let x = 0; x < img.width; x++) { at(x, 0); at(x, img.height - 1); }
    for (let y = 0; y < img.height; y++) { at(0, y); at(img.width - 1, y); }
    if (near.length / border >= 0.6) {
      // A colored backdrop (like the key colors) keeps the normal settings, which also remove its
      // shadows; a white or grey one gets a cut-off that follows its noise and no hue rule.
      const noise = near.sort((a, b) => a - b)[Math.floor(near.length * 0.9)];
      const tolerance = Math.min(28, Math.max(8, noise * 1.5 + 5));
      const neutral = Math.max(...bg) - Math.min(...bg) < 40;
      const { mask } = segmentKey(img, bg, neutral ? { tolerance, holeTolerance: tolerance * 0.7, hue: false } : {});
      // Remove the backdrop's color cast from the subject, as refs_normalize does for key colors.
      if (usable(mask)) return { img: neutral ? img : despill(img, bg, mask), mask, alpha: null, how: 'plain background' };
    }
    if (comfyConfig() && !fakeMode()) {
      const key = KEY_COLORS[0];
      const r = await this.gen('import_cutout', {
        prompt: '', workflow: 'rembg.json', provider: 'comfyui', keyColor: keyRGB(key),
        refs: [{ label: 'IMAGE', data: await sharp(src).png().toBuffer(), mime: 'image/png' }],
        aspectRatio: `${info.width}:${info.height}`, imageSize: n > 1.3e6 ? '2K' : '1K',
      });
      const cut = await loadRGB(await sharp(r.image).resize({ width: info.width, height: info.height, fit: 'fill' }).toBuffer());
      const { mask } = segmentKey(cut, keyRGB(key));
      if (usable(mask)) return { img: cut, mask, alpha: null, how: 'background removed on ComfyUI' };
    }
    throw new Error('Could not find the background in that picture. Use one with a plain background or a transparent PNG (ComfyUI, if set up, can remove any background).');
  }

  /** Edit an image in place through its interaction history. target: hero_N | sheet | <view> | part:<Name>:<view>. */
  async edit(target: string, instruction: string, provider?: Provider): Promise<string> {
    const internal = this.internal();
    const p = pickProvider(provider);
    let closeup: string | null = null;
    if (target.startsWith('part:')) {
      const [, name, v] = target.split(':');
      if (!name || !v) throw new Error('close-up target is part:<Name>:<view>, e.g. part:Head:front');
      closeup = name;
      target = `part:${name}:${v === 'side' ? 'right' : v}`;
    }
    const file = closeup ? this.s.path('refs', 'parts', `${closeup}_${target.split(':')[2]}.png`)
      : target.startsWith('hero_') ? this.file(`${target}.png`)
      : target === 'sheet' ? this.file('sheet.png') : this.file(`raw_${target}.png`);
    if (!fs.existsSync(file)) throw new Error(`no image for "${target}" (${file})`);
    // Gemini continues the conversation that made the image; otherwise the image itself is the reference.
    const interaction = p === 'gemini' ? internal.interactions[target] : undefined;
    const meta = await sharp(file).metadata();
    const aspect = closeup ? nearestAspect(meta.width! / meta.height!) : target === 'sheet' ? '21:9' : target.startsWith('hero_') || target === 'top' ? '1:1' : '3:4';
    const r = await this.gen(`edit_${target}`, {
      prompt: editPrompt(instruction, internal.key),
      ...(interaction ? { previousInteractionId: interaction } : { refs: [{ label: 'IMAGE TO EDIT', data: fs.readFileSync(file), mime: 'image/png' }] }),
      aspectRatio: aspect, imageSize: (meta.width ?? 0) > 1500 ? '2K' : '1K', provider: p, fake: async () => fs.readFileSync(file),
    });
    fs.copyFileSync(file, file.replace(/\.png$/, '.prev.png'));
    fs.writeFileSync(file, r.image);
    if (r.interactionId) internal.interactions[target] = r.interactionId;
    this.saveInternal(internal);
    if (target === 'sheet') await this.sliceSheet();
    else if (closeup) await this.normalizeCloseup(closeup);
    else if (target.startsWith('hero_')) {
      const c = this.s.refs.hero.candidates.find((x) => x.id === target);
      if (c) c.url = this.s.url(file);
    } else this.setRaw(target as RefView, file);
    this.s.saveRefs();
    return file;
  }

  /**
   * Close-up references of one part on its own, one image per view (front/side/back by default,
   * also top or threequarter). Each ortho close-up is then fitted onto the part's extent in the
   * matching normalized view, so its lines and spots measure in world studs at a much finer
   * scale. They are detail references only; evaluation never scores against them.
   */
  async generateCloseup(part: string, box: Box, opts: { notes?: string; views?: CloseupView[]; extra?: string; model?: 'flash' | 'pro'; provider?: Provider } = {}): Promise<{ files: string[]; report: string }> {
    if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('close-up name: letters, digits, _ and - only');
    const hero = this.heroFile();
    const internal = this.internal();
    const { preset } = loadStyle(this.s.meta.style);
    const st = this.styleRefs();
    // One picture per part by default: the part alone in a three-quarter view.
    const views = opts.views?.length ? opts.views : (['threequarter'] as CloseupView[]);
    const local = pickProvider(opts.provider) === 'comfyui';
    const dir = this.s.path('refs', 'parts');
    fs.mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    for (const v of views) {
      // The part alone: a view cut exactly at the part's box (everything else is background), so
      // the image model only sees the part; the hero is there for detail. The 3/4 picture starts
      // from the front view.
      const src: RefView = v === 'threequarter' ? 'front' : v;
      const crop = await this.cropWorld(src, box, 0.02);
      if (!crop) throw new Error(`no normalized ${viewLabel(src)} view covering that box (run refs_normalize; check the box)`);
      const m = await sharp(crop).metadata();
      const aspect = v === 'threequarter' ? '1:1' : nearestAspect(m.width! / m.height!);
      // Small crops are upscaled so the image model sees the detail.
      const big = await sharp(crop).resize({ width: 1024, height: 1024, fit: 'inside', kernel: 'lanczos3' }).png().toBuffer();
      const inputs: RefInput[] = [
        { label: `ONLY THE ${part.toUpperCase()}, cut out of the ${viewLabel(src)} view`, data: big, mime: 'image/png' },
        { label: 'WHOLE DESIGN (hero, for detail only)', data: fs.readFileSync(hero), mime: 'image/png' },
      ];
      const r = await this.gen(`closeup_${part}_${v}`, {
        prompt: closeupPrompt(part, v, opts.notes ?? '', this.s.meta.idea, preset, internal.key, !local && st.inputs.length > 0, opts.extra),
        // Local GPU: Qwen-Image-2.1 edit follows "only this part" far better than FLUX.2 [klein].
        refs: local ? inputs : [...inputs, ...st.inputs.slice(0, 1)], aspectRatio: aspect, imageSize: '1K',
        ...(local ? { workflow: 'qwen-edit.json', keyColor: keyRGB(internal.key) } : {}),
        model: opts.model ? MODELS[opts.model] : st.model, provider: opts.provider,
        fake: () => fakeCloseup(box, v as OrthoView | 'threequarter', keyRGB(internal.key)),
      });
      const f = path.join(dir, `${part}_${v}.png`);
      if (fs.existsSync(f)) fs.copyFileSync(f, f.replace(/\.png$/, '.prev.png'));
      fs.writeFileSync(f, r.image);
      if (r.interactionId) internal.interactions[`part:${part}:${v}`] = r.interactionId;
      files.push(f);
    }
    internal.closeups ??= {};
    internal.closeups[part] = { box, notes: opts.notes, frames: internal.closeups[part]?.frames ?? {} };
    this.saveInternal(internal);
    return { files, report: await this.normalizeCloseup(part) };
  }

  /** Fit every close-up of a part onto the part's extent in the normalized views (see generateCloseup). */
  async normalizeCloseup(part: string, tolerance?: number): Promise<string> {
    const internal = this.internal();
    const c = internal.closeups?.[part];
    if (!c) throw new Error(`no close-ups for "${part}" yet (refs_generate {kind:'part', part})`);
    const dir = this.s.path('refs', 'parts');
    const f2 = (x: number) => x.toFixed(2);
    const lines = [`${part} close-ups - detail references (never scored), box ${c.box.min.map(f2).join(',')} .. ${c.box.max.map(f2).join(',')}:`];
    const imgs: RefImage[] = [];
    c.frames = {};
    for (const v of [...REF_VIEWS, 'threequarter'] as CloseupView[]) {
      const raw = path.join(dir, `${part}_${v}.png`);
      if (!fs.existsSync(raw)) continue;
      const entry: RefImage = { id: `${part}_${v}`, url: this.s.url(raw), label: v === 'threequarter' ? '3/4' : viewLabel(v) };
      imgs.push(entry);
      if (v === 'threequarter') { lines.push('  3/4: picture only (perspective, not measurable)'); continue; }
      const fr = internal.frames[v];
      if (!fr || !fs.existsSync(this.file(`mask_${v}.png`))) {
        entry.flag = `the ${viewLabel(v)} view is not normalized`;
        lines.push(`  ${viewLabel(v)}: ${entry.flag}`);
        continue;
      }
      const img0 = await loadRGB(raw);
      const { mask, key } = segmentKey(img0, undefined, { tolerance });
      const bb = maskBBox(mask);
      if (!bb) { entry.flag = 'no subject found (key color / tolerance)'; lines.push(`  ${viewLabel(v)}: ${entry.flag}`); continue; }
      const img = despill(img0, key, mask);

      // Where the part is in the normalized view: the subject's extent inside the box.
      const ax = viewAxes(v as OrthoView);
      const idx = { x: 0, y: 1, z: 2 } as const;
      const span = (a: { axis: 'x' | 'y' | 'z'; sign: number }) => [c.box.min[idx[a.axis]] * a.sign, c.box.max[idx[a.axis]] * a.sign].sort((p, q) => p - q);
      const [bu0, bu1] = span(ax.h), [bv0, bv1] = span(ax.v);
      const main = await loadMask(this.file(`mask_${v}.png`));
      const P = fr.ppu;
      let tu0 = Infinity, tu1 = -Infinity, tv0 = Infinity, tv1 = -Infinity;
      const x0 = Math.max(0, Math.floor((bu0 - fr.u0) * P)), x1 = Math.min(fr.width, Math.ceil((bu1 - fr.u0) * P));
      const y0 = Math.max(0, Math.floor((fr.v0 - bv1) * P)), y1 = Math.min(fr.height, Math.ceil((fr.v0 - bv0) * P));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        if (!main.data[y * fr.width + x]) continue;
        tu0 = Math.min(tu0, fr.u0 + x / P); tu1 = Math.max(tu1, fr.u0 + (x + 1) / P);
        tv1 = Math.max(tv1, fr.v0 - y / P); tv0 = Math.min(tv0, fr.v0 - (y + 1) / P);
      }
      if (!Number.isFinite(tu0)) { tu0 = bu0; tu1 = bu1; tv0 = bv0; tv1 = bv1; }
      const tW = tu1 - tu0, tH = tv1 - tv0;
      const bw = bb.maxX - bb.minX + 1, bh = bb.maxY - bb.minY + 1;
      const stretch = (bw / bh) / (tW / tH); // > 1: the close-up is drawn wider than the view shows

      // Resample: close-up bounding box -> that extent, at a fine scale.
      const P2 = Math.max(P, Math.min(256, Math.round(640 / Math.max(tW, tH))));
      const margin = Math.max(0.1, 0.1 * Math.max(tW, tH));
      const uMin = tu0 - margin, vMax = tv1 + margin;
      const width = Math.ceil((tW + 2 * margin) * P2), height = Math.ceil((tH + 2 * margin) * P2);
      const rgba = Buffer.alloc(width * height * 4);
      const out: Mask = { width, height, data: new Uint8Array(width * height) };
      let inter = 0, uni = 0;
      for (let oy = 0; oy < height; oy++) {
        const wv = vMax - (oy + 0.5) / P2;
        const sy = Math.floor(bb.minY + ((tv1 - wv) / tH) * bh);
        const my = Math.floor((fr.v0 - wv) * P);
        for (let ox = 0; ox < width; ox++) {
          const wu = uMin + (ox + 0.5) / P2;
          const sx = Math.floor(bb.minX + ((wu - tu0) / tW) * bw);
          const oi = oy * width + ox;
          let on = 0;
          if (sx >= 0 && sy >= 0 && sx < img.width && sy < img.height) {
            const si = sy * img.width + sx;
            rgba[oi * 4] = img.data[si * 3]; rgba[oi * 4 + 1] = img.data[si * 3 + 1]; rgba[oi * 4 + 2] = img.data[si * 3 + 2];
            if (mask.data[si]) { on = 1; out.data[oi] = 1; rgba[oi * 4 + 3] = 255; }
          }
          // Outline agreement with the main view, inside the part's extent only.
          if (wu >= tu0 && wu <= tu1 && wv >= tv0 && wv <= tv1) {
            const mx = Math.floor((wu - fr.u0) * P);
            const m = mx >= 0 && my >= 0 && mx < fr.width && my < fr.height ? main.data[my * fr.width + mx] : 0;
            if (on && m) inter++;
            if (on || m) uni++;
          }
        }
      }
      const frame: RefFrame = { ppu: P2, u0: uMin, v0: vMax, width, height };
      await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(path.join(dir, `${part}_norm_${v}.png`));
      await saveMask(out, path.join(dir, `${part}_mask_${v}.png`));
      c.frames[v] = frame;
      const agree = uni ? inter / uni : 0;
      const flags: string[] = [];
      if (Math.abs(Math.log(stretch)) > Math.log(1.15)) flags.push(`drawn ${Math.round(Math.abs(stretch - 1) * 100)}% ${stretch > 1 ? 'wider' : 'narrower'} than the ${viewLabel(v)} view (squeezed to fit)`);
      if (agree < 0.7) flags.push(`outline differs from the ${viewLabel(v)} view (IoU ${f2(agree)}) - trust it for what the details are, not where`);
      if (flags.length) entry.flag = flags.join('; ');
      lines.push(`  ${viewLabel(v)}: fitted to ${ax.h.axis} ${f2(Math.min(tu0 * ax.h.sign, tu1 * ax.h.sign))}..${f2(Math.max(tu0 * ax.h.sign, tu1 * ax.h.sign))}, ${ax.v.axis} ${f2(Math.min(tv0 * ax.v.sign, tv1 * ax.v.sign))}..${f2(Math.max(tv0 * ax.v.sign, tv1 * ax.v.sign))} at ${P2} px/stud; outline vs view IoU ${f2(agree)}${flags.length ? ` - FLAG: ${flags.join('; ')}` : ''}`);
    }
    this.saveInternal(internal);
    this.s.refs.parts[part] = imgs;
    this.s.saveRefs();
    lines.push(`Measure them: refs_measure {view, part:'${part}', mode:'spots'|'lines'|'colors'} or plan_build {action:'analyze', part:'${part}'}.`);
    return lines.join('\n');
  }

  /** The normalized image, mask and frame of a view, or of a part's close-up in that view. */
  source(view: RefView, part?: string): { norm: string; mask: string; frame: RefFrame; label: string } | null {
    const internal = this.internal();
    if (!part) {
      const frame = internal.frames[view];
      const norm = this.file(`norm_${view}.png`), mask = this.file(`mask_${view}.png`);
      return frame && fs.existsSync(mask) ? { norm, mask, frame, label: viewLabel(view) } : null;
    }
    const frame = internal.closeups?.[part]?.frames[view];
    const dir = this.s.path('refs', 'parts');
    const norm = path.join(dir, `${part}_norm_${view}.png`), mask = path.join(dir, `${part}_mask_${view}.png`);
    return frame && fs.existsSync(mask) ? { norm, mask, frame, label: `${part} close-up ${viewLabel(view)}` } : null;
  }

  closeupNames(): string[] {
    return Object.keys(this.internal().closeups ?? {});
  }

  /** Crop a normalized view to a world-space box (for part close-up references). */
  private async cropWorld(view: RefView, box: { min: [number, number, number]; max: [number, number, number] }, grow: number): Promise<Buffer | null> {
    const frame = this.internal().frames[view];
    const norm = this.file(`norm_${view}.png`);
    if (!frame || !fs.existsSync(norm)) return null;
    const ax = viewAxes(view as OrthoView);
    const idx = { x: 0, y: 1, z: 2 } as const;
    const hr = [box.min[idx[ax.h.axis]] * ax.h.sign, box.max[idx[ax.h.axis]] * ax.h.sign].sort((a, b) => a - b);
    const vr = [box.min[idx[ax.v.axis]] * ax.v.sign, box.max[idx[ax.v.axis]] * ax.v.sign].sort((a, b) => a - b);
    const gh = (hr[1] - hr[0]) * grow, gv = (vr[1] - vr[0]) * grow;
    const x0 = Math.max(0, Math.floor((hr[0] - gh - frame.u0) * frame.ppu)), x1 = Math.min(frame.width, Math.ceil((hr[1] + gh - frame.u0) * frame.ppu));
    const y0 = Math.max(0, Math.floor((frame.v0 - (vr[1] + gv)) * frame.ppu)), y1 = Math.min(frame.height, Math.ceil((frame.v0 - (vr[0] - gv)) * frame.ppu));
    if (x1 - x0 < 4 || y1 - y0 < 4) return null;
    const k = keyRGB(this.internal().key);
    return sharp(norm).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).flatten({ background: { r: k[0], g: k[1], b: k[2] } }).png().toBuffer();
  }

  // ------------------------------------------------------------------ normalization

  async normalize(opts: { heightStuds?: number; tolerance?: number; axis?: Partial<Record<RefView, number>> } = {}): Promise<{ report: string; overlay: Buffer }> {
    const H = opts.heightStuds ?? this.s.meta.heightStuds;
    if (opts.heightStuds) { this.s.meta.heightStuds = H; this.s.saveMeta(); }
    const internal = this.internal();
    const P = Math.max(8, Math.min(128, Math.round(640 / H)));
    const segs: Partial<Record<RefView, { img: RGBImage; mask: Mask; key: [number, number, number] }>> = {};
    for (const v of REF_VIEWS) {
      const raw = this.file(`raw_${v}.png`);
      if (!fs.existsSync(raw)) continue;
      const img = await loadRGB(raw);
      const { mask, key } = segmentKey(img, undefined, { tolerance: opts.tolerance });
      if (!maskBBox(mask)) throw new Error(`no subject found in the ${v} view; check the key color / tolerance`);
      // Strip the background color's cast (pink on silver, colored outline) before anything reads colors.
      segs[v] = { img: despill(img, key, mask), mask, key };
    }
    if (!segs.front) throw new Error('need at least the front view (generate the sheet first)');

    const lines: string[] = [];
    const flags: Partial<Record<RefView, string>> = {};
    const studsPerPx: Partial<Record<RefView, number>> = {};
    const extents: Partial<Record<RefView, { w: number; h: number }>> = {};

    // One coordinate system for all views. The front view fixes x = 0 (symmetry axis, or the
    // torso centre) and the right view fixes z = 0 (torso centre). Every other view is placed
    // so its bounding box centre lands on the same world centre along each axis.
    let xc: number | null = null, zc: number | null = null; // world bbox centres
    for (const v of REF_VIEWS) {
      const sg = segs[v];
      if (!sg) continue;
      const bb = maskBBox(sg.mask)!;
      const wpx = bb.maxX - bb.minX + 1, hpx = bb.maxY - bb.minY + 1;
      const bbCx = (bb.minX + bb.maxX + 1) / 2;
      const ax = viewAxes(v as OrthoView);
      let spp: number; // studs per source pixel
      if (v === 'top') {
        // Top view: least-squares scale matching the front width and the side depth.
        const Wf = extents.front?.w ?? extents.back?.w;
        const Ds = extents.right?.w ?? extents.left?.w;
        if (!Wf) continue;
        spp = Ds ? (Wf * wpx + Ds * hpx) / (wpx * wpx + hpx * hpx) : Wf / wpx;
      } else {
        spp = H / hpx;
      }
      studsPerPx[v] = spp;
      const known = ax.h.axis === 'x' ? xc : zc;
      let axisPx: number;
      if (opts.axis?.[v] !== undefined) axisPx = opts.axis[v]!;
      else if (known !== null) axisPx = bbCx - (known * ax.h.sign) / spp;
      else axisPx = ax.h.axis === 'x' && this.s.meta.symmetric ? symmetryAxis(sg.mask) : coreCenter(sg.mask);
      if (known === null) {
        const c = (bbCx - axisPx) * spp * ax.h.sign;
        if (ax.h.axis === 'x') xc = c; else zc = c;
      }
      internal.axis[v] = axisPx;
      // Vertical zero: feet on y = 0; for the top view, z centred like the side views.
      const vZeroPx = v === 'top' ? (bb.minY + bb.maxY + 1) / 2 + ((zc ?? 0) * ax.v.sign) / spp : bb.maxY + 1;
      const { frame, rgba, mask } = this.resample(sg.img, sg.mask, bb, axisPx, vZeroPx, spp, P);
      internal.frames[v] = frame;
      extents[v] = { w: (bb.maxX - bb.minX + 1) * spp, h: (bb.maxY - bb.minY + 1) * spp };
      await sharp(rgba, { raw: { width: frame.width, height: frame.height, channels: 4 } }).png().toFile(this.file(`norm_${v}.png`));
      await saveMask(mask, this.file(`mask_${v}.png`));
    }

    // Consistency: orthographic silhouettes of opposite views are exact mirror images.
    const pairIoU = async (a: RefView, b: RefView) => {
      if (!internal.frames[a] || !internal.frames[b]) return null;
      return this.mirrorIoU(a, b, internal.frames[a]!, internal.frames[b]!);
    };
    const r = (x: number) => Math.round(x * 100) / 100;
    const pct = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b);
    lines.push(`height ${H} studs, ${P} px/stud. Key colors: ${REF_VIEWS.filter((v) => segs[v]).map((v) => `${v} ${rgbHex(segs[v]!.key)}`).join(', ')}`);
    lines.push(`extents (studs): ${REF_VIEWS.filter((v) => extents[v]).map((v) => `${v} ${r(extents[v]!.w)}w x ${r(extents[v]!.h)}${v === 'top' ? 'd' : 'h'}`).join(' | ')}`);
    const fb = await pairIoU('front', 'back');
    if (fb !== null) {
      lines.push(`front vs mirrored back silhouette IoU ${r(fb)}`);
      if (fb < 0.88) { flags.back = `back silhouette disagrees with front (IoU ${r(fb)})`; }
    }
    const rl = await pairIoU('right', 'left');
    if (rl !== null) {
      lines.push(`right vs mirrored left silhouette IoU ${r(rl)}`);
      if (rl < 0.88) { flags.left = `left silhouette disagrees with right (IoU ${r(rl)})`; }
    }
    if (extents.top && (extents.right || extents.left)) {
      const sideDepth = extents.right?.w ?? extents.left!.w;
      const d = pct(extents.top.h, sideDepth);
      lines.push(`top depth ${r(extents.top.h)} vs side depth ${r(sideDepth)} (${Math.round(d * 100)}% off)`);
      if (d > 0.12) flags.top = `top-view depth ${r(extents.top.h)} vs side ${r(sideDepth)} studs`;
    }
    if (this.s.meta.symmetric && segs.front) {
      const m = segs.front.mask;
      const ax = internal.axis.front!;
      const flipped = flipX(m);
      // IoU of the front mask with itself mirrored about the chosen axis
      let inter = 0, uni = 0;
      const shift = Math.round(2 * ax - m.width);
      for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
        const xs = x - shift;
        const p = m.data[y * m.width + x], q = xs >= 0 && xs < m.width ? flipped.data[y * m.width + xs] : 0;
        if (p && q) inter++;
        if (p || q) uni++;
      }
      lines.push(`front left/right symmetry IoU ${r(inter / uni)} (1.0 = perfectly symmetric)`);
    }

    // Palette from the side views.
    const pals = REF_VIEWS.filter((v) => v !== 'top' && segs[v]).flatMap((v) => palette(segs[v]!.img, segs[v]!.mask, 8));
    const merged = mergePalette(pals);
    this.s.refs.palette = merged.map((p) => p.hex);
    lines.push(`palette: ${merged.map((p) => `${p.hex} ${Math.round(p.share * 100)}%`).join(', ')}`);
    for (const [v, f] of Object.entries(flags)) lines.push(`FLAG ${v}: ${f}`);
    if (!Object.keys(flags).length) lines.push('no consistency flags');

    // Update the editor state; views whose image was removed are dropped.
    for (const v of REF_VIEWS) {
      if (!fs.existsSync(this.file(`raw_${v}.png`))) { delete this.s.refs.views[v]; delete internal.frames[v]; }
    }
    for (const v of REF_VIEWS) {
      if (!internal.frames[v]) continue;
      this.s.refs.views[v] = {
        url: this.s.url(this.file(`norm_${v}.png`)), maskUrl: this.s.url(this.file(`mask_${v}.png`)),
        rawUrl: this.s.url(this.file(`raw_${v}.png`)), frame: internal.frames[v], flag: flags[v],
      };
    }
    this.s.refs.report = lines.join('\n');
    this.saveInternal(internal);
    const overlay = await this.overlaySheet(segs);
    fs.writeFileSync(this.file('overlay.jpg'), overlay);
    this.s.refs.overlayUrl = this.s.url(this.file('overlay.jpg'));
    this.s.saveRefs();
    return { report: this.s.refs.report, overlay };
  }

  /** Crop + scale a view into world-aligned pixels: RGBA (alpha = mask) and mask, plus its frame. */
  private resample(img: RGBImage, mask: Mask, bb: NonNullable<ReturnType<typeof maskBBox>>, axisPx: number, vZeroPx: number, spp: number, P: number) {
    const margin = 0.5; // studs
    // World coords along the image axes: u = (x - axisPx) * spp, v = (vZeroPx - y) * spp.
    const uMin = (bb.minX - axisPx) * spp - margin, uMax = (bb.maxX + 1 - axisPx) * spp + margin;
    const vMax = (vZeroPx - bb.minY) * spp + margin, vMin = (vZeroPx - (bb.maxY + 1)) * spp - margin;
    const width = Math.ceil((uMax - uMin) * P), height = Math.ceil((vMax - vMin) * P);
    const frame: RefFrame = { ppu: P, u0: uMin, v0: vMax, width, height };
    const rgba = Buffer.alloc(width * height * 4);
    const out: Mask = { width, height, data: new Uint8Array(width * height) };
    for (let oy = 0; oy < height; oy++) {
      const v = vMax - (oy + 0.5) / P;
      const sy = Math.floor(vZeroPx - v / spp);
      if (sy < 0 || sy >= img.height) continue;
      for (let ox = 0; ox < width; ox++) {
        const u = uMin + (ox + 0.5) / P;
        const sx = Math.floor(axisPx + u / spp);
        if (sx < 0 || sx >= img.width) continue;
        const si = sy * img.width + sx;
        const oi = oy * width + ox;
        rgba[oi * 4] = img.data[si * 3]; rgba[oi * 4 + 1] = img.data[si * 3 + 1]; rgba[oi * 4 + 2] = img.data[si * 3 + 2];
        if (mask.data[si]) { out.data[oi] = 1; rgba[oi * 4 + 3] = 255; }
      }
    }
    return { frame, rgba, mask: out };
  }

  /** IoU between view a and the mirror image of view b, sampled on a shared world grid. */
  private async mirrorIoU(a: RefView, b: RefView, fa: RefFrame, fb: RefFrame): Promise<number> {
    const ma = await loadMask(this.file(`mask_${a}.png`));
    const mb = await loadMask(this.file(`mask_${b}.png`));
    const P = fa.ppu;
    // Opposite views have opposite image-right axes: u_b = -u_a.
    const uMin = Math.min(fa.u0, -(fb.u0 + fb.width / fb.ppu)), uMax = Math.max(fa.u0 + fa.width / fa.ppu, -fb.u0);
    const vMax = Math.max(fa.v0, fb.v0), vMin = Math.min(fa.v0 - fa.height / fa.ppu, fb.v0 - fb.height / fb.ppu);
    const sample = (m: Mask, f: RefFrame, u: number, v: number) => {
      const x = Math.floor((u - f.u0) * f.ppu), y = Math.floor((f.v0 - v) * f.ppu);
      return x >= 0 && y >= 0 && x < m.width && y < m.height ? m.data[y * m.width + x] : 0;
    };
    let inter = 0, uni = 0;
    for (let v = vMax - 0.5 / P; v > vMin; v -= 1 / P) for (let u = uMin + 0.5 / P; u < uMax; u += 1 / P) {
      const p = sample(ma, fa, u, v), q = sample(mb, fb, -u, v);
      if (p && q) inter++;
      if (p || q) uni++;
    }
    return uni ? inter / uni : 1;
  }

  private async overlaySheet(segs: Partial<Record<RefView, { img: RGBImage; mask: Mask }>>): Promise<Buffer> {
    const tiles = [];
    for (const v of REF_VIEWS) {
      const sg = segs[v];
      if (!sg) continue;
      const { img, mask } = sg;
      const edge = boundary(mask);
      const px = Buffer.from(img.data);
      // Dim the background, draw the mask outline in red.
      for (let i = 0; i < mask.data.length; i++) {
        if (!mask.data[i]) { px[i * 3] = px[i * 3] * 0.35 + 90; px[i * 3 + 1] = px[i * 3 + 1] * 0.35 + 90; px[i * 3 + 2] = px[i * 3 + 2] * 0.35 + 90; }
        if (edge[i]) { px[i * 3] = 255; px[i * 3 + 1] = 0; px[i * 3 + 2] = 0; }
      }
      const png = await sharp(px, { raw: { width: img.width, height: img.height, channels: 3 } }).png().toBuffer();
      tiles.push({ png, label: `${v} (${Math.round((maskArea(mask) / mask.data.length) * 100)}% subject)` });
    }
    return contactSheet(tiles, { tileHeight: 360 });
  }

  // ------------------------------------------------------------------ measuring

  /** Numbers from a normalized view, or from a part's close-up in that view (opts.part). */
  async measure(view: RefView, mode: 'profile' | 'extents' | 'colors' | 'lines' | 'spots', opts: { h?: [number, number]; v?: [number, number]; step?: number; part?: string } = {}): Promise<string> {
    const src = this.source(view, opts.part);
    if (!src) {
      throw new Error(opts.part
        ? `no fitted ${viewLabel(view)} close-up of "${opts.part}" (close-ups: ${this.closeupNames().join(', ') || 'none'}; refs_generate {kind:'part'})`
        : `the ${viewLabel(view)} view is not normalized yet (run refs_normalize)`);
    }
    const frame = src.frame;
    const mask = await loadMask(src.mask);
    if (mode === 'lines' || mode === 'spots') return this.measureStructure(src.label, mode, { ...frame, view: view as OrthoView }, mask, opts, src.norm);
    const ax = viewAxes(view as OrthoView);
    const P = frame.ppu;
    // World coordinate along the named axis for pixel column x / row y.
    const wh = (x: number) => (frame.u0 + x / P) * ax.h.sign;
    const wv = (y: number) => (frame.v0 - y / P) * ax.v.sign;
    const inH = (x: number) => !opts.h || (wh(x + 0.5) >= Math.min(...opts.h) && wh(x + 0.5) <= Math.max(...opts.h));
    const inV = (y: number) => !opts.v || (wv(y + 0.5) >= Math.min(...opts.v) && wv(y + 0.5) <= Math.max(...opts.v));
    const r = (x: number) => (Math.round(x * 100) / 100).toFixed(2);
    const hn = ax.h.axis, vn = ax.v.axis;

    if (mode === 'profile') {
      const step = opts.step ?? 0.25;
      const rows: { v0: number; v1: number; segs: string }[] = [];
      const vMin = (frame.v0 - frame.height / P) * ax.v.sign, vMaxW = frame.v0 * ax.v.sign;
      const lo = Math.min(vMin, vMaxW), hi = Math.max(vMin, vMaxW);
      for (let wvv = Math.ceil(lo / step) * step; wvv < hi; wvv += step) {
        const vc = wvv + step / 2;
        if (opts.v && (vc < Math.min(...opts.v) || vc > Math.max(...opts.v))) continue;
        const y = Math.floor((frame.v0 - vc * ax.v.sign) * P);
        if (y < 0 || y >= frame.height) continue;
        const spans: [number, number][] = [];
        let start = -1;
        for (let x = 0; x <= frame.width; x++) {
          const on = x < frame.width && mask.data[y * frame.width + x] && inH(x);
          if (on && start < 0) start = x;
          if (!on && start >= 0) {
            const a = wh(start), b = wh(x);
            spans.push([Math.min(a, b), Math.max(a, b)]);
            start = -1;
          }
        }
        spans.sort((a, b) => a[0] - b[0]);
        // Merge spans separated by less than 2 px
        const merged: [number, number][] = [];
        for (const s of spans) {
          const last = merged[merged.length - 1];
          if (last && s[0] - last[1] < 2 / P) last[1] = Math.max(last[1], s[1]);
          else merged.push([...s]);
        }
        const segs = merged.length ? merged.map(([a, b]) => `${hn} ${r(a)}..${r(b)} (${r(b - a)})`).join('  ') : '-';
        const last = rows[rows.length - 1];
        const same = last && last.segs.replace(/\(.*?\)/g, '') === segs.replace(/\(.*?\)/g, '') ? true : last && similar(last.segs, segs);
        if (last && same) last.v1 = wvv + step;
        else rows.push({ v0: wvv, v1: wvv + step, segs });
      }
      return [`${view} profile: silhouette extents along ${hn} for each ${step}-stud band of ${vn} (world coordinates, studs)`,
        ...rows.reverse().map((row) => `${vn} ${r(row.v0)}..${r(row.v1)}: ${row.segs}`)].join('\n');
    }

    // extents / colors within the rect
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, n = 0;
    for (let y = 0; y < frame.height; y++) {
      if (!inV(y)) continue;
      for (let x = 0; x < frame.width; x++) if (mask.data[y * frame.width + x] && inH(x)) {
        n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    if (!n) return `${view}: no subject pixels in that range`;
    const hs = [wh(minX), wh(maxX + 1)].sort((a, b) => a - b), vs = [wv(minY), wv(maxY + 1)].sort((a, b) => a - b);
    const ext = `${view} extents: ${hn} ${r(hs[0])}..${r(hs[1])} (${r(hs[1] - hs[0])}), ${vn} ${r(vs[0])}..${r(vs[1])} (${r(vs[1] - vs[0])}), area ${r(n / (P * P))} sq studs`;
    if (mode === 'extents') return ext;
    const { data, info } = await sharp(src.norm).raw().toBuffer({ resolveWithObject: true });
    const rgb = new Uint8Array(frame.width * frame.height * 3);
    const sel = new Uint8Array(frame.width * frame.height);
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const i = y * frame.width + x;
      if (!mask.data[i] || !inH(x) || !inV(y)) continue;
      sel[i] = 1;
      rgb[i * 3] = data[i * info.channels]; rgb[i * 3 + 1] = data[i * info.channels + 1]; rgb[i * 3 + 2] = data[i * info.channels + 2];
    }
    const pal = palette({ width: frame.width, height: frame.height, data: rgb }, { width: frame.width, height: frame.height, data: sel }, 4);
    const projPal = this.s.refs.palette;
    const nearest = (hex: string) => {
      if (!projPal.length) return '';
      const lab = rgbToLab(...hexToRgb(hex));
      let bi = 0, bd = Infinity;
      projPal.forEach((p, i) => { const d = deltaE(lab, rgbToLab(...hexToRgb(p))); if (d < bd) { bd = d; bi = i; } });
      return ` (~palette ${projPal[bi]})`;
    };
    return `${ext}\ncolors: ${pal.map((p) => `${p.hex} ${Math.round(p.share * 100)}%${nearest(p.hex)}`).join(', ')}`;
  }

  /** Inner lines (seams, plate edges, bands) or small details of a reference view, in studs. */
  private async measureStructure(name: string, mode: 'lines' | 'spots', frame: OrthoFrame, mask: Mask, opts: { h?: [number, number]; v?: [number, number] }, normFile: string): Promise<string> {
    const { data, info } = await sharp(normFile).raw().toBuffer({ resolveWithObject: true });
    const L = luminanceOf(data, frame.width, frame.height, info.channels);
    const E = imageEdges(L, interior(mask, Math.round(0.06 * frame.ppu)), frame.width, frame.height);
    const inRange = (val: number, r?: [number, number]) => !r || (val >= Math.min(...r) && val <= Math.max(...r));
    const f = (x: number) => x.toFixed(2);
    if (mode === 'lines') {
      const ax = viewAxes(frame.view);
      const ls = extractLines(E, frame).filter((l) => l.orient === 'h'
        ? inRange(l.pos, opts.v) && (!opts.h || (l.to >= Math.min(...opts.h) && l.from <= Math.max(...opts.h)))
        : inRange(l.pos, opts.h) && (!opts.v || (l.to >= Math.min(...opts.v) && l.from <= Math.max(...opts.v))));
      const hs = ls.filter((l) => l.orient === 'h').sort((a, b) => b.pos - a.pos);
      const vs = ls.filter((l) => l.orient === 'v').sort((a, b) => a.pos - b.pos);
      return [
        `${name}: visible lines inside the outline (seams, plate edges, bands), world studs. Horizontal lines give heights (where the chest ends, belt, knees...), vertical lines give widths.`,
        `horizontal (${ax.v.axis} = height, top to bottom):`, ...hs.map((l) => `  ${ax.v.axis} ${f(l.pos)}  across ${ax.h.axis} ${f(l.from)}..${f(l.to)}`),
        `vertical (${ax.h.axis} position):`, ...vs.map((l) => `  ${ax.h.axis} ${f(l.pos)}  over ${ax.v.axis} ${f(l.from)}..${f(l.to)}`),
      ].join('\n');
    }
    const spots = mergeSpots(findSpots(E, L, frame), findDarkSpots(L, interior(mask, Math.round(0.05 * frame.ppu)), frame))
      .filter((s) => inRange(s.h, opts.h) && inRange(s.v, opts.v))
      .sort((a, b) => b.v - a.v || a.h - b.h);
    return [`${name}: small details (dark holes = eye slits/vents, raised = rivets/buttons), centre and size in studs:`,
      ...spots.map((s) => `  ${s.dark ? 'dark hole   ' : 'raised bit  '} ${s.hAxis} ${f(s.h)}, ${s.vAxis} ${f(s.v)}  size ${f(s.sizeH)} x ${f(s.sizeV)}`)].join('\n');
  }

  // ------------------------------------------------------------------ showing

  async show(what: 'hero' | 'sheet' | 'views' | 'normalized' | 'overlay' | 'part', part?: string): Promise<Buffer> {
    const tiles: { png: Buffer; label: string }[] = [];
    const add = async (file: string, label: string) => { if (fs.existsSync(file)) tiles.push({ png: await sharp(file).png().toBuffer(), label }); };
    if (what === 'hero') for (const c of this.s.refs.hero.candidates) await add(this.file(`${c.id}.png`), `${c.id}${c.id === this.s.refs.hero.picked ? ' (picked)' : ''}`);
    if (what === 'sheet') await add(this.file('sheet.png'), 'sheet');
    if (what === 'views') for (const v of REF_VIEWS) await add(this.file(`raw_${v}.png`), v);
    if (what === 'normalized') {
      const internal = this.internal();
      for (const v of REF_VIEWS) {
        const f = this.file(`norm_${v}.png`);
        const frame = internal.frames[v];
        if (!fs.existsSync(f) || !frame) continue;
        const png = await sharp(f).flatten({ background: { r: 236, g: 239, b: 243 } })
          .composite([{ input: Buffer.from(gridSvg({ ...frame, view: v as OrthoView })), top: 0, left: 0 }]).png().toBuffer();
        tiles.push({ png, label: `${v} (normalized, studs)` });
      }
    }
    if (what === 'overlay') await add(this.file('overlay.jpg'), 'segmentation (red = subject outline)');
    if (what === 'part') {
      if (!part) throw new Error(`part name required (close-ups: ${this.closeupNames().join(', ') || 'none'})`);
      // Each close-up as generated, then fitted onto the view with a stud grid (world coordinates).
      for (const v of [...REF_VIEWS, 'threequarter'] as CloseupView[]) {
        await add(this.s.path('refs', 'parts', `${part}_${v}.png`), `${part} ${v === 'threequarter' ? '3/4' : viewLabel(v)}`);
        const src = v === 'threequarter' ? null : this.source(v, part);
        if (!src || !fs.existsSync(src.norm)) continue;
        const png = await sharp(src.norm).flatten({ background: { r: 236, g: 239, b: 243 } })
          .composite([{ input: Buffer.from(gridSvg({ ...src.frame, view: v as OrthoView })), top: 0, left: 0 }]).png().toBuffer();
        tiles.push({ png, label: `${viewLabel(v)} fitted (studs)` });
      }
    }
    if (!tiles.length) throw new Error(`nothing to show for "${what}" yet`);
    return contactSheet(tiles, { tileHeight: what === 'sheet' || what === 'part' ? 300 : 420 });
  }
}

const rgbHex = (c: [number, number, number]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

function similar(a: string, b: string): boolean {
  const na = [...a.matchAll(/-?\d+\.\d+/g)].map((m) => Number(m[0]));
  const nb = [...b.matchAll(/-?\d+\.\d+/g)].map((m) => Number(m[0]));
  return na.length === nb.length && na.every((v, i) => Math.abs(v - nb[i]) <= 0.06);
}

function mergePalette(p: { hex: string; share: number }[]): { hex: string; share: number }[] {
  const total = p.reduce((s, c) => s + c.share, 0) || 1;
  const out: { hex: string; share: number; lab: ReturnType<typeof rgbToLab> }[] = [];
  for (const c of [...p].sort((a, b) => b.share - a.share)) {
    const lab = rgbToLab(...hexToRgb(c.hex));
    const m = out.find((o) => deltaE(o.lab, lab) < 10);
    if (m) m.share += c.share / total;
    else out.push({ hex: c.hex, share: c.share / total, lab });
  }
  return out.filter((c) => c.share >= 0.015).slice(0, 12).map(({ hex, share }) => ({ hex, share }));
}

export { estimateBackground };
