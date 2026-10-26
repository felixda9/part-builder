// "Does the model look like the reference?" beyond the outline. Pure functions on pixel arrays:
//   structure  visible lines inside the outline (seams, plate edges, belt / knee lines), as edge
//              maps and as line segments in world coordinates, ref vs model
//   details    small features (eye slits, rivets, buttons) in the ref vs small parts in the model
//   color      reference pixels mapped to the model's palette vs the part colors, shading-tolerant
// The model side is computed from the rasterizer's buffers (depth steps, normal changes, color
// changes), which is what a lit render would show as edges - no outline drawing involved.

import { type OrthoFrame, type OrthoView, type RasterResult, viewAxes } from '../core/raster';
import type { Part } from '../core/scene';
import { type Lab, type Mask, boundary, components, deltaE, distanceTo, hexToRgb, rgbToLab } from './imaging';

// ------------------------------------------------------------------------------- basics

export function luminanceOf(px: Uint8Array | Buffer, w: number, h: number, channels: number): Float32Array {
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = rgbToLab(px[i * channels], px[i * channels + 1], px[i * channels + 2])[0] / 100;
  return L;
}

export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0.3) return src.slice();
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += k[i + r] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
    tmp[y * w + x] = a;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
    out[y * w + x] = a;
  }
  return out;
}

function percentile(values: Float32Array | number[], p: number): number {
  const a = Array.from(values).sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
}

/** Pixels at least `inset` px inside the mask (keeps outline edges out of the structure check). */
export function interior(m: Mask, inset: number): Uint8Array {
  const d = distanceTo(boundary(m), m.width, m.height);
  const out = new Uint8Array(m.data.length);
  for (let i = 0; i < out.length; i++) out[i] = m.data[i] && d[i] >= inset ? 1 : 0;
  return out;
}

// ------------------------------------------------------------------------------- edges

export interface EdgeMap {
  w: number;
  h: number;
  edge: Uint8Array; // any edge pixel
  horiz: Uint8Array; // part of a horizontal line (brightness changes vertically)
  vert: Uint8Array; // part of a vertical line
}

/** Edges in a reference image: Sobel on blurred luminance, thinned, thresholded, interior only. */
export function imageEdges(L: Float32Array, region: Uint8Array, w: number, h: number, opts: { sigma?: number; pct?: number; min?: number } = {}): EdgeMap {
  const B = gaussianBlur(L, w, h, opts.sigma ?? 1.2);
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const a = B[i - w - 1], b = B[i - w], c = B[i - w + 1], d = B[i - 1], f = B[i + 1], g = B[i + w - 1], hh = B[i + w], k = B[i + w + 1];
    gx[i] = (c + 2 * f + k - a - 2 * d - g) / 8;
    gy[i] = (g + 2 * hh + k - a - 2 * b - c) / 8;
    mag[i] = Math.hypot(gx[i], gy[i]);
  }
  const inside: number[] = [];
  for (let i = 0; i < mag.length; i++) if (region[i]) inside.push(mag[i]);
  const t = Math.max(opts.min ?? 0.012, percentile(inside, opts.pct ?? 0.86));
  const edge = new Uint8Array(w * h), horiz = new Uint8Array(w * h), vert = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!region[i] || mag[i] < t) continue;
    // Thin to the ridge along the gradient direction.
    const alongX = Math.abs(gx[i]) >= Math.abs(gy[i]);
    const n1 = alongX ? mag[i - 1] : mag[i - w], n2 = alongX ? mag[i + 1] : mag[i + w];
    if (mag[i] < n1 || mag[i] < n2) continue;
    edge[i] = 1;
    if (Math.abs(gy[i]) > 1.5 * Math.abs(gx[i])) horiz[i] = 1;
    else if (Math.abs(gx[i]) > 1.5 * Math.abs(gy[i])) vert[i] = 1;
  }
  return { w, h, edge, horiz, vert };
}

/**
 * Visible edges of the model from the rasterizer buffers: a depth step, a change of face
 * orientation, or a change of color between neighbouring pixels. Coplanar same-colored parts
 * that touch show no edge - as in a rendered image.
 */
export function modelEdges(res: RasterResult, parts: Part[], region: Uint8Array, ppu: number): EdgeMap {
  const { width: w, height: h, partIndex, faceIndex, depth } = res;
  const normals = res.faceNormals ?? [];
  const labs: Lab[] = parts.map((p) => rgbToLab(...hexToRgb(p.color)));
  const edge = new Uint8Array(w * h), horiz = new Uint8Array(w * h), vert = new Uint8Array(w * h);
  const differs = (i: number, j: number): boolean => {
    const a = partIndex[i], b = partIndex[j];
    if (a < 0 || b < 0) return false;
    if (Math.abs(depth[i] - depth[j]) > Math.max(0.03, 2 / ppu)) return true;
    if (faceIndex[i] !== faceIndex[j]) {
      const na = normals[faceIndex[i]], nb = normals[faceIndex[j]];
      if (na && nb && na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2] < 0.995) return true;
    }
    return a !== b && deltaE(labs[a], labs[b]) > 6;
  };
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const i = y * w + x;
    if (!region[i]) continue;
    if (differs(i, i + 1)) { edge[i] = 1; vert[i] = 1; }
    if (differs(i, i + w)) { edge[i] = 1; horiz[i] = 1; }
  }
  return { w, h, edge, horiz, vert };
}

/** Precision / recall / F1 of model edges against reference edges, within `tol` pixels. */
export function edgeScore(ref: EdgeMap, model: EdgeMap, tol: number): { precision: number; recall: number; f1: number } {
  const dRef = distanceTo(ref.edge, ref.w, ref.h), dModel = distanceTo(model.edge, model.w, model.h);
  let tp = 0, nm = 0, hit = 0, nr = 0;
  for (let i = 0; i < ref.edge.length; i++) {
    if (model.edge[i]) { nm++; if (dRef[i] <= tol) tp++; }
    if (ref.edge[i]) { nr++; if (dModel[i] <= tol) hit++; }
  }
  const precision = nm ? tp / nm : 1, recall = nr ? hit / nr : 1;
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
}

// ------------------------------------------------------------------------------- lines

export interface LineSeg {
  orient: 'h' | 'v';
  /** World coordinate of the line across it (y for a horizontal line in the front view). */
  pos: number;
  /** World extent along the line. */
  from: number;
  to: number;
  /** Axis names in this view, for messages. */
  posAxis: string;
  alongAxis: string;
}

/** Group edge pixels into straight horizontal / vertical segments at least `minLen` studs long. */
export function extractLines(E: EdgeMap, frame: OrthoFrame, minLen = 0.3): LineSeg[] {
  const { w, h } = E;
  const P = frame.ppu;
  const ax = viewAxes(frame.view as OrthoView);
  const out: LineSeg[] = [];
  const gap = 2;
  for (const orient of ['h', 'v'] as const) {
    const map = orient === 'h' ? E.horiz : E.vert;
    const lines = orient === 'h' ? h : w; // rows or columns
    const len = orient === 'h' ? w : h;
    const at = (line: number, k: number) => (orient === 'h' ? map[line * w + k] : map[k * w + line]);
    // Candidate runs per row/column (tolerating 1-px wobble by OR-ing neighbours).
    const runs: { line: number; a: number; b: number }[] = [];
    for (let line = 1; line < lines - 1; line++) {
      let start = -1, lastOn = -10;
      for (let k = 0; k <= len; k++) {
        const on = k < len && (at(line, k) || at(line - 1, k) || at(line + 1, k));
        if (on) { if (start < 0) start = k; lastOn = k; }
        else if (start >= 0 && k - lastOn > gap) {
          if (lastOn - start + 1 >= minLen * P) runs.push({ line, a: start, b: lastOn });
          start = -1;
        }
      }
    }
    // Merge runs on nearby rows/columns that overlap into one segment.
    runs.sort((p, q) => p.line - q.line);
    const used = new Uint8Array(runs.length);
    for (let i = 0; i < runs.length; i++) {
      if (used[i]) continue;
      let a = runs[i].a, b = runs[i].b, sum = runs[i].line, n = 1, last = runs[i].line;
      used[i] = 1;
      for (let j = i + 1; j < runs.length && runs[j].line - last <= 3; j++) {
        if (used[j]) continue;
        const ov = Math.min(b, runs[j].b) - Math.max(a, runs[j].a);
        if (ov > 0.5 * Math.min(b - a, runs[j].b - runs[j].a)) {
          a = Math.min(a, runs[j].a); b = Math.max(b, runs[j].b); sum += runs[j].line; n++; last = runs[j].line; used[j] = 1;
        }
      }
      const line = sum / n + 0.5;
      if (orient === 'h') {
        const v = frame.v0 - line / P, u1 = frame.u0 + a / P, u2 = frame.u0 + (b + 1) / P;
        const [f, t] = [u1 * ax.h.sign, u2 * ax.h.sign].sort((p, q) => p - q);
        out.push({ orient, pos: v * ax.v.sign, from: f, to: t, posAxis: ax.v.axis, alongAxis: ax.h.axis });
      } else {
        const u = frame.u0 + line / P, v1 = frame.v0 - a / P, v2 = frame.v0 - (b + 1) / P;
        const [f, t] = [v1 * ax.v.sign, v2 * ax.v.sign].sort((p, q) => p - q);
        out.push({ orient, pos: u * ax.h.sign, from: f, to: t, posAxis: ax.h.axis, alongAxis: ax.v.axis });
      }
    }
  }
  return out;
}

export interface LineMatch {
  matched: { ref: LineSeg; model: LineSeg }[];
  missing: LineSeg[]; // in the reference, no model line nearby
  extra: LineSeg[]; // in the model, not in the reference
  recall: number; // matched ref length / ref length
  precision: number;
}

export function matchLines(ref: LineSeg[], model: LineSeg[], tol: number): LineMatch {
  const len = (l: LineSeg) => l.to - l.from;
  const pairs: { r: number; m: number; d: number }[] = [];
  ref.forEach((r, ri) => model.forEach((m, mi) => {
    if (r.orient !== m.orient) return;
    const d = Math.abs(r.pos - m.pos);
    const ov = Math.min(r.to, m.to) - Math.max(r.from, m.from);
    if (d <= tol && ov >= 0.5 * Math.min(len(r), len(m))) pairs.push({ r: ri, m: mi, d });
  }));
  pairs.sort((a, b) => a.d - b.d);
  const ru = new Set<number>(), mu = new Set<number>();
  const matched: LineMatch['matched'] = [];
  for (const p of pairs) {
    if (ru.has(p.r) || mu.has(p.m)) continue;
    ru.add(p.r); mu.add(p.m);
    matched.push({ ref: ref[p.r], model: model[p.m] });
  }
  const total = (ls: LineSeg[]) => ls.reduce((s, l) => s + len(l), 0);
  const refLen = total(ref), modelLen = total(model);
  return {
    matched,
    missing: ref.filter((_, i) => !ru.has(i)).sort((a, b) => len(b) - len(a)),
    extra: model.filter((_, i) => !mu.has(i)).sort((a, b) => len(b) - len(a)),
    recall: refLen ? total(matched.map((m) => m.ref)) / refLen : 1,
    precision: modelLen ? total(matched.map((m) => m.model)) / modelLen : 1,
  };
}

export function describeLine(l: LineSeg): string {
  const f = (v: number) => v.toFixed(2);
  return `${l.orient === 'h' ? 'horizontal' : 'vertical'} line at ${l.posAxis} ${f(l.pos)}, ${l.alongAxis} ${f(l.from)}..${f(l.to)}`;
}

// ------------------------------------------------------------------------------- small details

export interface Spot {
  h: number; // world coordinate along the view's horizontal axis
  v: number; // along its vertical axis
  sizeH: number;
  sizeV: number;
  dark: boolean;
  hAxis: string;
  vAxis: string;
  part?: string;
}

/**
 * Small details (eye slits, rivets, buttons): small, compact, isolated clusters of edge pixels -
 * the outline of a little bump or hole. Long lines and big shapes are left to the line check.
 * `dark` says whether the inside is darker than its surroundings (eye slit) or not (rivet).
 */
export function findSpots(E: EdgeMap, L: Float32Array, frame: OrthoFrame, opts: { minSize?: number; maxSize?: number } = {}): Spot[] {
  const w = frame.width, h = frame.height, P = frame.ppu;
  const minS = opts.minSize ?? 0.05, maxS = opts.maxSize ?? 0.32;
  // Remove long straight runs first, so a rivet on a belt line or an eye slit under a visor
  // brim is not swallowed by the line it touches.
  const rest = E.edge.slice();
  const long = Math.round(0.25 * P);
  for (let y = 0; y < h; y++) {
    let s = -1;
    for (let x = 0; x <= w; x++) {
      const on = x < w && E.horiz[y * w + x];
      if (on && s < 0) s = x;
      if (!on && s >= 0) { if (x - s >= long) for (let k = s; k < x; k++) rest[y * w + k] = 0; s = -1; }
    }
  }
  for (let x = 0; x < w; x++) {
    let s = -1;
    for (let y = 0; y <= h; y++) {
      const on = y < h && E.vert[y * w + x];
      if (on && s < 0) s = y;
      if (!on && s >= 0) { if (y - s >= long) for (let k = s; k < y; k++) rest[k * w + x] = 0; s = -1; }
    }
  }
  // 8-connected clusters: bridge 1-px gaps by dilating once.
  const grown = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (rest[i]) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) grown[i + dy * w + dx] = 1;
  }
  const ax = viewAxes(frame.view as OrthoView);
  const out: Spot[] = [];
  for (const c of components({ width: w, height: h, data: grown }).list) {
    const bw = (c.maxX - c.minX + 1) / P, bh = (c.maxY - c.minY + 1) / P;
    if (Math.max(bw, bh) > maxS || Math.min(bw, bh) < minS) continue;
    if (Math.max(bw, bh) / Math.min(bw, bh) > 3.5) continue; // a short line, not a detail
    // Inside vs ring brightness tells dark holes (eye slits) from raised bits (rivets).
    let inS = 0, inN = 0, outS = 0, outN = 0;
    const cx0 = c.minX, cy0 = c.minY, cx1 = c.maxX, cy1 = c.maxY;
    const pad = Math.max(2, Math.round(0.04 * P));
    for (let y = Math.max(0, cy0 - pad); y <= Math.min(h - 1, cy1 + pad); y++) for (let x = Math.max(0, cx0 - pad); x <= Math.min(w - 1, cx1 + pad); x++) {
      const inside = x > cx0 && x < cx1 && y > cy0 && y < cy1;
      if (inside) { inS += L[y * w + x]; inN++; } else if (x < cx0 || x > cx1 || y < cy0 || y > cy1) { outS += L[y * w + x]; outN++; }
    }
    const dark = inN > 0 && outN > 0 && inS / inN < outS / outN - 0.08;
    const cx = (c.minX + c.maxX + 1) / 2, cy = (c.minY + c.maxY + 1) / 2;
    out.push({ h: (frame.u0 + cx / P) * ax.h.sign, v: (frame.v0 - cy / P) * ax.v.sign, sizeH: bw, sizeV: bh, dark, hAxis: ax.h.axis, vAxis: ax.v.axis });
  }
  return out;
}

/** Strongly dark small holes (eye slits, visor gaps) - complements findSpots. */
export function findDarkSpots(L: Float32Array, region: Uint8Array, frame: OrthoFrame, opts: { minContrast?: number; maxSize?: number } = {}): Spot[] {
  const w = frame.width, h = frame.height, P = frame.ppu;
  const fine = gaussianBlur(L, w, h, 0.8);
  const coarse = gaussianBlur(L, w, h, 0.15 * P);
  const m = new Uint8Array(w * h);
  const t = opts.minContrast ?? 0.15;
  // Very dark and darker than the surroundings: holes, not shadows under ledges.
  for (let i = 0; i < m.length; i++) m[i] = region[i] && fine[i] < 0.3 && coarse[i] - fine[i] > t ? 1 : 0;
  const ax = viewAxes(frame.view as OrthoView);
  const out: Spot[] = [];
  for (const c of components({ width: w, height: h, data: m }).list) {
    const bw = (c.maxX - c.minX + 1) / P, bh = (c.maxY - c.minY + 1) / P;
    if (Math.max(bw, bh) > (opts.maxSize ?? 0.32) || Math.max(bw, bh) < 0.04 || c.area < 5) continue;
    const cx = (c.minX + c.maxX + 1) / 2, cy = (c.minY + c.maxY + 1) / 2;
    out.push({ h: (frame.u0 + cx / P) * ax.h.sign, v: (frame.v0 - cy / P) * ax.v.sign, sizeH: bw, sizeV: bh, dark: true, hAxis: ax.h.axis, vAxis: ax.v.axis });
  }
  return out;
}

/** Union of spot lists, dropping near-duplicates (centres closer than `tol` studs). */
export function mergeSpots(a: Spot[], b: Spot[], tol = 0.1): Spot[] {
  const out = [...a];
  for (const s of b) if (!out.some((o) => Math.hypot(o.h - s.h, o.v - s.v) < tol)) out.push(s);
  return out;
}

/** The model's small visible parts (largest side <= maxSize) as spots. */
export function modelSpots(res: RasterResult, parts: Part[], frame: OrthoFrame, maxSize = 0.45): Spot[] {
  const P = frame.ppu;
  const ax = viewAxes(frame.view as OrthoView);
  const acc = new Map<number, { n: number; minX: number; minY: number; maxX: number; maxY: number }>();
  for (let y = 0; y < res.height; y++) for (let x = 0; x < res.width; x++) {
    const p = res.partIndex[y * res.width + x];
    if (p < 0 || Math.max(...parts[p].size) > maxSize) continue;
    const a = acc.get(p) ?? { n: 0, minX: x, minY: y, maxX: x, maxY: y };
    a.n++; a.minX = Math.min(a.minX, x); a.minY = Math.min(a.minY, y); a.maxX = Math.max(a.maxX, x); a.maxY = Math.max(a.maxY, y);
    acc.set(p, a);
  }
  const out: Spot[] = [];
  for (const [p, a] of acc) {
    const bw = (a.maxX - a.minX + 1) / P, bh = (a.maxY - a.minY + 1) / P;
    // Seen edge-on (a sliver) it isn't a visible detail from this side.
    if (a.n < 4 || Math.min(bw, bh) < 0.06 || Math.max(bw, bh) / Math.min(bw, bh) > 3.5) continue;
    const cx = (a.minX + a.maxX + 1) / 2, cy = (a.minY + a.maxY + 1) / 2;
    const lab = rgbToLab(...hexToRgb(parts[p].color));
    out.push({
      h: (frame.u0 + cx / P) * ax.h.sign, v: (frame.v0 - cy / P) * ax.v.sign,
      sizeH: (a.maxX - a.minX + 1) / P, sizeV: (a.maxY - a.minY + 1) / P, dark: lab[0] < 45, hAxis: ax.h.axis, vAxis: ax.v.axis, part: parts[p].name,
    });
  }
  return out;
}

export function matchSpots(ref: Spot[], model: Spot[], tol: number): { missing: Spot[]; extra: Spot[]; recall: number; precision: number } {
  const pairs: { r: number; m: number; d: number }[] = [];
  ref.forEach((r, ri) => model.forEach((m, mi) => {
    const d = Math.hypot(r.h - m.h, r.v - m.v);
    if (d <= tol + 0.5 * Math.max(m.sizeH, m.sizeV)) pairs.push({ r: ri, m: mi, d });
  }));
  pairs.sort((a, b) => a.d - b.d);
  const ru = new Set<number>(), mu = new Set<number>();
  for (const p of pairs) if (!ru.has(p.r) && !mu.has(p.m)) { ru.add(p.r); mu.add(p.m); }
  return {
    missing: ref.filter((_, i) => !ru.has(i)),
    extra: model.filter((_, i) => !mu.has(i)),
    recall: ref.length ? ru.size / ref.length : 1,
    precision: model.length ? mu.size / model.length : 1,
  };
}

// ------------------------------------------------------------------------------- color layout

/**
 * Color families: palette entries that differ mostly in lightness (silver / dark silver / light
 * silver, two blues) are one family, because the reference's shading changes lightness more than
 * anything else. Family = index of its first member.
 */
export function paletteFamilies(palette: string[]): number[] {
  const pl = palette.map((c) => rgbToLab(...hexToRgb(c)));
  const fam = palette.map((_, i) => i);
  const find = (i: number): number => (fam[i] === i ? i : (fam[i] = find(fam[i])));
  const chromaOf = (c: Lab) => Math.hypot(c[1], c[2]);
  const hueOf = (c: Lab) => Math.atan2(c[2], c[1]);
  for (let i = 0; i < pl.length; i++) for (let j = i + 1; j < pl.length; j++) {
    if (Math.abs(pl[i][0] - pl[j][0]) >= 30) continue;
    const ci = chromaOf(pl[i]), cj = chromaOf(pl[j]);
    const greys = ci < 15 && cj < 15 && Math.hypot(pl[i][1] - pl[j][1], pl[i][2] - pl[j][2]) < 15;
    let dh = Math.abs(hueOf(pl[i]) - hueOf(pl[j]));
    if (dh > Math.PI) dh = 2 * Math.PI - dh;
    const sameHue = ci >= 15 && cj >= 15 && dh < (20 * Math.PI) / 180;
    if (greys || sameHue) fam[find(j)] = find(i);
  }
  return fam.map((_, i) => find(i));
}

/** Palette family of a color: nearest palette entry (lightness weighted down), then its family. */
export function paletteLabeler(palette: string[]): (lab: Lab) => number {
  const pl = palette.map((c) => rgbToLab(...hexToRgb(c)));
  const fam = paletteFamilies(palette);
  return (lab) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < pl.length; i++) {
      const d = 0.4 * (lab[0] - pl[i][0]) ** 2 + (lab[1] - pl[i][1]) ** 2 + (lab[2] - pl[i][2]) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return fam[best];
  };
}

/** "p0/p1/p5 #a3a4b5" style name for a family. */
export function familyName(palette: string[], family: number): string {
  const fam = paletteFamilies(palette);
  const members = palette.map((_, i) => i).filter((i) => fam[i] === family);
  return `${members.map((i) => `p${i}`).join('/')} ${palette[family]}`;
}
