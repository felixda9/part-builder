// Cheap checks run after every batch. They catch the mistakes that look fine in one render and
// break in Roblox: floating parts, separate clusters, z-fighting faces, parts hidden inside others.

import { type Vec3, abs3, add, column, cross, dot, length, scale, sub } from './math';
import type { Part, SceneDoc } from './scene';
import { worldFaces, worldVerts } from './shapes';

export interface Lint {
  kind: 'floating' | 'disconnected' | 'zfight' | 'hidden' | 'ungrouped' | 'asymmetric' | 'gap' | 'loose' | 'blunt';
  message: string;
  parts: string[];
}

interface OBB {
  c: Vec3;
  axes: [Vec3, Vec3, Vec3];
  h: Vec3;
}

const obbOf = (p: Part): OBB => ({
  c: p.position,
  axes: [column(p.rotation, 0), column(p.rotation, 1), column(p.rotation, 2)],
  h: [p.size[0] / 2, p.size[1] / 2, p.size[2] / 2],
});

/** Separating-axis test; boxes closer than `tol` count as touching. */
export function obbTouch(a: OBB, b: OBB, tol = 0.02): boolean {
  const T = sub(b.c, a.c);
  const axes: Vec3[] = [...a.axes, ...b.axes];
  for (const u of a.axes) for (const v of b.axes) {
    const x = cross(u, v);
    const l = length(x);
    if (l > 1e-6) axes.push([x[0] / l, x[1] / l, x[2] / l]);
  }
  for (const L of axes) {
    const ra = a.h[0] * Math.abs(dot(a.axes[0], L)) + a.h[1] * Math.abs(dot(a.axes[1], L)) + a.h[2] * Math.abs(dot(a.axes[2], L));
    const rb = b.h[0] * Math.abs(dot(b.axes[0], L)) + b.h[1] * Math.abs(dot(b.axes[1], L)) + b.h[2] * Math.abs(dot(b.axes[2], L));
    if (Math.abs(dot(T, L)) > ra + rb + tol) return false;
  }
  return true;
}

function insideOBB(v: Vec3, o: OBB, eps = 1e-4): boolean {
  const d = sub(v, o.c);
  return o.axes.every((ax, i) => Math.abs(dot(d, ax)) <= o.h[i] + eps);
}

// --- 2D convex polygon clipping for coplanar overlap ---------------------------------------
type P2 = [number, number];
const area2 = (poly: P2[]) => Math.abs(poly.reduce((s, p, i) => {
  const q = poly[(i + 1) % poly.length];
  return s + p[0] * q[1] - q[0] * p[1];
}, 0)) / 2;

function ccw(poly: P2[]): P2[] {
  const s = poly.reduce((acc, p, i) => {
    const q = poly[(i + 1) % poly.length];
    return acc + p[0] * q[1] - q[0] * p[1];
  }, 0);
  return s < 0 ? [...poly].reverse() : poly;
}

function clip(subject: P2[], clipPoly: P2[]): P2[] {
  let out = subject;
  const c = ccw(clipPoly);
  for (let i = 0; i < c.length && out.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length];
    const inside = (p: P2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-9;
    const inp = out;
    out = [];
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j], q = inp[(j + 1) % inp.length];
      const pin = inside(p), qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) {
        const d1 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        const d2 = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
        const t = d1 / (d1 - d2);
        out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
  }
  return out;
}

function planeBasis(n: Vec3): [Vec3, Vec3] {
  const a = abs3(n);
  const helper: Vec3 = a[0] < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = cross(n, helper);
  const ul = length(u);
  const uu: Vec3 = [u[0] / ul, u[1] / ul, u[2] / ul];
  return [uu, cross(n, uu)];
}

/**
 * Left/right symmetry (mirror across x = 0): every part must either be symmetric itself (centred)
 * or have a twin of the same shape and color at the mirrored place.
 */
export function symmetryIssues(parts: Part[], max = 8, tol = 0.02): Lint[] {
  const out: Lint[] = [];
  const verts = parts.map((p) => worldVerts(p));
  const centre = (vs: Vec3[]): Vec3 => vs.reduce((a, v) => [a[0] + v[0] / vs.length, a[1] + v[1] / vs.length, a[2] + v[2] / vs.length], [0, 0, 0] as Vec3);
  const same = (a: Vec3[], b: Vec3[]) => a.length === b.length
    && a.every((v) => b.some((w) => Math.abs(v[0] - w[0]) < tol && Math.abs(v[1] - w[1]) < tol && Math.abs(v[2] - w[2]) < tol))
    && b.every((v) => a.some((w) => Math.abs(v[0] - w[0]) < tol && Math.abs(v[1] - w[1]) < tol && Math.abs(v[2] - w[2]) < tol));
  const reported = new Set<number>();
  for (let i = 0; i < parts.length && out.length < max; i++) {
    if (reported.has(i)) continue;
    const mirrored = verts[i].map((v) => [-v[0], v[1], v[2]] as Vec3);
    if (same(verts[i], mirrored)) continue; // centred, symmetric by itself
    const mc = centre(mirrored);
    let twin = -1, sameShapeTwin = -1;
    for (let j = 0; j < parts.length; j++) {
      if (j === i) continue;
      const c = centre(verts[j]);
      if (Math.abs(c[0] - mc[0]) > 0.1 || Math.abs(c[1] - mc[1]) > 0.1 || Math.abs(c[2] - mc[2]) > 0.1) continue;
      if (!same(verts[j], mirrored)) continue;
      sameShapeTwin = j;
      if (parts[j].color === parts[i].color) { twin = j; break; }
    }
    if (twin >= 0) continue;
    reported.add(i);
    if (sameShapeTwin >= 0) {
      reported.add(sameShapeTwin);
      out.push({ kind: 'asymmetric', message: `"${parts[i].name}" (${parts[i].color}) and its mirror twin "${parts[sameShapeTwin].name}" (${parts[sameShapeTwin].color}) differ in color`, parts: [parts[i].name, parts[sameShapeTwin].name] });
    } else {
      out.push({ kind: 'asymmetric', message: `"${parts[i].name}" has no mirror twin on the other side (expected a ${parts[i].shape} centred at x ${mc[0].toFixed(2)}, y ${mc[1].toFixed(2)}, z ${mc[2].toFixed(2)}) - give it a linked twin (the mirror op, or mirror: true in the plan) or move it`, parts: [parts[i].name] });
    }
  }
  return out;
}

/** A part as planes (convex): a point is inside when it is behind every face. */
interface Solid { planes: { n: Vec3; d: number }[]; lo: Vec3; hi: Vec3 }

function solidOf(p: Part): Solid {
  const faces = worldFaces(p);
  const vs = worldVerts(p);
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of vs) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], v[i]); hi[i] = Math.max(hi[i], v[i]); }
  return { planes: faces.map((f) => ({ n: f.normal, d: dot(f.normal, f.verts[0]) })), lo, hi };
}

const insideSolid = (s: Solid, q: Vec3, eps = 1e-4) =>
  q[0] >= s.lo[0] - eps && q[1] >= s.lo[1] - eps && q[2] >= s.lo[2] - eps && q[0] <= s.hi[0] + eps && q[1] <= s.hi[1] + eps && q[2] <= s.hi[2] + eps &&
  s.planes.every((pl) => dot(pl.n, q) - pl.d <= eps);

/** Indices of the parts that lie completely inside one other part (any shape). */
export function buriedParts(parts: Part[], which: (p: Part) => boolean = () => true): Set<number> {
  const solids = parts.map(solidOf);
  const out = new Set<number>();
  parts.forEach((p, i) => {
    if (!which(p)) return;
    const vs = worldVerts(p);
    if (parts.some((q, j) => j !== i && q.transparency === 0 && vs.every((v) => insideSolid(solids[j], v, 1e-4)))) out.add(i);
  });
  return out;
}

const GAP_MAX = 0.12;
const SAMPLE = 0.05;

/**
 * Thin gaps and loose parts, found by probing outward from points spread over every face:
 *  - gap: another part starts 0.005..GAP_MAX studs away over a visible area - looks unfinished
 *    (an ear hovering over the head, a pad that does not reach the arm);
 *  - loose: a part that touches the rest over only a sliver - it looks stuck on or floating.
 * Probe points already inside a third part are hidden, so they count as covered, not as gaps.
 */
export function gapIssues(parts: Part[], max = 8, groups: { id: string; parent: string | null }[] = []): Lint[] {
  const solids = parts.map(solidOf);
  // Gaps matter inside one bone or across a joint (body-head, body-tail); two separate limbs
  // (a leg and the tail) may sit close without touching.
  const parentOf = new Map(groups.map((g) => [g.id, g.parent]));
  const related = (a: Part, b: Part) => !a.group || !b.group || a.group === b.group || parentOf.get(a.group) === b.group || parentOf.get(b.group) === a.group;
  const near = (q: Vec3, self: number) => solids.map((_, j) => j).filter((j) => j !== self &&
    q[0] >= solids[j].lo[0] - GAP_MAX && q[1] >= solids[j].lo[1] - GAP_MAX && q[2] >= solids[j].lo[2] - GAP_MAX &&
    q[0] <= solids[j].hi[0] + GAP_MAX && q[1] <= solids[j].hi[1] + GAP_MAX && q[2] <= solids[j].hi[2] + GAP_MAX);
  const gapArea = new Map<string, { a: number; b: number; area: number; min: number; max: number; at: Vec3 }>();
  const pairContact = new Map<string, number>();
  const pairKey = (i: number, j: number) => (i < j ? `${i}|${j}` : `${j}|${i}`);
  const contact = new Array(parts.length).fill(0);
  const surface = new Array(parts.length).fill(0);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].transparency >= 1) continue;
    for (const f of worldFaces(parts[i])) {
      for (let t = 1; t + 1 < f.verts.length; t++) {
        const A = f.verts[0], B = f.verts[t], C = f.verts[t + 1];
        const triArea = length(cross(sub(B, A), sub(C, A))) / 2;
        if (triArea < 1e-6) continue;
        surface[i] += triArea;
        const k = Math.max(1, Math.ceil(Math.max(length(sub(B, A)), length(sub(C, A))) / SAMPLE));
        const n = (k * (k + 1)) / 2;
        for (let a = 0; a < k; a++) for (let b = 0; a + b < k; b++) {
          const u = (a + 1 / 3) / k, v = (b + 1 / 3) / k;
          const q = add(A, add(scale(sub(B, A), u), scale(sub(C, A), v)));
          const cand = near(q, i);
          if (!cand.length) continue;
          const at = (d: number) => add(q, scale(f.normal, d));
          // Touching / covered right at the surface.
          const p0 = at(0.004);
          const touch = cand.find((j) => insideSolid(solids[j], p0));
          if (touch !== undefined) {
            contact[i] += triArea / n;
            pairContact.set(pairKey(i, touch), (pairContact.get(pairKey(i, touch)) ?? 0) + triArea / n);
            continue;
          }
          for (let d = 0.01; d <= GAP_MAX + 1e-9; d += 0.01) {
            const pd = at(d);
            const hit = cand.find((j) => insideSolid(solids[j], pd));
            if (hit === undefined) continue;
            const key = pairKey(i, hit);
            const g = gapArea.get(key) ?? { a: Math.min(i, hit), b: Math.max(i, hit), area: 0, min: Infinity, max: 0, at: [0, 0, 0] as Vec3 };
            g.max = Math.max(g.max, d);
            g.at = add(g.at, scale(q, triArea / n));
            g.area += triArea / n;
            g.min = Math.min(g.min, d);
            gapArea.set(key, g);
            break;
          }
        }
      }
    }
  }
  const out: Lint[] = [];
  // A groove is fine: two parts that touch and then open up at an angle (a head resting on
  // sloped shoulders) have a gap that grows steadily from 0. A crack keeps the same thin gap.
  const groove = (g: { a: number; b: number; min: number; max: number }) => g.max - g.min >= 0.06 && (g.min <= 0.02 || (pairContact.get(pairKey(g.a, g.b)) ?? 0) >= 0.01);
  const gaps = [...gapArea.values()].filter((g) => g.area >= 0.025 && related(parts[g.a], parts[g.b]) && !groove(g)).sort((x, y) => y.area - x.area);
  for (const g of gaps.slice(0, max)) {
    const a = parts[g.a].name, b = parts[g.b].name;
    const c = scale(g.at, 1 / g.area);
    out.push({ kind: 'gap', message: `"${a}" and "${b}" have a thin gap (${g.min.toFixed(2)}+ studs) over ${g.area.toFixed(2)} sq studs around x ${c[0].toFixed(2)}, y ${c[1].toFixed(2)}, z ${c[2].toFixed(2)} - it shows as a crack; let one reach into the other`, parts: [a, b] });
  }
  const loose = parts.map((p, i) => ({ p, i })).filter(({ p, i }) => p.transparency < 1 && surface[i] > 0.05 && contact[i] < Math.max(0.01, 0.03 * surface[i]) &&
    gaps.some((g) => g.a === i || g.b === i));
  for (const { p, i } of loose.slice(0, max)) {
    out.push({ kind: 'loose', message: `"${p.name}" barely touches the rest (contact ${contact[i].toFixed(3)} of ${surface[i].toFixed(2)} sq studs) - it looks stuck on or floating; sink it into the part it belongs to`, parts: [p.name] });
  }
  return out;
}

const BLUNT_AREA = 0.08;
const END_NAMES: Record<string, string> = { '+z': 'back', '-z': 'front', '+y': 'top', '-y': 'bottom', '+x': 'side', '-x': 'side' };

/**
 * Blunt ends (animals and other organic subjects): the BACK of the big bones - the back of the
 * head, the rear of the body - cut off flat with square edges, and the little steps left by
 * stacking smaller boxes there (each step is another small blunt end). Only these: everywhere else
 * the look stays chunky and boxy (legs, paws, faces, chests, long edges stay boxes).
 * Each back-facing face's rim is probed just past the edge: when the surface goes on as a slope
 * (wedge, corner wedge, tilted part) the edge is rounded; when it drops away at 90 degrees it is
 * square. Faces whose rim is mostly square add up per bone; too much in total = blunt.
 * Triangle faces (the flat sides of wedges, ear plates) and tiny details don't count.
 */
export function bluntIssues(parts: Part[], max = 8, groups: { id: string; name: string }[] = []): Lint[] {
  const solids = parts.map(solidOf);
  const inAny = (q: Vec3, skip = -1) => solids.some((s, j) => j !== skip && parts[j].transparency < 1 && insideSolid(s, q, 1e-5));
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  // End axis per bone.
  const box = new Map<string, { lo: Vec3; hi: Vec3 }>();
  parts.forEach((p, i) => {
    const k = p.group ?? '';
    const b = box.get(k) ?? { lo: [Infinity, Infinity, Infinity] as Vec3, hi: [-Infinity, -Infinity, -Infinity] as Vec3 };
    for (let a = 0; a < 3; a++) { b.lo[a] = Math.min(b.lo[a], solids[i].lo[a]); b.hi[a] = Math.max(b.hi[a], solids[i].hi[a]); }
    box.set(k, b);
  });
  // Big bones only (body, head - not legs, ears or a jaw): at least 40% of the biggest box.
  const volume = (b: { lo: Vec3; hi: Vec3 }) => (b.hi[0] - b.lo[0]) * (b.hi[1] - b.lo[1]) * (b.hi[2] - b.lo[2]);
  const biggest = Math.max(...[...box.values()].map(volume));
  const big = new Set([...box].filter(([, b]) => volume(b) >= 0.4 * biggest).map(([k]) => k));
  const ends = new Map<string, { group: string; dir: string; area: number; faces: { part: number; open: number; squarePct: number }[] }>();
  parts.forEach((p, i) => {
    if (p.transparency >= 1 || p.size[0] * p.size[1] * p.size[2] < 0.012) return;
    if (!big.has(p.group ?? '')) return;
    const axis = 2;
    // Only the rear part of the bone (its back 40%): a back-facing face under the chest is not an end.
    const bb = box.get(p.group ?? '')!;
    const rearFrom = bb.lo[2] + 0.6 * (bb.hi[2] - bb.lo[2]);
    for (const f of worldFaces(p)) {
      if (f.verts.length < 4 || f.normal[axis] < 0.97 || f.verts[0][2] < rearFrom) continue; // back-facing faces at the back only
      // The flat side of a thin plate sticking out (an ear, a fin) is not an end of the body: the
      // part is thin and its front side is open too. A thin step stacked on the back is buried in
      // front, so it still counts.
      if (solids[i].hi[2] - solids[i].lo[2] <= 0.3) {
        const front = worldFaces(p).find((g) => g.normal[2] < -0.97);
        if (front) {
          const c = scale(front.verts.reduce((acc, v) => add(acc, v), [0, 0, 0] as Vec3), 1 / front.verts.length);
          const pts = [c, ...front.verts.map((v) => add(scale(v, 0.6), scale(c, 0.4)))];
          if (pts.filter((q) => !inAny(add(q, [0, 0, -0.004]), i)).length >= 0.6 * pts.length) continue;
        }
      }
      const sign = 1;
      // Open area of the face.
      let open = 0;
      for (let t = 1; t + 1 < f.verts.length; t++) {
        const A = f.verts[0], B = f.verts[t], C = f.verts[t + 1];
        const triArea = length(cross(sub(B, A), sub(C, A))) / 2;
        if (triArea < 1e-6) continue;
        const k = Math.max(1, Math.ceil(Math.max(length(sub(B, A)), length(sub(C, A))) / SAMPLE));
        const n = (k * (k + 1)) / 2;
        for (let a = 0; a < k; a++) for (let b = 0; a + b < k; b++) {
          const q = add(A, add(scale(sub(B, A), (a + 1 / 3) / k), scale(sub(C, A), (b + 1 / 3) / k)));
          if (!inAny(add(q, scale(f.normal, 0.004)), i)) open += triArea / n;
        }
      }
      if (open < 0.005) continue;
      // Rim: square or rounded, per 0.05 of edge.
      const centre = scale(f.verts.reduce((s, v) => add(s, v), [0, 0, 0] as Vec3), 1 / f.verts.length);
      let square = 0, round = 0;
      for (let e = 0; e < f.verts.length; e++) {
        const A = f.verts[e], B = f.verts[(e + 1) % f.verts.length];
        const len = length(sub(B, A));
        if (len < 1e-6) continue;
        let out = cross(sub(B, A), f.normal);
        out = scale(out, 1 / length(out));
        if (dot(out, sub(add(A, scale(sub(B, A), 0.5)), centre)) < 0) out = scale(out, -1);
        const m = Math.max(1, Math.round(len / SAMPLE));
        for (let j = 0; j < m; j++) {
          const q = add(A, scale(sub(B, A), (j + 0.5) / m));
          if (inAny(add(add(q, scale(out, -0.02)), scale(f.normal, 0.004)), i)) continue; // edge is covered
          if (inAny(add(add(q, scale(out, 0.02)), scale(f.normal, -0.004)))) continue; // surface goes on flat (or a wall rises)
          if (inAny(add(add(q, scale(out, 0.02)), scale(f.normal, -0.06)))) round += len / m; // a slope
          else square += len / m;
        }
      }
      if (square < 1e-6 || square < 0.5 * (square + round)) continue;
      const dir = `${sign > 0 ? '+' : '-'}${'xyz'[axis]}`;
      const key = `${p.group ?? ''}|${dir}`;
      const r = ends.get(key) ?? { group: p.group ?? '', dir, area: 0, faces: [] };
      r.area += open;
      r.faces.push({ part: i, open, squarePct: Math.round((100 * square) / (square + round)) });
      ends.set(key, r);
    }
  });
  const blunt = [...ends.values()].filter((r) => r.area >= BLUNT_AREA).sort((a, b) => b.area - a.area);
  return blunt.slice(0, max).map((r) => {
    const faces = r.faces.sort((a, b) => b.open - a.open);
    const names = [...new Set(faces.map((f) => parts[f.part].name))];
    const list = faces.slice(0, 4).map((f) => `"${parts[f.part].name}" ${f.open.toFixed(2)}`).join(', ') + (faces.length > 4 ? `, +${faces.length - 4} more` : '');
    const bone = groupName.get(r.group) ?? 'model';
    const many = faces.length > 1;
    return {
      kind: 'blunt' as const,
      message: `the ${END_NAMES[r.dir]} of ${bone} ends in ${many ? `${faces.length} flat faces` : 'a flat face'} with square edges (${r.area.toFixed(2)} sq studs: ${list})${many ? ' - a stepped end' : ''} - slope it off with bevel {ends:['${r.dir}'], size} on the plan part (wedges + corner wedges), not with smaller boxes (each step is another blunt end)`,
      parts: names,
    };
  });
}

export function lintScene(scene: SceneDoc, opts: { maxPerKind?: number; symmetric?: boolean; organic?: boolean } = {}): Lint[] {
  const maxPerKind = opts.maxPerKind ?? 8;
  const parts = scene.parts;
  const out: Lint[] = [];
  const obbs = parts.map(obbOf);

  // Contact graph
  const adj: number[][] = parts.map(() => []);
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++)
      if (obbTouch(obbs[i], obbs[j])) { adj[i].push(j); adj[j].push(i); }

  if (parts.length > 1) {
    const floating = parts.filter((_, i) => adj[i].length === 0);
    for (const p of floating.slice(0, maxPerKind))
      out.push({ kind: 'floating', message: `"${p.name}" touches no other part`, parts: [p.name] });

    const comp = new Array(parts.length).fill(-1);
    let n = 0;
    for (let i = 0; i < parts.length; i++) {
      if (comp[i] >= 0) continue;
      const stack = [i];
      comp[i] = n;
      while (stack.length) {
        const k = stack.pop()!;
        for (const m of adj[k]) if (comp[m] < 0) { comp[m] = n; stack.push(m); }
      }
      n++;
    }
    const multi = new Map<number, string[]>();
    parts.forEach((p, i) => { if (adj[i].length) multi.set(comp[i], [...(multi.get(comp[i]) ?? []), p.name]); });
    if (multi.size > 1) {
      const sizes = [...multi.values()].sort((a, b) => b.length - a.length);
      out.push({
        kind: 'disconnected',
        message: `${multi.size} separate clusters: ${sizes.map((s) => `[${s.slice(0, 3).join(', ')}${s.length > 3 ? `, +${s.length - 3}` : ''}]`).join(' ')}`,
        parts: sizes.slice(1).flat().slice(0, 20),
      });
    }
  }

  // Hidden: every vertex inside another Block.
  let hidden = 0;
  for (let i = 0; i < parts.length && hidden < maxPerKind; i++) {
    const vs = worldVerts(parts[i]);
    for (let j = 0; j < parts.length; j++) {
      if (i === j || parts[j].shape !== 'Block' || parts[j].transparency > 0) continue;
      if (vs.every((v) => insideOBB(v, obbs[j], -1e-4))) {
        out.push({ kind: 'hidden', message: `"${parts[i].name}" is completely inside "${parts[j].name}"`, parts: [parts[i].name, parts[j].name] });
        hidden++;
        break;
      }
    }
  }

  // Z-fighting: faces pointing the same way, on the same plane or less than ZFIGHT_GAP apart,
  // that overlap. Roblox renders those flickering against each other.
  const ZFIGHT_GAP = 0.008;
  const byNormal = new Map<string, { part: number; verts: Vec3[]; n: Vec3; d: number }[]>();
  parts.forEach((p, i) => {
    if (p.transparency >= 1) return;
    for (const f of worldFaces(p)) {
      const key = f.normal.map((v) => Math.round(v * 1000)).join(',');
      byNormal.set(key, [...(byNormal.get(key) ?? []), { part: i, verts: f.verts, n: f.normal, d: dot(f.normal, f.verts[0]) }]);
    }
  });
  let zf = 0;
  const seen = new Set<string>();
  // Only overlaps you can see flicker: points of the overlap that sit inside a third part are
  // buried (two pieces meeting inside the body).
  const zSolids = parts.map(solidOf);
  const shows = (poly: P2[], u: Vec3, v: Vec3, n: Vec3, d: number, a: number, b: number) => {
    for (let t = 1; t + 1 < poly.length; t++) {
      const [A, B, C] = [poly[0], poly[t], poly[t + 1]];
      for (let i = 0; i < 4; i++) for (let j = 0; i + j < 4; j++) {
        const x = A[0] + ((B[0] - A[0]) * (i + 1 / 3) + (C[0] - A[0]) * (j + 1 / 3)) / 4;
        const y = A[1] + ((B[1] - A[1]) * (i + 1 / 3) + (C[1] - A[1]) * (j + 1 / 3)) / 4;
        const q = add(add(scale(u, x), scale(v, y)), scale(n, d + 0.004));
        if (!zSolids.some((sd, k) => k !== a && k !== b && parts[k].transparency < 1 && insideSolid(sd, q, 1e-5))) return true;
      }
    }
    return false;
  };
  for (const list of byNormal.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.d - b.d);
    const [u, v] = planeBasis(list[0].n);
    const polys = list.map((f) => f.verts.map((p) => [dot(p, u), dot(p, v)] as P2));
    for (let a = 0; a < list.length && zf < maxPerKind; a++)
      for (let b = a + 1; b < list.length && list[b].d - list[a].d < ZFIGHT_GAP && zf < maxPerKind; b++) {
        if (list[a].part === list[b].part) continue;
        const key = `${Math.min(list[a].part, list[b].part)}-${Math.max(list[a].part, list[b].part)}`;
        if (seen.has(key)) continue;
        const inter = clip(ccw(polys[a]), polys[b]);
        if (inter.length >= 3 && area2(inter) > 0.0004 && shows(inter, u, v, list[a].n, list[b].d, list[a].part, list[b].part)) {
          seen.add(key);
          zf++;
          const pa = parts[list[a].part].name, pb = parts[list[b].part].name;
          const gap = list[b].d - list[a].d;
          out.push({
            kind: 'zfight',
            message: `"${pa}" and "${pb}" have overlapping faces ${gap < 1e-4 ? 'on the same plane' : `only ${gap.toFixed(3)} studs apart`} (flickers in Roblox); move one by >= 0.02 or make one face stick out`,
            parts: [pa, pb],
          });
        }
      }
  }

  if (opts.symmetric) out.push(...symmetryIssues(parts, maxPerKind));
  out.push(...gapIssues(parts, maxPerKind, scene.groups));
  if (opts.organic) out.push(...bluntIssues(parts, maxPerKind, scene.groups));

  if (scene.groups.length) {
    const loose = parts.filter((p) => !p.group);
    if (loose.length)
      out.push({ kind: 'ungrouped', message: `${loose.length} part(s) not in any group: ${loose.slice(0, 6).map((p) => p.name).join(', ')}${loose.length > 6 ? '…' : ''}`, parts: loose.map((p) => p.name).slice(0, 20) });
  }
  return out;
}
