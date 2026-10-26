// Looks at an image-to-3D model (.glb) against a project's references: finds how it is turned
// (the AI returns it at any angle), scales it to the project height with the feet on y=0, then
// renders it in every normalized reference frame and from the three-quarter angle, next to the
// references and the hero, and prints how well its outline matches each view:
//   npx tsx scripts/view-3d.ts <project> <model.glb> [out.png]
// Saves the alignment next to the model (<model>.align.json) for later steps.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Vec3 } from '../src/core/math';
import { type OrthoFrame, type OrthoView, maskOf, renderMeshOrtho, renderMeshPerspective } from '../src/core/raster';
import { loadGlb, meshBounds, transformMesh, type TriMesh } from '../src/server/glb';
import { contactSheet } from '../src/server/images';
import { loadMask } from '../src/server/refs';

const [project, glb, out = 'view-3d.png'] = process.argv.slice(2);
const dir = path.resolve('projects', project);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
const frames = JSON.parse(fs.readFileSync(path.join(dir, 'refs', 'internal.json'), 'utf8')).frames as Record<string, Omit<OrthoFrame, 'view'>>;
const views = (['front', 'right', 'back', 'top'] as OrthoView[]).filter((v) => frames[v] && fs.existsSync(path.join(dir, 'refs', `mask_${v}.png`)));
const masks = Object.fromEntries(await Promise.all(views.map(async (v) => [v, await loadMask(path.join(dir, 'refs', `mask_${v}.png`))] as const)));

const raw = await loadGlb(glb);
console.log(`${raw.indices.length / 3} triangles`);

// Turn about y, then scale to the project height and stand it on y=0 centred on x/z.
const place = (yawDeg: number): TriMesh => {
  const a = (yawDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const R = [c, 0, s, 0, 1, 0, -s, 0, c];
  const turned = transformMesh(raw, R, 1, [0, 0, 0]);
  const b = meshBounds(turned);
  const k = meta.heightStuds / (b.max[1] - b.min[1]);
  const t: Vec3 = [-((b.min[0] + b.max[0]) / 2) * k, -b.min[1] * k, -((b.min[2] + b.max[2]) / 2) * k];
  return transformMesh(turned, [1, 0, 0, 0, 1, 0, 0, 0, 1], k, t);
};

// Outline match in one view, at a reduced resolution, allowing a small sideways shift (the
// references centre on the torso, the mesh on its bounding box).
const outline = (m: TriMesh, v: OrthoView, shrink: number) => {
  const f = frames[v];
  const frame: OrthoFrame = { view: v, ppu: f.ppu / shrink, u0: f.u0, v0: f.v0, width: Math.round(f.width / shrink), height: Math.round(f.height / shrink) };
  const mine = maskOf(renderMeshOrtho(m, frame));
  const ref = masks[v];
  let best = { iou: 0, shift: 0 };
  const maxShift = Math.round((0.6 * frame.ppu));
  for (let dx = -maxShift; dx <= maxShift; dx += Math.max(1, Math.round(maxShift / 15))) {
    let inter = 0, uni = 0;
    for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
      const a = mine[y * frame.width + x] > 0;
      const rx = Math.min(ref.width - 1, Math.floor((x + dx) * shrink + shrink / 2)), ry = Math.min(ref.height - 1, Math.floor(y * shrink + shrink / 2));
      const xs = x + dx;
      const b = xs >= 0 && xs < frame.width && ref.data[ry * ref.width + rx] > 0;
      if (a && b) inter++;
      if (a || b) uni++;
    }
    const iou = uni ? inter / uni : 0;
    if (iou > best.iou) best = { iou, shift: dx / frame.ppu };
  }
  return best;
};
const score = (yaw: number, shrink: number) => {
  const m = place(yaw);
  const side = ['front', 'right'].filter((v) => views.includes(v as OrthoView)) as OrthoView[];
  return side.reduce((s, v) => s + outline(m, v, shrink).iou, 0) / side.length;
};

let best = { yaw: 0, s: -1 };
for (let yaw = 0; yaw < 360; yaw += 10) { const s = score(yaw, 4); if (s > best.s) best = { yaw, s }; }
for (let yaw = best.yaw - 8; yaw <= best.yaw + 8; yaw += 2) { const s = score(yaw, 4); if (s > best.s) best = { yaw, s }; }
// Outlines can't tell front from back (a fox looks the same size both ways): compare colours in
// the front and back views (white chest and face in front) for the best turn and its opposite.
const refRgb = Object.fromEntries(await Promise.all(views.map(async (v) => [v, await sharp(path.join(dir, 'refs', `norm_${v}.png`)).removeAlpha().raw().toBuffer()] as const)));
const colorMatch = (m: TriMesh) => {
  let sum = 0, n = 0;
  for (const v of (['front', 'back'] as OrthoView[]).filter((x) => views.includes(x))) {
    const f = frames[v];
    const res = renderMeshOrtho(m, { view: v, ...f, ppu: f.ppu / 2, width: Math.round(f.width / 2), height: Math.round(f.height / 2) });
    const ref = refRgb[v], rw = f.width;
    for (let y = 0; y < res.height; y++) for (let x = 0; x < res.width; x++) {
      const i = y * res.width + x;
      const ri = Math.min(f.height - 1, y * 2) * rw + Math.min(rw - 1, x * 2);
      if (!res.color[i * 4 + 3] || !masks[v].data[ri]) continue;
      sum += Math.abs(res.color[i * 4] - ref[ri * 3]) + Math.abs(res.color[i * 4 + 1] - ref[ri * 3 + 1]) + Math.abs(res.color[i * 4 + 2] - ref[ri * 3 + 2]);
      n++;
    }
  }
  return n ? sum / n : Infinity;
};
const flipped = (best.yaw + 180) % 360;
const [dA, dB] = [colorMatch(place(best.yaw)), colorMatch(place(flipped))];
if (dB < dA) best = { yaw: flipped, s: score(flipped, 4) };
console.log(`turned ${best.yaw} degrees about y (colour difference ${Math.min(dA, dB).toFixed(0)} vs ${Math.max(dA, dB).toFixed(0)} the other way round)`);
const mesh = place(best.yaw);
fs.writeFileSync(glb.replace(/\.glb$/, '.align.json'), JSON.stringify({ yaw: best.yaw, heightStuds: meta.heightStuds }, null, 1));

const tiles = [];
const hero = path.join(dir, 'refs', `${meta.checkpoints?.hero}.png`);
const size = 460;
const png = async (res: ReturnType<typeof renderMeshOrtho>) => sharp(Buffer.from(res.color), { raw: { width: res.width, height: res.height, channels: 4 } })
  .flatten({ background: { r: 226, g: 230, b: 237 } }).png().toBuffer();
if (fs.existsSync(hero)) tiles.push({ png: await sharp(hero).resize(size, size, { fit: 'inside' }).png().toBuffer(), label: 'hero' });
const b = meshBounds(mesh);
const target: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
const radius = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2;
for (const [label, yaw] of [['3D model 3/4', 45], ['3D model from behind', 225]] as const) {
  const a = (yaw * Math.PI) / 180, p = (20 * Math.PI) / 180, dist = (radius / Math.sin((15 * Math.PI) / 180)) * 1.05;
  const eye: Vec3 = [target[0] + Math.sin(a) * Math.cos(p) * dist, target[1] + Math.sin(p) * dist, target[2] - Math.cos(a) * Math.cos(p) * dist];
  tiles.push({ png: await png(renderMeshPerspective(mesh, { eye, target, up: [0, 1, 0], fovY: 30, width: size, height: size })), label });
}
const lines: string[] = [];
for (const v of views) {
  const o = outline(mesh, v, 1);
  lines.push(`${v === 'right' ? 'side' : v}: outline match ${o.iou.toFixed(2)}${Math.abs(o.shift) > 0.02 ? ` (best with a ${o.shift.toFixed(2)} stud shift)` : ''}`);
  tiles.push({ png: await sharp(path.join(dir, 'refs', `norm_${v}.png`)).png().toBuffer(), label: `${v === 'right' ? 'side' : v} reference` });
  tiles.push({ png: await png(renderMeshOrtho(mesh, { view: v, ...frames[v] })), label: `${v === 'right' ? 'side' : v} 3D model (match ${o.iou.toFixed(2)})` });
}
console.log(lines.join('\n'));
fs.writeFileSync(out, await contactSheet(tiles, { tileHeight: size, maxWidth: 2000, format: 'png' }));
console.log(`wrote ${out}`);
