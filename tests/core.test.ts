import { describe, expect, it } from 'vitest';
import {
  type AxisDir, type Mat3, type Vec3, AXIS_DIRS, IDENTITY, cfInv, cfMul, cfPoint, det, fromOrientation, isRotation,
  matMul, toOrientation,
} from '../src/core/math';
import { applyBatch, cornerWedgeRotation, mirrorName, wedgeRotation, type Command } from '../src/core/commands';
import { emptyScene, type Part, type SceneDoc } from '../src/core/scene';
import { localGeometry, mirrorPartX, partAABB, worldFaces, worldVerts } from '../src/core/shapes';
import { lintScene } from '../src/core/lints';
import { autoFrame, maskOf, renderOrtho, renderPerspective, threeQuarterCamera } from '../src/core/raster';
import { History } from '../src/core/history';
import { planRig } from '../src/core/export/rig';
import { toRbxmx } from '../src/core/export/rbxmx';
import { toLuau } from '../src/core/export/luau';

const close = (a: number[], b: number[], eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);
const sameVertexSet = (a: Vec3[], b: Vec3[], eps = 1e-6) =>
  a.length === b.length && a.every((v) => b.some((w) => close(v, w, eps))) && b.every((v) => a.some((w) => close(v, w, eps)));

function build(cmds: Command[], scene: SceneDoc = emptyScene()): SceneDoc {
  return applyBatch(scene, cmds).scene;
}
const part = (s: SceneDoc, name: string) => s.parts.find((p) => p.name === name)!;

let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

describe('orientation', () => {
  it('round-trips Roblox YXZ orientation', () => {
    for (let i = 0; i < 200; i++) {
      const o: Vec3 = [rand() * 170 - 85, rand() * 360 - 180, rand() * 360 - 180];
      const R = fromOrientation(o);
      expect(isRotation(R)).toBe(true);
      expect(close(fromOrientation(toOrientation(R)), R, 1e-4)).toBe(true);
    }
  });
  it('keeps axis-aligned rotations exact', () => {
    const R = fromOrientation([0, 90, 0]);
    expect(R).toEqual([0, 0, 1, 0, 1, 0, -1, 0, 0]);
  });
});

describe('shape geometry', () => {
  it('wedge: tall face at +Z, slope faces up and toward -Z', () => {
    const g = localGeometry('Wedge', [2, 3, 4]);
    expect(g.verts.filter((v) => v[1] > 0).every((v) => v[2] === 2)).toBe(true);
    const slope = worldFaces({ shape: 'Wedge', size: [2, 3, 4], position: [0, 0, 0], rotation: IDENTITY }).find((f) => f.verts.length === 4 && f.normal[1] > 0)!;
    expect(slope.normal[1]).toBeGreaterThan(0);
    expect(slope.normal[2]).toBeLessThan(0);
    // normal ∝ (0, sz, -sy)
    expect(Math.abs(slope.normal[1] / slope.normal[2] - 4 / -3)).toBeLessThan(1e-9);
  });
  it('cornerwedge apex at (+hx, +hy, -hz)', () => {
    const g = localGeometry('CornerWedge', [2, 2, 2]);
    expect(g.verts.filter((v) => v[1] > 0)).toEqual([[1, 1, -1]]);
  });
  it('every face winds outward', () => {
    for (const shape of ['Block', 'Wedge', 'CornerWedge'] as const) {
      const p = { shape, size: [1, 2, 3] as Vec3, position: [0, 0, 0] as Vec3, rotation: IDENTITY };
      const vs = worldVerts(p);
      const centroid = vs.reduce((a, v) => [a[0] + v[0], a[1] + v[1], a[2] + v[2]], [0, 0, 0]).map((x) => x / vs.length);
      for (const f of worldFaces(p)) {
        const c = f.verts.reduce((a, v) => [a[0] + v[0], a[1] + v[1], a[2] + v[2]], [0, 0, 0]).map((x, i) => x / f.verts.length - centroid[i]);
        expect(c[0] * f.normal[0] + c[1] * f.normal[1] + c[2] * f.normal[2]).toBeGreaterThan(0);
      }
    }
  });
});

describe('semantic placement', () => {
  it('wedge default (tall +z, flat -y) is identity', () => {
    expect(wedgeRotation('+z', '-y')).toEqual(IDENTITY);
  });
  it('wedge fills its box with the tall face on the requested side, for every orientation', () => {
    for (const tall of AXIS_DIRS) for (const flat of AXIS_DIRS) {
      if (tall[1] === flat[1]) continue;
      const s = build([{ op: 'wedge', name: 'w', min: [1, 2, 3], max: [3, 5, 7], tall, flat }]);
      const p = part(s, 'w');
      const bb = partAABB(p);
      expect(close(bb.min, [1, 2, 3])).toBe(true);
      expect(close(bb.max, [3, 5, 7])).toBe(true);
      // The tall face is a full rectangle on the box side `tall`.
      const ax = 'xyz'.indexOf(tall[1]);
      const side = tall[0] === '+' ? bb.max[ax] : bb.min[ax];
      const onTall = worldVerts(p).filter((v) => Math.abs(v[ax] - side) < 1e-9);
      expect(onTall.length).toBe(4);
      // ...and so is the flat face.
      const fx = 'xyz'.indexOf(flat[1]);
      const fside = flat[0] === '+' ? bb.max[fx] : bb.min[fx];
      expect(worldVerts(p).filter((v) => Math.abs(v[fx] - fside) < 1e-9).length).toBe(4);
    }
  });
  it('cornerwedge puts its apex at the requested corner, for all 24 orientations', () => {
    let count = 0;
    for (const sx of '+-') for (const sy of '+-') for (const sz of '+-') {
      const apex = `${sx}x${sy}y${sz}z`;
      for (const flat of AXIS_DIRS) {
        const sign = { x: sx, y: sy, z: sz }[flat[1] as 'x' | 'y' | 'z'];
        if (sign === flat[0]) continue; // apex must be opposite flat
        const s = build([{ op: 'cornerwedge', name: 'c', min: [0, 0, 0], max: [2, 4, 6], apex, flat: flat as AxisDir }]);
        const p = part(s, 'c');
        const want: Vec3 = [sx === '+' ? 2 : 0, sy === '+' ? 4 : 0, sz === '+' ? 6 : 0];
        const vs = worldVerts(p);
        expect(vs.some((v) => close(v, want))).toBe(true);
        // the other 4 verts lie on the flat face
        const fx = 'xyz'.indexOf(flat[1]);
        const fside = flat[0] === '+' ? [2, 4, 6][fx] : 0;
        expect(vs.filter((v) => Math.abs(v[fx] - fside) < 1e-9).length).toBe(4);
        count++;
      }
    }
    expect(count).toBe(24);
    expect(cornerWedgeRotation('+x+y-z')).toEqual(IDENTITY);
  });
});

describe('mirror', () => {
  const rots: Mat3[] = [IDENTITY, fromOrientation([0, 90, 0]), fromOrientation([90, 0, 0]), fromOrientation([30, -50, 12]), fromOrientation([-75, 140, 33])];
  for (const shape of ['Block', 'Wedge', 'CornerWedge'] as const)
    it(`${shape}: mirrored solid equals the reflected solid exactly`, () => {
      for (const R of rots) {
        const p = { shape, size: [1.5, 2, 3.25] as Vec3, position: [2, 1, -0.5] as Vec3, rotation: R, surfaces: { top: 'Studs', bottom: 'Inlet', front: 'Smooth', back: 'Studs', left: 'Inlet', right: 'Smooth' } as Part['surfaces'] };
        const m = mirrorPartX(p);
        expect(Math.abs(det(m.rotation) - 1)).toBeLessThan(1e-9);
        const reflected = worldVerts(p).map((v) => [-v[0], v[1], v[2]] as Vec3);
        expect(sameVertexSet(worldVerts(m), reflected)).toBe(true);
        // Surfaces follow the faces: each mirrored face has the surface of the face it came from.
        const fo = worldFaces(p), fm = worldFaces(m);
        for (const f of fo) {
          const target = f.verts.map((v) => [-v[0], v[1], v[2]] as Vec3);
          const match = fm.find((g) => sameVertexSet(g.verts, target))!;
          expect(m.surfaces[match.surface]).toBe(p.surfaces[f.surface]);
        }
      }
    });
  it('swaps side names', () => {
    expect(mirrorName('RightArm')).toBe('LeftArm');
    expect(mirrorName('right_eye')).toBe('left_eye');
    expect(mirrorName('Arm.R')).toBe('Arm.L');
    expect(mirrorName('Hand')).toBe('Hand_M');
  });
});

describe('commands', () => {
  it('batches are atomic', () => {
    const s0 = build([{ op: 'box', name: 'a', min: [0, 0, 0], max: [1, 1, 1] }]);
    expect(() => applyBatch(s0, [{ op: 'box', name: 'b', min: [0, 1, 0], max: [1, 2, 1] }, { op: 'delete', parts: 'nope' }])).toThrow(/command 1/);
    expect(s0.parts.map((p) => p.name)).toEqual(['a']);
  });
  it('applies the default look: smooth surfaces, studs only when asked, small details SmoothPlastic', () => {
    const s = build([
      { op: 'box', name: 'body', min: [-1, 0, -0.5], max: [1, 2, 0.5] },
      { op: 'attach', name: 'eye', to: 'body', face: '-z', size: [0.3, 0.3, 0.1], offset: [0.4, 0.5, 0] },
      { op: 'box', name: 'studded', min: [2, 0, 0], max: [3, 1, 1], surfaces: 'Studs' },
    ]);
    expect(part(s, 'body').material).toBe('Plastic');
    expect(part(s, 'body').surfaces.front).toBe('Smooth');
    expect(part(s, 'studded').surfaces.top).toBe('Studs');
    const eye = part(s, 'eye');
    expect(eye.material).toBe('SmoothPlastic');
    expect(eye.surfaces.front).toBe('Smooth');
    expect(close(eye.position, [0.4, 1.5, -0.55])).toBe(true);
  });
  it('linked mirror groups regenerate and are read-only', () => {
    let s = build([
      { op: 'box', name: 'Torso', min: [-1, 2, -0.5], max: [1, 4, 0.5] },
      { op: 'box', name: 'RightArm', min: [1, 2, -0.5], max: [2, 4, 0.5] },
      { op: 'group', name: 'Body', parts: 'Torso', pivot: [0, 3, 0] },
      { op: 'group', name: 'RightArmG', parts: 'RightArm', parent: 'Body', pivot: [1.5, 3.8, 0] },
      { op: 'mirror_group', source: 'RightArmG', name: 'LeftArmG' },
    ]);
    const left = part(s, 'LeftArm');
    expect(close(partAABB(left).min, [-2, 2, -0.5])).toBe(true);
    s = build([{ op: 'move', parts: 'RightArm', by: [0.5, 0, 0] }], s);
    expect(close(partAABB(part(s, 'LeftArm')).min, [-2.5, 2, -0.5])).toBe(true);
    expect(() => applyBatch(s, [{ op: 'move', parts: 'LeftArm', by: [1, 0, 0] }])).toThrow(/linked mirror/);
    const g = s.groups.find((x) => x.name === 'LeftArmG')!;
    expect(g.pivot).toEqual([-1.5, 3.8, 0]);
  });
  it('rotates a group about its pivot', () => {
    const s = build([
      { op: 'box', name: 'arm', min: [1, 2, -0.5], max: [2, 4, 0.5] },
      { op: 'group', name: 'A', parts: 'arm', pivot: [1.5, 4, 0] },
      { op: 'rotate', parts: 'group:A', axis: 'x', degrees: 90 },
    ]);
    const bb = partAABB(part(s, 'arm'));
    expect(close(bb.max, [2, 4.5, 0], 1e-9)).toBe(true);
    expect(close(bb.min, [1, 3.5, -2], 1e-9)).toBe(true);
  });
});

describe('history', () => {
  it('undo / redo / checkout', () => {
    const h = new History(emptyScene());
    const s1 = build([{ op: 'box', name: 'a', min: [0, 0, 0], max: [1, 1, 1] }]);
    h.push(s1, 'a');
    const s2 = build([{ op: 'box', name: 'b', min: [0, 1, 0], max: [1, 2, 1] }], s1);
    h.push(s2, 'b');
    expect(h.current.parts.length).toBe(2);
    h.undo();
    expect(h.current.parts.length).toBe(1);
    h.redo();
    expect(h.current.parts.length).toBe(2);
    h.checkout(0);
    expect(h.current.parts.length).toBe(0);
    h.push(s1, 'branch');
    expect(h.canRedo).toBe(false);
  });
});

describe('lints', () => {
  it('flags floating parts, z-fighting and hidden parts', () => {
    const s = build([
      { op: 'box', name: 'a', min: [0, 0, 0], max: [2, 2, 2] },
      { op: 'box', name: 'b', min: [1, 0, 0], max: [3, 2, 2] }, // overlaps a; shares top/bottom/front/back planes
      { op: 'box', name: 'far', min: [10, 0, 0], max: [11, 1, 1] },
      { op: 'box', name: 'inner', min: [0.5, 0.5, 0.5], max: [1, 1, 1] },
    ]);
    const kinds = lintScene(s).map((l) => `${l.kind}:${l.parts.join(',')}`);
    expect(kinds).toContain('floating:far');
    expect(kinds.some((k) => k.startsWith('zfight:a,b') || k.startsWith('zfight:b,a'))).toBe(true);
    expect(kinds.some((k) => k.startsWith('hidden:inner'))).toBe(true);
  });
  it('touching parts with opposite faces are fine', () => {
    const s = build([
      { op: 'box', name: 'a', min: [0, 0, 0], max: [2, 2, 2] },
      { op: 'box', name: 'b', min: [0, 2, 0], max: [2, 3, 2] },
    ]);
    expect(lintScene(s).filter((l) => l.kind === 'zfight' || l.kind === 'floating')).toEqual([]);
  });
});

describe('rasterizer', () => {
  it('front silhouette area matches the box', () => {
    const s = build([{ op: 'box', name: 'a', min: [-1, 0, -0.5], max: [1, 4, 0.5] }]);
    const frame = autoFrame(s.parts, 'front', 10, 1);
    const res = renderOrtho(s.parts, frame);
    const area = maskOf(res).reduce((a, b) => a + b, 0);
    expect(Math.abs(area - 2 * 4 * 100)).toBeLessThan(2 * (20 + 40) + 4);
  });
  it('front view puts the model right side (+X) on image-left', () => {
    const s = build([{ op: 'box', name: 'a', min: [1, 0, 0], max: [2, 1, 1] }, { op: 'box', name: 'b', min: [-1, 0, 0], max: [1, 1, 1] }]);
    const frame = autoFrame(s.parts, 'front', 10, 0);
    const res = renderOrtho(s.parts, frame);
    const ia = s.parts.findIndex((p) => p.name === 'a');
    expect(res.partIndex[5 * res.width + 2]).toBe(ia); // left edge of the image is +X
  });
  it('perspective three-quarter render covers the model', () => {
    const s = build([{ op: 'box', name: 'a', min: [-1, 0, -0.5], max: [1, 4, 0.5] }]);
    const res = renderPerspective(s.parts, threeQuarterCamera(s.parts, 200, 200));
    const area = maskOf(res).reduce((a, b) => a + b, 0);
    expect(area).toBeGreaterThan(2000);
  });
});

describe('export', () => {
  const character = () => build([
    { op: 'box', name: 'Torso', min: [-1, 2, -0.5], max: [1, 4, 0.5], color: '#2255aa', surfaces: 'Studs' },
    { op: 'box', name: 'Head', min: [-0.6, 4, -0.6], max: [0.6, 5.2, 0.6], color: '#f2c39b' },
    { op: 'attach', name: 'RightEye', to: 'Head', face: '-z', size: [0.2, 0.2, 0.1], offset: [0.25, 0.1, 0], color: '#111111' },
    { op: 'box', name: 'RightArm', min: [1, 2, -0.5], max: [2, 4, 0.5] },
    { op: 'wedge', name: 'RightShoulderPad', min: [1, 4, -0.5], max: [2, 4.5, 0.5], tall: '-x' },
    { op: 'box', name: 'RightLeg', min: [0, 0, -0.5], max: [1, 2, 0.5] },
    { op: 'group', name: 'TorsoG', parts: ['Torso'], pivot: [0, 3, 0] },
    { op: 'group', name: 'HeadG', parts: ['Head', 'RightEye'], parent: 'TorsoG', pivot: [0, 4, 0] },
    { op: 'group', name: 'RightArmG', parts: ['RightArm', 'RightShoulderPad'], parent: 'TorsoG', pivot: [1.5, 3.8, 0], main: 'RightArm' },
    { op: 'group', name: 'RightLegG', parts: ['RightLeg'], parent: 'TorsoG', pivot: [0.5, 2, 0] },
    { op: 'mirror_group', source: 'RightArmG', name: 'LeftArmG' },
    { op: 'mirror_group', source: 'RightLegG', name: 'LeftLegG' },
  ]);

  it('rig joints reproduce the rest pose exactly and reach every part', () => {
    const s = character();
    const plan = planRig(s, { rig: true });
    const cfOf = new Map(plan.parts.map((p) => [p.key, p.cframe]));
    for (const j of [...plan.motors, ...plan.welds]) {
      // Part1.CFrame == Part0.CFrame * C0 * C1^-1
      const want = cfMul(cfMul(cfOf.get(j.part0)!, j.c0), cfInv(j.c1));
      const got = cfOf.get(j.part1)!;
      expect(close(want.p, got.p, 1e-9) && close(want.R, got.R, 1e-9)).toBe(true);
    }
    // Every part reachable from the root through joints.
    const reach = new Set(['HRP']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const j of [...plan.motors, ...plan.welds]) if (reach.has(j.part0) && !reach.has(j.part1)) { reach.add(j.part1); grew = true; }
    }
    expect(reach.size).toBe(plan.parts.length);
    expect(plan.motors.map((m) => m.name).sort()).toEqual(['Head', 'LeftArm', 'LeftLeg', 'RightArm', 'RightLeg', 'Torso']);
    // The shoulder joint sits at the group pivot.
    const shoulder = plan.motors.find((m) => m.name === 'RightArm')!;
    expect(close(cfPoint(cfOf.get(shoulder.part0)!, shoulder.c0.p), [1.5, 3.8, 0], 1e-9)).toBe(true);
  });

  it('writes a well-formed rbxmx', () => {
    const { xml, plan } = toRbxmx(character(), { rig: true, name: 'Knight' });
    const referents = [...xml.matchAll(/referent="(RBX[0-9A-F]{32})"/g)].map((m) => m[1]);
    expect(new Set(referents).size).toBe(referents.length);
    for (const m of xml.matchAll(/<Ref name="\w+">(RBX[0-9A-F]{32})<\/Ref>/g)) expect(referents).toContain(m[1]);
    expect((xml.match(/<Item class="Motor6D"/g) ?? []).length).toBe(plan.motors.length);
    expect((xml.match(/<Item class="Weld"/g) ?? []).length).toBe(plan.welds.length);
    expect(xml).toContain('<Item class="WedgePart"');
    expect(xml).toContain('<Vector3 name="size">');
    expect(xml).toContain('<token name="TopSurface">3</token>');
    expect(xml).toContain(`<Color3uint8 name="Color3uint8">${0xff000000 + 0x2255aa}</Color3uint8>`);
    expect(xml).toContain('<Item class="AnimationController"');
    // Unique Part1 names (the Animation Editor matches poses by name).
    const names = plan.parts.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('writes a Luau builder', () => {
    const { code, plan } = toLuau(character(), { rig: true, name: 'Knight' });
    expect(code).toContain('local NAME, REPLACE, RIG = "Knight", true, true');
    expect((code.match(/^\{"/gm) ?? []).length).toBe(plan.parts.length);
  });

  it('static export anchors everything and has no joints', () => {
    const { plan } = toRbxmx(character(), { rig: false });
    expect(plan.motors.length + plan.welds.length).toBe(0);
    expect(plan.parts.every((p) => p.anchored)).toBe(true);
  });
});

describe('rotation sanity', () => {
  it('matMul with transpose is identity for generated rotations', () => {
    const R = fromOrientation([10, 20, 30]);
    const Rt = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]] as Mat3;
    expect(close(matMul(R, Rt), IDENTITY, 1e-12)).toBe(true);
  });
});
