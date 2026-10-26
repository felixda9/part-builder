// Renders the pose reference images sent with hero prompts (assets/poses/<body>.png): a plain grey
// block mannequin in the body plan's neutral pose, from the hero camera angle. The small local
// image model ignores pose words for some animals (a panda drawn as a teddy bear with arms); a
// picture of the stance fixes that.
//   npx tsx scripts/make-pose-refs.ts
import fs from 'node:fs';
import sharp from 'sharp';
import { applyBatch, type Command } from '../src/core/commands';
import { renderPerspective, threeQuarterCamera } from '../src/core/raster';
import { emptyScene } from '../src/core/scene';
import { type BuildPlan, planToCommands } from '../src/server/plan';

const GREY = '#a8a8a8';
type P = BuildPlan['parts'][number];
const part = (name: string, min: number[], max: number[], bevel?: P['bevel'], mirror = false): P =>
  ({ name, group: 'All', min, max, color: GREY, ...(bevel ? { bevel } : {}), ...(mirror ? { mirror } : {}) } as P);
const ALL4 = ['+x+y', '-x+y', '+x-y', '-x-y'];

// Soft, faceted shapes (bevelled) so the image model takes the stance from it, not plain boxes.
const poses: Record<string, P[]> = {
  // Level back, four equal pillar legs under shoulders and hips, head in front at shoulder height.
  quadruped: [
    // Chunky pet proportions (short legs, thick body, big head) - the image model copies them.
    part('Body', [-0.6, 0.55, -0.9], [0.6, 1.75, 0.9], { ends: ['-z', '+z'], size: 0.3, edges: ALL4, edgeSize: 0.3 }),
    part('Head', [-0.55, 1.15, -1.75], [0.55, 2.25, -0.65], { ends: ['-z', '+z'], size: 0.2, edges: ALL4, edgeSize: 0.2 }),
    part('Snout', [-0.25, 1.2, -2.0], [0.25, 1.55, -1.7], { ends: ['-z'], size: 0.1 }),
    part('RightFrontLeg', [0.15, 0, -0.85], [0.5, 0.95, -0.45], undefined, true),
    part('RightBackLeg', [0.15, 0, 0.45], [0.5, 0.95, 0.85], undefined, true),
    part('Tail', [-0.15, 1.3, 0.85], [0.15, 1.6, 1.25], { ends: ['+z'], size: 0.15 }),
  ],
};

fs.mkdirSync('assets/poses', { recursive: true });
for (const [name, ops] of Object.entries(poses)) {
  const plan: BuildPlan = { summary: name, landmarks: [], palette: [], groups: [{ name: 'All', parent: null, pivot: [0, 1, 0] }], parts: ops, details: [], differences: [], closeups: [] };
  const scene = applyBatch(emptyScene(), planToCommands(plan, [], true) as Command[]).scene;
  const size = 768;
  const res = renderPerspective(scene.parts, threeQuarterCamera(scene.parts, size, size, 45, 20));
  const png = await sharp(Buffer.from(res.color), { raw: { width: size, height: size, channels: 4 } })
    .flatten({ background: { r: 255, g: 255, b: 255 } }).flop().png().toBuffer(); // heroes face image-left
  fs.writeFileSync(`assets/poses/${name}.png`, png);
  console.log(`wrote assets/poses/${name}.png`);
}
