// MCP tools for reference images, part planning, style presets and evaluation.

import fs from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import sharp from 'sharp';
import { z } from 'zod';
import { type RefView, toRefView, viewLabel } from '../core/protocol';
import type { CloseupView } from './prompts';
import { blockout } from './blockout';
import { analyzeRefs, checkPlan, loadPlan, planBox, planText, planToCommands, zBuildPlan, zCloseupView } from './plan';
import { evaluate } from './evaluate';
import { comfyConfig, comfyStatus } from './comfy';
import { hasApiKey } from './gemini';
import { type Provider, defaultProvider, fakeMode, generateImage, pickProvider } from './imagegen';
import { contactSheet } from './images';
import { type Box, Refs } from './refs';
import type { Session } from './session';
import { similarityLabel, similarityText } from './similarity';
import { DEFAULT_STYLE, listStyles, loadStyle, saveStyle } from './styles';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
const text = (t: string): Content => ({ type: 'text', text: t });
const jpeg = (b: Buffer): Content => ({ type: 'image', data: b.toString('base64'), mimeType: 'image/jpeg' });
const fail = (e: unknown) => ({ content: [text(`ERROR: ${e instanceof Error ? e.message : String(e)}`)], isError: true });

const zRefView = z.enum(['front', 'side', 'back', 'top', 'right', 'left']).describe("front, side (the model's right side, facing image-right), back, top");
const zVec3 = z.tuple([z.number(), z.number(), z.number()]);
const zModel = z.enum(['flash', 'pro']).optional().describe("Gemini only: flash = Nano Banana 2.1 (default), pro = Nano Banana Pro (real style references, ~3-4x the price)");
const zProvider = z.enum(['gemini', 'comfyui']).optional().describe('image source: comfyui = your ComfyUI server (free), gemini = Nano Banana API (paid). Default: IMAGE_PROVIDER in .env');

const zPlanPart = z.object({
  name: z.string().describe('group/bone name, e.g. Head, Torso, RightArm'),
  parent: z.string().nullable().optional(),
  pivot: zVec3.optional().describe('joint position in studs (neck, shoulder, hip...)'),
  box: z.object({ min: zVec3, max: zVec3 }).optional().describe('rough world box measured from the refs'),
  mirrorOf: z.string().optional().describe('this part is the linked mirror of another (e.g. LeftArm of RightArm)'),
  closeup: z.boolean().optional().describe('generate a close-up reference for detail'),
  notes: z.string().optional(),
});

async function imagesSheet(files: string[], labels: string[]): Promise<Buffer> {
  const tiles = await Promise.all(files.map(async (f, i) => ({ png: await sharp(f).png().toBuffer(), label: labels[i] })));
  return contactSheet(tiles, { tileHeight: 400 });
}

function notes(session: Session): string {
  const fb = session.refs.feedback.slice(-5);
  return fb.length ? `\nUser notes from the editor:\n${fb.map((f) => `  - [${f.time.slice(11, 16)}${f.view ? ` ${f.view}` : ''}] ${f.text}`).join('\n')}` : '';
}

export function registerRefsTools(server: McpServer, session: Session): void {
  const refs = () => new Refs(session);
  const check = (p?: Provider) => pickProvider(p); // throws a helpful error if the source isn't set up

  server.registerTool('image_backend', {
    title: 'Image source status',
    description: 'Which image source is used (comfyui = local GPU over the network, gemini = Nano Banana API), whether it is reachable, the GPU, and how the ComfyUI workflows were understood (prompt / reference-image / size / seed / output nodes). action "test" generates one quick image to prove the whole path works.',
    inputSchema: {
      action: z.enum(['status', 'test']),
      provider: zProvider,
      prompt: z.string().optional().describe('for test (default: a small blocky Roblox robot)'),
    },
  }, async (a) => {
    try {
      const def = defaultProvider();
      const lines = [
        `default image source: ${def ?? 'none configured'}${fakeMode() ? ' (FAKE images mode is on)' : ''}`,
        `gemini: ${hasApiKey() ? 'API key set' : 'no API key'}`,
      ];
      const cfg = comfyConfig();
      lines.push(cfg ? await comfyStatus(cfg) : 'comfyui: COMFYUI_URL not set (see docs/local-gpu.md)');
      if (a.action === 'status') return { content: [text(lines.join('\n'))] };
      const p = check(a.provider);
      const started = Date.now();
      const r = await generateImage({
        provider: p, aspectRatio: '1:1', imageSize: '1K', tag: 'backend_test', logFile: session.path('gemini-log.jsonl'),
        prompt: a.prompt ?? 'A small blocky robot built only from Roblox parts (blocks and wedges), solid plastic colors with studs, three-quarter view, on a flat pure magenta (#FF00FF) background.',
      });
      const jpg = await sharp(r.image).resize({ width: 640, height: 640, fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
      return { content: [text(`${lines.join('\n')}\n\ntest image from ${r.provider} (${r.model}) in ${((Date.now() - started) / 1000).toFixed(1)}s, $${r.costUsd.toFixed(3)}`), jpeg(jpg)] };
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool('style', {
    title: 'Style presets',
    description: 'Manage the style presets that steer the image model: list, get, save (description / avoid / palette / model), or test (generate quick 1K sample renders of a subject in the current project\'s style). Example images for a preset go in styles/<name>/ as png/jpg (up to 6 are sent as style examples).',
    inputSchema: {
      action: z.enum(['list', 'get', 'save', 'test']),
      name: z.string().optional().describe('preset name (default: the project\'s style)'),
      description: z.string().optional(),
      avoid: z.string().optional(),
      palette: z.string().optional(),
      model: z.enum(['flash', 'pro']).optional(),
      subject: z.string().optional().describe('for test: what to draw (default: the project idea)'),
      count: z.number().int().min(1).max(4).optional(),
      provider: zProvider,
    },
  }, async (a) => {
    try {
      const name = a.name ?? session.meta.style;
      if (a.action === 'list') return { content: [text(`styles: ${listStyles().join(', ') || '(none saved; the built-in default is used)'}\nproject style: ${session.meta.style}`)] };
      if (a.action === 'get') {
        const { preset, images } = loadStyle(name);
        return { content: [text(`${JSON.stringify(preset, null, 2)}\nexample images: ${images.map((i) => i.file).join(', ') || 'none'}`)] };
      }
      if (a.action === 'save') {
        const cur = loadStyle(name).preset;
        const f = saveStyle({ ...DEFAULT_STYLE, ...cur, name, ...(a.description ? { description: a.description } : {}), ...(a.avoid ? { avoid: a.avoid } : {}), ...(a.palette ? { palette: a.palette } : {}), ...(a.model ? { model: a.model } : {}) });
        return { content: [text(`saved ${f}`)] };
      }
      check(a.provider);
      if (name !== session.meta.style) { session.meta.style = name; session.saveMeta(); }
      const r = refs();
      const files = await r.styleTest(a.subject ?? (session.meta.idea || 'a small blocky robot'), a.count ?? 2, a.model, a.provider);
      return { content: [jpeg(await imagesSheet(files, files.map((_, i) => `style test ${i + 1}`))), text(`saved: ${files.join(', ')}\n${r.cost()}`)] };
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool('refs_generate', {
    title: 'Generate reference images',
    description: `Generate reference images for the open project.
  hero: N three-quarter candidates of the idea (default 3). CHECKPOINT 1 - then stop and let the user pick one (editor References panel or chat -> refs_pick).
  sheet: turnaround (front | side | back) from the picked hero, sliced into views (Gemini; the local model can't do sheets). Then refs_normalize and CHECKPOINT 2 - the user approves the views.
  view: (re)generate one view (front/side/back/top) on its own, keeping it consistent with the others; pass what to fix in extra.
  part: a close-up of ONE part on its own (nothing else of the subject): one three-quarter picture by default, made from the part cut out of the front view (Qwen-Image-2.1 edit on the local GPU). The box defaults to the build plan's close-up entry / group / part of that name. Optional views front/side/back/top add ortho pictures fitted onto the part's place in the views (then refs_measure {part} and plan_build analyze {part} give their details in world studs). Detail references only - evaluate never scores them.`,
    inputSchema: {
      kind: z.enum(['hero', 'sheet', 'view', 'part']),
      count: z.number().int().min(1).max(6).optional(),
      view: zRefView.optional(),
      part: z.string().optional(),
      notes: z.string().optional().describe('for part: what the part is / what to show (default: the plan close-up notes)'),
      box: z.object({ min: zVec3, max: zVec3 }).optional().describe('for part: world box (default from the build plan)'),
      views: z.array(zCloseupView).optional().describe('for part: which pictures (default one threequarter)'),
      method: z.enum(['prompt', 'qwen-angles']).optional().describe('for view: qwen-angles (default on the local GPU) = rotate the camera around the hero with Qwen-Image-2.1 + Multiple-Angles LoRA; prompt (default for Gemini) = describe the view to the image model'),
      extra: z.string().optional().describe('extra instructions appended to the prompt'),
      model: zModel,
      provider: zProvider,
    },
  }, async (a) => {
    try {
      check(a.provider);
      const r = refs();
      if (a.kind === 'hero') {
        if (!session.meta.idea) return fail('set the idea first: project_open {name, idea}');
        const files = await r.generateHero(a.count ?? 3, a.extra, a.model, a.provider);
        const all = session.refs.hero.candidates;
        return { content: [jpeg(await r.show('hero')), text(`hero candidates: ${all.map((c) => c.id).join(', ')} (new: ${files.length})\n${r.cost()}\nCHECKPOINT 1: ask the user which hero to use (they can click Pick in the editor's References panel). Wait for the answer; then refs_pick {hero}.`)] };
      }
      if (a.kind === 'sheet') {
        await r.generateSheet(a.extra, a.model, a.provider);
        return { content: [jpeg(await r.show('sheet')), text(`sheet sliced into front/right/back/left.\n${r.cost()}\nNext: refs_generate {kind:'view', view:'top'}, then refs_normalize.`)] };
      }
      if (a.kind === 'view') {
        if (!a.view) return fail('view is required');
        const f = await r.generateView(toRefView(a.view), a.extra, a.model, a.provider, a.method);
        return { content: [jpeg(await imagesSheet([f], [viewLabel(toRefView(a.view))])), text(`saved ${f}\n${r.cost()}\nRe-run refs_normalize after changing views.`)] };
      }
      if (!a.part) return fail('part is required');
      const plan = loadPlan(session);
      const entry = plan?.closeups.find((c) => c.name === a.part);
      const box = (a.box as Box | undefined) ?? (plan ? planBox(plan, a.part) : null);
      if (!box) return fail(`no box for "${a.part}": pass box, or name a group/part/close-up of the saved build plan`);
      const views = (a.views ?? entry?.views)?.map((v) => (v === 'side' ? 'right' : v) as CloseupView);
      const { report } = await r.generateCloseup(a.part, box, { notes: a.notes ?? entry?.notes, views, extra: a.extra, model: a.model, provider: a.provider });
      return { content: [jpeg(await r.show('part', a.part)), text(`${report}\n${r.cost()}`)] };
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool('refs_edit', {
    title: 'Edit a reference image',
    description: 'Targeted fix of an existing generated image through its conversation with the image model (keeps everything else). target: hero_N, sheet, front/side/back/top (only views generated on their own), or part:<Name>:<view> for a close-up (e.g. part:Head:front; it is re-fitted automatically). Re-run refs_normalize afterwards if a main view changed.',
    inputSchema: { target: z.string(), instruction: z.string(), provider: zProvider },
  }, async (a) => {
    try {
      check(a.provider);
      const r = refs();
      const f = await r.edit(a.target, a.instruction, a.provider);
      return { content: [jpeg(await imagesSheet([f], [a.target])), text(`updated ${f} (previous version kept as .prev.png)\n${r.cost()}`)] };
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool('refs_flip', {
    title: 'Mirror a view',
    description: 'Mirror a generated view left-to-right. Use it when a side view faces the wrong way (the RIGHT view must face image-right, the LEFT view image-left) - exact for left/right-symmetric subjects. Free; re-run refs_normalize afterwards.',
    inputSchema: { view: zRefView },
  }, async (a) => {
    try {
      const f = await refs().flip(toRefView(a.view));
      return { content: [jpeg(await imagesSheet([f], [`${a.view} (mirrored)`])), text(`mirrored ${f} (previous kept as .prev.png). Re-run refs_normalize.`)] };
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool('refs_pick', {
    title: 'Record a checkpoint decision',
    description: 'Record the user\'s decision when they give it in chat: the hero they picked, and/or that they approve the views. (They can also do this with buttons in the editor.)',
    inputSchema: { hero: z.string().optional().describe('e.g. hero_2'), approve_views: z.boolean().optional() },
  }, async (a) => {
    try {
      const r = refs();
      if (a.hero) r.pickHero(a.hero);
      if (a.approve_views) r.approveViews();
      const c = session.meta.checkpoints;
      return { content: [text(`hero: ${c.hero ?? 'not picked'} | views approved: ${c.viewsApproved}${notes(session)}`)] };
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool('refs_normalize', {
    title: 'Normalize reference views',
    description: 'Cut the subject out of each view (flat key-color background), scale every view to the same studs scale (feet on y=0, centred on the symmetry axis), check cross-view consistency (opposite views must be mirror-image silhouettes) and extract the color palette. Returns the report, the normalized views with a stud grid, and a segmentation overlay to sanity-check.',
    inputSchema: {
      heightStuds: z.number().positive().optional().describe('model height in studs (default: project setting)'),
      tolerance: z.number().min(5).max(80).optional().describe('key-color tolerance (Lab dE, default 28); raise if background specks remain, lower if parts of the subject vanish'),
      axis: z.record(z.string(), z.number()).optional().describe('override the centre column (source pixels) per view, e.g. {"front": 512}'),
    },
  }, async (a) => {
    try {
      const r = refs();
      const { report, overlay } = await r.normalize({ heightStuds: a.heightStuds, tolerance: a.tolerance, axis: a.axis as never });
      return { content: [text(report + notes(session)), jpeg(await r.show('normalized')), jpeg(overlay)] };
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool('refs_measure', {
    title: 'Measure a reference view',
    description: `Exact numbers from a normalized reference view, in world studs (axes named per view: front/back = x,y; right/left = z,y; top = x,z).
  profile: silhouette extents along the horizontal axis for each band of the vertical axis (default 0.25 studs); identical bands are merged. Use h/v to limit to a region (e.g. one arm).
  extents: bounding box of the subject inside the h/v ranges.
  colors: extents plus the dominant colors inside the ranges (nearest palette entry noted).
  lines: the visible lines INSIDE the outline (seams, plate edges, belt / knee bands) - use these for proportions: where the chest ends, where the legs start, helmet face plate width...
  spots: small details (eye slits, rivets, buttons) with centre and size - place small parts there.`,
    inputSchema: {
      view: zRefView,
      mode: z.enum(['profile', 'extents', 'colors', 'lines', 'spots']),
      h: z.tuple([z.number(), z.number()]).optional().describe('range along the view\'s horizontal world axis'),
      v: z.tuple([z.number(), z.number()]).optional().describe('range along the view\'s vertical world axis'),
      step: z.number().min(0.05).max(2).optional(),
      part: z.string().optional().describe('measure this part\'s close-up instead of the main view (same world studs, much finer)'),
    },
  }, async (a) => {
    try {
      return { content: [text(await refs().measure(toRefView(a.view), a.mode, { h: a.h, v: a.v, step: a.step, part: a.part }))] };
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool('refs_show', {
    title: 'Show reference images',
    description: 'Look at reference images: hero candidates, the sheet, raw views, normalized views (with stud grid in world coordinates), the segmentation overlay, or a part close-up.',
    inputSchema: { what: z.enum(['hero', 'sheet', 'views', 'normalized', 'overlay', 'part']), part: z.string().optional() },
  }, async (a) => {
    try {
      return { content: [jpeg(await refs().show(a.what, a.part))] };
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool('parts_plan', {
    title: 'Plan the part breakdown',
    description: 'Write or read the part breakdown (parts/parts.json): one entry per group/bone with parent, pivot, rough box, mirror link, whether it needs a close-up reference, and notes. With apply_groups, also creates the groups (pivots, parents, linked mirrors) in the model so building can start.',
    inputSchema: {
      parts: z.array(zPlanPart).optional(),
      apply_groups: z.boolean().optional(),
    },
  }, async (a) => {
    try {
      const file = session.path('parts', 'parts.json');
      if (a.parts) fs.writeFileSync(file, JSON.stringify(a.parts, null, 2));
      if (!fs.existsSync(file)) return { content: [text('no part plan yet')] };
      const plan = JSON.parse(fs.readFileSync(file, 'utf8')) as z.infer<typeof zPlanPart>[];
      let applied = '';
      if (a.apply_groups) {
        const ops: unknown[] = [];
        for (const p of plan.filter((x) => !x.mirrorOf)) ops.push({ op: 'group', name: p.name, ...(p.pivot ? { pivot: p.pivot } : {}) });
        for (const p of plan.filter((x) => !x.mirrorOf && x.parent)) ops.push({ op: 'group', name: p.name, parent: p.parent });
        for (const p of plan.filter((x) => x.mirrorOf)) ops.push({ op: 'mirror_group', source: p.mirrorOf, name: p.name });
        const existing = new Set(session.scene.groups.map((g) => g.name));
        const filtered = ops.filter((o) => !((o as { op: string }).op === 'mirror_group' && existing.has((o as { name: string }).name)));
        const r = session.apply(filtered as never, 'parts plan groups');
        applied = `\ngroups created/updated at rev ${r.rev}`;
      }
      const fmt = (v?: number[]) => (v ? v.join(',') : '-');
      return { content: [text(`part plan (${file}):\n${plan.map((p) => `  ${p.name} | parent ${p.parent ?? '-'} | pivot ${fmt(p.pivot)} | box ${p.box ? `${fmt(p.box.min)}..${fmt(p.box.max)}` : '-'}${p.mirrorOf ? ` | mirror of ${p.mirrorOf}` : ''}${p.closeup ? ' | close-up' : ''}${p.notes ? ` | ${p.notes}` : ''}`).join('\n')}${applied}`)] };
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool('plan_build', {
    title: 'Plan the build from the references',
    description: `The build plan, written BEFORE building and built in one go. Follow the project's similarity level (project_open shows it; the user sets it in the editor).
  analyze: reference analysis for the plan - per view the outline bands, the lines inside the outline (H = heights, V = widths), the small details (S), and an annotated sheet with every H/V/S numbered on the references. With part: the same for that part's close-ups (finer, detail only).
  save: store the plan (checked for consistency and against the similarity level). landmarks = the key heights/widths you read off the analysis (chest_bottom y 2.76 ...); groups = bones with pivots, limbs on one side only plus mirrorOf groups for the other side; parts = boxes in world studs with shape/color (mirror: true gives a centred group's side part a linked twin); details = small parts attached to a face (eye slits, rivets), mirror: true for pairs. Nothing symmetric is listed twice. differences = the deliberate differences from the references (the similarity level says how many). closeups = parts to get close-up references of (the part alone, for detail).
  get: show the saved plan.
  build: build the model from the saved plan (replace: true clears the current parts first). Then evaluate checks the landmarks too.`,
    inputSchema: {
      action: z.enum(['analyze', 'save', 'get', 'build']),
      plan: z.union([zBuildPlan, z.string()]).optional().describe('for save'),
      views: z.array(zRefView).optional().describe('for analyze; default front, side, back'),
      part: z.string().optional().describe('for analyze: analyze this part\'s close-ups instead of the main views'),
      replace: z.boolean().optional().describe('for build: clear the current model first (default true)'),
    },
  }, async (a) => {
    try {
      if (a.action === 'analyze') {
        const { text: t, image } = await analyzeRefs(session, refs(), a.views?.map(toRefView) ?? ['front', 'right', 'back'], a.part);
        return { content: [text(`similarity: ${similarityText(session.similarity)}\n${t}`), jpeg(image)] };
      }
      if (a.action === 'save') {
        if (!a.plan) return fail('pass plan');
        const plan = zBuildPlan.parse(typeof a.plan === 'string' ? JSON.parse(a.plan) : a.plan);
        const { errors, warnings } = checkPlan(plan, session.similarity);
        if (errors.length) return fail(`plan not saved:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
        fs.writeFileSync(session.path('parts', 'plan.json'), JSON.stringify(plan, null, 2));
        session.emit('change');
        const have = new Set(refs().closeupNames());
        const todo = plan.closeups.filter((c) => !have.has(c.name));
        const next = todo.length
          ? `\nNext: close-ups (detail only) - ${todo.map((c) => `refs_generate {kind:'part', part:'${c.name}'}`).join(', ')}; then plan_build {action:'analyze', part} for each, add the details they show, save again, build.`
          : '\nNext: plan_build {action:\'build\'}.';
        return { content: [text(`plan saved (${session.path('parts', 'plan.json')}) - similarity ${similarityLabel(session.similarity)}\n${planText(plan)}${warnings.length ? `\nwarnings:\n${warnings.map((w) => `  - ${w}`).join('\n')}` : ''}${next}`)] };
      }
      const plan = loadPlan(session);
      if (!plan) return fail('no plan yet: plan_build {action:"analyze"}, then {action:"save", plan}');
      if (a.action === 'get') return { content: [text(planText(plan))] };
      const ops = planToCommands(plan, session.scene.groups.map((g) => g.name), a.replace !== false);
      const r = session.apply(ops, 'build from plan');
      const lintsText = r.lints.length ? `\nchecks:\n${r.lints.map((l) => `  - ${l.kind}: ${l.message}`).join('\n')}` : '\nchecks: none';
      return { content: [text(`built from the plan at rev ${r.rev}: ${r.created.length} parts (${session.scene.parts.filter((p) => p.mirrorOf).length} of them mirrored automatically)${lintsText}\nNext: evaluate.`)] };
    } catch (e) {
      return fail(e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : e);
    }
  });

  server.registerTool('refs_blockout', {
    title: 'Propose a blockout from the silhouettes',
    description: 'Carve a voxel volume from the normalized front, right and top silhouettes inside a box (a planned part\'s box, or any box), cover it with a few blocks and return them as box commands colored from the palette. A starting point: review, adjust, then apply with scene_apply (or apply:true). Works best per part (one arm, the head), not the whole model.',
    inputSchema: {
      part: z.string().optional().describe('name of a part in parts_plan (uses its box; blocks join that group)'),
      box: z.object({ min: zVec3, max: zVec3 }).optional(),
      res: z.number().min(0.05).max(1).optional().describe('voxel size in studs (default 0.25)'),
      maxBlocks: z.number().int().min(1).max(40).optional(),
      apply: z.boolean().optional().describe('apply the proposed commands right away'),
    },
  }, async (a) => {
    try {
      let box = a.box as { min: [number, number, number]; max: [number, number, number] } | undefined;
      let group: string | undefined;
      if (a.part) {
        const file = session.path('parts', 'parts.json');
        const plan = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as z.infer<typeof zPlanPart>[]) : [];
        const entry = plan.find((p) => p.name === a.part);
        if (!entry?.box && !box) return fail(`part "${a.part}" has no box in parts_plan; pass box`);
        box ??= entry!.box as typeof box;
        if (session.scene.groups.some((g) => g.name === a.part)) group = a.part;
      }
      if (!box) return fail('pass part or box');
      const { commands, summary } = await blockout(session, refs(), { box, name: a.part ?? 'Block', group, res: a.res, maxBlocks: a.maxBlocks });
      let applied = '';
      if (a.apply) {
        const r = session.apply(commands, `blockout ${a.part ?? ''}`.trim());
        applied = `\napplied at rev ${r.rev}${r.lints.length ? `; lints: ${r.lints.map((l) => l.kind).join(', ')}` : ''}`;
      }
      return { content: [text(`${summary}${applied}\n${JSON.stringify(commands)}`)] };
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool('evaluate', {
    title: 'Compare the model with the references',
    description: 'Likeness check: render the model in each normalized reference frame and compare four things - outline (silhouette IoU), structure (the inner lines: seams, plate edges, belt/knee bands - reported as missing/extra line segments in studs), color (reference mapped to the model palette vs part colors) and details (eye slits, rivets vs small parts). Gives a score per view and per body part, a list of concrete fixes, and a sheet with reference | model | overlay | lines per view plus the hero next to the model 3/4. Logs an iteration (unless group is set or log=false) and says when progress has stalled.',
    inputSchema: {
      views: z.array(zRefView).optional().describe('default: all normalized views (front, side, back, top)'),
      group: z.string().optional().describe('only this group, compared inside its own area'),
      note: z.string().optional().describe('what changed this round'),
      log: z.boolean().optional(),
    },
  }, async (a) => {
    try {
      const { text: t, image } = await evaluate(session, refs(), { views: a.views?.map(toRefView), group: a.group, note: a.note, log: a.log });
      return { content: [text(t + notes(session)), jpeg(image)] };
    } catch (e) {
      return fail(e);
    }
  });
}
