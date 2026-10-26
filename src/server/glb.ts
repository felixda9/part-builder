// Minimal binary glTF (.glb) reader for the meshes the 3D AI models make (Pixal3D / TRELLIS.2 on
// ComfyUI): triangles, with a colour per vertex sampled from the base-colour texture (or COLOR_0).
// No animation, skins or compression - just what is needed to render and measure the model.

import fs from 'node:fs';
import sharp from 'sharp';
import type { Vec3 } from '../core/math';

export interface TriMesh {
  positions: Float32Array; // xyz per vertex
  indices: Uint32Array; // 3 per triangle
  colors: Uint8Array; // rgb per vertex
}

interface Gltf {
  scene?: number;
  scenes?: { nodes: number[] }[];
  nodes?: { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }[] }[];
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  materials?: { pbrMetallicRoughness?: { baseColorTexture?: { index: number }; baseColorFactor?: number[] } }[];
  textures?: { source?: number }[];
  images?: { bufferView?: number; mimeType?: string; uri?: string }[];
  extensionsRequired?: string[];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(g: Gltf, bin: Buffer, index: number): Float64Array {
  const a = g.accessors![index];
  const n = COMPONENTS[a.type];
  const out = new Float64Array(a.count * n);
  if (a.bufferView === undefined) return out;
  const bv = g.bufferViews![a.bufferView];
  const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType]!;
  const stride = bv.byteStride || size * n;
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const norm = a.normalized ? { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[a.componentType] ?? 1 : 1;
  for (let i = 0; i < a.count; i++) {
    for (let c = 0; c < n; c++) {
      const o = base + i * stride + c * size;
      let v: number;
      switch (a.componentType) {
        case 5126: v = bin.readFloatLE(o); break;
        case 5125: v = bin.readUInt32LE(o); break;
        case 5123: v = bin.readUInt16LE(o); break;
        case 5122: v = bin.readInt16LE(o); break;
        case 5121: v = bin.readUInt8(o); break;
        default: v = bin.readInt8(o);
      }
      out[i * n + c] = v / norm;
    }
  }
  return out;
}

type Mat = number[]; // column-major 4x4
const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mul = (a: Mat, b: Mat): Mat => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
function nodeMatrix(n: NonNullable<Gltf['nodes']>[number]): Mat {
  if (n.matrix) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

export async function loadGlb(file: string): Promise<TriMesh> {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a binary glTF (.glb)`);
  let off = 12;
  let json: Gltf | null = null;
  let bin = Buffer.alloc(0);
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
    else if (type === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  if (!json) throw new Error(`${file}: no JSON chunk`);
  const g = json;
  const unsupported = (g.extensionsRequired ?? []).filter((e) => e !== 'KHR_materials_unlit');
  if (unsupported.length) throw new Error(`${file} needs glTF extensions this reader doesn't support: ${unsupported.join(', ')}`);

  // Base-colour textures, decoded once.
  const texCache = new Map<number, { data: Buffer; w: number; h: number }>();
  const texture = async (t: number) => {
    if (texCache.has(t)) return texCache.get(t)!;
    const img = g.images?.[g.textures?.[t]?.source ?? -1];
    if (!img || img.bufferView === undefined) return null;
    const bv = g.bufferViews![img.bufferView];
    const raw = await sharp(bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const tex = { data: raw.data, w: raw.info.width, h: raw.info.height };
    texCache.set(t, tex);
    return tex;
  };

  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const visit = async (ni: number, parent: Mat) => {
    const node = g.nodes![ni];
    const m = mul(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const prim of g.meshes![node.mesh].primitives) {
        if ((prim.mode ?? 4) !== 4) continue;
        const p = readAccessor(g, bin, prim.attributes.POSITION);
        const count = p.length / 3;
        const base = pos.length / 3;
        for (let i = 0; i < count; i++) {
          const [x, y, z] = [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
          pos.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
        }
        const mat = g.materials?.[prim.material ?? -1]?.pbrMetallicRoughness;
        const factor = mat?.baseColorFactor ?? [1, 1, 1, 1];
        const tex = mat?.baseColorTexture ? await texture(mat.baseColorTexture.index) : null;
        const uv = tex && prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(g, bin, prim.attributes.TEXCOORD_0) : null;
        const vc = prim.attributes.COLOR_0 !== undefined ? readAccessor(g, bin, prim.attributes.COLOR_0) : null;
        const vcN = vc ? vc.length / count : 0;
        for (let i = 0; i < count; i++) {
          let rgb = [255, 255, 255];
          if (tex && uv) {
            const u = uv[i * 2] - Math.floor(uv[i * 2]), v = uv[i * 2 + 1] - Math.floor(uv[i * 2 + 1]);
            const px = Math.min(tex.w - 1, Math.floor(u * tex.w)), py = Math.min(tex.h - 1, Math.floor(v * tex.h));
            const o = (py * tex.w + px) * 3;
            rgb = [tex.data[o], tex.data[o + 1], tex.data[o + 2]];
          } else if (vc) {
            rgb = [vc[i * vcN] * 255, vc[i * vcN + 1] * 255, vc[i * vcN + 2] * 255];
          }
          col.push(rgb[0] * factor[0], rgb[1] * factor[1], rgb[2] * factor[2]);
        }
        if (prim.indices !== undefined) for (const v of readAccessor(g, bin, prim.indices)) idx.push(base + v);
        else for (let i = 0; i < count; i++) idx.push(base + i);
      }
    }
    for (const c of node.children ?? []) await visit(c, m);
  };
  const roots = g.scenes?.[g.scene ?? 0]?.nodes ?? (g.nodes ?? []).map((_, i) => i);
  for (const r of roots) await visit(r, IDENTITY);
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx), colors: Uint8Array.from(col.map((c) => Math.max(0, Math.min(255, Math.round(c))))) };
}

export function meshBounds(m: TriMesh): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) for (let a = 0; a < 3; a++) {
    min[a] = Math.min(min[a], m.positions[i + a]);
    max[a] = Math.max(max[a], m.positions[i + a]);
  }
  return { min, max };
}

/** Apply p -> R*p*s + t to every vertex (R row-major 3x3). Returns a new mesh. */
export function transformMesh(m: TriMesh, R: number[], s: number, t: Vec3): TriMesh {
  const p = new Float32Array(m.positions.length);
  for (let i = 0; i < p.length; i += 3) {
    const [x, y, z] = [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
    p[i] = (R[0] * x + R[1] * y + R[2] * z) * s + t[0];
    p[i + 1] = (R[3] * x + R[4] * y + R[5] * z) * s + t[1];
    p[i + 2] = (R[6] * x + R[7] * y + R[8] * z) * s + t[2];
  }
  return { positions: p, indices: m.indices, colors: m.colors };
}
