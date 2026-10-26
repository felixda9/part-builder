import { describe, expect, it } from 'vitest';
import type { OrthoFrame } from '../src/core/raster';
import {
  type EdgeMap, edgeScore, extractLines, findDarkSpots, findSpots, imageEdges, interior, matchLines, matchSpots, paletteFamilies, paletteLabeler,
} from '../src/server/likeness';
import { rgbToLab } from '../src/server/imaging';

// A 4 x 6 stud "figure" at 20 px/stud: light block with a darker band (a belt) at y 2.5..2.75,
// two dark 0.15-stud squares (eyes) and two raised 0.1-stud squares (rivets).
const P = 20;
const frame: OrthoFrame = { view: 'front', ppu: P, u0: -3, v0: 7, width: 6 * P, height: 8 * P };
function figure(opts: { beltY?: number; eyes?: boolean } = {}) {
  const w = frame.width, h = frame.height;
  const L = new Float32Array(w * h).fill(0.98);
  const mask = new Uint8Array(w * h);
  const px = (x: number) => Math.round((x * -1 - frame.u0) * P); // front view: image-right = -x
  const py = (y: number) => Math.round((frame.v0 - y) * P);
  const fill = (x0: number, x1: number, y0: number, y1: number, val: number, m = false) => {
    const [a, b] = [px(x1), px(x0)].sort((p, q) => p - q);
    for (let y = py(y1); y < py(y0); y++) for (let x = a; x < b; x++) { L[y * w + x] = val; if (m) mask[y * w + x] = 1; }
  };
  fill(-2, 2, 0, 6, 0.7, true);
  const by = opts.beltY ?? 2.5;
  fill(-2, 2, by, by + 0.25, 0.45);
  if (opts.eyes !== false) { fill(0.3, 0.45, 5, 5.15, 0.05); fill(-0.45, -0.3, 5, 5.15, 0.05); }
  fill(1.2, 1.3, 4, 4.1, 0.9); fill(-1.3, -1.2, 4, 4.1, 0.9);
  return { L, mask: { width: w, height: h, data: mask } };
}

describe('structure', () => {
  it('finds the belt edges as horizontal lines at the right heights', () => {
    const { L, mask } = figure();
    const E = imageEdges(L, interior(mask, 2), frame.width, frame.height);
    const hs = extractLines(E, frame).filter((l) => l.orient === 'h' && l.to - l.from > 2);
    const ys = hs.map((l) => l.pos).sort((a, b) => a - b);
    expect(ys.some((y) => Math.abs(y - 2.5) < 0.08)).toBe(true);
    expect(ys.some((y) => Math.abs(y - 2.75) < 0.08)).toBe(true);
  });

  it('reports a moved belt as missing + extra lines and lowers edge F1', () => {
    const a = figure({ beltY: 2.5 }), b = figure({ beltY: 1.6 });
    const Ea = imageEdges(a.L, interior(a.mask, 2), frame.width, frame.height);
    const Eb = imageEdges(b.L, interior(b.mask, 2), frame.width, frame.height);
    const same = edgeScore(Ea, Ea, 0.08 * P), moved = edgeScore(Ea, Eb, 0.08 * P);
    expect(same.f1).toBeCloseTo(1, 5);
    expect(moved.f1).toBeLessThan(0.6);
    const m = matchLines(extractLines(Ea, frame), extractLines(Eb, frame), 0.1);
    expect(m.missing.some((l) => l.orient === 'h' && Math.abs(l.pos - 2.5) < 0.1)).toBe(true);
    expect(m.extra.some((l) => l.orient === 'h' && Math.abs(l.pos - 1.6) < 0.1)).toBe(true);
  });
});

describe('details', () => {
  it('finds eye slits (dark) and rivets (raised) at their positions', () => {
    const { L, mask } = figure();
    const E: EdgeMap = imageEdges(L, interior(mask, 2), frame.width, frame.height);
    const spots = [...findSpots(E, L, frame), ...findDarkSpots(L, interior(mask, 1), frame)];
    const near = (x: number, y: number) => spots.some((s) => Math.hypot(s.h - x, s.v - y) < 0.12);
    expect(near(0.375, 5.075)).toBe(true); // right eye (model's right is +x)
    expect(near(-0.375, 5.075)).toBe(true);
    expect(near(1.25, 4.05)).toBe(true); // rivets
    expect(near(-1.25, 4.05)).toBe(true);
  });

  it('matches details by position', () => {
    const s = (h: number, v: number) => ({ h, v, sizeH: 0.1, sizeV: 0.1, dark: false, hAxis: 'x', vAxis: 'y' });
    const m = matchSpots([s(0, 0), s(1, 1)], [s(0.05, 0), s(3, 3)], 0.12);
    expect(m.recall).toBe(0.5);
    expect(m.missing.map((x) => x.h)).toEqual([1]);
    expect(m.extra.map((x) => x.h)).toEqual([3]);
  });
});

describe('color families', () => {
  it('groups shades of one color and keeps different colors apart', () => {
    const pal = ['#a3a4b5', '#8a88a2', '#4757d8', '#2545a1', '#16182a', '#b3b5c4'];
    const fam = paletteFamilies(pal);
    expect(fam[1]).toBe(fam[0]); // silvers
    expect(fam[5]).toBe(fam[0]);
    expect(fam[3]).toBe(fam[2]); // blues
    expect(fam[4]).not.toBe(fam[0]); // near-black is not silver
    expect(fam[2]).not.toBe(fam[0]);
    const label = paletteLabeler(pal);
    expect(label(rgbToLab(120, 118, 135))).toBe(fam[0]); // shaded silver is still silver
    expect(label(rgbToLab(30, 50, 140))).toBe(fam[2]);
  });
});
