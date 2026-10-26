// Before/after picture: the hero next to two revisions of a project, each from the front and
// back three-quarter angles:
//   npx tsx scripts/compare-revs.ts <project> <revBefore> <revAfter> <out.png>
import fs from 'node:fs';
import sharp from 'sharp';
import { applyBatch, type Command } from '../src/core/commands';
import { parseScene, type SceneDoc } from '../src/core/scene';
import { contactSheet } from '../src/server/images';
import { renderView } from '../src/server/render';

const [project, before, after, out = 'compare.png'] = process.argv.slice(2);
const dir = `projects/${project}`;
const rev = (r: string) => parseScene(JSON.parse(fs.readFileSync(`${dir}/history/r${r.padStart(5, '0')}.json`, 'utf8')).scene);
const meta = JSON.parse(fs.readFileSync(`${dir}/project.json`, 'utf8'));
const size = 520;
const tiles = [];
const heroFile = `${dir}/refs/${meta.checkpoints?.hero}.png`;
if (fs.existsSync(heroFile)) tiles.push({ png: await sharp(heroFile).resize(size, size, { fit: 'inside' }).png().toBuffer(), label: 'hero' });
for (const [label, r] of [['before', before], ['now', after]] as const) {
  const scene: SceneDoc = rev(r);
  const turned = applyBatch(scene, [{ op: 'rotate', parts: '*', axis: 'y', degrees: 180, pivot: [0, 0, 0] } as Command]).scene;
  tiles.push({ png: (await renderView(scene, 'threequarter', { mode: 'color', grid: false, size })).png, label: `${label} (rev ${r}, ${scene.parts.length} parts)` });
  tiles.push({ png: (await renderView(turned, 'threequarter', { mode: 'color', grid: false, size })).png, label: `${label} from behind` });
}
fs.writeFileSync(out, await contactSheet(tiles, { tileHeight: size, maxWidth: 2700, format: 'png' }));
console.log(`wrote ${out}`);
