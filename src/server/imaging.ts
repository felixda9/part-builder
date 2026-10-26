// Pure image analysis on raw pixel arrays: color-key segmentation, morphology, connected
// components, Lab palettes, distance transforms. No I/O here, so it is easy to test.

export interface RGBImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray; // RGB, 3 bytes per pixel
}

export interface Mask {
  width: number;
  height: number;
  data: Uint8Array; // 1 = subject
}

// ---------------------------------------------------------------- color

export type Lab = [number, number, number];

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function rgbToLab(r: number, g: number, b: number): Lab {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export const deltaE = (a: Lab, b: Lab): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export const hexToRgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
export const rgbToHex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/** The most common color along the image border (quantized), refined by averaging. */
export function estimateBackground(img: RGBImage): [number, number, number] {
  const { width: w, height: h, data } = img;
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  const add = (x: number, y: number) => {
    const i = (y * w + x) * 3;
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const c = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    c.n++; c.r += data[i]; c.g += data[i + 1]; c.b += data[i + 2];
    counts.set(key, c);
  };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return [best.r / best.n, best.g / best.n, best.b / best.n];
}

// ---------------------------------------------------------------- segmentation

export interface SegmentOptions {
  /** Lab distance from the key color that still counts as background when connected to the border. */
  tolerance?: number;
  /** Stricter tolerance for key-colored regions fully enclosed by the subject (arm/torso gaps). */
  holeTolerance?: number;
  /** Minimum size (px) of an enclosed key-colored region to be removed. */
  minHole?: number;
}

/**
 * Separate the subject from a flat key-color background.
 *  1. flood fill from the border through pixels close to the key color, or with the key's
 *     chromaticity (its shadows / anti-aliased fringe);
 *  2. remove enclosed key-colored regions (gaps between arms and body);
 *  3. clean up with open/close and keep the main subject (plus parts overlapping its box).
 */
export function segmentKey(img: RGBImage, key?: [number, number, number], opts: SegmentOptions = {}): { mask: Mask; key: [number, number, number] } {
  const { width: w, height: h, data } = img;
  const k = key ?? estimateBackground(img);
  const kLab = rgbToLab(k[0], k[1], k[2]);
  const kSum = k[0] + k[1] + k[2] || 1;
  const kc = [k[0] / kSum, k[1] / kSum, k[2] / kSum];
  const tol = opts.tolerance ?? 28;
  const holeTol = opts.holeTolerance ?? 18;
  const n = w * h;
  const dist = new Float32Array(n);
  const keyish = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    dist[i] = deltaE(rgbToLab(r, g, b), kLab);
    const s = r + g + b;
    // Same hue family as the key, just darker (shadow) or blended (fringe).
    const chroma = s > 0.15 * kSum ? Math.abs(r / s - kc[0]) + Math.abs(g / s - kc[1]) + Math.abs(b / s - kc[2]) : 9;
    keyish[i] = dist[i] < tol || chroma < 0.07 ? 1 : 0;
  }
  const bg = new Uint8Array(n);
  const stack: number[] = [];
  const seed = (i: number) => { if (keyish[i] && !bg[i]) { bg[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (y > 0) seed(i - w);
    if (y < h - 1) seed(i + w);
  }
  // Enclosed key-colored holes.
  const hole = new Uint8Array(n);
  for (let i = 0; i < n; i++) hole[i] = !bg[i] && dist[i] < holeTol ? 1 : 0;
  const holes = components({ width: w, height: h, data: hole });
  for (const c of holes.list) if (c.area >= (opts.minHole ?? 20)) for (const i of c.pixels) bg[i] = 1;

  let mask: Mask = { width: w, height: h, data: new Uint8Array(n) };
  for (let i = 0; i < n; i++) mask.data[i] = bg[i] ? 0 : 1;
  mask = close(open(mask, 1), 1);
  return { mask: keepMainSubject(mask), key: k };
}

export function erode(m: Mask, r = 1): Mask {
  const { width: w, height: h } = m;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 1;
    for (let dy = -r; dy <= r && v; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h || !m.data[yy * w + xx]) { v = 0; break; }
    }
    out[y * w + x] = v;
  }
  return { width: w, height: h, data: out };
}

export function dilate(m: Mask, r = 1): Mask {
  const { width: w, height: h } = m;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!m.data[y * w + x]) continue;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 1;
    }
  }
  return { width: w, height: h, data: out };
}

export const open = (m: Mask, r = 1) => dilate(erode(m, r), r);
export const close = (m: Mask, r = 1) => erode(dilate(m, r), r);

const LUMA = [0.299, 0.587, 0.114];

/**
 * Remove the key color's cast from the subject ("despill"). The generated images light the
 * subject with the background color: silver armor turns pink on magenta, and the anti-aliased
 * outline keeps a pink fringe. Where the key's strong channels rise above its weak ones, they
 * are pulled down and the lost brightness is spread over all channels, so a pinkish silver
 * becomes neutral silver with the same lightness. Real subject colors are safe because the key
 * is chosen far from the subject's palette, and inside the subject the correction is capped
 * (a tint is a few dozen levels; a saturated color is far more). The outline band is fully
 * cleaned.
 */
export function despill(img: RGBImage, key: [number, number, number], mask?: Mask, opts: { cap?: number; edge?: number } = {}): RGBImage {
  const hi = [0, 1, 2].filter((c) => key[c] >= 128), lo = [0, 1, 2].filter((c) => key[c] < 128);
  if (!hi.length || !lo.length) return img; // grey key: nothing to remove
  const cap = opts.cap ?? 48;
  const n = img.width * img.height;
  const inner = mask ? erode(mask, opts.edge ?? 2) : null;
  const out = new Uint8Array(img.data);
  for (let i = 0; i < n; i++) {
    const d = i * 3;
    let strong = 255, weak = 0;
    for (const c of hi) strong = Math.min(strong, out[d + c]);
    for (const c of lo) weak = Math.max(weak, out[d + c]);
    let spill = strong - weak;
    if (spill <= 0) continue;
    if (!inner || inner.data[i]) spill = Math.min(spill, cap);
    let lost = 0;
    for (const c of hi) { out[d + c] -= spill; lost += LUMA[c] * spill; }
    for (let c = 0; c < 3; c++) out[d + c] = Math.min(255, Math.round(out[d + c] + lost));
  }
  return { width: img.width, height: img.height, data: out };
}

export interface Component {
  area: number;
  pixels: number[];
  minX: number; minY: number; maxX: number; maxY: number;
}

/** 4-connected components of the set pixels. */
export function components(m: Mask): { list: Component[]; labels: Int32Array } {
  const { width: w, height: h, data } = m;
  const labels = new Int32Array(w * h).fill(-1);
  const list: Component[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!data[s] || labels[s] >= 0) continue;
    const c: Component = { area: 0, pixels: [], minX: w, minY: h, maxX: -1, maxY: -1 };
    const id = list.length;
    const stack = [s];
    labels[s] = id;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i / w) | 0;
      c.area++; c.pixels.push(i);
      if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x; if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && data[j] && labels[j] < 0) { labels[j] = id; stack.push(j); }
    }
    list.push(c);
  }
  return { list, labels };
}

/** Keep the largest blob plus any sizeable blob that overlaps its (slightly grown) box. */
export function keepMainSubject(m: Mask): Mask {
  const { list } = components(m);
  if (!list.length) return m;
  const main = list.reduce((a, b) => (b.area > a.area ? b : a));
  const gx = (main.maxX - main.minX) * 0.1, gy = (main.maxY - main.minY) * 0.1;
  const out = new Uint8Array(m.width * m.height);
  for (const c of list) {
    const overlaps = c.maxX >= main.minX - gx && c.minX <= main.maxX + gx && c.maxY >= main.minY - gy && c.minY <= main.maxY + gy;
    // Small separate pieces near the subject (a held sword, a feather) are kept; specks are not.
    if (c === main || (overlaps && c.area >= Math.max(12, main.area * 0.001))) for (const i of c.pixels) out[i] = 1;
  }
  return { width: m.width, height: m.height, data: out };
}

export function maskBBox(m: Mask): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = m.width, minY = m.height, maxX = -1, maxY = -1;
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) if (m.data[y * m.width + x]) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

export const maskArea = (m: Mask): number => m.data.reduce((a, b) => a + b, 0);

export function flipX(m: Mask): Mask {
  const out = new Uint8Array(m.width * m.height);
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) out[y * m.width + (m.width - 1 - x)] = m.data[y * m.width + x];
  return { width: m.width, height: m.height, data: out };
}

/** IoU of two equally sized masks. */
export function iou(a: Mask, b: Mask): number {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.data.length; i++) {
    const p = a.data[i], q = b.data[i];
    if (p && q) inter++;
    if (p || q) uni++;
  }
  return uni ? inter / uni : 1;
}

/**
 * Column of the best left/right mirror symmetry axis (sub-pixel, as a half-integer allowed).
 * Searched around the bounding-box centre; robust to a held item on one side.
 */
export function symmetryAxis(m: Mask, searchFrac = 0.2): number {
  const bb = maskBBox(m);
  if (!bb) return m.width / 2;
  // Search around the torso centre: a long held item can drag the bbox centre far off.
  const centre = coreCenter(m);
  const span = Math.max(2, Math.round((bb.maxX - bb.minX) * searchFrac));
  const rowStep = Math.max(1, Math.floor((bb.maxY - bb.minY + 1) / 200));
  let best = centre, bestScore = -1;
  for (let c2 = Math.round(2 * centre) - 2 * span; c2 <= Math.round(2 * centre) + 2 * span; c2++) {
    const c = c2 / 2; // axis at x = c (pixel centres at x + 0.5 are mirrored to 2c - x - 1)
    let inter = 0, uni = 0;
    for (let y = bb.minY; y <= bb.maxY; y += rowStep) for (let x = bb.minX; x <= bb.maxX; x++) {
      const xm = Math.round(2 * c - x - 1);
      const p = m.data[y * m.width + x];
      const q = xm >= 0 && xm < m.width ? m.data[y * m.width + xm] : 0;
      if (p && q) inter++;
      if (p || q) uni++;
    }
    const s = uni ? inter / uni : 0;
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best;
}

/**
 * Horizontal centre of the "core" of a standing subject: the median centre of the widest span
 * in each row between 35% and 75% of its height (the torso). Held items and capes that stick
 * out further down or up do not move it.
 */
export function coreCenter(m: Mask): number {
  const bb = maskBBox(m);
  if (!bb) return m.width / 2;
  const h = bb.maxY - bb.minY + 1;
  const centres: number[] = [];
  for (let y = Math.round(bb.maxY - 0.75 * h); y <= Math.round(bb.maxY - 0.35 * h); y++) {
    let best = 0, bestC = -1, start = -1;
    for (let x = bb.minX; x <= bb.maxX + 1; x++) {
      const on = x <= bb.maxX && m.data[y * m.width + x];
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        if (x - start > best) { best = x - start; bestC = (start + x) / 2; }
        start = -1;
      }
    }
    if (bestC >= 0) centres.push(bestC);
  }
  if (!centres.length) return (bb.minX + bb.maxX + 1) / 2;
  centres.sort((a, b) => a - b);
  return centres[Math.floor(centres.length / 2)];
}

// ---------------------------------------------------------------- palette

/** k-means in Lab over the masked pixels. Returns clusters sorted by share. */
export function palette(img: RGBImage, mask: Mask | null, k = 8, maxSamples = 20000): { hex: string; share: number }[] {
  const samples: { lab: Lab; rgb: [number, number, number] }[] = [];
  const n = img.width * img.height;
  const stride = Math.max(1, Math.floor(n / maxSamples));
  for (let i = 0; i < n; i += stride) {
    if (mask && !mask.data[i]) continue;
    const r = img.data[i * 3], g = img.data[i * 3 + 1], b = img.data[i * 3 + 2];
    samples.push({ lab: rgbToLab(r, g, b), rgb: [r, g, b] });
  }
  if (!samples.length) return [];
  k = Math.min(k, samples.length);
  // k-means++ style seeding (deterministic: farthest-point)
  const centres: Lab[] = [samples[Math.floor(samples.length / 2)].lab];
  while (centres.length < k) {
    let far = 0, farD = -1;
    for (let i = 0; i < samples.length; i++) {
      const d = Math.min(...centres.map((c) => deltaE(c, samples[i].lab)));
      if (d > farD) { farD = d; far = i; }
    }
    centres.push(samples[far].lab);
  }
  const assign = new Int32Array(samples.length);
  for (let it = 0; it < 12; it++) {
    for (let i = 0; i < samples.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < centres.length; c++) { const d = deltaE(centres[c], samples[i].lab); if (d < bd) { bd = d; best = c; } }
      assign[i] = best;
    }
    for (let c = 0; c < centres.length; c++) {
      let L = 0, A = 0, B = 0, cnt = 0;
      for (let i = 0; i < samples.length; i++) if (assign[i] === c) { L += samples[i].lab[0]; A += samples[i].lab[1]; B += samples[i].lab[2]; cnt++; }
      if (cnt) centres[c] = [L / cnt, A / cnt, B / cnt];
    }
  }
  const out: { hex: string; share: number; lab: Lab }[] = [];
  for (let c = 0; c < centres.length; c++) {
    const members = samples.filter((_, i) => assign[i] === c);
    if (!members.length) continue;
    // Report the median member color (a real pixel color, not a blend).
    const med = (ch: number) => { const v = members.map((m) => m.rgb[ch]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
    out.push({ hex: rgbToHex(med(0), med(1), med(2)), share: members.length / samples.length, lab: centres[c] });
  }
  // Merge near-duplicates (ΔE < 8)
  out.sort((a, b) => b.share - a.share);
  const merged: typeof out = [];
  for (const c of out) {
    const m = merged.find((x) => deltaE(x.lab, c.lab) < 8);
    if (m) m.share += c.share;
    else merged.push(c);
  }
  return merged.filter((c) => c.share >= 0.01).map(({ hex, share }) => ({ hex, share: Math.round(share * 1000) / 1000 }));
}

// ---------------------------------------------------------------- distances

/** Boundary pixels: set pixels with at least one unset 4-neighbour (or the image edge). */
export function boundary(m: Mask): Uint8Array {
  const { width: w, height: h, data } = m;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!data[i]) continue;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !data[i - 1] || !data[i + 1] || !data[i - w] || !data[i + w]) out[i] = 1;
  }
  return out;
}

/** Chamfer (3-4) distance transform to the nearest set pixel, in pixels. */
export function distanceTo(set: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = set[i] ? 0 : INF;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 3);
    if (y > 0) {
      d[i] = Math.min(d[i], d[i - w] + 3);
      if (x > 0) d[i] = Math.min(d[i], d[i - w - 1] + 4);
      if (x < w - 1) d[i] = Math.min(d[i], d[i - w + 1] + 4);
    }
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (x < w - 1) d[i] = Math.min(d[i], d[i + 1] + 3);
    if (y < h - 1) {
      d[i] = Math.min(d[i], d[i + w] + 3);
      if (x < w - 1) d[i] = Math.min(d[i], d[i + w + 1] + 4);
      if (x > 0) d[i] = Math.min(d[i], d[i + w - 1] + 4);
    }
  }
  for (let i = 0; i < w * h; i++) d[i] /= 3;
  return d;
}

/** Symmetric boundary distance between two masks: mean and 95th percentile, in pixels. */
export function boundaryError(a: Mask, b: Mask): { mean: number; p95: number } {
  const ba = boundary(a), bb = boundary(b);
  const da = distanceTo(ba, a.width, a.height), db = distanceTo(bb, b.width, b.height);
  const ds: number[] = [];
  for (let i = 0; i < ba.length; i++) {
    if (ba[i]) ds.push(db[i]);
    if (bb[i]) ds.push(da[i]);
  }
  if (!ds.length) return { mean: 0, p95: 0 };
  ds.sort((x, y) => x - y);
  return { mean: ds.reduce((s, v) => s + v, 0) / ds.length, p95: ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.95))] };
}
