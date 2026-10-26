import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderMeshOrtho, maskOf } from '../src/core/raster';
import { loadGlb, meshBounds } from '../src/server/glb';

/** A .glb with one quad (two triangles) coloured by COLOR_0, under a translated node. */
function writeQuadGlb(file: string): void {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 2, 0, 0, 2, 0]);
  const col = new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]);
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(col.buffer), Buffer.from(idx.buffer)]);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [0, 0, 5] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, indices: 2 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 48 }, { buffer: 0, byteOffset: 96, byteLength: 12 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
  };
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const binPad = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + binPad.length, 8);
  const ch = (len: number, type: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  fs.writeFileSync(file, Buffer.concat([header, ch(js.length, 0x4e4f534a), js, ch(binPad.length, 0x004e4942), binPad]));
}

describe('glb', () => {
  it('reads triangles, node transforms and vertex colours, and renders them', async () => {
    const file = path.join(os.tmpdir(), `mb-quad-${process.pid}.glb`);
    writeQuadGlb(file);
    const m = await loadGlb(file);
    expect(m.indices.length).toBe(6);
    expect(meshBounds(m)).toEqual({ min: [0, 0, 5], max: [1, 2, 5] });
    expect([...m.colors.slice(0, 3)]).toEqual([255, 0, 0]);
    const res = renderMeshOrtho(m, { view: 'back', ppu: 10, u0: -2, v0: 3, width: 40, height: 40 });
    const filled = maskOf(res).reduce((s, v) => s + (v ? 1 : 0), 0);
    expect(filled).toBeGreaterThan(150); // 1 x 2 studs at 10 px/stud = 200 px
    expect(filled).toBeLessThan(260);
    fs.rmSync(file);
  });
});
