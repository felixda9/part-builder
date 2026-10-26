// Geometry of the three Roblox part shapes in their local frame, plus world-space helpers.
//
// Conventions (sources: devforum 235107, FrostDracony "GetCornersOfWedgeAndCornerWedge"; the
// CornerWedge apex is still to be confirmed against Studio in milestone M0):
//   WedgePart      4 bottom corners + top edge at (±hx, +hy, +hz). Vertical face = Back (+Z);
//                  the slope rises from the bottom-front edge to the top-back edge.
//   CornerWedgePart 4 bottom corners + apex (+hx, +hy, -hz). Vertical triangles = Right (+X)
//                  and Front (-Z); two sloped triangles face up/-X and up/+Z.

import {
  type CFrame, type Mat3, type Vec3, add, cross, dot, matMul, matVec, normalize, sub, det, clean,
} from './math';
import type { Face, Part, Shape } from './scene';

export interface LocalFace {
  /** Indices into the vertex list, counter-clockwise seen from outside. */
  idx: number[];
  /** Which Roblox surface property this face displays. */
  surface: Face;
}

export interface LocalGeometry {
  verts: Vec3[];
  faces: LocalFace[];
}

/** Unit-cube corners scaled by half size. */
function corners(h: Vec3): Vec3[] {
  const [x, y, z] = h;
  return [
    [-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z], // 0-3 bottom
    [-x, y, -z], [x, y, -z], [x, y, z], [-x, y, z],     // 4-7 top
  ];
}

export function localGeometry(shape: Shape, size: Vec3): LocalGeometry {
  const h: Vec3 = [size[0] / 2, size[1] / 2, size[2] / 2];
  const c = corners(h);
  let geo: LocalGeometry;
  if (shape === 'Block') {
    geo = {
      verts: c,
      faces: [
        { idx: [0, 1, 2, 3], surface: 'bottom' },
        { idx: [4, 5, 6, 7], surface: 'top' },
        { idx: [0, 1, 5, 4], surface: 'front' },
        { idx: [3, 2, 6, 7], surface: 'back' },
        { idx: [0, 3, 7, 4], surface: 'left' },
        { idx: [1, 2, 6, 5], surface: 'right' },
      ],
    };
  } else if (shape === 'Wedge') {
    // bottom 0-3, top-back edge: 4 = (-x,+y,+z), 5 = (+x,+y,+z)
    const verts: Vec3[] = [c[0], c[1], c[2], c[3], c[7], c[6]];
    geo = {
      verts,
      faces: [
        { idx: [0, 1, 2, 3], surface: 'bottom' },
        { idx: [3, 2, 5, 4], surface: 'back' },
        { idx: [0, 1, 5, 4], surface: 'top' }, // slope (surface mapping verified in M0)
        { idx: [0, 3, 4], surface: 'left' },
        { idx: [1, 2, 5], surface: 'right' },
      ],
    };
  } else {
    // CornerWedge: bottom 0-3, apex 4 = (+x,+y,-z)
    const verts: Vec3[] = [c[0], c[1], c[2], c[3], c[5]];
    geo = {
      verts,
      faces: [
        { idx: [0, 1, 2, 3], surface: 'bottom' },
        { idx: [1, 2, 4], surface: 'right' },
        { idx: [0, 1, 4], surface: 'front' },
        { idx: [0, 3, 4], surface: 'left' }, // slope facing up/-X
        { idx: [3, 2, 4], surface: 'back' }, // slope facing up/+Z
      ],
    };
  }
  orientOutward(geo);
  return geo;
}

/** Make every face wind counter-clockwise seen from outside (shapes are convex). */
function orientOutward(geo: LocalGeometry): void {
  const centroid = geo.verts.reduce((a, v) => add(a, v), [0, 0, 0] as Vec3).map((v) => v / geo.verts.length) as Vec3;
  for (const f of geo.faces) {
    const [a, b, c] = f.idx.map((i) => geo.verts[i]);
    const n = cross(sub(b, a), sub(c, a));
    const fc = f.idx.reduce((acc, i) => add(acc, geo.verts[i]), [0, 0, 0] as Vec3).map((v) => v / f.idx.length) as Vec3;
    if (dot(n, sub(fc, centroid)) < 0) f.idx.reverse();
  }
}

export interface WorldFace {
  verts: Vec3[];
  normal: Vec3;
  surface: Face;
}

export function partCFrame(p: Pick<Part, 'position' | 'rotation'>): CFrame {
  return { p: p.position, R: p.rotation };
}

export function worldVerts(p: Pick<Part, 'shape' | 'size' | 'position' | 'rotation'>): Vec3[] {
  return localGeometry(p.shape, p.size).verts.map((v) => add(p.position, matVec(p.rotation, v)));
}

export function worldFaces(p: Pick<Part, 'shape' | 'size' | 'position' | 'rotation'>): WorldFace[] {
  const geo = localGeometry(p.shape, p.size);
  const wv = geo.verts.map((v) => add(p.position, matVec(p.rotation, v)));
  return geo.faces.map((f) => {
    const verts = f.idx.map((i) => wv[i]);
    const normal = normalize(cross(sub(verts[1], verts[0]), sub(verts[2], verts[0])));
    return { verts, normal, surface: f.surface };
  });
}

/** Triangles (world space) with the face index they came from. */
export function worldTriangles(p: Pick<Part, 'shape' | 'size' | 'position' | 'rotation'>): { tri: [Vec3, Vec3, Vec3]; face: number; normal: Vec3 }[] {
  const out: { tri: [Vec3, Vec3, Vec3]; face: number; normal: Vec3 }[] = [];
  worldFaces(p).forEach((f, fi) => {
    for (let i = 1; i + 1 < f.verts.length; i++) out.push({ tri: [f.verts[0], f.verts[i], f.verts[i + 1]], face: fi, normal: f.normal });
  });
  return out;
}

export interface AABB {
  min: Vec3;
  max: Vec3;
}

export function partAABB(p: Pick<Part, 'shape' | 'size' | 'position' | 'rotation'>): AABB {
  const vs = worldVerts(p);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of vs) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], v[i]); max[i] = Math.max(max[i], v[i]); }
  return { min, max };
}

export function unionAABB(boxes: AABB[]): AABB | null {
  if (!boxes.length) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], b.min[i]); max[i] = Math.max(max[i], b.max[i]); }
  return { min, max };
}

// ---------------------------------------------------------------------------------------------
// Mirroring across the world X = 0 plane.
//
// Reflecting a part gives a matrix with det -1, which is not a valid CFrame. Each shape has a
// local symmetry S (det -1) that maps the shape onto itself, so R' = M * R * S is a proper
// rotation that produces exactly the reflected solid.
//   Block / Wedge: S = diag(-1, 1, 1)
//   CornerWedge:   S: (x, y, z) -> (-z, y, -x), and the size swaps sx <-> sz.
// ---------------------------------------------------------------------------------------------

const M_X: Mat3 = [-1, 0, 0, 0, 1, 0, 0, 0, 1];
const S_FLIP_X: Mat3 = [-1, 0, 0, 0, 1, 0, 0, 0, 1];
const S_CORNER: Mat3 = [0, 0, -1, 0, 1, 0, -1, 0, 0];

export const reflectX = (v: Vec3): Vec3 => [-v[0], v[1], v[2]];

export function mirrorPartX<T extends Pick<Part, 'shape' | 'size' | 'position' | 'rotation' | 'surfaces'>>(p: T): T {
  const S = p.shape === 'CornerWedge' ? S_CORNER : S_FLIP_X;
  const R = clean(matMul(matMul(M_X, p.rotation), S));
  if (Math.abs(det(R) - 1) > 1e-6) throw new Error('mirror produced an improper rotation');
  const size: Vec3 = p.shape === 'CornerWedge' ? [p.size[2], p.size[1], p.size[0]] : [p.size[0], p.size[1], p.size[2]];
  // Surfaces follow the geometry: the local symmetry swaps faces.
  const s = p.surfaces;
  const surfaces =
    p.shape === 'CornerWedge'
      ? { top: s.top, bottom: s.bottom, front: s.right, right: s.front, left: s.back, back: s.left }
      : { ...s, left: s.right, right: s.left };
  return { ...p, rotation: R, size, position: reflectX(p.position), surfaces };
}
