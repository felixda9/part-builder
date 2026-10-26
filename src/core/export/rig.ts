// Shared by the .rbxmx and Luau exporters: decides which part each group's joint drives, where
// the joints sit, and which parts are welded to what.
//
// Rig = one rigid bone per group: a Motor6D from the parent group's main part to this group's
// main part, pivoting at the group's pivot. Everything else in a group is welded to its main
// part. An invisible anchored HumanoidRootPart is the assembly root.

import { type CFrame, type Vec3, IDENTITY, cf, cfInv, cfMul } from '../math';
import type { Part, SceneDoc } from '../scene';
import { partAABB, unionAABB } from '../shapes';

export interface ExportPart {
  key: string; // part id, or 'HRP'
  name: string;
  className: 'Part' | 'WedgePart' | 'CornerWedgePart';
  part: Part | null; // null for the generated root
  size: Vec3;
  cframe: CFrame;
  anchored: boolean;
  canCollide: boolean;
  transparency: number;
}

export interface Joint {
  name: string;
  part0: string;
  part1: string;
  c0: CFrame;
  c1: CFrame;
}

export interface RigPlan {
  parts: ExportPart[];
  primary: string;
  motors: Joint[];
  welds: Joint[];
  rigged: boolean;
}

const CLASS: Record<Part['shape'], ExportPart['className']> = { Block: 'Part', Wedge: 'WedgePart', CornerWedge: 'CornerWedgePart' };
const volume = (p: Part) => p.size[0] * p.size[1] * p.size[2];

export function planRig(scene: SceneDoc, opts: { rig: boolean; offset?: Vec3 }): RigPlan {
  const off = opts.offset ?? [0, 0, 0];
  const shift = (c: CFrame): CFrame => ({ p: [c.p[0] + off[0], c.p[1] + off[1], c.p[2] + off[2]], R: c.R });
  const parts: ExportPart[] = scene.parts.map((p) => ({
    key: p.id, name: p.name, className: CLASS[p.shape], part: p, size: p.size,
    cframe: shift(cf(p.position, p.rotation)), anchored: !opts.rig, canCollide: true, transparency: p.transparency,
  }));
  const byKey = new Map(parts.map((e) => [e.key, e]));
  if (!parts.length) throw new Error('scene is empty');

  if (!opts.rig) {
    const biggest = [...scene.parts].sort((a, b) => volume(b) - volume(a))[0];
    return { parts, primary: biggest.id, motors: [], welds: [], rigged: false };
  }

  // Each group's main part: designated, else the largest part in it.
  const groupParts = new Map<string, Part[]>();
  for (const p of scene.parts) if (p.group) groupParts.set(p.group, [...(groupParts.get(p.group) ?? []), p]);
  const main = new Map<string, string>();
  for (const g of scene.groups) {
    const ps = groupParts.get(g.id);
    if (!ps?.length) continue;
    const designated = g.mainPart && ps.some((p) => p.id === g.mainPart) ? g.mainPart : null;
    main.set(g.id, designated ?? [...ps].sort((a, b) => volume(b) - volume(a))[0].id);
  }
  // Nearest ancestor group that has parts.
  const anchorOf = (gid: string | null): string | null => {
    for (let id = gid; id; id = scene.groups.find((g) => g.id === id)?.parent ?? null) if (main.has(id)) return id;
    return null;
  };

  const rootGroups = scene.groups.filter((g) => main.has(g.id) && !anchorOf(g.parent));
  const bb = unionAABB(scene.parts.map(partAABB))!;
  const fallbackPivot: Vec3 = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
  // The biggest root group anchors the model; the root part sits at its pivot.
  const primaryGroup = [...rootGroups].sort((a, b) => volume(byKey.get(main.get(b.id)!)!.part!) - volume(byKey.get(main.get(a.id)!)!.part!))[0];
  const rootPos = primaryGroup ? primaryGroup.pivot : fallbackPivot;

  const hrp: ExportPart = {
    key: 'HRP', name: 'HumanoidRootPart', className: 'Part', part: null, size: [1, 1, 1],
    cframe: shift(cf(rootPos, IDENTITY)), anchored: true, canCollide: false, transparency: 1,
  };
  if (scene.parts.some((p) => p.name === 'HumanoidRootPart')) throw new Error('a part is already named HumanoidRootPart; rename it');
  const all = [hrp, ...parts];
  const at = (key: string) => (key === 'HRP' ? hrp : byKey.get(key)!);

  const motors: Joint[] = [];
  const welds: Joint[] = [];
  const motor = (part0: string, part1: string, pivot: Vec3) => {
    const P = shift(cf(pivot, IDENTITY));
    motors.push({ name: at(part1).name, part0, part1, c0: cfMul(cfInv(at(part0).cframe), P), c1: cfMul(cfInv(at(part1).cframe), P) });
  };
  const weld = (part0: string, part1: string) => {
    welds.push({ name: `${at(part1).name}_Weld`, part0, part1, c0: cfMul(cfInv(at(part0).cframe), at(part1).cframe), c1: cf([0, 0, 0]) });
  };

  if (!main.size) {
    // No groups: one implicit bone - weld everything to the biggest part.
    const biggest = [...scene.parts].sort((a, b) => volume(b) - volume(a))[0];
    motor('HRP', biggest.id, rootPos);
    for (const p of scene.parts) if (p.id !== biggest.id) weld(biggest.id, p.id);
    return { parts: all, primary: 'HRP', motors, welds, rigged: true };
  }

  for (const g of scene.groups) {
    const m = main.get(g.id);
    if (!m) continue;
    const parentGroup = anchorOf(g.parent);
    motor(parentGroup ? main.get(parentGroup)! : 'HRP', m, g.pivot);
  }
  const rootMain = primaryGroup ? main.get(primaryGroup.id)! : null;
  for (const p of scene.parts) {
    const gid = p.group ? anchorOf(p.group) : null;
    const m = gid ? main.get(gid)! : rootMain;
    if (!m || m === p.id) continue;
    weld(m, p.id);
  }
  return { parts: all, primary: 'HRP', motors, welds, rigged: true };
}
