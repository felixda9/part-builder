// Likeness evaluation: how much the model looks like the normalized reference views.
//
// Four components per view, each 0..1:
//   outline    silhouette IoU (the old score)
//   structure  inner lines: edge-map F1 + matched line segments (proportions, plate edges, bands)
//   color      reference pixels mapped to the model's palette vs the model's part colors
//   details    small features (eye slits, rivets) matched to small parts
// Weighted 0.3 / 0.3 / 0.25 / 0.15 (details only where the reference has some), views weighted
// front/right 1, back/left/top 0.5. The text lists concrete fixes; the sheet shows
// ref | model | overlay | edges per view, plus the hero next to the model's 3/4 view.

import fs from 'node:fs';
import sharp from 'sharp';
import { type OrthoFrame, type OrthoView, type RasterResult, drawOutlines, partsOf, renderOrtho, renderPerspective, threeQuarterCamera, viewAxes } from '../core/raster';
import { type RefView, type ReviewData, toRefView, viewLabel } from '../core/protocol';
import type { Part, SceneDoc } from '../core/scene';
import { gridSheet, rasterToPng } from './images';
import { type Mask, boundaryError, components, distanceTo, hexToRgb, iou, rgbToLab } from './imaging';
import {
  type LineMatch, type LineSeg, type Spot, describeLine, edgeScore, extractLines, findDarkSpots, findSpots,
  familyName, imageEdges, interior, luminanceOf, matchLines, matchSpots, mergeSpots, modelEdges, modelSpots, paletteLabeler,
} from './likeness';
import { loadPlan } from './plan';
import { type Refs, loadMask } from './refs';
import type { Session } from './session';
import { SIMILARITY_RULES, similarityLabel } from './similarity';

export interface EvalOptions {
  views?: RefView[];
  group?: string;
  note?: string;
  log?: boolean;
  maxItems?: number;
}

const VIEW_WEIGHT: Record<RefView, number> = { front: 1, right: 1, back: 0.5, left: 0.5, top: 0.5 };
const WEIGHT = { silhouette: 0.3, structure: 0.3, color: 0.25, detail: 0.15 };
const r2 = (x: number) => (Math.round(x * 100) / 100).toFixed(2);

interface Item { text: string; size: number }
interface Mark { orient: 'h' | 'v'; pos: number }

/**
 * Where a landmark can sit on a silhouette: its flat outline edges (a flat head top, the belly
 * line) and its extreme points (an ear tip, the snout tip, the end of a tail).
 */
function outlineMarks(mask: Mask, frame: OrthoFrame): Mark[] {
  const { width: w, height: h } = mask;
  const edge = new Uint8Array(w * h), horiz = new Uint8Array(w * h), vert = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, m = mask.data[i];
    if (y > 0 && mask.data[i - w] !== m) { horiz[i] = 1; edge[i] = 1; }
    if (x > 0 && mask.data[i - 1] !== m) { vert[i] = 1; edge[i] = 1; }
  }
  const marks: Mark[] = extractLines({ w, h, edge, horiz, vert }, frame, 0.1).map((l) => ({ orient: l.orient, pos: l.pos }));
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask.data[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 >= 0) {
    const ax = viewAxes(frame.view as OrthoView), P = frame.ppu;
    const wh = (x: number) => (frame.u0 + x / P) * ax.h.sign, wv = (y: number) => (frame.v0 - y / P) * ax.v.sign;
    marks.push({ orient: 'v', pos: wh(x0) }, { orient: 'v', pos: wh(x1 + 1) }, { orient: 'h', pos: wv(y0) }, { orient: 'h', pos: wv(y1 + 1) });
  }
  return marks;
}
interface GroupAcc { silI: number; silU: number; edgeHit: number; edgeTot: number; colAgree: number; colTot: number }

interface ViewResult {
  view: RefView;
  sil: number;
  struct: number;
  color: number;
  detail: number | null;
  score: number;
  boundary: { mean: number; p95: number };
  lines: LineMatch;
  refLines: LineSeg[];
  modelLines: LineSeg[];
  /** Inner lines plus the outline's flat edges and extreme points - what landmarks are checked against. */
  refMarks: Mark[];
  modelMarks: Mark[];
  spots: { missing: Spot[]; extra: Spot[] };
  colorItems: Item[];
  silItems: Item[];
  groups: Map<string, GroupAcc>;
  tiles: { png: Buffer; label: string }[];
  /** The line map alone on a transparent background, in the view's frame (drawn over the model in the editor). */
  layer: Buffer;
}

const f1 = (p: number, r: number) => (p + r ? (2 * p * r) / (p + r) : 0);

export async function evaluate(session: Session, refs: Refs, opts: EvalOptions = {}): Promise<{ text: string; image: Buffer }> {
  const internal = refs.internal();
  const avail = (Object.keys(internal.frames) as RefView[]).filter((v) => fs.existsSync(session.path('refs', `mask_${v}.png`)) && fs.existsSync(session.path('refs', `raw_${v}.png`)));
  if (!avail.length) throw new Error('no normalized reference views yet (generate views, then refs_normalize)');
  const views = (opts.views ?? (['front', 'right', 'back', 'top'] as RefView[])).filter((v) => avail.includes(v));
  const scene = session.scene;
  const parts = partsOf(scene, opts.group);
  if (!parts.length) throw new Error(opts.group ? `group "${opts.group}" has no parts` : 'the model is empty');
  const palette = scene.palette.length ? scene.palette : session.refs.palette;
  if (!palette.length) throw new Error('no palette: set one with scene_apply {op:"palette"} or run refs_normalize');

  const results: ViewResult[] = [];
  for (const v of views) results.push(await evalView(session, scene, parts, palette, v, { view: v as OrthoView, ...internal.frames[v]! }, opts.group));

  // ---- aggregate
  const wsum = results.reduce((s, r) => s + VIEW_WEIGHT[r.view], 0);
  const wavg = (pick: (r: ViewResult) => number) => results.reduce((s, r) => s + VIEW_WEIGHT[r.view] * pick(r), 0) / wsum;
  const withDetail = results.filter((r) => r.detail !== null);
  const detailW = withDetail.reduce((s, r) => s + VIEW_WEIGHT[r.view], 0);
  const comp = {
    silhouette: wavg((r) => r.sil),
    structure: wavg((r) => r.struct),
    color: wavg((r) => r.color),
    detail: detailW ? withDetail.reduce((s, r) => s + VIEW_WEIGHT[r.view] * (r.detail as number), 0) / detailW : null,
  };
  const score = Math.round(wavg((r) => r.score) * 1000) / 1000;
  const perView: Record<string, number> = Object.fromEntries(results.map((r) => [r.view, Math.round(r.score * 1000) / 1000]));
  const boundary: Record<string, { mean: number; p95: number }> = Object.fromEntries(results.map((r) => [r.view, r.boundary]));

  // Groups across views
  const gAcc = new Map<string, GroupAcc>();
  for (const r of results) for (const [g, a] of r.groups) {
    const t = gAcc.get(g) ?? { silI: 0, silU: 0, edgeHit: 0, edgeTot: 0, colAgree: 0, colTot: 0 };
    for (const k of Object.keys(a) as (keyof GroupAcc)[]) t[k] += a[k] * VIEW_WEIGHT[r.view];
    gAcc.set(g, t);
  }
  const groupRows = [...gAcc.entries()].map(([g, a]) => {
    const sil = a.silU ? a.silI / a.silU : 1, st = a.edgeTot ? a.edgeHit / a.edgeTot : 1, col = a.colTot ? a.colAgree / a.colTot : 1;
    return { g, sil, st, col, score: 0.35 * sil + 0.35 * st + 0.3 * col };
  }).sort((a, b) => a.score - b.score);

  const history = [...session.iterations];
  const prev = history.slice(-2);
  // Each logged round also saves its pictures and numbers for the editor's Review screen.
  const reviewId = `r${session.history.rev}-${Date.now().toString(36)}`;
  const reviewPath = `renders/review/${reviewId}.json`;
  const rec = opts.log !== false && !opts.group
    ? session.addIteration({ rev: session.history.rev, score, perView, boundary, note: opts.note, components: roundComp(comp), review: reviewPath })
    : null;

  // ---- text
  const max = opts.maxItems ?? 10;
  const lines: string[] = [];
  const compText = (c: { silhouette: number; structure: number; color: number; detail: number | null }) =>
    `outline ${r2(c.silhouette)} · structure ${r2(c.structure)} · color ${r2(c.color)} · details ${c.detail === null ? '-' : r2(c.detail)}`;
  lines.push(`${opts.group ? `group ${opts.group}: ` : ''}likeness ${r2(score)} (${compText(comp)}) over ${views.map(viewLabel).join(', ')}${rec ? ` - iteration ${rec.iter} at rev ${rec.rev}` : ''}`);
  for (const r of results) lines.push(`  ${viewLabel(r.view).padEnd(5)} ${r2(r.score)}  ${compText({ silhouette: r.sil, structure: r.struct, color: r.color, detail: r.detail })}`);
  const sim = session.similarity, rules = SIMILARITY_RULES[sim], simName = similarityLabel(sim);
  if (!opts.group) lines.push(`similarity: ${simName} - ${rules.guide}`);
  const hints: string[] = [];
  if (!opts.group && groupRows.length > 1) {
    lines.push(`by part, worst first: ${groupRows.slice(0, 8).map((g) => `${g.g} ${r2(g.score)} (outline ${r2(g.sil)}, lines ${r2(g.st)}, color ${r2(g.col)})`).join(' | ')}`);
  }
  if (prev.length && !opts.group) {
    const last = prev[prev.length - 1];
    const gain = score - last.score;
    lines.push(`change since iteration ${last.iter}: ${gain >= 0 ? '+' : ''}${r2(gain * 100)} points${last.components ? '' : ' (that round used the old outline-only score)'}`);
    const comparable = history.filter((it) => it.components);
    const best = comparable.reduce<typeof comparable[number] | null>((b, it) => (!b || it.score > b.score ? it : b), null);
    if (rules.chase && best && score < best.score - 0.02) lines.push(`REGRESSION: the best so far is iteration ${best.iter} (rev ${best.rev}, likeness ${r2(best.score)}). If this round made things worse, go back with scene_apply {checkout: ${best.rev}}.`);
    else if (rules.chase && prev.length === 2 && prev.every((p) => p.components) && Math.abs(score - prev[0].score) < 0.005 && Math.abs(gain) < 0.005) {
      hints.push('STOP HINT: less than 0.5 points gained over the last 2 rounds - show the user and ask what still looks off.');
    }
  }

  // Planned landmarks: does the model have a line where the plan (and the reference) says?
  const plan = loadPlan(session);
  let landmarkMisses = 0;
  const landmarkRows: ReviewData['landmarks'] = [];
  let checkRows: ReviewData['checks'] = [];
  if (plan?.landmarks.length && !opts.group) {
    const marks = plan.landmarks.map((lm) => {
      const lv = toRefView(lm.view);
      const r = results.find((x) => x.view === lv);
      const row = { name: lm.name, view: viewLabel(lv), axis: lm.axis, planned: lm.value, model: null as number | null, reference: null as number | null, mark: '?' as ReviewData['landmarks'][number]['mark'] };
      landmarkRows.push(row);
      if (!r) return `${lm.name} ${lm.axis} ${lm.value} (${lm.view}): view not evaluated`;
      const ax = viewAxes(lv as OrthoView);
      const orient = lm.axis === ax.v.axis ? 'h' : lm.axis === ax.h.axis ? 'v' : null;
      if (!orient) return `${lm.name}: axis ${lm.axis} is not visible in the ${lm.view} view`;
      const nearest = (ls: Mark[]) => ls.filter((l) => l.orient === orient).reduce<Mark | null>((b, l) => (!b || Math.abs(l.pos - lm.value) < Math.abs(b.pos - lm.value) ? l : b), null);
      const m = nearest(r.modelMarks), rf = nearest(r.refMarks);
      const d = m ? m.pos - lm.value : Infinity;
      const mark = Math.abs(d) <= 0.05 ? 'OK' : Math.abs(d) <= 0.12 ? '~' : 'X';
      if (mark === 'X') landmarkMisses++;
      Object.assign(row, { model: m ? Math.round(m.pos * 100) / 100 : null, reference: rf ? Math.round(rf.pos * 100) / 100 : null, mark });
      return `${mark} ${lm.name} ${lm.axis} ${lm.value} (${lm.view}): model ${m ? `${m.pos.toFixed(2)} (${d >= 0 ? '+' : ''}${d.toFixed(2)})` : 'none'}${rf ? `, reference ${rf.pos.toFixed(2)}` : ''}`;
    });
    lines.push(`LANDMARKS from the plan (OK within 0.05, ~ within 0.12, X off):\n${marks.map((m) => `  ${m}`).join('\n')}`);
  }

  // Model checks: z-fighting, symmetry, floating, ...
  if (!opts.group) {
    const checks = session.lints();
    checkRows = checks.map((l) => ({ kind: l.kind, message: l.message }));
    lines.push(checks.length
      ? `CHECKS:\n${checks.map((l) => `  - ${l.kind}: ${l.message}`).join('\n')}`
      : `CHECKS: no z-fighting, no thin gaps, ${session.meta.symmetric ? 'symmetric, ' : ''}nothing floating or disconnected`);
    const clean = !checks.some((l) => ['zfight', 'asymmetric', 'floating', 'disconnected', 'gap', 'loose', 'blunt'].includes(l.kind)) && landmarkMisses === 0;
    const diffs = plan?.differences ?? [];
    if (diffs.length) lines.push(`DELIBERATE DIFFERENCES (plan) - leave the list items they cause alone:\n${diffs.map((d) => `  - ${d.what}${d.where ? ` [${d.where}]` : ''}`).join('\n')}`);
    if (rules.floor !== null && score < rules.floor) {
      hints.push(`DRIFTED: likeness ${r2(score)} is under ${rules.floor} - at ${simName} it must still read as the subject; bring back the outline and colors that define it.`);
    } else if (rules.enough !== null && score >= rules.enough && clean) {
      hints.push(`STOP HINT: likeness ${r2(score)} is enough for ${simName}, the checks are clean and the landmarks hold - stop polishing the score, show the user${diffs.length ? ' and name the deliberate differences' : ''}.`);
    } else if (sim === 'free' && clean) {
      hints.push('At Free the likeness is information only. Checks are clean - when the design is done, show the user.');
    }
    lines.push(...hints);
    if (!rules.chase) lines.push(`(At ${simName} the lists below are information, not targets: act on them only where they matter for the theme or where something is broken.)`);
  }

  const byLen = (a: LineSeg, b: LineSeg) => (b.to - b.from) - (a.to - a.from);
  const missingLines = results.flatMap((r) => r.lines.missing.map((l) => ({ v: r.view, l, w: VIEW_WEIGHT[r.view] }))).sort((a, b) => b.w - a.w || byLen(a.l, b.l));
  const extraLines = results.flatMap((r) => r.lines.extra.map((l) => ({ v: r.view, l, w: VIEW_WEIGHT[r.view] }))).sort((a, b) => b.w - a.w || byLen(a.l, b.l));
  lines.push(missingLines.length
    ? `STRUCTURE - lines in the reference with no model line within 0.1 studs (proportions, plate edges, bands; fix these first):\n${missingLines.slice(0, max).map((m) => `  - ${viewLabel(m.v)}: ${describeLine(m.l)}`).join('\n')}`
    : 'STRUCTURE - every reference line has a matching model line');
  if (extraLines.length) lines.push(`  model lines the reference doesn't have:\n${extraLines.slice(0, Math.ceil(max / 2)).map((m) => `  - ${viewLabel(m.v)}: ${describeLine(m.l)}`).join('\n')}`);

  const missingSpots = results.flatMap((r) => r.spots.missing.map((s) => ({ v: r.view, s, w: VIEW_WEIGHT[r.view] }))).sort((a, b) => b.w - a.w);
  if (missingSpots.length) {
    lines.push(`DETAILS - small features in the reference with no small part there (eye slits, rivets, buttons):\n${missingSpots.slice(0, max).map((m) =>
      `  - ${viewLabel(m.v)}: ${m.s.dark ? 'dark hole' : 'raised detail'} ${r2(m.s.sizeH)}x${r2(m.s.sizeV)} at ${m.s.hAxis} ${r2(m.s.h)}, ${m.s.vAxis} ${r2(m.s.v)}`).join('\n')}`);
  }
  const extraSpots = results.flatMap((r) => r.spots.extra.map((s) => `${s.part} (${r.view})`));
  if (extraSpots.length) lines.push(`  small parts with no matching detail in the reference: ${[...new Set(extraSpots)].slice(0, 12).join(', ')}`);

  const colorItems = results.flatMap((r) => r.colorItems.map((c) => ({ ...c, w: VIEW_WEIGHT[r.view] }))).sort((a, b) => b.size * b.w - a.size * a.w);
  if (colorItems.length) lines.push(`COLOR - where the reference reads as a different palette color than the model:\n${colorItems.slice(0, Math.ceil(max * 0.6)).map((c) => `  - ${c.text}`).join('\n')}`);
  const silItems = results.flatMap((r) => r.silItems.map((c) => ({ ...c, w: VIEW_WEIGHT[r.view] }))).sort((a, b) => b.size * b.w - a.size * a.w);
  if (silItems.length) lines.push(`OUTLINE - largest missing/extra areas:\n${silItems.slice(0, Math.ceil(max * 0.6)).map((c) => `  - ${c.text}`).join('\n')}`);

  // ---- sheet: one row per view (ref | model | overlay | lines), then hero vs model 3/4
  const rows = results.map((r) => r.tiles);
  if (!opts.group) {
    const last: { png: Buffer; label: string }[] = [];
    const heroId = session.refs.hero.picked;
    const heroFile = heroId ? session.path('refs', `${heroId}.png`) : null;
    if (heroFile && fs.existsSync(heroFile)) last.push({ png: await sharp(heroFile).png().toBuffer(), label: 'hero (reference)' });
    const three = renderPerspective(parts, threeQuarterCamera(parts, 600, 600));
    drawOutlines(three);
    last.push({ png: await rasterToPng(three), label: 'model 3/4' });
    rows.push(last);
  }
  const image = await gridSheet(rows, { tileHeight: 260, title: `likeness ${r2(score)} - lines: red = only in the reference, blue = only in the model, black = both` });
  fs.writeFileSync(session.path('renders', `eval_rev${session.history.rev}${opts.group ? '_' + opts.group : ''}.jpg`), image);

  if (rec) {
    const dir = session.path('renders', 'review');
    fs.mkdirSync(dir, { recursive: true });
    const save = (name: string, png: Buffer) => { fs.writeFileSync(`${dir}/${reviewId}_${name}.png`, png); return `renders/review/${reviewId}_${name}.png`; };
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    const views = results.map((r) => ({
      view: r.view, label: viewLabel(r.view), weight: VIEW_WEIGHT[r.view], score: r3(r.score),
      components: roundComp({ silhouette: r.sil, structure: r.struct, color: r.color, detail: r.detail }), boundary: r.boundary,
      images: { ref: save(`${r.view}_ref`, r.tiles[0].png), model: save(`${r.view}_model`, r.tiles[1].png), overlay: save(`${r.view}_overlay`, r.tiles[2].png), lines: save(`${r.view}_lines`, r.tiles[3].png), layer: save(`${r.view}_layer`, r.layer) },
      issues: {
        missingLines: r.lines.missing.map(describeLine), extraLines: r.lines.extra.map(describeLine),
        details: r.spots.missing.map((s) => `${s.dark ? 'dark hole' : 'raised detail'} ${r2(s.sizeH)}x${r2(s.sizeV)} at ${s.hAxis} ${r2(s.h)}, ${s.vAxis} ${r2(s.v)}`),
        extraDetails: [...new Set(r.spots.extra.map((s) => s.part ?? ""))].filter(Boolean),
        color: r.colorItems.sort((a, b) => b.size - a.size).map((c) => c.text), outline: r.silItems.sort((a, b) => b.size - a.size).map((c) => c.text),
      },
    }));
    const heroRow = rows[rows.length - 1];
    const review: ReviewData = {
      id: reviewId, iter: rec.iter, rev: rec.rev, time: rec.time, note: opts.note, likeness: score, components: roundComp(comp), weights: WEIGHT,
      similarity: { level: sim, label: simName, guide: rules.guide }, views,
      hero: heroRow.length === 2 ? { hero: save('hero', heroRow[0].png), model: save('model34', heroRow[1].png) } : undefined,
      parts: groupRows.map((g) => ({ name: g.g, score: r3(g.score), outline: r3(g.sil), lines: r3(g.st), color: r3(g.col) })),
      landmarks: landmarkRows, checks: checkRows, differences: (plan?.differences ?? []).map((d) => ({ what: d.what, where: d.where })), hints,
      report: lines.join('\n'),
    };
    fs.writeFileSync(session.path(reviewPath), JSON.stringify(review, null, 1));
    session.emit('change');
  }
  return { text: lines.join('\n'), image };
}

function roundComp(c: { silhouette: number; structure: number; color: number; detail: number | null }) {
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { silhouette: r(c.silhouette), structure: r(c.structure), color: r(c.color), detail: c.detail === null ? null : r(c.detail) };
}

async function evalView(session: Session, scene: SceneDoc, parts: Part[], palette: string[], v: RefView, frame: OrthoFrame, group?: string): Promise<ViewResult> {
  const P = frame.ppu, W = frame.width, H = frame.height, N = W * H;
  const ax = viewAxes(frame.view);
  const wh = (x: number) => (frame.u0 + x / P) * ax.h.sign;
  const wv = (y: number) => (frame.v0 - y / P) * ax.v.sign;
  const where = (minX: number, minY: number, maxX: number, maxY: number) => {
    const hs = [wh(minX), wh(maxX + 1)].sort((a, b) => a - b), vs = [wv(minY), wv(maxY + 1)].sort((a, b) => a - b);
    return `${ax.h.axis} ${r2(hs[0])}..${r2(hs[1])}, ${ax.v.axis} ${r2(vs[0])}..${r2(vs[1])}`;
  };

  let refMask = await loadMask(session.path('refs', `mask_${v}.png`));
  const { data: refPx, info } = await sharp(session.path('refs', `norm_${v}.png`)).raw().toBuffer({ resolveWithObject: true });
  const L = luminanceOf(refPx, W, H, info.channels);
  const res = renderOrtho(parts, frame);
  let modelMask: Mask = { width: W, height: H, data: new Uint8Array(N) };
  for (let i = 0; i < N; i++) modelMask.data[i] = res.partIndex[i] >= 0 ? 1 : 0;
  if (group) {
    const reg = projectedBox(res, Math.round(0.5 * P));
    refMask = clip(refMask, reg);
    modelMask = clip(modelMask, reg);
  }

  // Outline
  const sil = iou(refMask, modelMask);
  const be = boundaryError(refMask, modelMask);
  const silItems: Item[] = [];
  for (const kind of ['missing', 'extra'] as const) {
    const m = new Uint8Array(N);
    for (let i = 0; i < N; i++) m[i] = kind === 'missing' ? (refMask.data[i] && !modelMask.data[i] ? 1 : 0) : (modelMask.data[i] && !refMask.data[i] ? 1 : 0);
    for (const c of components({ width: W, height: H, data: m }).list) {
      if (c.area < Math.max(12, 0.04 * P * P)) continue;
      const near = nearestPart(c.pixels, res.partIndex, W, H, Math.round(P * 0.5));
      silItems.push({ size: c.area / (P * P), text: `${viewLabel(v)}: ${kind === 'missing' ? 'MISSING' : 'EXTRA'} ${r2(c.area / (P * P))} sq studs at ${where(c.minX, c.minY, c.maxX, c.maxY)}${near >= 0 ? ` near ${parts[near].name}` : ''}` });
    }
  }

  // Structure
  const inset = Math.round(0.06 * P);
  const refRegion = interior(refMask, inset), modelRegion = interior(modelMask, inset);
  const refE = imageEdges(L, refRegion, W, H);
  const modE = modelEdges(res, parts, modelRegion, P);
  const es = edgeScore(refE, modE, 0.08 * P);
  const refLines = extractLines(refE, frame), modelLines = extractLines(modE, frame);
  const lm = matchLines(refLines, modelLines, 0.1);
  const struct = 0.5 * es.f1 + 0.5 * f1(lm.precision, lm.recall);

  // Details
  const refSpots = mergeSpots(findSpots(refE, L, frame), findDarkSpots(L, interior(refMask, Math.round(0.05 * P)), frame));
  const modSp = modelSpots(res, parts, frame);
  const sm = matchSpots(refSpots, modSp, 0.12);
  const detail = refSpots.length >= 3 ? f1(sm.precision, sm.recall) : null;

  // Color layout. The reference's overall brightness differs per view (back and side views are
  // lit darker), so its lightness is first scaled to the model palette's over the shared area.
  const label = paletteLabeler(palette);
  const partLab = parts.map((p) => rgbToLab(...hexToRgb(p.color)));
  const partLabel = partLab.map((lab) => label(lab));
  const refLabel = new Int16Array(N).fill(-1);
  const refLs: number[] = [], modLs: number[] = [];
  for (let i = 0; i < N; i += 3) {
    if (!refRegion[i] || !modelRegion[i]) continue;
    refLs.push(L[i] * 100);
    modLs.push(partLab[res.partIndex[i]][0]);
  }
  const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 1);
  const gain = Math.min(1.8, Math.max(0.6, med(modLs) / Math.max(1, med(refLs))));
  let agree = 0, tot = 0;
  for (let i = 0; i < N; i++) {
    if (!refRegion[i] || !modelRegion[i]) continue;
    const c = i * info.channels;
    const lab = rgbToLab(refPx[c], refPx[c + 1], refPx[c + 2]);
    refLabel[i] = label([Math.min(100, lab[0] * gain), lab[1], lab[2]]);
    tot++;
    if (refLabel[i] === partLabel[res.partIndex[i]]) agree++;
  }
  const color = tot ? agree / tot : 1;
  const colorItems: Item[] = [];
  const pairs = new Map<number, Uint8Array>();
  for (let i = 0; i < N; i++) {
    if (refLabel[i] < 0) continue;
    const ml = partLabel[res.partIndex[i]];
    if (refLabel[i] === ml) continue;
    const key = refLabel[i] * 64 + ml;
    let m = pairs.get(key);
    if (!m) { m = new Uint8Array(N); pairs.set(key, m); }
    m[i] = 1;
  }
  for (const [key, m] of pairs) {
    const rl = Math.floor(key / 64), ml = key % 64;
    for (const c of components({ width: W, height: H, data: m }).list) {
      if (c.area < 0.03 * P * P) continue;
      const near = nearestPart(c.pixels, res.partIndex, W, H, 1);
      colorItems.push({ size: c.area / (P * P), text: `${viewLabel(v)}: reference reads ${familyName(palette, rl)} where the model has ${familyName(palette, ml)} - ${r2(c.area / (P * P))} sq studs at ${where(c.minX, c.minY, c.maxX, c.maxY)}${near >= 0 ? ` (${parts[near].name})` : ''}` });
    }
  }

  // Per group (outline / line recall / color inside each group's own area)
  const groups = new Map<string, GroupAcc>();
  const gname = (p: number) => scene.groups.find((g) => g.id === parts[p].group)?.name ?? '(ungrouped)';
  const dModel = distanceTo(modE.edge, W, H);
  const boxes = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = res.partIndex[y * W + x];
    if (p < 0) continue;
    const g = gname(p);
    const b = boxes.get(g) ?? { x0: x, y0: y, x1: x, y1: y };
    b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x); b.y1 = Math.max(b.y1, y);
    boxes.set(g, b);
    const a = groups.get(g) ?? { silI: 0, silU: 0, edgeHit: 0, edgeTot: 0, colAgree: 0, colTot: 0 };
    const i = y * W + x;
    if (refLabel[i] >= 0) { a.colTot++; if (refLabel[i] === partLabel[p]) a.colAgree++; }
    groups.set(g, a);
  }
  const grow = Math.round(0.1 * P);
  for (const [g, b] of boxes) {
    const a = groups.get(g)!;
    for (let y = Math.max(0, b.y0 - grow); y <= Math.min(H - 1, b.y1 + grow); y++) for (let x = Math.max(0, b.x0 - grow); x <= Math.min(W - 1, b.x1 + grow); x++) {
      const i = y * W + x;
      const rm = refMask.data[i], mm = modelMask.data[i];
      if (rm && mm) a.silI++;
      if (rm || mm) a.silU++;
      if (refE.edge[i]) { a.edgeTot++; if (dModel[i] <= 0.08 * P) a.edgeHit++; }
    }
  }

  const detailW = detail === null ? 0 : WEIGHT.detail;
  const score = (WEIGHT.silhouette * sil + WEIGHT.structure * struct + WEIGHT.color * color + detailW * (detail ?? 0)) /
    (WEIGHT.silhouette + WEIGHT.structure + WEIGHT.color + detailW);

  // Tiles
  const refPng = await sharp(session.path('refs', `norm_${v}.png`)).flatten({ background: { r: 236, g: 239, b: 243 } }).png().toBuffer();
  const shaded: RasterResult = { ...res, color: res.color.slice() };
  drawOutlines(shaded);
  const modelPng = await rasterToPng(shaded);
  const blend = await sharp(refPng).composite([{ input: await sharp(modelPng).ensureAlpha(0.5).png().toBuffer(), blend: 'over' }]).png().toBuffer();
  // Thicken edges for display (the sheet is scaled down ~3x).
  const thick = (e: Uint8Array) => {
    const o = new Uint8Array(N);
    const r = Math.max(1, Math.round(P / 60));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (e[y * W + x]) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H) o[yy * W + xx] = 1;
      }
    }
    return o;
  };
  const re = thick(refE.edge), me = thick(modE.edge);
  const ev = Buffer.alloc(N * 3);
  for (let i = 0; i < N; i++) {
    const g = refMask.data[i] ? 228 : 250;
    const c = re[i] && me[i] ? [0, 0, 0] : re[i] ? [225, 45, 45] : me[i] ? [45, 95, 230] : [g, g, g];
    ev[i * 3] = c[0]; ev[i * 3 + 1] = c[1]; ev[i * 3 + 2] = c[2];
  }
  const edgePng = await sharp(ev, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const lay = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    if (!re[i] && !me[i]) continue;
    const c = re[i] && me[i] ? [0, 0, 0] : re[i] ? [235, 40, 40] : [40, 95, 240];
    lay[i * 4] = c[0]; lay[i * 4 + 1] = c[1]; lay[i * 4 + 2] = c[2]; lay[i * 4 + 3] = 255;
  }
  const layer = await sharp(lay, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const tiles = [
    { png: refPng, label: `${viewLabel(v)} ref` },
    { png: modelPng, label: 'model' },
    { png: blend, label: 'overlay' },
    { png: edgePng, label: 'lines' },
  ];

  return {
    view: v, sil, struct, color, detail, score, boundary: { mean: Math.round((be.mean / P) * 100) / 100, p95: Math.round((be.p95 / P) * 100) / 100 },
    lines: lm, refLines, modelLines, spots: { missing: sm.missing, extra: sm.extra }, colorItems, silItems, groups, tiles, layer,
    refMarks: [...refLines, ...outlineMarks(refMask, frame)], modelMarks: [...modelLines, ...outlineMarks(modelMask, frame)],
  };
}

function projectedBox(res: RasterResult, grow: number): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = res.width, y0 = res.height, x1 = -1, y1 = -1;
  for (let y = 0; y < res.height; y++) for (let x = 0; x < res.width; x++) if (res.partIndex[y * res.width + x] >= 0) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0: Math.max(0, x0 - grow), y0: Math.max(0, y0 - grow), x1: Math.min(res.width - 1, x1 + grow), y1: Math.min(res.height - 1, y1 + grow) };
}

function clip(m: Mask, r: { x0: number; y0: number; x1: number; y1: number }): Mask {
  const out = new Uint8Array(m.data.length);
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) out[y * m.width + x] = m.data[y * m.width + x];
  return { width: m.width, height: m.height, data: out };
}

/** Most common part index inside the blob or within `radius` px of it. */
function nearestPart(pixels: number[], partIndex: Int32Array, w: number, h: number, radius: number): number {
  const counts = new Map<number, number>();
  const step = Math.max(1, Math.floor(pixels.length / 400));
  const r = Math.max(1, radius);
  for (let k = 0; k < pixels.length; k += step) {
    const i = pixels[k];
    const x = i % w, y = (i / w) | 0;
    for (let dy = -r; dy <= r; dy += Math.max(1, r >> 2)) for (let dx = -r; dx <= r; dx += Math.max(1, r >> 2)) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const p = partIndex[yy * w + xx];
      if (p >= 0) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  let best = -1, bc = 0;
  for (const [p, c] of counts) if (c > bc) { bc = c; best = p; }
  return best;
}
