// Before/after of the despill step on a project's raw reference views (subject on grey).
// npx tsx scripts/despill-check.ts <project> <out.jpg>
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';
import { loadRGB } from '../src/server/refs';
import { despill, segmentKey } from '../src/server/imaging';

const [project = 'test_knight', out = 'despill.jpg'] = process.argv.slice(2);
const dir = path.join('projects', project, 'refs');
const tiles: Buffer[] = [];
for (const v of ['front', 'right', 'back']) {
  const f = path.join(dir, `raw_${v}.png`);
  if (!fs.existsSync(f)) continue;
  const img = await loadRGB(f);
  const { mask, key } = segmentKey(img);
  const clean = despill(img, key, mask);
  for (const im of [img, clean]) {
    const rgb = Buffer.alloc(img.width * img.height * 3);
    for (let i = 0; i < img.width * img.height; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = mask.data[i] ? im.data[i * 3 + c] : 128;
    tiles.push(await sharp(rgb, { raw: { width: img.width, height: img.height, channels: 3 } }).resize({ height: 600 }).png().toBuffer());
  }
}
const metas = await Promise.all(tiles.map((t) => sharp(t).metadata()));
let x = 0;
const comp = tiles.map((t, i) => { const c = { input: t, left: x, top: 0 }; x += metas[i].width!; return c; });
await sharp({ create: { width: x, height: 600, channels: 3, background: '#808080' } }).composite(comp).jpeg({ quality: 85 }).toFile(out);
console.log('wrote', out);
