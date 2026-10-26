// Writes a copy of an image-to-3D model (.glb) placed for Roblox: turned to face -Z (using the
// <model>.align.json from view-3d.ts), scaled to the project height, feet on y=0, centred. Only
// a parent node is added - mesh, UVs and textures are untouched.
//   npx tsx scripts/export-3d.ts <project> <model.glb> [out.glb]
// Import in Studio: Home > Import 3D (or File > Import 3D), pick the file.
import fs from 'node:fs';
import path from 'node:path';
import { loadGlb, meshBounds, transformMesh } from '../src/server/glb';

const [project, glb, outArg] = process.argv.slice(2);
const dir = path.resolve('projects', project);
const align = JSON.parse(fs.readFileSync(glb.replace(/\.glb$/, '.align.json'), 'utf8')) as { yaw: number; heightStuds: number };
const out = outArg ?? path.join(dir, 'exports', `${project}_3d.glb`);

// Same placement as view-3d: turn about y, scale to the height, feet on 0, centred on x/z.
const a = (align.yaw * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
const turned = transformMesh(await loadGlb(glb), [c, 0, s, 0, 1, 0, -s, 0, c], 1, [0, 0, 0]);
const b = meshBounds(turned);
const k = align.heightStuds / (b.max[1] - b.min[1]);
const t = [-((b.min[0] + b.max[0]) / 2) * k, -b.min[1] * k, -((b.min[2] + b.max[2]) / 2) * k];

const buf = fs.readFileSync(glb);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const rest = buf.subarray(20 + jsonLen); // the BIN chunk, unchanged
const scene = json.scenes[json.scene ?? 0];
json.nodes.push({ name: `${project}_placed`, children: scene.nodes, rotation: [0, Math.sin(a / 2), 0, Math.cos(a / 2)], scale: [k, k, k], translation: t });
scene.nodes = [json.nodes.length - 1];
let js = Buffer.from(JSON.stringify(json));
js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(20);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + js.length + rest.length, 8);
header.writeUInt32LE(js.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, js, rest]));
const check = meshBounds(await loadGlb(out));
console.log(`wrote ${out}: ${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ${check.max[0] - check.min[0] > 0 ? `size ${(check.max[0] - check.min[0]).toFixed(2)} x ${(check.max[1] - check.min[1]).toFixed(2)} x ${(check.max[2] - check.min[2]).toFixed(2)} studs, feet at y ${check.min[1].toFixed(2)}` : ''}`);
