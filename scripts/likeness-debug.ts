// Visual check of the likeness analysis on a project's references and current model:
//   npx tsx scripts/likeness-debug.ts <project> [view] [outDir]
// Writes <view>_debug.png: reference edges (red), model edges (blue), both (black), reference
// lines (orange), model lines (cyan), reference spots (green boxes), model small parts (magenta).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { type OrthoFrame, type OrthoView, renderOrtho, partsOf, viewAxes } from '../src/core/raster';
import { parseScene } from '../src/core/scene';
import { PROJECTS_DIR } from '../src/server/paths';
import { loadMask } from '../src/server/refs';
import { edgeScore, extractLines, findDarkSpots, findSpots, imageEdges, interior, luminanceOf, matchLines, matchSpots, mergeSpots, modelEdges, modelSpots, describeLine } from '../src/server/likeness';

const [project = 'test_knight', view = 'front', outArg] = process.argv.slice(2);
const dir = path.join(PROJECTS_DIR, project);
const out = path.resolve(outArg ?? path.join(dir, 'renders'));
const internal = JSON.parse(fs.readFileSync(path.join(dir, 'refs', 'internal.json'), 'utf8'));
const frame: OrthoFrame = { view: view as OrthoView, ...internal.frames[view] };
const scene = parseScene(JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8')));
const parts = partsOf(scene);
const P = frame.ppu, W = frame.width, H = frame.height;

const refMask = await loadMask(path.join(dir, 'refs', `mask_${view}.png`));
const { data: refPx, info } = await sharp(path.join(dir, 'refs', `norm_${view}.png`)).raw().toBuffer({ resolveWithObject: true });
const L = luminanceOf(refPx, W, H, info.channels);
const res = renderOrtho(parts, frame);
const modelMask = { width: W, height: H, data: new Uint8Array(W * H).map((_, i) => (res.partIndex[i] >= 0 ? 1 : 0)) };
const inset = Math.round(0.06 * P);
const refE = imageEdges(L, interior(refMask, inset), W, H);
const modE = modelEdges(res, parts, interior(modelMask, inset), P);
const sc = edgeScore(refE, modE, 0.08 * P);
const refLines = extractLines(refE, frame), modLines = extractLines(modE, frame);
const lm = matchLines(refLines, modLines, 0.1);
const refSpots = mergeSpots(findSpots(refE, L, frame), findDarkSpots(L, interior(refMask, Math.round(0.05 * P)), frame));
const modSpots = modelSpots(res, parts, frame);
const sm = matchSpots(refSpots, modSpots, 0.12);
console.log(`${view}: edges P ${sc.precision.toFixed(2)} R ${sc.recall.toFixed(2)} F1 ${sc.f1.toFixed(2)} | lines ref ${refLines.length} model ${modLines.length} recall ${lm.recall.toFixed(2)} precision ${lm.precision.toFixed(2)} | spots ref ${refSpots.length} model ${modSpots.length} recall ${sm.recall.toFixed(2)} precision ${sm.precision.toFixed(2)}`);
console.log('missing ref lines:'); for (const l of lm.missing.slice(0, 12)) console.log('  ' + describeLine(l));
console.log('extra model lines:'); for (const l of lm.extra.slice(0, 8)) console.log('  ' + describeLine(l));
console.log('ref spots:'); for (const s of refSpots) console.log(`  ${s.dark ? 'dark' : 'bright'} ${s.hAxis} ${s.h.toFixed(2)} ${s.vAxis} ${s.v.toFixed(2)} size ${s.sizeH.toFixed(2)}x${s.sizeV.toFixed(2)}`);
console.log('unmatched ref spots:', sm.missing.length, '| unmatched model spots:', sm.extra.map((s) => s.part).join(', '));

// Picture
const img = Buffer.alloc(W * H * 3);
for (let i = 0; i < W * H; i++) {
  const g = refMask.data[i] ? 225 : 250;
  let c = [g, g, g];
  if (refE.edge[i] && modE.edge[i]) c = [0, 0, 0];
  else if (refE.edge[i]) c = [230, 40, 40];
  else if (modE.edge[i]) c = [40, 90, 230];
  img.set(c, i * 3);
}
const ax = viewAxes(frame.view as OrthoView);
const toPx = (hh: number, vv: number) => [(hh * ax.h.sign - frame.u0) * P, (frame.v0 - vv * ax.v.sign) * P];
const svg: string[] = [];
const lineSvg = (l: (typeof refLines)[number], color: string, dy: number) => {
  const [a, b] = l.orient === 'h' ? [toPx(l.from, l.pos), toPx(l.to, l.pos)] : [toPx(l.pos, l.from), toPx(l.pos, l.to)];
  svg.push(`<line x1="${a[0] + dy}" y1="${a[1] + dy}" x2="${b[0] + dy}" y2="${b[1] + dy}" stroke="${color}" stroke-width="2" stroke-opacity="0.8"/>`);
};
refLines.forEach((l) => lineSvg(l, '#ff9900', -2));
modLines.forEach((l) => lineSvg(l, '#00c8ff', 2));
for (const s of refSpots) { const [x, y] = toPx(s.h, s.v); svg.push(`<rect x="${x - (s.sizeH * P) / 2 - 2}" y="${y - (s.sizeV * P) / 2 - 2}" width="${s.sizeH * P + 4}" height="${s.sizeV * P + 4}" fill="none" stroke="#11aa33" stroke-width="2"/>`); }
for (const s of modSpots) { const [x, y] = toPx(s.h, s.v); svg.push(`<rect x="${x - (s.sizeH * P) / 2}" y="${y - (s.sizeV * P) / 2}" width="${s.sizeH * P}" height="${s.sizeV * P}" fill="none" stroke="#dd00dd" stroke-width="1.5"/>`); }
const f = path.join(out, `${view}_debug.png`);
await sharp(img, { raw: { width: W, height: H, channels: 3 } })
  .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svg.join('')}</svg>`), top: 0, left: 0 }])
  .png().toFile(f);
console.log('wrote', f);
