// Print the exact prompts the reference pipeline sends for a project, per image source:
//   npx tsx scripts/show-prompts.ts <project> [comfyui|gemini]
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from '../src/server/paths';
import { KEY_COLORS, closeupPrompt, heroPrompt, sheetPrompt, viewPrompt } from '../src/server/prompts';
import { loadStyle } from '../src/server/styles';
import { guessBody } from '../src/server/body';

const [project = 'test_knight', provider = 'comfyui'] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, project, 'project.json'), 'utf8'));
const { preset, images } = loadStyle(meta.style);
const internalFile = path.join(PROJECTS_DIR, project, 'refs', 'internal.json');
const key = fs.existsSync(internalFile) ? JSON.parse(fs.readFileSync(internalFile, 'utf8')).key : KEY_COLORS[0];
const styleRefs = images.length > 0;
const body = meta.body ?? guessBody(meta.idea);
// Local models get "AVOID:" as a negative prompt instead (see imagegen.forDiffusion), and the
// reference images are listed as "image 1 = ..." in front of the prompt.
const local = provider === 'comfyui';
const shape = (p: string) => (local ? p.split('\n').filter((l) => !/^AVOID:/i.test(l.trim())).join('\n') : p);
const withRefs = (labels: string[], p: string) => (local && labels.length ? `Input images: ${labels.map((l, i) => `image ${i + 1} = ${l}`).join('; ')}.\n\n${p}` : p);

const blocks: [string, string][] = [
  ['HERO (x3, 1:1, no reference images)', shape(heroPrompt(meta.idea, preset, key, styleRefs, '', body))],
  ['FRONT VIEW (3:4, reference: the picked hero)', withRefs(['HERO DESIGN'], shape(viewPrompt('front', meta.idea, preset, key, styleRefs, '', body)))],
  ['SIDE VIEW (3:4, references: hero + views made so far)', withRefs(['HERO DESIGN', 'EXISTING FRONT VIEW'], shape(viewPrompt('right', meta.idea, preset, key, styleRefs, '', body)))],
  ['BACK VIEW (3:4)', withRefs(['HERO DESIGN', 'EXISTING FRONT VIEW', 'EXISTING SIDE VIEW'], shape(viewPrompt('back', meta.idea, preset, key, styleRefs, '', body)))],
  ['TOP VIEW (1:1)', withRefs(['HERO DESIGN', 'EXISTING FRONT VIEW', 'EXISTING RIGHT VIEW'], shape(viewPrompt('top', meta.idea, preset, key, styleRefs, '', body)))],
  ['CLOSE-UP, e.g. the head, front (one image per view; references: the front view cropped to the head + hero)', withRefs(['FRONT VIEW cropped around the Head', 'WHOLE DESIGN (hero)'], shape(closeupPrompt('Head', 'front', 'helmeted head with visor', meta.idea, preset, key, styleRefs)))],
];
if (!local) blocks.splice(1, 0, ['TURNAROUND SHEET (Gemini only, front | side | back)', sheetPrompt(meta.idea, preset, key, styleRefs, '', true, body)]);
console.log(`project ${project} | source ${provider} | key color ${key.name} ${key.hex}${local ? ` | negative prompt (ignored by the 4-step distilled model): ${preset.avoid}` : ''}\n`);
for (const [title, p] of blocks) console.log(`======== ${title}\n${p}\n`);
