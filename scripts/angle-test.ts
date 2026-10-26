// Try one Qwen Multiple-Angles prompt on a project's hero (local GPU):
//   npx tsx scripts/angle-test.ts <project> "<mva> left side view, eye-level shot" <out.png>
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../src/server/env';
import { generateImage } from '../src/server/imagegen';
import { PROJECTS_DIR } from '../src/server/paths';

loadEnv();
const [project, prompt, out] = process.argv.slice(2);
const refsJson = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, project, 'refs', 'refs.json'), 'utf8'));
const hero = path.join(PROJECTS_DIR, project, 'refs', `${refsJson.hero.picked}.png`);
const r = await generateImage({
  prompt, rawPrompt: true, workflow: 'qwen-angles.json', provider: 'comfyui',
  refs: [{ label: 'HERO', data: fs.readFileSync(hero), mime: 'image/png' }], aspectRatio: '1:1', imageSize: '1K',
});
fs.writeFileSync(out, r.image);
console.log('wrote', out);
process.exit(0);
