// The command layer: every change to a scene (from Claude over MCP or from the editor UI) is a
// batch of these JSON commands. Batches are atomic: if one command fails nothing changes.
//
// Semantic placement commands (box / wedge / cornerwedge / attach) compile to a CFrame so the
// caller rarely has to do rotation math.

import { z } from 'zod';
import {
  type AxisDir, type Mat3, type Vec3, AXIS_DIRS, IDENTITY, add, axisIndex, axisRot, clean, column, cross,
  dirVec, dot, fromColumns, fromOrientation, isRotation, matMul, matVec, round, roundVec, snap, sub,
} from './math';
import {
  type Group, type Part, type SceneDoc, type Surface, type Surfaces, ALL_SMOOTH, FACES, clone, defaultLook,
  zColor, zMat3, zMaterial, zShape, zSurface, zVec3,
} from './scene';
import { mirrorPartX, partAABB, reflectX, unionAABB } from './shapes';

// ---------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------

const zAxisDir = z.enum(AXIS_DIRS as [AxisDir, ...AxisDir[]]);
/** '#rrggbb' or a palette reference like 'p3'. */
const zColorRef = z.union([zColor, z.string().regex(/^p\d+$/)]);
const zSurfaceInput = z.union([zSurface, z.object(Object.fromEntries(FACES.map((f) => [f, zSurface.optional()])) as Record<(typeof FACES)[number], z.ZodOptional<typeof zSurface>>)]);
/** Part names / ids, "group:<GroupName>" for every part in a group, or "*" for all. */
const zSelector = z.union([z.string(), z.array(z.string())]);

const look = {
  color: zColorRef.optional(),
  material: zMaterial.optional(),
  surfaces: zSurfaceInput.optional(),
  transparency: z.number().min(0).max(1).optional(),
  group: z.string().nullable().optional().describe('group name to put the part in'),
};

export const zCommand = z.discriminatedUnion('op', [
  z.object({ op: z.literal('box'), name: z.string(), min: zVec3, max: zVec3, ...look })
    .describe('Axis-aligned Block filling the box min..max.'),
  z.object({
    op: z.literal('wedge'), name: z.string(), min: zVec3, max: zVec3,
    tall: zAxisDir.describe('side of the box that is the full rectangle (the high end of the slope)'),
    flat: zAxisDir.optional().describe("full face it rests on; default '-y' (use '+y' for an upside-down overhang)"),
    ...look,
  }).describe('Wedge filling the box; the slope faces away from both `tall` and `flat`.'),
  z.object({
    op: z.literal('cornerwedge'), name: z.string(), min: zVec3, max: zVec3,
    apex: z.string().regex(/^[+-][xyz][+-][xyz][+-][xyz]$/).describe("box corner holding the peak, e.g. '+x+y-z'"),
    flat: zAxisDir.optional().describe("full face it rests on; default '-y' if the apex is on top"),
    ...look,
  }).describe('CornerWedge filling the box with its peak at `apex`.'),
  z.object({
    op: z.literal('part'), name: z.string(), shape: zShape, size: zVec3, position: zVec3,
    orientation: zVec3.optional().describe('Roblox Orientation in degrees (YXZ order)'),
    rotation: zMat3.optional().describe('row-major 3x3 rotation, like CFrame R00..R22'),
    ...look,
  }).describe('Raw part with explicit CFrame.'),
  z.object({
    op: z.literal('attach'), name: z.string(), to: z.string(), face: zAxisDir, size: zVec3,
    offset: zVec3.optional().describe('offset from the face centre; the component along the face normal is ignored'),
    sink: z.number().optional().describe('how far it sinks into the target (default 0 = touching)'),
    ...look,
  }).describe("Block placed flush against a face of another part's bounding box."),
  z.object({
    op: z.literal('update'), part: z.string(),
    set: z.object({
      name: z.string().optional(), shape: zShape.optional(), size: zVec3.optional(), position: zVec3.optional(),
      orientation: zVec3.optional(), rotation: zMat3.optional(),
      box: z.object({ min: zVec3, max: zVec3 }).optional().describe('refit size/position to this world box, keeping rotation'),
      ...look,
    }),
  }),
  z.object({ op: z.literal('delete'), parts: zSelector }),
  z.object({ op: z.literal('duplicate'), part: z.string(), name: z.string(), offset: zVec3.optional() }),
  z.object({ op: z.literal('move'), parts: zSelector, by: zVec3 }),
  z.object({
    op: z.literal('rotate'), parts: zSelector, axis: z.enum(['x', 'y', 'z']), degrees: z.number(),
    pivot: zVec3.optional().describe('default: group pivot when selecting "group:X", else selection centre'),
  }),
  z.object({
    op: z.literal('paint'), parts: zSelector, color: zColorRef.optional(), material: zMaterial.optional(),
    surfaces: zSurfaceInput.optional(), transparency: z.number().min(0).max(1).optional(),
  }),
  z.object({
    op: z.literal('group'), name: z.string(), rename: z.string().optional(),
    parent: z.string().nullable().optional(), pivot: zVec3.optional(),
    main: z.string().optional().describe('main part (the one the joint drives)'),
    parts: zSelector.optional().describe('parts to move into this group'),
  }).describe('Create or update a group (= one bone in the rig).'),
  z.object({ op: z.literal('delete_group'), name: z.string(), deleteParts: z.boolean().optional() }),
  z.object({
    op: z.literal('mirror_group'), source: z.string(), name: z.string(),
  }).describe('Create a linked mirror of a group across X=0; it is regenerated after every edit.'),
  z.object({ op: z.literal('mirror'), parts: zSelector })
    .describe('Linked mirror twins of single parts across X=0, in the same group: build one side, the other side follows every edit. For side details on centred groups (rivets, hip plates, cape flares). Limbs: mirror_group.'),
  z.object({ op: z.literal('unlink'), group: z.string().optional(), parts: zSelector.optional() })
    .describe('Turn a linked mirror group, or linked twin parts, into normal editable parts.'),
  z.object({ op: z.literal('mirror_copy'), parts: zSelector, suffix: z.string().optional() })
    .describe('One-off mirrored copies of parts across X=0 (not linked).'),
  z.object({ op: z.literal('palette'), colors: z.array(zColor) }),
]);

export type Command = z.infer<typeof zCommand>;

export class CommandError extends Error {
  constructor(message: string, public index = -1) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function newId(scene: SceneDoc, prefix: string): string {
  return `${prefix}${scene.nextId++}`;
}

export function findPart(scene: SceneDoc, ref: string): Part | undefined {
  return scene.parts.find((p) => p.name === ref) ?? scene.parts.find((p) => p.id === ref);
}
export function findGroup(scene: SceneDoc, ref: string): Group | undefined {
  return scene.groups.find((g) => g.name === ref) ?? scene.groups.find((g) => g.id === ref);
}

function needPart(scene: SceneDoc, ref: string, editable = true): Part {
  const p = findPart(scene, ref);
  if (!p) throw new CommandError(`no part named "${ref}"`);
  if (editable && p.mirrorOf) {
    const src = scene.parts.find((q) => q.id === p.mirrorOf);
    throw new CommandError(`"${p.name}" is generated by a linked mirror; edit "${src?.name ?? p.mirrorOf}" instead (or unlink the group)`);
  }
  return p;
}
function needGroup(scene: SceneDoc, ref: string): Group {
  const g = findGroup(scene, ref);
  if (!g) throw new CommandError(`no group named "${ref}"`);
  return g;
}

export function select(scene: SceneDoc, sel: string | string[], editable = true): Part[] {
  const refs = Array.isArray(sel) ? sel : [sel];
  const out = new Map<string, Part>();
  for (const r of refs) {
    if (r === '*') scene.parts.filter((p) => !editable || !p.mirrorOf).forEach((p) => out.set(p.id, p));
    else if (r.startsWith('group:')) {
      const g = needGroup(scene, r.slice(6));
      if (editable && g.mirrorOf) throw new CommandError(`group "${g.name}" is a linked mirror; edit its source instead`);
      scene.parts.filter((p) => p.group === g.id).forEach((p) => out.set(p.id, p));
    } else {
      const p = needPart(scene, r, editable);
      out.set(p.id, p);
    }
  }
  return [...out.values()];
}

function resolveColor(scene: SceneDoc, c: string): string {
  if (c.startsWith('#')) return c.toLowerCase();
  const i = Number(c.slice(1));
  const hex = scene.palette[i];
  if (!hex) throw new CommandError(`palette has no entry ${c} (palette size ${scene.palette.length})`);
  return hex.toLowerCase();
}

function resolveSurfaces(base: Surfaces, input: Surface | Partial<Surfaces>): Surfaces {
  if (typeof input === 'string') return { top: input, bottom: input, front: input, back: input, left: input, right: input };
  return { ...base, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v)) } as Surfaces;
}

function sortedBox(min: Vec3, max: Vec3, step: number): { lo: Vec3; hi: Vec3 } {
  const lo = [0, 1, 2].map((i) => snap(Math.min(min[i], max[i]), step)) as Vec3;
  const hi = [0, 1, 2].map((i) => snap(Math.max(min[i], max[i]), step)) as Vec3;
  for (let i = 0; i < 3; i++) if (hi[i] - lo[i] < 0.05 - 1e-9) throw new CommandError(`box is thinner than 0.05 studs on ${'xyz'[i]}`);
  return { lo, hi };
}

/** For an axis-aligned rotation, the world axis each local axis points along. */
function localToWorldAxis(R: Mat3): number[] {
  return [0, 1, 2].map((i) => {
    const c = column(R, i).map(Math.abs);
    return c.indexOf(Math.max(...c));
  });
}

/** Size/position for a part with rotation R filling the world box lo..hi. */
function fitBox(R: Mat3, lo: Vec3, hi: Vec3): { size: Vec3; position: Vec3 } {
  const ext = sub(hi, lo);
  const map = localToWorldAxis(R);
  return {
    size: roundVec([ext[map[0]], ext[map[1]], ext[map[2]]], 6),
    position: roundVec([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], 6),
  };
}

export function wedgeRotation(tall: AxisDir, flat: AxisDir = '-y'): Mat3 {
  if (axisIndex(tall) === axisIndex(flat)) throw new CommandError(`wedge: tall (${tall}) and flat (${flat}) must be on different axes`);
  const y = dirVec(flat).map((v) => -v) as Vec3;
  const zc = dirVec(tall);
  return clean(fromColumns(cross(y, zc), y, zc));
}

export function cornerWedgeRotation(apex: string, flat?: AxisDir): Mat3 {
  const signs: Record<string, number> = {};
  for (let i = 0; i < 6; i += 2) signs[apex[i + 1]] = apex[i] === '-' ? -1 : 1;
  if (Object.keys(signs).length !== 3) throw new CommandError(`cornerwedge: apex "${apex}" must name x, y and z once each`);
  const f: AxisDir = flat ?? (signs.y > 0 ? '-y' : '+y');
  const fa = f[1];
  const fs = f[0] === '-' ? -1 : 1;
  if (signs[fa] === fs) throw new CommandError(`cornerwedge: apex ${apex} must be on the side opposite flat (${f})`);
  const y = dirVec(f).map((v) => -v) as Vec3;
  const others = ['x', 'y', 'z'].filter((a) => a !== fa);
  const u = dirVec(`${signs[others[0]] < 0 ? '-' : '+'}${others[0]}` as AxisDir);
  const w = dirVec(`${signs[others[1]] < 0 ? '-' : '+'}${others[1]}` as AxisDir);
  // Canonical apex sits at local +X and -Z, so R*X and -(R*Z) must be u and w in some order.
  for (const [x, zc] of [[u, w.map((v) => -v) as Vec3], [w, u.map((v) => -v) as Vec3]] as [Vec3, Vec3][]) {
    if (dot(x, cross(y, zc)) > 0.5) return clean(fromColumns(x, y, zc));
  }
  throw new CommandError('cornerwedge: could not build a rotation');
}

function makePart(scene: SceneDoc, name: string, shape: Part['shape'], size: Vec3, position: Vec3, rotation: Mat3,
  opts: { color?: string; material?: Part['material']; surfaces?: Surface | Partial<Surfaces>; transparency?: number; group?: string | null }): Part {
  if (findPart(scene, name)) throw new CommandError(`a part named "${name}" already exists`);
  // Default look: smooth surfaces, no studs; small details become SmoothPlastic (see defaultLook).
  // Studs only when asked for (surfaces: 'Studs').
  const material = opts.material ?? defaultLook(size).material;
  let surfaces: Surfaces = { ...ALL_SMOOTH };
  if (opts.surfaces) surfaces = resolveSurfaces(surfaces, opts.surfaces);
  const group = opts.group ? needGroup(scene, opts.group) : null;
  if (group?.mirrorOf) throw new CommandError(`group "${group.name}" is a linked mirror; add parts to its source`);
  const part: Part = {
    id: newId(scene, 'p'), name, shape, size: roundVec(size, 6), position: roundVec(position, 6), rotation,
    color: resolveColor(scene, opts.color ?? '#a3a2a5'), material, surfaces, group: group?.id ?? null,
    transparency: opts.transparency ?? 0, mirrorOf: null,
  };
  scene.parts.push(part);
  return part;
}

function rotationFrom(input: { orientation?: Vec3; rotation?: Mat3 }): Mat3 | undefined {
  if (input.rotation) {
    const R = clean(input.rotation as Mat3, 1e-6);
    if (!isRotation(R, 1e-4)) throw new CommandError('rotation is not a proper rotation matrix');
    return R;
  }
  if (input.orientation) return fromOrientation(input.orientation as Vec3);
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------------------------

function applyOne(scene: SceneDoc, c: Command): void {
  const step = scene.snap;
  switch (c.op) {
    case 'box': {
      const { lo, hi } = sortedBox(c.min, c.max, step);
      const { size, position } = fitBox(IDENTITY, lo, hi);
      makePart(scene, c.name, 'Block', size, position, IDENTITY, c);
      return;
    }
    case 'wedge': {
      const { lo, hi } = sortedBox(c.min, c.max, step);
      const R = wedgeRotation(c.tall, c.flat);
      const { size, position } = fitBox(R, lo, hi);
      makePart(scene, c.name, 'Wedge', size, position, R, c);
      return;
    }
    case 'cornerwedge': {
      const { lo, hi } = sortedBox(c.min, c.max, step);
      const R = cornerWedgeRotation(c.apex, c.flat);
      const { size, position } = fitBox(R, lo, hi);
      makePart(scene, c.name, 'CornerWedge', size, position, R, c);
      return;
    }
    case 'part': {
      const R = rotationFrom(c) ?? IDENTITY;
      for (const s of c.size) if (s < 0.05) throw new CommandError('part size must be at least 0.05 on every axis');
      makePart(scene, c.name, c.shape, c.size as Vec3, c.position as Vec3, R, c);
      return;
    }
    case 'attach': {
      const target = needPart(scene, c.to, false);
      const bb = partAABB(target);
      const ax = axisIndex(c.face);
      const sgn = c.face[0] === '-' ? -1 : 1;
      const size = c.size.map((v) => snap(v, step)) as Vec3;
      const centre: Vec3 = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
      const off = (c.offset ?? [0, 0, 0]) as Vec3;
      const pos: Vec3 = [centre[0] + off[0], centre[1] + off[1], centre[2] + off[2]];
      const faceCoord = sgn > 0 ? bb.max[ax] : bb.min[ax];
      pos[ax] = faceCoord + sgn * (size[ax] / 2 - (c.sink ?? 0));
      // Unless told otherwise, an attached detail joins the target's group.
      const targetGroup = scene.groups.find((g) => g.id === target.group);
      const group = c.group !== undefined ? c.group : targetGroup && !targetGroup.mirrorOf ? targetGroup.name : null;
      makePart(scene, c.name, 'Block', size, pos, IDENTITY, { ...c, group });
      return;
    }
    case 'update': {
      const p = needPart(scene, c.part);
      const s = c.set;
      if (s.name && s.name !== p.name) {
        if (findPart(scene, s.name)) throw new CommandError(`a part named "${s.name}" already exists`);
        p.name = s.name;
      }
      if (s.shape) p.shape = s.shape;
      const R = rotationFrom(s);
      if (R) p.rotation = R;
      if (s.size) p.size = roundVec(s.size as Vec3, 6);
      if (s.position) p.position = roundVec(s.position as Vec3, 6);
      if (s.box) {
        const { lo, hi } = sortedBox(s.box.min as Vec3, s.box.max as Vec3, step);
        Object.assign(p, fitBox(p.rotation, lo, hi));
      }
      if (s.color) p.color = resolveColor(scene, s.color);
      if (s.material) p.material = s.material;
      if (s.surfaces) p.surfaces = resolveSurfaces(p.surfaces, s.surfaces);
      if (s.transparency !== undefined) p.transparency = s.transparency;
      if (s.group !== undefined) {
        const g = s.group ? needGroup(scene, s.group) : null;
        if (g?.mirrorOf) throw new CommandError(`group "${g.name}" is a linked mirror`);
        p.group = g?.id ?? null;
      }
      return;
    }
    case 'delete': {
      const ids = new Set(select(scene, c.parts).map((p) => p.id));
      // Linked copies go with their source right away, so a later op in the same batch can reuse their names.
      scene.parts = scene.parts.filter((p) => !ids.has(p.id) && !(p.mirrorOf && ids.has(p.mirrorOf)));
      for (const g of scene.groups) if (g.mainPart && ids.has(g.mainPart)) g.mainPart = null;
      return;
    }
    case 'duplicate': {
      const p = needPart(scene, c.part);
      const pos = add(p.position, (c.offset ?? [0, 0, 0]) as Vec3);
      const g = p.group ? scene.groups.find((x) => x.id === p.group)?.name : null;
      makePart(scene, c.name, p.shape, [...p.size] as Vec3, pos, [...p.rotation] as Mat3, {
        color: p.color, material: p.material, surfaces: p.surfaces, transparency: p.transparency, group: g,
      });
      return;
    }
    case 'move': {
      for (const p of select(scene, c.parts)) p.position = roundVec(add(p.position, c.by as Vec3), 6);
      if (typeof c.parts === 'string' && c.parts.startsWith('group:')) {
        const g = needGroup(scene, c.parts.slice(6));
        g.pivot = roundVec(add(g.pivot, c.by as Vec3), 6);
      }
      return;
    }
    case 'rotate': {
      const parts = select(scene, c.parts);
      let pivot = c.pivot as Vec3 | undefined;
      if (!pivot && typeof c.parts === 'string' && c.parts.startsWith('group:')) pivot = needGroup(scene, c.parts.slice(6)).pivot;
      if (!pivot) {
        const bb = unionAABB(parts.map(partAABB))!;
        pivot = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
      }
      const Q = axisRot(c.axis, c.degrees);
      for (const p of parts) {
        p.rotation = clean(matMul(Q, p.rotation), 1e-9);
        p.position = roundVec(add(pivot, matVec(Q, sub(p.position, pivot))), 6);
      }
      return;
    }
    case 'paint': {
      for (const p of select(scene, c.parts)) {
        if (c.color) p.color = resolveColor(scene, c.color);
        if (c.material) p.material = c.material;
        if (c.surfaces) p.surfaces = resolveSurfaces(p.surfaces, c.surfaces);
        if (c.transparency !== undefined) p.transparency = c.transparency;
      }
      return;
    }
    case 'group': {
      let g = findGroup(scene, c.name);
      if (!g) {
        g = { id: newId(scene, 'g'), name: c.name, parent: null, pivot: [0, 0, 0], mainPart: null, mirrorOf: null };
        scene.groups.push(g);
        if (!c.pivot && c.parts) {
          const bb = unionAABB(select(scene, c.parts).map(partAABB));
          if (bb) g.pivot = roundVec([(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2], 6);
        }
      } else if (g.mirrorOf && (c.parts || c.main || c.pivot)) {
        throw new CommandError(`group "${g.name}" is a linked mirror; edit its source`);
      }
      if (c.rename) {
        if (findGroup(scene, c.rename)) throw new CommandError(`a group named "${c.rename}" already exists`);
        g.name = c.rename;
      }
      if (c.parent !== undefined) {
        const parent = c.parent ? needGroup(scene, c.parent) : null;
        for (let q: Group | undefined = parent ?? undefined; q; q = scene.groups.find((x) => x.id === q!.parent))
          if (q.id === g.id) throw new CommandError(`group "${g.name}" cannot be its own ancestor`);
        g.parent = parent?.id ?? null;
      }
      if (c.pivot) g.pivot = roundVec(c.pivot as Vec3, 6);
      if (c.parts) for (const p of select(scene, c.parts)) p.group = g.id;
      if (c.main) {
        const m = needPart(scene, c.main);
        if (m.group !== g.id) throw new CommandError(`main part "${m.name}" is not in group "${g.name}"`);
        g.mainPart = m.id;
      }
      return;
    }
    case 'delete_group': {
      const g = needGroup(scene, c.name);
      const mirrors = scene.groups.filter((x) => x.mirrorOf === g.id);
      for (const victim of [g, ...mirrors]) {
        if (c.deleteParts || victim.mirrorOf) scene.parts = scene.parts.filter((p) => p.group !== victim.id);
        else for (const p of scene.parts) if (p.group === victim.id) p.group = victim.parent;
        for (const x of scene.groups) if (x.parent === victim.id) x.parent = victim.parent;
      }
      const gone = new Set([g.id, ...mirrors.map((m) => m.id)]);
      scene.groups = scene.groups.filter((x) => !gone.has(x.id));
      return;
    }
    case 'mirror_group': {
      const src = needGroup(scene, c.source);
      if (src.mirrorOf) throw new CommandError(`"${src.name}" is itself a mirror`);
      if (findGroup(scene, c.name)) throw new CommandError(`a group named "${c.name}" already exists`);
      if (scene.groups.some((x) => x.mirrorOf === src.id)) throw new CommandError(`"${src.name}" already has a mirror`);
      scene.groups.push({ id: newId(scene, 'g'), name: c.name, parent: src.parent, pivot: reflectX(src.pivot), mainPart: null, mirrorOf: src.id });
      return;
    }
    case 'mirror': {
      const mirroredGroups = new Set(scene.groups.filter((g) => g.mirrorOf).map((g) => g.mirrorOf));
      for (const p of select(scene, c.parts)) {
        if (p.group && mirroredGroups.has(p.group)) {
          throw new CommandError(`"${p.name}" is in a group that is already mirrored as a whole; no twin needed`);
        }
        if (scene.parts.some((q) => q.mirrorOf === p.id)) continue; // already has a twin
        const m = mirrorPartX(p);
        const self = Math.abs(p.position[0]) < 1e-6 && m.size.every((v, i) => Math.abs(v - p.size[i]) < 1e-9)
          && m.rotation.every((v, i) => Math.abs(v - p.rotation[i]) < 1e-9);
        if (self) throw new CommandError(`"${p.name}" is centred on x=0 and symmetric by itself; it needs no twin`);
        const name = mirrorName(p.name);
        if (findPart(scene, name)) throw new CommandError(`the twin of "${p.name}" would be named "${name}", which is taken; rename one of them`);
        scene.parts.push({ ...m, id: `${p.id}~m`, name, group: p.group, mirrorOf: p.id, color: p.color, material: p.material, transparency: p.transparency, shape: p.shape });
      }
      return;
    }
    case 'unlink': {
      if (c.parts) {
        for (const p of select(scene, c.parts, false)) {
          if (!p.mirrorOf) continue;
          p.mirrorOf = null;
          p.id = newId(scene, 'p');
        }
        if (!c.group) return;
      }
      if (!c.group) throw new CommandError('unlink needs group or parts');
      const g = needGroup(scene, c.group);
      if (!g.mirrorOf) throw new CommandError(`"${g.name}" is not a linked mirror`);
      g.mirrorOf = null;
      for (const p of scene.parts) if (p.group === g.id && p.mirrorOf) {
        const oldId = p.id;
        p.mirrorOf = null;
        p.id = newId(scene, 'p');
        if (g.mainPart === oldId) g.mainPart = p.id;
      }
      return;
    }
    case 'mirror_copy': {
      for (const p of select(scene, c.parts)) {
        const m = mirrorPartX(p);
        const name = mirrorName(p.name, c.suffix ?? '_M');
        const g = p.group ? scene.groups.find((x) => x.id === p.group)?.name : null;
        makePart(scene, name, p.shape, m.size, m.position, m.rotation, { color: p.color, material: p.material, surfaces: m.surfaces, transparency: p.transparency, group: g });
      }
      return;
    }
    case 'palette': {
      scene.palette = c.colors.map((x) => x.toLowerCase());
      return;
    }
  }
}

const SIDE_SWAP: Record<string, string> = { Right: 'Left', Left: 'Right', right: 'left', left: 'right', RIGHT: 'LEFT', LEFT: 'RIGHT' };

export function mirrorName(name: string, fallbackSuffix = '_M'): string {
  let out = name.replace(/Right|Left|right|left|RIGHT|LEFT/g, (m) => SIDE_SWAP[m]);
  out = out.replace(/([._])([RL])$/, (_m, sep, s) => sep + (s === 'R' ? 'L' : 'R'));
  out = out.replace(/^([RL])([._])/, (_m, s, sep) => (s === 'R' ? 'L' : 'R') + sep);
  return out === name ? name + fallbackSuffix : out;
}

/** Rebuild every linked mirror group, and every linked twin part, from its source. */
export function regenMirrors(scene: SceneDoc): void {
  const mirrorGroups = scene.groups.filter((g) => g.mirrorOf);
  const mirrorIds = new Set(mirrorGroups.map((g) => g.id));
  regenTwins(scene, mirrorIds);
  if (!mirrorGroups.length) return;
  scene.parts = scene.parts.filter((p) => !(p.mirrorOf && p.group && mirrorIds.has(p.group)));
  for (const mg of mirrorGroups) {
    const src = scene.groups.find((g) => g.id === mg.mirrorOf);
    if (!src) throw new CommandError(`mirror group "${mg.name}" lost its source`);
    mg.pivot = reflectX(src.pivot);
    // Parent: the mirror of the source's parent if it has one, else the same parent.
    const parentMirror = src.parent ? scene.groups.find((g) => g.mirrorOf === src.parent) : undefined;
    mg.parent = parentMirror?.id ?? src.parent;
    mg.mainPart = src.mainPart ? `${src.mainPart}~m` : null;
    for (const p of scene.parts.filter((q) => q.group === src.id && !q.mirrorOf)) {
      const m = mirrorPartX(p);
      const name = mirrorName(p.name);
      if (scene.parts.some((q) => q.name === name)) throw new CommandError(`mirror of "${p.name}" would be named "${name}", which is taken; rename one of them`);
      scene.parts.push({ ...m, id: `${p.id}~m`, name, group: mg.id, mirrorOf: p.id, color: p.color, material: p.material, transparency: p.transparency, shape: p.shape });
    }
  }
}

/** Twin parts (mirror op) follow their source; a twin whose source is gone goes too. */
function regenTwins(scene: SceneDoc, mirrorGroupIds: Set<string>): void {
  const byId = new Map(scene.parts.map((p) => [p.id, p]));
  const keep: Part[] = [];
  for (const p of scene.parts) {
    if (!p.mirrorOf || (p.group && mirrorGroupIds.has(p.group))) { keep.push(p); continue; }
    const src = byId.get(p.mirrorOf);
    if (!src || src.mirrorOf) continue; // source deleted
    const m = mirrorPartX(src);
    keep.push({ ...p, shape: src.shape, size: m.size, position: m.position, rotation: m.rotation, surfaces: m.surfaces, color: src.color, material: src.material, transparency: src.transparency, group: src.group });
  }
  scene.parts = keep;
}

function validate(scene: SceneDoc): void {
  const names = new Set<string>();
  for (const p of scene.parts) {
    if (names.has(p.name)) throw new CommandError(`duplicate part name "${p.name}"`);
    names.add(p.name);
    for (const s of p.size) if (!(s >= 0.05 && s <= 2048)) throw new CommandError(`"${p.name}" has an invalid size ${JSON.stringify(p.size)}`);
    if (!isRotation(p.rotation, 1e-4)) throw new CommandError(`"${p.name}" has an invalid rotation`);
  }
  const gnames = new Set<string>();
  for (const g of scene.groups) {
    if (gnames.has(g.name)) throw new CommandError(`duplicate group name "${g.name}"`);
    gnames.add(g.name);
  }
}

export interface ApplyResult {
  scene: SceneDoc;
  created: string[];
  updated: string[];
  deleted: string[];
}

/** Apply a batch atomically. Throws CommandError (with .index) and leaves `scene` untouched. */
export function applyBatch(scene: SceneDoc, commands: Command[]): ApplyResult {
  const next = clone(scene);
  commands.forEach((cmd, i) => {
    try {
      applyOne(next, zCommand.parse(cmd));
    } catch (e) {
      const msg = e instanceof z.ZodError ? e.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') : (e as Error).message;
      throw new CommandError(`command ${i} (${(cmd as { op?: string }).op ?? '?'}): ${msg}`, i);
    }
  });
  regenMirrors(next);
  validate(next);
  return { scene: next, ...diffScenes(scene, next) };
}

export function diffScenes(a: SceneDoc, b: SceneDoc): { created: string[]; updated: string[]; deleted: string[] } {
  const before = new Map(a.parts.map((p) => [p.id, p]));
  const after = new Map(b.parts.map((p) => [p.id, p]));
  const created: string[] = [], updated: string[] = [], deleted: string[] = [];
  for (const [id, p] of after) {
    const q = before.get(id);
    if (!q) created.push(p.name);
    else if (JSON.stringify(q) !== JSON.stringify(p)) updated.push(p.name);
  }
  for (const [id, p] of before) if (!after.has(id)) deleted.push(p.name);
  return { created, updated, deleted };
}

export { round };
