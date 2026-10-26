import { describe, expect, it } from 'vitest';
import { applyBatch, type Command } from '../src/core/commands';
import { lintScene } from '../src/core/lints';
import { emptyScene, type SceneDoc } from '../src/core/scene';
import { partAABB, worldFaces } from '../src/core/shapes';
import { type BuildPlan, checkPlan, planBox, planToCommands } from '../src/server/plan';

const build = (cmds: Command[], s: SceneDoc = emptyScene()) => applyBatch(s, cmds).scene;
const part = (s: SceneDoc, n: string) => s.parts.find((p) => p.name === n)!;

describe('linked twin parts', () => {
  it('a twin follows its source and is read-only', () => {
    let s = build([
      { op: 'box', name: 'Chest', min: [-1, 0, -0.5], max: [1, 2, 0.5] },
      { op: 'group', name: 'Torso', parts: 'Chest', pivot: [0, 1, 0] },
      { op: 'attach', name: 'RightRivet', to: 'Chest', face: '-z', size: [0.1, 0.1, 0.05], offset: [0.6, 0.5, 0] },
      { op: 'mirror', parts: 'RightRivet' },
    ]);
    const twin = part(s, 'LeftRivet');
    expect(twin.mirrorOf).toBe(part(s, 'RightRivet').id);
    expect(twin.position[0]).toBeCloseTo(-0.6, 9);
    s = build([{ op: 'move', parts: 'RightRivet', by: [0.1, 0, 0] }], s);
    expect(part(s, 'LeftRivet').position[0]).toBeCloseTo(-0.7, 9);
    expect(() => applyBatch(s, [{ op: 'move', parts: 'LeftRivet', by: [1, 0, 0] }])).toThrow(/linked mirror/);
    s = build([{ op: 'delete', parts: 'RightRivet' }], s);
    expect(s.parts.find((p) => p.name === 'LeftRivet')).toBeUndefined();
  });

  it('refuses a twin for a centred part', () => {
    const s = build([{ op: 'box', name: 'Belt', min: [-1, 0, -0.5], max: [1, 0.3, 0.5] }]);
    expect(() => applyBatch(s, [{ op: 'mirror', parts: 'Belt' }])).toThrow(/centred/);
  });
});

describe('checks', () => {
  it('flags a one-sided part and a twin with a different color, not mirrored pairs', () => {
    const s = build([
      { op: 'box', name: 'Body', min: [-1, 0, -0.5], max: [1, 2, 0.5] },
      { op: 'attach', name: 'RightPad', to: 'Body', face: '+x', size: [0.5, 0.5, 0.5] },
      { op: 'mirror', parts: 'RightPad' },
      { op: 'attach', name: 'RightBolt', to: 'Body', face: '-z', size: [0.1, 0.1, 0.05], offset: [0.5, 0.5, 0] },
      { op: 'attach', name: 'LeftBolt', to: 'Body', face: '-z', size: [0.1, 0.1, 0.05], offset: [-0.5, 0.5, 0], color: '#ff0000' },
      { op: 'attach', name: 'Badge', to: 'Body', face: '-z', size: [0.2, 0.2, 0.05], offset: [0.3, -0.5, 0] },
    ]);
    const asym = lintScene(s, { symmetric: true }).filter((l) => l.kind === 'asymmetric');
    const text = asym.map((l) => l.message).join('\n');
    expect(text).toMatch(/"Badge" has no mirror twin/);
    expect(text).toMatch(/differ in color/);
    expect(text).not.toMatch(/RightPad|LeftPad/);
    expect(lintScene(s, { symmetric: false }).some((l) => l.kind === 'asymmetric')).toBe(false);
  });

  it('flags near-coplanar overlapping faces as z-fighting', () => {
    const s = build([
      { op: 'part', name: 'A', shape: 'Block', size: [2, 1, 1], position: [0, 0.5, 0] },
      { op: 'part', name: 'B', shape: 'Block', size: [1, 1, 1], position: [0, 1.4, 0.006] }, // front and back faces 0.006 apart
    ]);
    expect(lintScene(s).some((l) => l.kind === 'zfight' && /0\.006 studs apart/.test(l.message))).toBe(true);
  });
});

describe('build plan', () => {
  const plan: BuildPlan = {
    summary: 'test figure',
    landmarks: [{ name: 'hip', view: 'front', axis: 'y', value: 2 }],
    palette: ['#a3a4b5', '#4757d8'],
    groups: [
      { name: 'Torso', parent: null, pivot: [0, 3, 0] },
      { name: 'RightArm', parent: 'Torso', pivot: [1.2, 3.8, 0] },
      { name: 'LeftArm', parent: 'Torso', pivot: [-1.2, 3.8, 0], mirrorOf: 'RightArm' },
    ],
    parts: [
      { name: 'Chest', group: 'Torso', min: [-0.8, 2, -0.5], max: [0.8, 4, 0.5], color: 'p0' },
      { name: 'RightHipPlate', group: 'Torso', shape: 'Wedge', min: [0.5, 1.6, -0.5], max: [0.8, 2, 0.5], tall: '+y', flat: '-x', color: 'p0', mirror: true },
      { name: 'RightUpperArm', group: 'RightArm', min: [0.8, 2.5, -0.4], max: [1.5, 3.8, 0.4], color: 'p0' },
    ],
    details: [{ name: 'RightBolt', to: 'Chest', face: '-z', size: [0.1, 0.1, 0.05], offset: [0.6, 0.8, 0], color: 'p1', mirror: true }],
    differences: [{ what: 'no shoulder crest', where: 'RightArm' }],
    closeups: [{ name: 'RightArm' }, { name: 'LeftArm' }, { name: 'Chest', notes: 'chest plate' }],
  };

  it('builds each symmetric thing once and mirrors the rest', () => {
    expect(checkPlan(plan).errors).toEqual([]);
    const s = build(planToCommands(plan, [], true));
    const names = s.parts.map((p) => p.name).sort();
    expect(names).toEqual(['Chest', 'LeftBolt', 'LeftHipPlate', 'LeftUpperArm', 'RightBolt', 'RightHipPlate', 'RightUpperArm']);
    expect(s.parts.filter((p) => p.mirrorOf).map((p) => p.name).sort()).toEqual(['LeftBolt', 'LeftHipPlate', 'LeftUpperArm']);
    expect(partAABB(part(s, 'LeftUpperArm')).min[0]).toBeCloseTo(-1.5, 6);
    expect(lintScene(s, { symmetric: true }).filter((l) => l.kind === 'asymmetric')).toEqual([]);
  });

  it('close-up boxes come from the plan, mirror groups mirrored', () => {
    expect(planBox(plan, 'RightArm')).toEqual({ min: [0.8, 2.5, -0.4], max: [1.5, 3.8, 0.4] });
    expect(planBox(plan, 'LeftArm')).toEqual({ min: [-1.5, 2.5, -0.4], max: [-0.8, 3.8, 0.4] });
    expect(planBox(plan, 'Torso')).toEqual({ min: [-0.8, 1.6, -0.5], max: [0.8, 4, 0.5] });
    expect(planBox(plan, 'Chest')).toEqual({ min: [-0.8, 2, -0.5], max: [0.8, 4, 0.5] });
    expect(planBox(plan, 'Cape')).toBeNull();
    expect(checkPlan({ ...plan, closeups: [{ name: 'Cape' }] }).errors.join()).toMatch(/close-up Cape/);
  });

  it('warns when the deliberate differences do not fit the similarity level', () => {
    expect(checkPlan(plan, 'balanced').warnings.join()).not.toMatch(/similarity/);
    expect(checkPlan(plan, 'close').warnings.join()).toMatch(/no deliberate differences expected/);
    expect(checkPlan(plan, 'distinct').warnings.join()).toMatch(/plan 4-12 deliberate differences/);
    expect(checkPlan({ ...plan, differences: [] }, 'balanced').warnings.join()).toMatch(/plan 1-3/);
    expect(checkPlan({ ...plan, landmarks: [], differences: [] }, 'free').warnings).toEqual([]);
  });

  it('rejects numbers off the 0.05 snap grid (they would move when built)', () => {
    const off = { ...plan, parts: [...plan.parts, { name: 'Eye', group: 'Torso', min: [0.38, 3, -0.6], max: [0.52, 3.2, -0.5], color: 'p0' }] } as BuildPlan;
    expect(checkPlan(off).errors.join()).toMatch(/Eye: min x 0.38 is not on the 0.05 snap grid \(it would be built at 0.40\)/);
  });

  it('rejects parts listed in a mirror group', () => {
    const bad = { ...plan, parts: [...plan.parts, { name: 'LeftExtra', group: 'LeftArm', min: [-1, 2, 0], max: [-0.9, 2.5, 0.1], color: 'p0' }] } as BuildPlan;
    expect(checkPlan(bad).errors.join()).toMatch(/mirror group/);
  });

  it('rebuilding replaces the old model', () => {
    const first = build(planToCommands(plan, [], true));
    const again = build(planToCommands(plan, first.groups.map((g) => g.name), true), first);
    expect(again.parts.length).toBe(first.parts.length);
  });
});

describe('thin gaps', () => {
  const two = (gap: number, groups?: [string, string]) => build([
    { op: 'box', name: 'Base', min: [-1, 0, -1], max: [1, 1, 1] },
    { op: 'box', name: 'Top', min: [-0.5, 1 + gap, -0.5], max: [0.5, 1.5 + gap, 0.5] },
    ...(groups ? [
      { op: 'group', name: groups[0], parts: 'Base', pivot: [0, 0.5, 0] },
      { op: 'group', name: groups[1], parts: 'Top', pivot: [0, 1.2, 0] },
    ] as Command[] : []),
  ]);
  const gaps = (s: SceneDoc) => lintScene(s).filter((l) => l.kind === 'gap' || l.kind === 'loose');

  it('flags a part hovering just above another', () => {
    const g = gaps(two(0.05));
    expect(g.some((l) => l.kind === 'gap' && /"Base" and "Top"/.test(l.message) && /0\.05\+ studs/.test(l.message))).toBe(true);
    expect(g.some((l) => l.kind === 'loose' && /"Top"/.test(l.message))).toBe(true);
  });

  it('is quiet when parts touch or are clearly apart', () => {
    expect(gaps(two(0))).toEqual([]);
    expect(gaps(two(0.3))).toEqual([]);
  });

  it('a groove is not a crack: a head resting on sloped shoulders', () => {
    const s = build([
      { op: 'box', name: 'Body', min: [-0.2, 0, -1], max: [0.2, 1, 1] },
      { op: 'wedge', name: 'RightShoulder', min: [0.2, 0.7, -1], max: [0.5, 1, 1], tall: '-x' },
      { op: 'mirror', parts: 'RightShoulder' },
      { op: 'box', name: 'Head', min: [-0.6, 1, -0.6], max: [0.6, 1.8, 0.4] },
    ]);
    expect(gaps(s)).toEqual([]);
  });

  it('catches flicker between tiny details (an eye and its glint sharing a side face)', () => {
    const s = build([
      { op: 'box', name: 'Eye', min: [0.4, 2.3, -2.15], max: [0.5, 2.45, -2.05] },
      { op: 'box', name: 'Glint', min: [0.4, 2.35, -2.2], max: [0.45, 2.4, -2.1] },
    ]);
    expect(lintScene(s).some((l) => l.kind === 'zfight' && /"Eye" and "Glint"/.test(l.message))).toBe(true);
  });

  it('only flags flicker you can see, not two faces buried in a third part', () => {
    const buried = build([
      { op: 'box', name: 'Outer', min: [-1, 0, -1], max: [1, 2, 1] },
      { op: 'box', name: 'A', min: [-0.5, 0.5, -0.5], max: [0, 1, 0.5] },
      { op: 'box', name: 'B', min: [-0.4, 0.5, -0.4], max: [0.3, 1, 0.4] },
    ]);
    expect(lintScene(buried).filter((l) => l.kind === 'zfight')).toEqual([]);
    const seen = build([
      { op: 'box', name: 'A', min: [-0.5, 0.5, -0.5], max: [0, 1, 0.5] },
      { op: 'box', name: 'B', min: [-0.4, 0.5, -0.4], max: [0.3, 1, 0.4] },
    ]);
    expect(lintScene(seen).some((l) => l.kind === 'zfight')).toBe(true);
  });

  it('ignores gaps between separate limbs (sibling bones)', () => {
    const s = build([
      { op: 'box', name: 'Body', min: [-1, 1, -1], max: [1, 2, 1] },
      { op: 'group', name: 'BodyG', parts: 'Body', pivot: [0, 1.5, 0] },
      { op: 'box', name: 'LegA', min: [0.2, 0, -0.2], max: [0.6, 1, 0.2], group: null },
      { op: 'box', name: 'LegB', min: [0.65, 0, -0.2], max: [0.95, 1, 0.2], group: null },
      { op: 'group', name: 'LegAG', parts: 'LegA', parent: 'BodyG', pivot: [0.4, 1, 0] },
      { op: 'group', name: 'LegBG', parts: 'LegB', parent: 'BodyG', pivot: [0.8, 1, 0] },
    ]);
    expect(gaps(s).filter((l) => /LegA/.test(l.message) && /LegB/.test(l.message))).toEqual([]);
  });
});

describe('blunt ends', () => {
  const blunt = (s: SceneDoc) => lintScene(s, { organic: true }).filter((l) => l.kind === 'blunt');
  const bevelled = (bevel: BuildPlan['parts'][number]['bevel']) => build(planToCommands({
    summary: 'body', landmarks: [], palette: ['#e0832f'], groups: [{ name: 'B', parent: null, pivot: [0, 0.5, 0] }],
    parts: [{ name: 'Body', group: 'B', min: [-0.6, 0, -1], max: [0.6, 1, 1], color: 'p0', bevel }], details: [], differences: [], closeups: [],
  }, [], true));

  it('flags a square-cut end on an organic model only', () => {
    const cut = build([{ op: 'box', name: 'Body', min: [-0.6, 0, -1], max: [0.6, 1, 1] }]);
    expect(blunt(cut).some((l) => /back of model/.test(l.message) && l.parts.includes('Body'))).toBe(true);
    expect(lintScene(cut, { organic: false }).some((l) => l.kind === 'blunt')).toBe(false);
  });

  it('a smaller box stacked on the end is still blunt (a step, not a slope)', () => {
    const stepped = build([
      { op: 'box', name: 'Body', min: [-0.6, 0, -1], max: [0.6, 1, 0.8] },
      { op: 'box', name: 'Cap', min: [-0.35, 0.2, 0.8], max: [0.35, 0.8, 1] },
      { op: 'group', name: 'B', parts: ['Body', 'Cap'], pivot: [0, 0.5, 0] },
    ]);
    const text = blunt(stepped).map((l) => l.message).join('\n');
    expect(text).toMatch(/"Cap"/);
    expect(text).toMatch(/"Body"/);
  });

  it('the flat back of a thin plate sticking out (an ear) is not a blunt end', () => {
    const head = (earZ: [number, number]) => build([
      { op: 'box', name: 'Head', min: [-0.6, 0, -1], max: [0.6, 1, 0] },
      { op: 'box', name: 'RightEar', min: [0.3, 0.8, earZ[0]], max: [0.7, 1.4, earZ[1]] },
      { op: 'group', name: 'H', parts: ['Head', 'RightEar'], pivot: [0, 0.5, -0.5] },
    ]);
    // The head's own back is a separate matter; only the ear is looked at here.
    const earBlunt = (s: SceneDoc) => blunt(s).some((l) => l.parts.includes('RightEar'));
    expect(earBlunt(head([-0.35, -0.1]))).toBe(false); // a thin ear standing on the head
  });

  it('a bevelled end passes and is built from slopes', () => {
    const s = bevelled({ ends: ['-z', '+z'], size: 0.3, edges: ['+x+y', '-x+y'], edgeSize: 0.1 });
    expect(blunt(s)).toEqual([]);
    const lints = lintScene(s, { symmetric: true, organic: true });
    expect(lints.filter((l) => ['zfight', 'asymmetric', 'gap', 'floating', 'disconnected'].includes(l.kind))).toEqual([]);
  });

  // Every sample point well inside / outside the ideal shape (box cut by half-spaces) must be
  // inside / outside the built parts.
  const exact = (bevel: Parameters<typeof bevelled>[0], cuts: (x: number, y: number, z: number) => number[]) => {
    const s = bevelled(bevel);
    const solids = s.parts.map((p) => worldFaces(p).map((f) => ({ n: f.normal, d: f.normal[0] * f.verts[0][0] + f.normal[1] * f.verts[0][1] + f.normal[2] * f.verts[0][2] })));
    const inPart = (q: number[]) => solids.some((pl) => pl.every((h) => h.n[0] * q[0] + h.n[1] * q[1] + h.n[2] * q[2] - h.d <= 1e-9));
    let checked = 0;
    for (let x = -0.68; x <= 0.68; x += 0.0371) for (let y = -0.07; y <= 1.07; y += 0.0373) for (let z = -1.07; z <= 1.07; z += 0.0377) {
      const c = [0.6 - Math.abs(x), y, 1 - y, 1 - Math.abs(z), ...cuts(Math.abs(x), y, z)];
      if (c.some((v) => Math.abs(v) < 0.004)) continue; // too close to the surface to tell
      expect(inPart([x, y, z]), `point ${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`).toBe(c.every((v) => v > 0));
      checked++;
    }
    expect(checked).toBeGreaterThan(30000);
    return s;
  };

  it('fills exactly the chamfered shape - no fins at the corners, no holes', () => {
    // Both ends sloped all round (size 0.3), top long edges cut by 0.1.
    exact({ ends: ['-z', '+z'], size: 0.3, edges: ['+x+y', '-x+y'], edgeSize: 0.1 }, (ax, y, z) => [
      1 - ((ax - 0.3) / 0.3 + (Math.abs(z) - 0.7) / 0.3), 1 - ((y - 0.7) / 0.3 + (Math.abs(z) - 0.7) / 0.3), 1 - ((0.3 - y) / 0.3 + (Math.abs(z) - 0.7) / 0.3),
      0.1 - ((ax - 0.5) + (y - 0.9)),
    ]);
    // One end, bottom side not sloped (it sits on something), all four long edges cut.
    const s = exact({ ends: ['+z'], size: 0.3, rim: ['+x', '-x', '+y'], edges: ['+x+y', '-x+y', '+x-y', '-x-y'], edgeSize: 0.1 }, (ax, y, z) => [
      1 - ((ax - 0.3) / 0.3 + (z - 0.7) / 0.3), 1 - ((y - 0.7) / 0.3 + (z - 0.7) / 0.3),
      0.1 - ((ax - 0.5) + (y - 0.9)), 0.1 - ((ax - 0.5) + (0.1 - y)),
    ]);
    expect(lintScene(s, { symmetric: true }).filter((l) => ['zfight', 'asymmetric', 'gap', 'floating', 'disconnected'].includes(l.kind))).toEqual([]);
    // A smaller slope at the front end.
    exact({ ends: ['-z', '+z'], size: 0.3, sizes: { '-z': 0.2 }, edges: ['+x+y', '-x+y'], edgeSize: 0.1 }, (ax, y, z) => [
      1 - ((ax - 0.3) / 0.3 + (z - 0.7) / 0.3), 1 - ((y - 0.7) / 0.3 + (z - 0.7) / 0.3), 1 - ((0.3 - y) / 0.3 + (z - 0.7) / 0.3),
      1 - ((ax - 0.4) / 0.2 + (-z - 0.8) / 0.2), 1 - ((y - 0.8) / 0.2 + (-z - 0.8) / 0.2), 1 - ((0.2 - y) / 0.2 + (-z - 0.8) / 0.2),
      0.1 - ((ax - 0.5) + (y - 0.9)),
    ]);
  }, 30_000); // dense point sampling: slow on CI machines

  it('leaves out bevel pieces buried inside another part', () => {
    const s = build(planToCommands({
      summary: 'b', landmarks: [], palette: [], groups: [{ name: 'B', parent: null, pivot: [0, 0, 0] }],
      parts: [
        { name: 'Body', group: 'B', min: [-1, 0, -1], max: [1, 2, 1], color: '#ffffff' },
        // Its front end sits inside the body, its back end sticks out.
        { name: 'Tail', group: 'B', min: [-0.3, 0.7, 0.5], max: [0.3, 1.3, 2], color: '#ffffff', bevel: { ends: ['-z', '+z'], size: 0.2 } },
      ], details: [], differences: [], closeups: [],
    } as BuildPlan, [], true));
    const names = s.parts.map((p) => p.name);
    expect(names.some((n) => n.startsWith('TailFront'))).toBe(false);
    expect(names.some((n) => n.startsWith('TailBack'))).toBe(true);
  });

  it('checks bevel sizes', () => {
    const plan = (bevel: object) => ({
      summary: 'b', landmarks: [], palette: [], groups: [{ name: 'B', parent: null, pivot: [0, 0, 0] }],
      parts: [{ name: 'Body', group: 'B', min: [-0.6, 0, -1], max: [0.6, 1, 1], color: '#ffffff', bevel }], details: [], differences: [], closeups: [],
    }) as BuildPlan;
    expect(checkPlan(plan({ ends: ['+z'], size: 0.3 })).errors).toEqual([]);
    expect(checkPlan(plan({ ends: ['+z'], size: 0.5 })).errors).toEqual([]); // ridge
    expect(checkPlan(plan({ ends: ['+z'], size: 0.48 })).errors.join()).toMatch(/cap 0.04 wide/);
    expect(checkPlan(plan({ ends: ['+z', '+y'], size: 0.3 })).errors.join()).toMatch(/one axis/);
    expect(checkPlan(plan({ ends: ['+x'], size: 0.3 })).errors.join()).toMatch(/centred/);
  });
});
