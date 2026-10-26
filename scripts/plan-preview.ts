// Builds a plan offline and scores it against a project's references - nothing is saved, the
// project's model and history stay as they are:
//   npx tsx scripts/plan-preview.ts <project> <plan.json> [outDir]
// Prints the plan check, the model checks and the evaluation; writes the evaluation sheet and
// front/back three-quarter renders to outDir.
import fs from 'node:fs';
import path from 'node:path';
import { applyBatch, type Command } from '../src/core/commands';
import { lintScene } from '../src/core/lints';
import { emptyScene } from '../src/core/scene';
import { evaluate } from '../src/server/evaluate';
import { contactSheet } from '../src/server/images';
import { checkPlan, planToCommands, zBuildPlan } from '../src/server/plan';
import { Refs } from '../src/server/refs';
import { renderView } from '../src/server/render';
import { Session } from '../src/server/session';

process.env.PART_BUILDER_NO_REMEMBER = '1';
const [project, planFile, outDir = '.'] = process.argv.slice(2);
const plan = zBuildPlan.parse(JSON.parse(fs.readFileSync(planFile, 'utf8')));
const { errors, warnings } = checkPlan(plan);
for (const e of errors) console.log(`PLAN ERROR ${e}`);
for (const w of warnings) console.log(`plan warning ${w}`);
if (errors.length) process.exit(1);

const s = new Session();
s.open(project, {});
const scene = applyBatch({ ...emptyScene(s.meta.name), palette: s.scene.palette }, planToCommands(plan, [], true) as Command[]).scene;
// In memory only: the preview scene becomes the current revision without being written.
(s as unknown as { history: { push: (sc: typeof scene, label: string) => void } }).history.push(scene, 'preview');
console.log(`${scene.parts.length} parts`);
for (const l of lintScene(scene, { maxPerKind: 100, symmetric: s.meta.symmetric, organic: !['object', 'humanoid'].includes(s.body) }).filter((x) => x.kind !== 'hidden')) console.log(`- ${l.kind}: ${l.message}`);
const r = await evaluate(s, new Refs(s), { log: false });
console.log(r.text);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'preview-eval.jpg'), r.image);
const turned = applyBatch(scene, [{ op: 'rotate', parts: '*', axis: 'y', degrees: 180, pivot: [0, 0, 0] } as Command]).scene;
const tiles = [];
for (const [label, sc] of [['front 3/4', scene], ['back 3/4', turned]] as const) {
  tiles.push({ png: (await renderView(sc, 'threequarter', { mode: 'color', grid: false, size: 560 })).png, label });
}
fs.writeFileSync(path.join(outDir, 'preview-34.png'), await contactSheet(tiles, { tileHeight: 560, format: 'png' }));
console.log(`wrote ${path.join(outDir, 'preview-eval.jpg')} and preview-34.png`);
process.exit(0);
