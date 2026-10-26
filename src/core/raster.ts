// Pure-TS rasterizer. Deterministic and dependency-free, so it runs the same in Node and the
// browser. It produces what evaluation needs: a silhouette mask, a part-id buffer and a flat-lit
// color image, for orthographic views (matched to reference images) and a perspective 3/4 view.

import { type Vec3, cross, dot, length, normalize, sub, add, scale } from './math';
import type { Part, SceneDoc } from './scene';
import { partAABB, unionAABB, worldTriangles, worldVerts } from './shapes';

export type OrthoView = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom';
export type ViewName = OrthoView | 'threequarter';
export const ORTHO_VIEWS: OrthoView[] = ['front', 'back', 'right', 'left', 'top', 'bottom'];

/**
 * Camera basis per view. View names say which side of the model is visible. The model faces -Z
 * and its right side is +X, so in the front view the model's right hand is on image-left.
 */
export const VIEW_BASIS: Record<OrthoView, { forward: Vec3; up: Vec3; right: Vec3 }> = (() => {
  const mk = (forward: Vec3, up: Vec3) => ({ forward, up, right: cross(forward, up) });
  return {
    front: mk([0, 0, 1], [0, 1, 0]),   // camera at -Z looking +Z; image-right = -X
    back: mk([0, 0, -1], [0, 1, 0]),   // image-right = +X
    right: mk([-1, 0, 0], [0, 1, 0]),  // camera at +X; image-right = -Z (model faces image-right)
    left: mk([1, 0, 0], [0, 1, 0]),    // camera at -X; image-right = +Z (model faces image-left)
    top: mk([0, -1, 0], [0, 0, 1]),    // camera above; model front (-Z) at image bottom; image-right = -X
    bottom: mk([0, 1, 0], [0, 0, -1]),
  };
})();

/** Orthographic framing: world (u,v) of the image's top-left corner + pixels per stud. */
export interface OrthoFrame {
  view: OrthoView;
  ppu: number;
  u0: number;
  v0: number;
  width: number;
  height: number;
}

export interface PerspCamera {
  eye: Vec3;
  target: Vec3;
  up: Vec3;
  fovY: number; // degrees
  width: number;
  height: number;
}

export interface RasterResult {
  width: number;
  height: number;
  depth: Float32Array;
  partIndex: Int32Array; // -1 = background
  faceIndex: Int32Array; // global face id, for outlines
  /** RGBA, flat-lit part colors. */
  color: Uint8ClampedArray;
  /** World normal of each face id found in faceIndex. */
  faceNormals?: Vec3[];
}

export const LIGHT_DIR: Vec3 = normalize([0.35, 1.0, -0.55]);

export function shade(hex: string, n: Vec3, ambient = 0.55): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const k = ambient + (1 - ambient) * Math.max(0, dot(n, LIGHT_DIR));
  return [Math.min(255, r * k), Math.min(255, g * k), Math.min(255, b * k)];
}

/** Bounds of the given parts in a view's (u, v) image axes. */
export function viewBounds(parts: Part[], view: OrthoView) {
  const B = VIEW_BASIS[view];
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const p of parts) for (const w of worldVerts(p)) {
    const u = dot(w, B.right), v = dot(w, B.up);
    uMin = Math.min(uMin, u); uMax = Math.max(uMax, u); vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
  }
  return { uMin, uMax, vMin, vMax };
}

/** Frame that fits the parts with a margin (in studs). */
export function autoFrame(parts: Part[], view: OrthoView, ppu = 16, margin = 0.5): OrthoFrame {
  if (!parts.length) return { view, ppu, u0: -2, v0: 4, width: Math.round(4 * ppu), height: Math.round(4 * ppu) };
  const b = viewBounds(parts, view);
  const u0 = b.uMin - margin, v0 = b.vMax + margin;
  return { view, ppu, u0, v0, width: Math.max(1, Math.ceil((b.uMax - b.uMin + 2 * margin) * ppu)), height: Math.max(1, Math.ceil((b.vMax - b.vMin + 2 * margin) * ppu)) };
}

interface ScreenTri {
  x: [number, number, number];
  y: [number, number, number];
  /** depth for ortho; 1/z for perspective (interpolated linearly in screen space). */
  d: [number, number, number];
  part: number;
  face: number;
  rgb: [number, number, number];
}

function rasterize(tris: ScreenTri[], width: number, height: number, persp: boolean): RasterResult {
  const n = width * height;
  const depth = new Float32Array(n).fill(persp ? 0 : Infinity);
  const partIndex = new Int32Array(n).fill(-1);
  const faceIndex = new Int32Array(n).fill(-1);
  const color = new Uint8ClampedArray(n * 4);
  for (const t of tris) {
    const [x0, x1, x2] = t.x, [y0, y1, y2] = t.y;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-12) continue;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2)));
    const inv = 1 / area;
    for (let py = minY; py <= maxY; py++) {
      const cy = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const cx = px + 0.5;
        let w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) * inv;
        let w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) * inv;
        let w2 = 1 - w0 - w1;
        if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
        const d = w0 * t.d[0] + w1 * t.d[1] + w2 * t.d[2];
        const i = py * width + px;
        if (persp ? d <= depth[i] : d >= depth[i]) continue;
        depth[i] = d;
        partIndex[i] = t.part;
        faceIndex[i] = t.face;
        color[i * 4] = t.rgb[0]; color[i * 4 + 1] = t.rgb[1]; color[i * 4 + 2] = t.rgb[2]; color[i * 4 + 3] = 255;
      }
    }
  }
  return { width, height, depth, partIndex, faceIndex, color };
}

export function renderOrtho(parts: Part[], frame: OrthoFrame): RasterResult {
  const B = VIEW_BASIS[frame.view];
  const tris: ScreenTri[] = [];
  const faceNormals: Vec3[] = [];
  let faceBase = 0;
  parts.forEach((p, pi) => {
    for (const { tri, face, normal } of worldTriangles(p)) {
      faceNormals[faceBase + face] = normal;
      if (dot(normal, B.forward) > 1e-9) continue; // back-facing
      tris.push({
        x: tri.map((w) => (dot(w, B.right) - frame.u0) * frame.ppu) as [number, number, number],
        y: tri.map((w) => (frame.v0 - dot(w, B.up)) * frame.ppu) as [number, number, number],
        d: tri.map((w) => dot(w, B.forward)) as [number, number, number],
        part: pi,
        face: faceBase + face,
        rgb: shade(p.color, normal),
      });
    }
    faceBase += 8;
  });
  return { ...rasterize(tris, frame.width, frame.height, false), faceNormals };
}

/** Front-right three-quarter camera that fits the parts. */
export function threeQuarterCamera(parts: Part[], width = 640, height = 640, yawDeg = 45, pitchDeg = 20): PerspCamera {
  const bb = unionAABB(parts.map(partAABB)) ?? { min: [-1, 0, -1] as Vec3, max: [1, 2, 1] as Vec3 };
  const target: Vec3 = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
  const radius = Math.max(0.5, Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) / 2);
  const fovY = 30;
  const dist = (radius / Math.sin((fovY / 2) * (Math.PI / 180))) * 1.05;
  const yaw = (yawDeg * Math.PI) / 180, pitch = (pitchDeg * Math.PI) / 180;
  // Front is -Z, the model's right is +X: front-right is (+x, -z).
  const dir: Vec3 = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
  return { eye: add(target, scale(dir, dist)), target, up: [0, 1, 0], fovY, width, height };
}

export function renderPerspective(parts: Part[], cam: PerspCamera): RasterResult {
  const f = normalize(sub(cam.target, cam.eye));
  const r = normalize(cross(f, cam.up));
  const u = cross(r, f);
  const focal = (cam.height / 2) / Math.tan(((cam.fovY / 2) * Math.PI) / 180);
  const tris: ScreenTri[] = [];
  let faceBase = 0;
  parts.forEach((p, pi) => {
    for (const { tri, face, normal } of worldTriangles(p)) {
      const rel = tri.map((w) => sub(w, cam.eye));
      const zs = rel.map((v) => dot(v, f));
      if (zs.some((z) => z < 0.05)) continue; // behind/too close (camera is fitted, so rare)
      if (dot(normal, sub(tri[0], cam.eye)) >= 0) continue; // back-facing
      tris.push({
        x: rel.map((v, i) => cam.width / 2 + (dot(v, r) / zs[i]) * focal) as [number, number, number],
        y: rel.map((v, i) => cam.height / 2 - (dot(v, u) / zs[i]) * focal) as [number, number, number],
        d: zs.map((z) => 1 / z) as [number, number, number],
        part: pi,
        face: faceBase + face,
        rgb: shade(p.color, normal),
      });
    }
    faceBase += 8;
  });
  return rasterize(tris, cam.width, cam.height, true);
}

/** Darken pixels on part/face boundaries so individual parts read clearly. */
export function drawOutlines(res: RasterResult, strength = 0.45): void {
  const { width: w, height: h, faceIndex, partIndex, color } = res;
  const dark = (i: number, k: number) => {
    color[i * 4] *= k; color[i * 4 + 1] *= k; color[i * 4 + 2] *= k;
    if (color[i * 4 + 3] === 0) { color[i * 4 + 3] = 255; color[i * 4] = color[i * 4 + 1] = color[i * 4 + 2] = 40; }
  };
  const edge = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (partIndex[i] < 0) continue;
    const nb = [x + 1 < w ? i + 1 : -1, y + 1 < h ? i + w : -1, x > 0 ? i - 1 : -1, y > 0 ? i - w : -1];
    for (const j of nb) {
      if (j < 0 || partIndex[j] < 0) { edge[i] = 2; break; }
      if (partIndex[j] !== partIndex[i]) { edge[i] = Math.max(edge[i], 2); }
      else if (faceIndex[j] !== faceIndex[i]) edge[i] = Math.max(edge[i], 1);
    }
  }
  for (let i = 0; i < w * h; i++) if (edge[i]) dark(i, edge[i] === 2 ? 1 - strength : 1 - strength * 0.4);
}

/** Distinct color per part index (for 'parts' mode). */
export function partColor(i: number): [number, number, number] {
  const hue = (i * 137.508) % 360;
  const s = 0.65, l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

export function recolorByPart(res: RasterResult): void {
  for (let i = 0; i < res.partIndex.length; i++) {
    const p = res.partIndex[i];
    if (p < 0) continue;
    const [r, g, b] = partColor(p);
    res.color[i * 4] = r; res.color[i * 4 + 1] = g; res.color[i * 4 + 2] = b;
  }
}

export function maskOf(res: RasterResult): Uint8Array {
  const m = new Uint8Array(res.partIndex.length);
  for (let i = 0; i < m.length; i++) m[i] = res.partIndex[i] >= 0 ? 1 : 0;
  return m;
}

/** Which world axis (and sign) runs along image-right and image-up in a view - for grid labels. */
export function viewAxes(view: OrthoView): { h: { axis: 'x' | 'y' | 'z'; sign: number }; v: { axis: 'x' | 'y' | 'z'; sign: number } } {
  const B = VIEW_BASIS[view];
  const pick = (vec: Vec3) => {
    const i = vec.findIndex((c) => Math.abs(c) > 0.5);
    return { axis: (['x', 'y', 'z'] as const)[i], sign: Math.sign(vec[i]) };
  };
  return { h: pick(B.right), v: pick(B.up) };
}

export function partsOf(scene: SceneDoc, group?: string): Part[] {
  if (!group) return scene.parts.filter((p) => p.transparency < 1);
  const g = scene.groups.find((x) => x.name === group || x.id === group);
  if (!g) throw new Error(`no group "${group}"`);
  // A group plus its descendant groups.
  const ids = new Set([g.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const x of scene.groups) if (x.parent && ids.has(x.parent) && !ids.has(x.id)) { ids.add(x.id); grew = true; }
  }
  return scene.parts.filter((p) => p.group && ids.has(p.group) && p.transparency < 1);
}

/** A triangle mesh with a colour per vertex (e.g. a 3D model from an image-to-3D AI). */
export interface ColorMesh {
  positions: Float32Array;
  indices: Uint32Array;
  colors: Uint8Array;
}

function meshTris(m: ColorMesh, project: (w: Vec3) => { x: number; y: number; d: number } | null, toViewer: (n: Vec3, w: Vec3) => boolean): ScreenTri[] {
  const tris: ScreenTri[] = [];
  const P = (i: number): Vec3 => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
  for (let t = 0; t < m.indices.length; t += 3) {
    const ia = m.indices[t], ib = m.indices[t + 1], ic = m.indices[t + 2];
    const a = P(ia), b = P(ib), c = P(ic);
    const nRaw = cross(sub(b, a), sub(c, a));
    if (length(nRaw) < 1e-12) continue;
    // AI meshes are not always consistently wound: draw both sides, lit from the viewer's side.
    const n0 = normalize(nRaw);
    const n = toViewer(n0, a) ? n0 : scale(n0, -1);
    const s = [a, b, c].map(project);
    if (s.some((v) => !v)) continue;
    const k = 0.55 + 0.45 * Math.max(0, dot(n, LIGHT_DIR));
    const rgb = [0, 1, 2].map((ch) => Math.min(255, ((m.colors[ia * 3 + ch] + m.colors[ib * 3 + ch] + m.colors[ic * 3 + ch]) / 3) * k)) as [number, number, number];
    tris.push({ x: s.map((v) => v!.x) as [number, number, number], y: s.map((v) => v!.y) as [number, number, number], d: s.map((v) => v!.d) as [number, number, number], part: 0, face: t / 3, rgb });
  }
  return tris;
}

/** Orthographic render of a colour mesh in a frame (same frames as the part renders). */
export function renderMeshOrtho(m: ColorMesh, frame: OrthoFrame): RasterResult {
  const B = VIEW_BASIS[frame.view];
  const tris = meshTris(m, (w) => ({ x: (dot(w, B.right) - frame.u0) * frame.ppu, y: (frame.v0 - dot(w, B.up)) * frame.ppu, d: dot(w, B.forward) }), (n) => dot(n, B.forward) <= 0);
  return rasterize(tris, frame.width, frame.height, false);
}

/** Perspective render of a colour mesh (e.g. with threeQuarterCamera of matching bounds). */
export function renderMeshPerspective(m: ColorMesh, cam: PerspCamera): RasterResult {
  const f = normalize(sub(cam.target, cam.eye));
  const r = normalize(cross(f, cam.up));
  const u = cross(r, f);
  const focal = (cam.height / 2) / Math.tan(((cam.fovY / 2) * Math.PI) / 180);
  const tris = meshTris(m, (w) => {
    const v = sub(w, cam.eye);
    const z = dot(v, f);
    if (z < 0.05) return null;
    return { x: cam.width / 2 + (dot(v, r) / z) * focal, y: cam.height / 2 - (dot(v, u) / z) * focal, d: 1 / z };
  }, (n, w) => dot(n, sub(w, cam.eye)) <= 0);
  return rasterize(tris, cam.width, cam.height, true);
}
