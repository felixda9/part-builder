import { describe, expect, it } from 'vitest';
import {
  type Mask, type RGBImage, boundaryError, coreCenter, despill, estimateBackground, iou, maskArea, maskBBox, palette, segmentKey,
  symmetryAxis,
} from '../src/server/imaging';

/** Synthetic image: key-color background with filled rectangles. */
function makeImage(w: number, h: number, key: [number, number, number], rects: { x0: number; y0: number; x1: number; y1: number; c: [number, number, number] }[]): RGBImage {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) data.set(key, i * 3);
  for (const r of rects) for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) data.set(r.c, (y * w + x) * 3);
  return { width: w, height: h, data };
}

const MAGENTA: [number, number, number] = [255, 0, 255];

describe('segmentation', () => {
  it('finds the key color and cuts out the subject', () => {
    const img = makeImage(100, 100, MAGENTA, [{ x0: 30, y0: 20, x1: 70, y1: 90, c: [60, 80, 120] }]);
    expect(estimateBackground(img).map(Math.round)).toEqual(MAGENTA);
    const { mask } = segmentKey(img);
    expect(maskBBox(mask)).toEqual({ minX: 30, minY: 20, maxX: 69, maxY: 89 });
    expect(maskArea(mask)).toBe(40 * 70);
  });

  it('removes enclosed key-colored gaps (between arm and body)', () => {
    const body: [number, number, number] = [200, 200, 200];
    const img = makeImage(100, 100, MAGENTA, [
      { x0: 20, y0: 10, x1: 80, y1: 30, c: body }, // shoulders
      { x0: 20, y0: 30, x1: 30, y1: 80, c: body }, // arm
      { x0: 40, y0: 30, x1: 80, y1: 80, c: body }, // torso
      { x0: 20, y0: 80, x1: 80, y1: 90, c: body }, // closes the gap at the bottom
    ]);
    const { mask } = segmentKey(img);
    expect(mask.data[55 * 100 + 35]).toBe(0); // inside the enclosed gap
    expect(mask.data[55 * 100 + 25]).toBe(1);
  });

  it('treats darker key-colored shadow as background', () => {
    const img = makeImage(100, 100, MAGENTA, [
      { x0: 30, y0: 20, x1: 70, y1: 80, c: [40, 160, 60] },
      { x0: 20, y0: 80, x1: 80, y1: 86, c: [120, 0, 120] }, // shadow under the feet
    ]);
    const { mask } = segmentKey(img);
    expect(maskBBox(mask)!.maxY).toBe(79);
  });
});

describe('alignment helpers', () => {
  it('finds the symmetry axis despite a held item', () => {
    const img = makeImage(200, 200, MAGENTA, [
      { x0: 80, y0: 20, x1: 120, y1: 180, c: [90, 90, 90] }, // body centred on x = 100
      { x0: 120, y0: 120, x1: 160, y1: 126, c: [90, 90, 90] }, // sword sticking out on one side
    ]);
    const { mask } = segmentKey(img);
    expect(symmetryAxis(mask)).toBeCloseTo(100, 0);
    expect(coreCenter(mask)).toBeCloseTo(100, 0);
  });
});

describe('metrics', () => {
  const rect = (w: number, h: number, x0: number, y0: number, x1: number, y1: number): Mask => {
    const data = new Uint8Array(w * h);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * w + x] = 1;
    return { width: w, height: h, data };
  };
  it('IoU and boundary error of shifted boxes', () => {
    const a = rect(60, 60, 10, 10, 30, 30);
    const b = rect(60, 60, 14, 10, 34, 30);
    expect(iou(a, b)).toBeCloseTo(16 * 20 / (24 * 20), 5);
    const be = boundaryError(a, b);
    expect(be.p95).toBeGreaterThanOrEqual(3.5);
    expect(be.p95).toBeLessThanOrEqual(4.5);
    expect(boundaryError(a, a)).toEqual({ mean: 0, p95: 0 });
  });
  it('palette finds the dominant colors', () => {
    const img = makeImage(50, 50, [250, 250, 250], [
      { x0: 0, y0: 0, x1: 50, y1: 30, c: [200, 30, 30] },
      { x0: 0, y0: 30, x1: 50, y1: 50, c: [30, 30, 200] },
    ]);
    const p = palette(img, null, 4);
    expect(p[0].hex).toBe('#c81e1e');
    expect(p[0].share).toBeCloseTo(0.6, 1);
    expect(p[1].hex).toBe('#1e1ec8');
  });
});

describe('despill', () => {
  const MAGENTA: [number, number, number] = [255, 0, 255];
  const px = (...c: [number, number, number][]) => ({ width: c.length, height: 1, data: Uint8Array.from(c.flat()) });
  const get = (img: { data: ArrayLike<number> }, i: number) => [img.data[i * 3], img.data[i * 3 + 1], img.data[i * 3 + 2]];
  const luma = (c: number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

  it('turns pink-tinted silver neutral and keeps its lightness', () => {
    const out = despill(px([196, 172, 198]), MAGENTA);
    const c = get(out, 0);
    expect(Math.max(...c) - Math.min(...c)).toBeLessThanOrEqual(2);
    expect(Math.abs(luma(c) - luma([196, 172, 198]))).toBeLessThan(1.5);
  });

  it('leaves real subject colors alone (red, blue, gold, dark grey)', () => {
    const cols: [number, number, number][] = [[200, 40, 40], [60, 90, 220], [184, 134, 11], [40, 42, 45]];
    const out = despill(px(...cols), MAGENTA);
    cols.forEach((c, i) => expect(get(out, i)).toEqual(c));
  });

  it('caps the correction inside the subject but cleans the outline fully', () => {
    // 5x5 subject, all strongly magenta-tinted; only the 1-px outline band is uncapped.
    const w = 5, img = { width: w, height: w, data: new Uint8Array(w * w * 3) };
    for (let i = 0; i < w * w; i++) img.data.set([230, 100, 230], i * 3);
    const mask = { width: w, height: w, data: new Uint8Array(w * w).fill(1) };
    const out = despill(img, MAGENTA, mask, { cap: 48, edge: 1 });
    const edge = get(out, 0), centre = get(out, 12);
    expect(edge[0] - edge[1]).toBeLessThanOrEqual(1); // fully neutral
    expect(centre[0] - centre[1]).toBeGreaterThan(70); // only 48 removed from 130
  });

  it('works for a green key too', () => {
    const c = get(despill(px([150, 178, 152]), [0, 255, 0]), 0);
    expect(Math.max(...c) - Math.min(...c)).toBeLessThanOrEqual(2);
  });
});
