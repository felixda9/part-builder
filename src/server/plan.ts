// Build plan: written from the reference analysis before anything is built, then built in one
// go. Everything symmetric is built once: limbs as linked mirror groups, side details on centred
// parts as linked twins (mirror: true).

import fs from 'node:fs';
import sharp from 'sharp';
import { z } from 'zod';
import { type Bevel, bevelErrors, bevelPieces } from '../core/bevel';
import { applyBatch, type Command } from '../core/commands';
import { buriedParts } from '../core/lints';
import type { AxisDir, Vec3 } from '../core/math';
import type { AnalysisData, RefView, Similarity } from '../core/protocol';
import { REF_VIEWS, viewLabel } from '../core/protocol';
import { type OrthoFrame, type OrthoView, viewAxes } from '../core/raster';
import { emptyScene, zColor, zMaterial, zShape, zSurface, zVec3 } from '../core/scene';
import { gridSheet } from './images';
import { type LineSeg, type Spot, extractLines, findDarkSpots, findSpots, imageEdges, interior, luminanceOf, mergeSpots } from './likeness';
import { type Box, type Refs, loadMask } from './refs';
import type { Session } from './session';
import { SIMILARITY_RULES, similarityLabel } from './similarity';

const zAxisDir = z.enum(['+x', '-x', '+y', '-y', '+z', '-z']);
const zColorRef = z.union([zColor, z.string().regex(/^p\d+$/)]);
const zRefView = z.enum(['front', 'side', 'back', 'top', 'right', 'left']).describe('front, side (= right), back, top');

export const zPlanLandmark = z.object({
  name: z.string().describe('e.g. chest_bottom, knee_top, helmet_brim, face_plate_half_width'),
  view: zRefView,
  axis: z.enum(['x', 'y', 'z']),
  value: z.number(),
  note: z.string().optional(),
});
export const zPlanGroup = z.object({
  name: z.string(),
  parent: z.string().nullable().optional(),
  pivot: zVec3,
  mirrorOf: z.string().optional().describe('this group is the linked mirror of another (LeftArm of RightArm) - its parts are generated, list none'),
});
export const zPlanBevel = z.object({
  ends: z.array(zAxisDir).optional().describe("faces that slope off instead of ending in a flat cut: ['+z'] the back of a head, ['-z','+z'] both ends of a body"),
  size: z.number().describe('how far the end slopes reach in from the rim (studs); half the width makes a ridge'),
  depth: z.number().optional().describe('how far the end slopes reach along the part (default = size: 45 degrees; deeper = more pointed)'),
  sizes: z.record(z.string(), z.number()).optional().describe("a different size for one end, same slope angle, e.g. {'-z': 0.15} for a face that needs less rounding than the back of the head"),
  rim: z.array(zAxisDir).optional().describe("which sides of the end slope (default all four); leave out a side buried in another part, e.g. -y where the neck joins"),
  rims: z.record(z.string(), z.array(zAxisDir)).optional().describe("a different rim for one end, e.g. {'-z': ['+x','-x','-y']}: the chest end stays full height where the head sits on it"),
  edges: z.array(z.string()).optional().describe("long edges cut off along the whole part, e.g. ['+x+y','-x+y'] the two top edges of a body"),
  edgeSize: z.number().optional().describe('width of the long-edge slopes (default size/2, never more than size)'),
});
export const zPlanPart = z.object({
  name: z.string(),
  group: z.string(),
  shape: zShape.optional().describe('Block (default), Wedge, CornerWedge'),
  min: zVec3,
  max: zVec3,
  tall: zAxisDir.optional().describe('Wedge: side that is the full rectangle'),
  flat: zAxisDir.optional().describe('Wedge/CornerWedge: face it rests on (default -y)'),
  apex: z.string().optional().describe("CornerWedge: corner holding the peak, e.g. '+x+y-z'"),
  color: zColorRef,
  material: zMaterial.optional(),
  surfaces: zSurface.optional(),
  mirror: z.boolean().optional().describe('also create a linked mirror twin on the other side (side details of centred groups)'),
  note: z.string().optional().describe('which landmarks / reference lines this part follows'),
  rotate: z.object({ axis: z.enum(['x', 'y', 'z']), degrees: z.number(), pivot: zVec3.optional().describe('default: the part centre; give the same pivot to parts that turn together (the halves of an ear)') }).optional()
    .describe('tilt the part after placing the box (a raised tail segment, ears leaning out); the twin mirrors it'),
  bevel: zPlanBevel.optional().describe('Block only: round the part off with slopes - the box becomes a core plus wedges and corner wedges (never stepped boxes)'),
});
export const zPlanDetail = z.object({
  name: z.string(),
  to: z.string().describe('part it sits on'),
  face: zAxisDir,
  size: zVec3,
  offset: zVec3.optional().describe('from the centre of that face'),
  sink: z.number().optional(),
  color: zColorRef,
  material: zMaterial.optional(),
  mirror: z.boolean().optional(),
  note: z.string().optional(),
});
export const zPlanDifference = z.object({
  what: z.string().describe('what is deliberately different from the references, e.g. "helmet crest left out"'),
  why: z.string().optional().describe('why it makes a better part model'),
  where: z.string().optional().describe('group or part it concerns'),
});
export const zCloseupView = z.enum(['front', 'side', 'back', 'top', 'right', 'threequarter']);
export const zPlanCloseup = z.object({
  name: z.string().describe('a group or part of this plan (its box is used), or any name with a box'),
  notes: z.string().optional().describe('what it is and what to show, e.g. "helmet with eye slits and side rivets"'),
  box: z.object({ min: zVec3, max: zVec3 }).optional().describe('world box; default = the group/part box from this plan'),
  views: z.array(zCloseupView).optional().describe('default: one three-quarter picture of the part alone; front/side/back/top add ortho pictures fitted to the views'),
});
export const zBuildPlan = z.object({
  summary: z.string().describe('what it is, overall proportions, style notes, what is mirrored'),
  landmarks: z.array(zPlanLandmark),
  palette: z.array(zColor).optional(),
  groups: z.array(zPlanGroup),
  parts: z.array(zPlanPart),
  details: z.array(zPlanDetail).default([]),
  differences: z.array(zPlanDifference).default([]).describe('deliberate differences from the references; how many depends on the similarity level'),
  closeups: z.array(zPlanCloseup).default([]).describe('close-up references to generate: the part alone, for detail only'),
});
export type BuildPlan = z.infer<typeof zBuildPlan>;
export type PlanPart = z.infer<typeof zPlanPart>;

const planFile = (s: Session) => s.path('parts', 'plan.json');

export function loadPlan(s: Session): BuildPlan | null {
  const f = planFile(s);
  return fs.existsSync(f) ? zBuildPlan.parse(JSON.parse(fs.readFileSync(f, 'utf8'))) : null;
}

/** World box of a close-up target: its own box, else the union of a plan group's (or part's) boxes. */
export function planBox(p: BuildPlan, name: string): Box | null {
  const own = p.closeups.find((c) => c.name === name)?.box;
  if (own) return own as Box;
  const g = p.groups.find((x) => x.name === name);
  let boxes: { min: number[]; max: number[] }[] = [];
  const flip = (b: { min: number[]; max: number[] }) => ({ min: [-b.max[0], b.min[1], b.min[2]], max: [-b.min[0], b.max[1], b.max[2]] });
  if (g) {
    const own = p.parts.filter((x) => x.group === (g.mirrorOf ?? g.name));
    // Linked twins (mirror: true) are part of the group too.
    boxes = [...own, ...own.filter((x) => x.mirror).map(flip)];
    if (g.mirrorOf) boxes = boxes.map(flip);
  } else {
    const part = p.parts.find((x) => x.name === name);
    if (part) boxes = [part];
  }
  if (!boxes.length) return null;
  const lo = [0, 1, 2].map((i) => Math.min(...boxes.flatMap((b) => [b.min[i], b.max[i]])));
  const hi = [0, 1, 2].map((i) => Math.max(...boxes.flatMap((b) => [b.min[i], b.max[i]])));
  return { min: lo as Box['min'], max: hi as Box['max'] };
}

/** Consistency checks before saving. Errors block, warnings are reported. */
export function checkPlan(p: BuildPlan, similarity?: Similarity): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  const groups = new Map(p.groups.map((g) => [g.name, g]));
  const mirrorGroups = new Set(p.groups.filter((g) => g.mirrorOf).map((g) => g.name));
  for (const g of p.groups) {
    if (g.parent && !groups.has(g.parent)) errors.push(`group ${g.name}: parent ${g.parent} is not in the plan`);
    if (g.mirrorOf && !groups.has(g.mirrorOf)) errors.push(`group ${g.name}: mirrorOf ${g.mirrorOf} is not in the plan`);
    if (g.mirrorOf && Math.abs(g.pivot[0] + groups.get(g.mirrorOf)!.pivot[0]) > 0.01) warnings.push(`group ${g.name}: pivot x should be ${-groups.get(g.mirrorOf)!.pivot[0]} (mirror of ${g.mirrorOf}); the build uses the mirrored pivot`);
  }
  const names = new Set<string>();
  for (const part of [...p.parts, ...p.details]) {
    if (names.has(part.name)) errors.push(`duplicate name ${part.name}`);
    names.add(part.name);
  }
  for (const part of p.parts) {
    if (!groups.has(part.group)) errors.push(`part ${part.name}: group ${part.group} is not in the plan`);
    if (mirrorGroups.has(part.group)) errors.push(`part ${part.name}: ${part.group} is a mirror group - its parts are generated from ${groups.get(part.group)!.mirrorOf}; build the source side only`);
    if (part.shape === 'Wedge' && !part.tall) errors.push(`part ${part.name}: a Wedge needs "tall"`);
    if (part.shape === 'CornerWedge' && !part.apex) errors.push(`part ${part.name}: a CornerWedge needs "apex"`);
    if (part.bevel) {
      if (part.shape && part.shape !== 'Block') errors.push(`part ${part.name}: bevel works on Block parts only`);
      else {
        for (const e of bevelErrors(part.min as Vec3, part.max as Vec3, part.bevel as Bevel, isCentred(part))) errors.push(`part ${part.name}: ${e}`);
        for (const piece of expandPart(part).slice(1)) {
          if (names.has(piece.name)) errors.push(`duplicate name ${piece.name} (bevel piece of ${part.name})`);
          names.add(piece.name);
        }
      }
    }
    for (let i = 0; i < 3; i++) if (Math.abs(part.max[i] - part.min[i]) < 0.05 - 1e-6) errors.push(`part ${part.name}: thinner than 0.05 on ${'xyz'[i]}`);
    // The build snaps boxes to the 0.05 grid: an off-grid number moves (an eye planned at 0.38
    // was built at 0.40 and ended up sharing a face with its glint - flicker).
    for (const [label, v] of [['min', part.min], ['max', part.max]] as const) {
      for (let i = 0; i < 3; i++) if (Math.abs(v[i] / 0.05 - Math.round(v[i] / 0.05)) > 1e-6) errors.push(`part ${part.name}: ${label} ${'xyz'[i]} ${v[i]} is not on the 0.05 snap grid (it would be built at ${(Math.round(v[i] / 0.05) * 0.05).toFixed(2)}) - use multiples of 0.05`);
    }
    const cx = (part.min[0] + part.max[0]) / 2;
    if (!part.mirror && !groups.get(part.group)?.mirrorOf && !p.groups.some((g) => g.mirrorOf === part.group) && Math.abs(cx) > 0.05 && /right|left/i.test(part.name)) {
      warnings.push(`part ${part.name} is off-centre in a centred group without mirror: true - its other side won't exist`);
    }
  }
  for (const d of p.details) if (!p.parts.some((q) => q.name === d.to) && !p.details.some((q) => q.name === d.to)) errors.push(`detail ${d.name}: part ${d.to} is not in the plan`);
  for (const c of p.closeups) if (!planBox(p, c.name)) errors.push(`close-up ${c.name}: not a group or part of the plan - give it a box`);
  if (!p.landmarks.length && similarity !== 'free') warnings.push('no landmarks: list the key heights/widths you measured so evaluate can check them');
  const want = similarity ? SIMILARITY_RULES[similarity].differences : null;
  if (want) {
    const n = p.differences.length, label = similarityLabel(similarity!);
    if (n < want[0]) warnings.push(`similarity is ${label}: plan ${want[0]}${want[1] > want[0] ? `-${want[1]}` : ''} deliberate differences from the references (differences: [...]); you have ${n}`);
    else if (n > want[1]) warnings.push(`similarity is ${label}: ${want[1] === 0 ? 'no deliberate differences expected - match the references' : `at most ~${want[1]} deliberate differences expected`}; you have ${n}`);
  }
  return { errors, warnings };
}

const isCentred = (part: PlanPart) => !part.mirror && Math.abs((part.min[0] + part.max[0]) / 2) < 0.05;

interface PlanPiece { name: string; shape: 'Block' | 'Wedge' | 'CornerWedge'; min: Vec3; max: Vec3; tall?: AxisDir; flat?: AxisDir; apex?: string; mirror: boolean }

/** A plan part as the parts it builds: itself, or its core + slopes when bevelled. */
export function expandPart(part: PlanPart): PlanPiece[] {
  if (part.bevel && (!part.shape || part.shape === 'Block')) {
    return bevelPieces(part.name, part.min as Vec3, part.max as Vec3, part.bevel as Bevel, { centred: isCentred(part), mirror: !!part.mirror });
  }
  return [{ name: part.name, shape: part.shape ?? 'Block', min: part.min as Vec3, max: part.max as Vec3, tall: part.tall, flat: part.flat, apex: part.apex, mirror: !!part.mirror }];
}

/**
 * Bevel pieces that end up completely inside another part (the end of a tail buried in the
 * body, a thigh corner inside the torso) are left out - they add parts nobody sees.
 */
function dropBuriedPieces(ops: Command[], twins: string[], pieceNames: Set<string>): void {
  if (!pieceNames.size) return;
  const build = ops.filter((c) => c.op !== 'delete' && c.op !== 'delete_group');
  let scene;
  try { scene = applyBatch(emptyScene(), [...build, ...(twins.length ? [{ op: 'mirror', parts: twins } as Command] : [])]).scene; } catch { return; }
  const buried = buriedParts(scene.parts, (part) => pieceNames.has(part.name));
  const drop = new Set([...buried].map((i) => scene.parts[i].name));
  if (!drop.size) return;
  const named = (c: Command) => (c as { name?: string }).name;
  for (let i = ops.length - 1; i >= 0; i--) {
    const c = ops[i];
    if ((c.op === 'box' || c.op === 'wedge' || c.op === 'cornerwedge') && drop.has(named(c)!)) ops.splice(i, 1);
    else if (c.op === 'rotate') {
      const list = (Array.isArray(c.parts) ? c.parts : [c.parts]).filter((n) => !drop.has(n));
      if (!list.length) ops.splice(i, 1);
      else (c as { parts: string | string[] }).parts = list;
    }
  }
  for (let i = twins.length - 1; i >= 0; i--) if (drop.has(twins[i])) twins.splice(i, 1);
}

/** Commands that build the plan (optionally replacing the current model). */
export function planToCommands(p: BuildPlan, existingGroups: string[], replace: boolean): Command[] {
  const ops: Command[] = [];
  if (p.palette?.length) ops.push({ op: 'palette', colors: p.palette });
  const planGroups = new Set(p.groups.map((g) => g.name));
  if (replace) {
    ops.push({ op: 'delete', parts: '*' } as Command);
    for (const g of existingGroups) if (!planGroups.has(g)) ops.push({ op: 'delete_group', name: g, deleteParts: true } as Command);
  }
  const sources = p.groups.filter((g) => !g.mirrorOf);
  for (const g of sources) ops.push({ op: 'group', name: g.name, pivot: g.pivot } as Command);
  for (const g of sources) ops.push({ op: 'group', name: g.name, parent: g.parent ?? null } as Command);
  for (const g of p.groups.filter((x) => x.mirrorOf)) {
    if (!existingGroups.includes(g.name) || replace) {
      if (existingGroups.includes(g.name)) ops.push({ op: 'delete_group', name: g.name, deleteParts: true } as Command);
      ops.push({ op: 'mirror_group', source: g.mirrorOf!, name: g.name } as Command);
    }
  }
  const twins: string[] = [];
  const turns: Command[] = [];
  for (const part of p.parts) {
    const look = { color: part.color, ...(part.material ? { material: part.material } : {}), ...(part.surfaces ? { surfaces: part.surfaces } : {}), group: part.group };
    const pieces = expandPart(part);
    for (const x of pieces) {
      if (x.shape === 'Block') ops.push({ op: 'box', name: x.name, min: x.min, max: x.max, ...look } as Command);
      else if (x.shape === 'Wedge') ops.push({ op: 'wedge', name: x.name, min: x.min, max: x.max, tall: x.tall!, ...(x.flat ? { flat: x.flat } : {}), ...look } as Command);
      else ops.push({ op: 'cornerwedge', name: x.name, min: x.min, max: x.max, apex: x.apex!, ...(x.flat ? { flat: x.flat } : {}), ...look } as Command);
      if (x.mirror) twins.push(x.name);
    }
    if (part.rotate) {
      // All pieces of a bevelled part turn together around the plan box centre.
      const pivot = part.rotate.pivot ?? (pieces.length > 1 ? [0, 1, 2].map((i) => (part.min[i] + part.max[i]) / 2) : undefined);
      turns.push({ op: 'rotate', parts: pieces.length > 1 ? pieces.map((x) => x.name) : part.name, axis: part.rotate.axis, degrees: part.rotate.degrees, ...(pivot ? { pivot } : {}) } as Command);
    }
  }
  ops.push(...turns);
  dropBuriedPieces(ops, twins, new Set(p.parts.flatMap((x) => expandPart(x).slice(1).map((piece) => piece.name))));
  if (twins.length) ops.push({ op: 'mirror', parts: twins } as Command);
  for (const d of p.details) {
    ops.push({ op: 'attach', name: d.name, to: d.to, face: d.face, size: d.size, ...(d.offset ? { offset: d.offset } : {}), ...(d.sink !== undefined ? { sink: d.sink } : {}), color: d.color, ...(d.material ? { material: d.material } : {}) } as Command);
  }
  const dTwins = p.details.filter((x) => x.mirror).map((x) => x.name);
  if (dTwins.length) ops.push({ op: 'mirror', parts: dTwins } as Command);
  return ops;
}

export function planText(p: BuildPlan): string {
  const f = (v: number[]) => v.map((x) => +x.toFixed(2)).join(',');
  return [
    `PLAN: ${p.summary}`,
    `landmarks: ${p.landmarks.map((l) => `${l.name} ${l.axis}=${l.value} (${l.view})`).join(' | ')}`,
    `bones: ${p.groups.map((g) => `${g.name}${g.mirrorOf ? ` = mirror of ${g.mirrorOf}` : ''}${g.parent ? ` <- ${g.parent}` : ' (root)'} @${f(g.pivot)}`).join(' | ')}`,
    `parts (${p.parts.length}${p.parts.some((x) => x.mirror) ? `, ${p.parts.filter((x) => x.mirror).length} with linked twins` : ''}):`,
    ...p.parts.map((x) => `  ${x.name} [${x.group}] ${x.shape ?? 'Block'} ${f(x.min)}..${f(x.max)} ${x.color}${x.mirror ? ' +twin' : ''}${x.bevel ? ` bevel${x.bevel.ends?.length ? ` ends ${x.bevel.ends.join(',')} ${x.bevel.size}` : ''}${x.bevel.edges?.length ? ` edges ${x.bevel.edges.join(',')}` : ''} (${expandPart(x).length} parts)` : ''}${x.note ? ` - ${x.note}` : ''}`),
    `details (${p.details.length}): ${p.details.map((d) => `${d.name} on ${d.to} ${d.face}${d.mirror ? ' +twin' : ''}`).join(', ') || '-'}`,
    ...(p.differences.length ? [`deliberate differences: ${p.differences.map((d) => `${d.what}${d.where ? ` [${d.where}]` : ''}${d.why ? ` (${d.why})` : ''}`).join(' | ')}`] : []),
    ...(p.closeups.length ? [`close-ups: ${p.closeups.map((c) => `${c.name}${c.notes ? ` (${c.notes})` : ''}`).join(', ')}`] : []),
  ].join('\n');
}

// ------------------------------------------------------------------ reference analysis

/** Lines and spots of the normalized views - or of one part's close-ups (part), same world studs. */
export async function analyzeRefs(session: Session, refs: Refs, views: RefView[], part?: string): Promise<{ text: string; image: Buffer }> {
  const text: string[] = [part
    ? `CLOSE-UP ANALYSIS of ${part} - detail reference, world studs (fitted onto the views). Use it for which details exist and where; outline and proportions come from the main views.`
    : 'REFERENCE ANALYSIS - world studs. Model faces -z; its right side is +x; feet at y=0.'];
  const tiles: { png: Buffer; label: string }[] = [];
  const saved: AnalysisData['views'] = [];
  for (const v of views) {
    const src = refs.source(v, part);
    if (!src) { if (part) text.push(`\n${viewLabel(v)}: no fitted close-up`); continue; }
    const frame: OrthoFrame = { ...src.frame, view: v as OrthoView };
    const P = frame.ppu;
    const mask = await loadMask(src.mask);
    const { data, info } = await sharp(src.norm).raw().toBuffer({ resolveWithObject: true });
    const L = luminanceOf(data, frame.width, frame.height, info.channels);
    const E = imageEdges(L, interior(mask, Math.round(0.06 * P)), frame.width, frame.height);
    const lines = extractLines(E, frame);
    const spots = mergeSpots(findSpots(E, L, frame), findDarkSpots(L, interior(mask, Math.round(0.05 * P)), frame));
    const hs = lines.filter((l) => l.orient === 'h').sort((a, b) => b.pos - a.pos);
    const vs = lines.filter((l) => l.orient === 'v').sort((a, b) => a.pos - b.pos);
    const ax = viewAxes(frame.view);
    const g = (x: number) => x.toFixed(2);
    text.push(`\n${src.label.toUpperCase()} (horizontal axis ${ax.h.axis}, vertical ${ax.v.axis})`);
    text.push(await refs.measure(v, 'profile', { step: part ? 0.1 : 0.25, part }));
    const heights = hs.map((l, i) => `H${i + 1} ${ax.v.axis}${g(l.pos)} [${ax.h.axis} ${g(l.from)}..${g(l.to)}]`);
    const widths = vs.map((l, i) => `V${i + 1} ${ax.h.axis}${g(l.pos)} [${ax.v.axis} ${g(l.from)}..${g(l.to)}]`);
    const details = spots.map((s, i) => `S${i + 1} ${s.dark ? 'hole' : 'bump'} ${g(s.sizeH)}x${g(s.sizeV)} @${ax.h.axis}${g(s.h)},${ax.v.axis}${g(s.v)}`);
    text.push(`lines across (heights): ${heights.join(' | ') || '-'}`);
    text.push(`lines down (widths): ${widths.join(' | ') || '-'}`);
    text.push(`details: ${details.join(' | ') || '-'}`);
    const png = await annotate(src.norm, frame, hs, vs, spots);
    tiles.push({ png, label: `${src.label}: H/V lines, S details` });
    if (!part) {
      // Kept for the editor's Review screen.
      fs.mkdirSync(session.path('refs', 'analysis'), { recursive: true });
      fs.writeFileSync(session.path('refs', 'analysis', `${v}.png`), png);
      saved.push({ view: v, label: viewLabel(v), image: `refs/analysis/${v}.png`, heights, widths, details });
    }
  }
  if (!tiles.length) throw new Error(part ? `no fitted close-ups of "${part}" (refs_generate {kind:'part', part:'${part}'})` : 'no normalized views (refs_normalize)');
  if (!part) {
    session.refs.analysis = { time: new Date().toISOString(), views: saved };
    session.saveRefs();
    session.emit('change');
  }
  if (session.refs.palette.length && !part) text.push(`\nreference palette: ${session.refs.palette.join(' ')}`);
  return { text: text.join('\n'), image: await gridSheet([tiles], { tileHeight: 620 }) };
}

async function annotate(file: string, frame: OrthoFrame, hs: LineSeg[], vs: LineSeg[], spots: Spot[]): Promise<Buffer> {
  const P = frame.ppu;
  const ax = viewAxes(frame.view as OrthoView);
  const px = (h: number, v: number): [number, number] => [(h * ax.h.sign - frame.u0) * P, (frame.v0 - v * ax.v.sign) * P];
  const s: string[] = [];
  const label = (x: number, y: number, t: string, color: string) =>
    s.push(`<text x="${x}" y="${y}" font-family="Arial" font-size="${Math.max(9, Math.round(P / 9))}" font-weight="bold" fill="${color}" stroke="#fff" stroke-width="3" paint-order="stroke">${t}</text>`);
  hs.forEach((l, i) => {
    const [a, b] = [px(l.from, l.pos), px(l.to, l.pos)];
    s.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#ff7a00" stroke-width="2"/>`);
    label(Math.min(a[0], b[0]) - 4, a[1] - 2, `H${i + 1}`, '#c45c00');
  });
  vs.forEach((l, i) => {
    const [a, b] = [px(l.pos, l.from), px(l.pos, l.to)];
    s.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#0096d6" stroke-width="2"/>`);
    label(a[0] + 2, Math.min(a[1], b[1]) + 10, `V${i + 1}`, '#006a99');
  });
  spots.forEach((sp, i) => {
    const [x, y] = px(sp.h, sp.v);
    const w = sp.sizeH * P, h = sp.sizeV * P;
    s.push(`<rect x="${x - w / 2 - 2}" y="${y - h / 2 - 2}" width="${w + 4}" height="${h + 4}" fill="none" stroke="#11a33a" stroke-width="2"/>`);
    label(x + w / 2 + 3, y + 4, `S${i + 1}`, '#0b7a2a');
  });
  return sharp(file).flatten({ background: { r: 236, g: 239, b: 243 } })
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${frame.width}" height="${frame.height}">${s.join('')}</svg>`), top: 0, left: 0 }])
    .png().toBuffer();
}
