// Rounded-off parts: one plan box becomes a core plus wedges and corner wedges, so its ends and
// long edges slope instead of ending in a flat 90-degree cut. Pure geometry, no scene access.
//
// End bevel ("ends"): the box is shortened by `depth` at that end; the end becomes a smaller
// cap ringed by four wedges and four corner wedges (hip corners), all at one slope. With a cap
// size of 0 the slopes meet in a ridge or a point.
// Long edges ("edges"): the edges along the part are cut off by wedges over the whole length.

import type { AxisDir, Vec3 } from './math';

export interface Bevel {
  ends?: AxisDir[];
  size: number;
  /** A different size for one end (the slope angle stays the same), e.g. {'-z': 0.15}. */
  sizes?: Partial<Record<AxisDir, number>>;
  depth?: number;
  rim?: AxisDir[];
  /** A different rim for one end, e.g. {'-z': ['+x','-x','-y']} when the head sits on top of the chest end. */
  rims?: Partial<Record<AxisDir, AxisDir[]>>;
  edges?: string[];
  edgeSize?: number;
}

export interface BevelPiece {
  name: string;
  shape: 'Block' | 'Wedge' | 'CornerWedge';
  min: Vec3;
  max: Vec3;
  tall?: AxisDir;
  flat?: AxisDir;
  apex?: string;
  /** Build a linked mirror twin of this piece (+x pieces of a centred part, or a mirror part). */
  mirror: boolean;
}

const AX = 'xyz';
const EPS = 1e-6;
const axisOf = (d: string) => AX.indexOf(d[1]);
const signOf = (d: string) => (d[0] === '-' ? -1 : 1);
const dir = (sign: number, axis: number) => `${sign < 0 ? '-' : '+'}${AX[axis]}` as AxisDir;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

interface Ctx { min: Vec3; max: Vec3; b: Bevel; endAxis: number; u: number; v: number; s: number; d: number; c: number }

function context(min: Vec3, max: Vec3, b: Bevel): Ctx | null {
  const ends = b.ends ?? [];
  const edges = b.edges ?? [];
  let endAxis = -1;
  if (ends.length) endAxis = axisOf(ends[0]);
  else if (edges.length) endAxis = [0, 1, 2].find((i) => !edges[0].includes(AX[i])) ?? -1;
  if (endAxis < 0) return null;
  const perp = [0, 1, 2].filter((i) => i !== endAxis); // x first when it is one of them
  const s = b.size;
  const d = b.depth ?? s;
  const c = b.edgeSize ?? (ends.length ? Math.max(0.05, Math.round(s / 2 / 0.05) * 0.05) : s);
  return { min, max, b, endAxis, u: perp[0], v: perp[1], s, d, c };
}

const edgeFlag = (x: Ctx, su: number, sv: number) => {
  const a = `${dir(su, x.u)}${dir(sv, x.v)}`, b = `${dir(sv, x.v)}${dir(su, x.u)}`;
  return (x.b.edges ?? []).some((e) => e === a || e === b);
};
/** Size and depth of the slope at one end. */
const endSD = (x: Ctx, sign: number) => {
  const s = x.b.sizes?.[dir(sign, x.endAxis)] ?? x.s;
  return { s, d: r6((s * x.d) / x.s) };
};
const hasEnd = (x: Ctx, sign: number) => (x.b.ends ?? []).some((e) => axisOf(e) === x.endAxis && signOf(e) === sign);
const rimFlag = (x: Ctx, axis: number, sign: number, end: number) =>
  (x.b.rims?.[dir(end, x.endAxis)] ?? x.b.rim ?? [dir(-1, x.u), dir(1, x.u), dir(-1, x.v), dir(1, x.v)]).includes(dir(sign, axis));

/** Problems with a bevel on a box; empty when it can be built. */
export function bevelErrors(min: Vec3, max: Vec3, b: Bevel, centred: boolean): string[] {
  const errs: string[] = [];
  const x = context(min, max, b);
  if (!x) return ['bevel needs ends or edges'];
  const ends = b.ends ?? [];
  if (ends.some((e) => axisOf(e) !== x.endAxis)) errs.push('bevel ends must be on one axis (one end or both ends of the part); slope other sides with separate wedges');
  for (const e of b.edges ?? []) {
    if (!/^[+-][xyz][+-][xyz]$/.test(e) || e[1] === e[3]) errs.push(`bevel edge "${e}" must name two different axes, e.g. '+x+y'`);
    else if (e.includes(AX[x.endAxis])) errs.push(`bevel edge "${e}" must run along the part (${AX[x.endAxis]}), between two side faces`);
  }
  for (const r of [...(b.rim ?? []), ...Object.values(b.rims ?? {}).flat()]) if (r && axisOf(r) === x.endAxis) errs.push(`bevel rim "${r}" must be a side of the end, not the end itself`);
  if (centred && ends.some((e) => e[1] === 'x')) errs.push('a centred part cannot bevel its +x/-x side as an end; use edges or wedges');
  if (centred && x.u === 0) {
    for (const sv of [-1, 1]) if (edgeFlag(x, 1, sv) !== edgeFlag(x, -1, sv)) errs.push('a centred part needs the same long edges on both sides (e.g. +x+y and -x+y)');
    for (const sa of [-1, 1]) if (rimFlag(x, 0, 1, sa) !== rimFlag(x, 0, -1, sa)) errs.push('a centred part needs the same rim on both sides (+x and -x)');
  }
  if (x.s < 0.05 - EPS || x.d < 0.05 - EPS) errs.push('bevel size and depth must be at least 0.05');
  const ext = (i: number) => max[i] - min[i];
  const signs = [-1, 1].filter((sa) => hasEnd(x, sa));
  const nEnds = signs.length;
  const depthSum = signs.reduce((sum, sa) => sum + endSD(x, sa).d, 0);
  if (nEnds && ext(x.endAxis) - depthSum < 0.05 - EPS) errs.push(`bevel depth ${r6(depthSum)} is too deep: the part is only ${r6(ext(x.endAxis))} long along ${AX[x.endAxis]}`);
  const onGrid = (v: number, step = 0.05) => Math.abs(v / step - Math.round(v / step)) < 1e-6;
  if (![x.s, x.d, x.c].every((v) => onGrid(v))) errs.push('bevel size, depth and edgeSize must be multiples of 0.05 (the snap grid)');
  for (const sa of signs) {
    const { s, d } = endSD(x, sa);
    const at = `the ${dir(sa, x.endAxis)} end`;
    if (!onGrid(s) || !onGrid(d)) errs.push(`${at}: size ${s} and depth ${d} must be multiples of 0.05`);
    for (const w of [x.u, x.v]) {
      const left = ext(w) - s * ((rimFlag(x, w, -1, sa) ? 1 : 0) + (rimFlag(x, w, 1, sa) ? 1 : 0));
      if (left < -EPS || (left > EPS && left < 0.05 - EPS)) errs.push(`${at}: size ${s} leaves a cap ${r6(left)} wide on ${AX[w]}; use ${r6(ext(w) / 2)} for a ridge or less for a flat cap >= 0.05`);
    }
    if (!b.edges?.length) continue;
    if (x.c > s + EPS) errs.push(`${at}: edgeSize must not be bigger than its size ${s}`);
    const h = (d * x.c) / s, t = s - x.c;
    for (const su of [-1, 1]) for (const sv of [-1, 1]) {
      if (!edgeFlag(x, su, sv)) continue;
      const inRim = (rimFlag(x, x.u, su, sa) ? 1 : 0) + (rimFlag(x, x.v, sv, sa) ? 1 : 0);
      const edge = `long edge ${dir(su, x.u)}${dir(sv, x.v)}`;
      if (inRim === 0) errs.push(`${edge} needs at least one of its sides in the rim (or leave the edge out)`);
      // Where the cut meets the end slopes the corner is filled with pieces of size - edgeSize,
      // edgeSize/2 and depth * edgeSize / size, so those must sit on the grid.
      if (inRim === 2 && (!onGrid(x.c, 0.1) || !onGrid(h, 0.1) || h < 0.1 - EPS)) errs.push(`${at}: where ${edge} meets the end slopes, edgeSize and depth*edgeSize/size (${r6(h)}) must be multiples of 0.1 - e.g. edgeSize ${s >= 0.2 ? 0.1 : s}${s === d ? '' : ' with depth = size'}`);
      if (inRim === 1 && (!onGrid(h) || h < 0.05 - EPS)) errs.push(`${at}: ${edge} meets an unsloped side: depth*edgeSize/size (${r6(h)}) must be a multiple of 0.05`);
      if (inRim && t > EPS && (t < 0.05 - EPS || d - h < 0.05 - EPS)) errs.push(`${at}: edgeSize must be equal to size or at least 0.05 smaller`);
    }
  }
  if (b.edges?.length) {
    if (x.c < 0.05 - EPS) errs.push('bevel edgeSize must be at least 0.05');
    for (const [w, other] of [[x.u, x.v], [x.v, x.u]]) {
      for (const sw of [-1, 1]) {
        const n = [-1, 1].filter((so) => (w === x.u ? edgeFlag(x, sw, so) : edgeFlag(x, so, sw))).length;
        if (n && ext(other) - n * x.c < 0.05 - EPS) errs.push(`bevel edgeSize ${x.c} is too big for the part's ${AX[other]} size`);
      }
    }
  }
  return errs;
}

/**
 * The pieces of a bevelled box. The first piece keeps the part's name (the core).
 * `centred`: the part sits on x = 0 - only its +x side pieces are listed (named Right...,
 * mirror: true), the -x side comes from their twins. Otherwise every piece is listed and
 * x sides are named Outer/Inner; `mirror` marks them all for twins.
 */
export function bevelPieces(name: string, min: Vec3, max: Vec3, b: Bevel, opts: { centred: boolean; mirror: boolean }): BevelPiece[] {
  const x = context(min, max, b);
  if (!x) return [{ name, shape: 'Block', min, max, mirror: opts.mirror }];
  const { u, v, endAxis: a, c } = x;
  const cx = (min[0] + max[0]) / 2;
  const sideLabel = (sign: number) => (opts.centred ? 'Side' : Math.sign(sign) === Math.sign(cx || 1) ? 'Outer' : 'Inner');
  const label = (axis: number, sign: number) => (axis === 0 ? sideLabel(sign) : axis === 1 ? (sign > 0 ? 'Top' : 'Bottom') : sign > 0 ? 'Back' : 'Front');
  const pieces: BevelPiece[] = [];
  const box = (ru: number[], rv: number[], ra: number[]) => {
    const lo = [0, 0, 0] as Vec3, hi = [0, 0, 0] as Vec3;
    lo[u] = r6(ru[0]); hi[u] = r6(ru[1]); lo[v] = r6(rv[0]); hi[v] = r6(rv[1]); lo[a] = r6(ra[0]); hi[a] = r6(ra[1]);
    return { min: lo, max: hi };
  };
  // A piece on the +x side of a centred part gets the Right prefix and a twin; -x pieces are skipped.
  const add = (base: string, p: Omit<BevelPiece, 'name' | 'mirror'>, xSide: number) => {
    if (opts.centred && xSide < 0) return;
    const side = opts.centred && xSide > 0;
    pieces.push({ ...p, name: side ? `Right${name}${base}` : `${name}${base}`, mirror: side || opts.mirror });
  };
  const xSideOf = (axis: number, sign: number) => (axis === 0 ? sign : 0);

  const a0 = min[a] + (hasEnd(x, -1) ? endSD(x, -1).d : 0), a1 = max[a] - (hasEnd(x, 1) ? endSD(x, 1).d : 0);
  const anyU = (su: number) => edgeFlag(x, su, -1) || edgeFlag(x, su, 1);
  // Core: full v height, narrowed on u where long edges are cut.
  pieces.push({ name, shape: 'Block', ...box([min[u] + (anyU(-1) ? c : 0), max[u] - (anyU(1) ? c : 0)], [min[v], max[v]], [a0, a1]), mirror: opts.mirror });
  for (const su of [-1, 1]) {
    if (!anyU(su)) continue;
    const ru = su > 0 ? [max[u] - c, max[u]] : [min[u], min[u] + c];
    add(u === 0 && opts.centred ? 'Side' : `${label(u, su)}Side`,
      { shape: 'Block', ...box(ru, [min[v] + (edgeFlag(x, su, -1) ? c : 0), max[v] - (edgeFlag(x, su, 1) ? c : 0)], [a0, a1]) }, xSideOf(u, su));
    for (const sv of [-1, 1]) {
      if (!edgeFlag(x, su, sv)) continue;
      add(`${u === 0 && opts.centred ? '' : label(u, su)}${label(v, sv)}Edge`, {
        shape: 'Wedge', ...box(ru, sv > 0 ? [max[v] - c, max[v]] : [min[v], min[v] + c], [a0, a1]), tall: dir(-su, u), flat: dir(-sv, v),
      }, xSideOf(u, su));
    }
  }
  // Ends: cap + ring of wedges + hip corner wedges.
  for (const sa of [-1, 1]) {
    if (!hasEnd(x, sa)) continue;
    const { s, d } = endSD(x, sa);
    const ra = sa > 0 ? [a1, max[a]] : [min[a], a0];
    const end = a === 0 ? sideLabel(sa) : label(a, sa);
    const lo = (w: number) => min[w] + (rimFlag(x, w, -1, sa) ? s : 0);
    const hi = (w: number) => max[w] - (rimFlag(x, w, 1, sa) ? s : 0);
    const open = (w: number) => hi(w) - lo(w) > EPS;
    if (open(u) && open(v)) add(end, { shape: 'Block', ...box([lo(u), hi(u)], [lo(v), hi(v)], ra) }, 0);
    for (const [w, other] of [[u, v], [v, u]]) {
      for (const sw of [-1, 1]) {
        if (!rimFlag(x, w, sw, sa) || !open(other)) continue;
        const rw = sw > 0 ? [hi(w), max[w]] : [min[w], lo(w)];
        const ro = [lo(other), hi(other)];
        const lab = w === 0 && opts.centred ? 'Side' : label(w, sw);
        const pick = (pw: number[], po: number[], pa: number[]) => (w === u ? box(pw, po, pa) : box(po, pw, pa));
        // A long edge cut reaching this end on a side that is not sloped (the rim leaves it
        // out): stop the wedge short of the cut and fill the strip so the cut runs on into the
        // end slope without anything sticking out.
        for (const so of [-1, 1]) {
          const cut = w === u ? edgeFlag(x, sw, so) : edgeFlag(x, so, sw);
          if (!cut || rimFlag(x, other, so, sa)) continue;
          if (so > 0) ro[1] = max[other] - c; else ro[0] = min[other] + c;
          const zone = so > 0 ? [max[other] - c, max[other]] : [min[other], min[other] + c];
          const t = s - c, h = (d * c) / s;
          const inW = sw > 0 ? hi(w) : lo(w), inA = sa > 0 ? a1 : a0;
          const wr = (p0: number, p1: number) => (sw > 0 ? [inW + p0, inW + p1] : [inW - p1, inW - p0]);
          const ar = (r0: number, r1: number) => (sa > 0 ? [inA + r0, inA + r1] : [inA - r1, inA - r0]);
          const name = `${end}${lab}${other === 0 && opts.centred ? '' : label(other, so)}`;
          const xs = other === 0 ? so : xSideOf(w, sw);
          if (t > EPS) {
            add(`${name}Base`, { shape: 'Block', ...pick(wr(0, t), zone, ar(0, h)) }, xs);
            add(`${name}Slope`, { shape: 'Wedge', ...pick(wr(0, t), zone, ar(h, d)), tall: dir(-sw, w), flat: dir(-sa, a) }, xs);
          }
          const signs: Record<number, number> = { [w]: sw, [other]: -so, [a]: -sa };
          add(`${name}Tip`, { shape: 'CornerWedge', ...pick(wr(t, s), zone, ar(0, h)), flat: dir(-sw, w), apex: [0, 1, 2].map((i) => dir(signs[i], i)).join('') }, xs);
        }
        add(`${end}${lab}`, { shape: 'Wedge', ...pick(rw, ro, ra), tall: dir(-sw, w), flat: dir(-sa, a) }, xSideOf(w, sw));
      }
    }
    for (const su of [-1, 1]) for (const sv of [-1, 1]) {
      if (!rimFlag(x, u, su, sa) || !rimFlag(x, v, sv, sa)) continue;
      const lab = `${end}${u === 0 && opts.centred ? '' : label(u, su)}${label(v, sv)}Corner`;
      const apexOf = (au: number, av: number, aa: number) => {
        const signs: Record<number, number> = { [u]: au, [v]: av, [a]: aa };
        return [0, 1, 2].map((i) => dir(signs[i], i)).join('');
      };
      // Corner-local coordinates: p outward along u from the inner corner, q along v, r from the
      // core end outward along a.
      const inU = su > 0 ? hi(u) : lo(u), inV = sv > 0 ? hi(v) : lo(v), inA = sa > 0 ? a1 : a0;
      const lbox = (p: number[], q: number[], r: number[]) => box(
        su > 0 ? [inU + p[0], inU + p[1]] : [inU - p[1], inU - p[0]],
        sv > 0 ? [inV + q[0], inV + q[1]] : [inV - q[1], inV - q[0]],
        sa > 0 ? [inA + r[0], inA + r[1]] : [inA - r[1], inA - r[0]]);
      const xs = xSideOf(u, su);
      if (!edgeFlag(x, su, sv)) {
        // Hip corner: the two end slopes meet along a diagonal.
        add(lab, { shape: 'CornerWedge', ...lbox([0, s], [0, s], [0, d]), flat: dir(-sa, a), apex: apexOf(-su, -sv, sa) }, xs);
        continue;
      }
      // Three slopes meet here (two end slopes + the long-edge cut). One corner wedge would
      // stick out past the long edge, so the corner is filled exactly: the hip over the inner
      // square, two strips, and the last c x c square where the long cut runs on into the end.
      const t = s - c, h = (d * c) / s;
      if (t > EPS) {
        add(`${lab}Base`, { shape: 'Block', ...lbox([0, t], [0, t], [0, h]) }, xs);
        add(lab, { shape: 'CornerWedge', ...lbox([0, t], [0, t], [h, d]), flat: dir(-sa, a), apex: apexOf(-su, -sv, sa) }, xs);
        add(`${lab}U`, { shape: 'Wedge', ...lbox([t, s], [0, t], [0, h]), tall: dir(-su, u), flat: dir(-sa, a) }, xs);
        add(`${lab}V`, { shape: 'Wedge', ...lbox([0, t], [t, s], [0, h]), tall: dir(-sv, v), flat: dir(-sa, a) }, xs);
      }
      const m = t + c / 2;
      add(`${lab}TipBase`, { shape: 'Block', ...lbox([t, m], [t, m], [0, h / 2]) }, xs);
      add(`${lab}Tip`, { shape: 'CornerWedge', ...lbox([t, m], [t, m], [h / 2, h]), flat: dir(-sa, a), apex: apexOf(-su, -sv, sa) }, xs);
      add(`${lab}TipU`, { shape: 'CornerWedge', ...lbox([m, s], [t, m], [0, h / 2]), flat: dir(-su, u), apex: apexOf(su, -sv, -sa) }, xs);
      add(`${lab}TipV`, { shape: 'CornerWedge', ...lbox([t, m], [m, s], [0, h / 2]), flat: dir(-sv, v), apex: apexOf(-su, sv, -sa) }, xs);
    }
  }
  return pieces;
}
