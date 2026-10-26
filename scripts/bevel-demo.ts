// Renders bevelled boxes from the front and back three-quarter angles to check the rounding by
// eye, and prints the checks:
//   npx tsx scripts/bevel-demo.ts [out.png]
import fs from 'node:fs';
import { applyBatch, type Command } from '../src/core/commands';
import { lintScene } from '../src/core/lints';
import { emptyScene } from '../src/core/scene';
import { contactSheet } from '../src/server/images';
import { type BuildPlan, checkPlan, planToCommands } from '../src/server/plan';
import { renderView } from '../src/server/render';

const out = process.argv[2] ?? 'bevel-demo.png';
const plan: BuildPlan = {
  summary: 'bevel demo', landmarks: [], palette: ['#e0832f', '#eeeeee'],
  groups: [{ name: 'Body', parent: null, pivot: [0, 0.5, 0] }, { name: 'Head', parent: 'Body', pivot: [0, 1, -1] }],
  parts: [
    { name: 'Torso', group: 'Body', min: [-0.6, 0.2, -1], max: [0.6, 1.2, 1], color: 'p0', bevel: { ends: ['-z', '+z'], size: 0.3, edges: ['+x+y', '-x+y', '+x-y', '-x-y'], edgeSize: 0.1 } },
    { name: 'Skull', group: 'Head', min: [-0.55, 1.4, -2.6], max: [0.55, 2.3, -1.6], color: 'p1', bevel: { ends: ['+z'], size: 0.3, rim: ['+x', '-x', '+y'], edges: ['+x+y', '-x+y'], edgeSize: 0.1 } },
  ],
  details: [], differences: [], closeups: [],
};
console.log(checkPlan(plan));
const scene = applyBatch(emptyScene(), planToCommands(plan, [], true) as Command[]).scene;
console.log(`${scene.parts.length} parts`);
for (const l of lintScene(scene, { symmetric: true, organic: true })) console.log(`${l.kind}: ${l.message}`);
const turned = applyBatch(scene, [{ op: 'rotate', parts: '*', axis: 'y', degrees: 180, pivot: [0, 0, 0] } as Command]).scene;
const tiles = [];
for (const [label, s] of [['front 3/4', scene], ['back 3/4', turned]] as const) {
  for (const group of ['Body', 'Head']) {
    const r = await renderView(s, 'threequarter', { mode: 'color', grid: false, size: 460, group });
    tiles.push({ png: r.png, label: `${group} ${label}` });
  }
}
fs.writeFileSync(out, await contactSheet(tiles, { tileHeight: 460 }));
console.log(`wrote ${out}`);
