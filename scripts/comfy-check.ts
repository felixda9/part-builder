// Check the ComfyUI image source end to end and save sample images:
//   COMFYUI_URL=http://127.0.0.1:18188 npx tsx scripts/comfy-check.ts [outDir]
// Prints status (GPU, workflow understanding), then makes one text-to-image and one edit
// (reference image -> four-view sheet) and reports timings.
import fs from 'node:fs';
import path from 'node:path';
import { comfyConfig, comfyGenerate, comfyStatus, sizeFor } from '../src/server/comfy';
import { loadEnv } from '../src/server/env';

loadEnv();
const cfg = comfyConfig();
if (!cfg) throw new Error('set COMFYUI_URL');
const out = path.resolve(process.argv[2] ?? '.runtime/comfy-check');
fs.mkdirSync(out, { recursive: true });
console.log(await comfyStatus(cfg));

const robot = 'A small blocky robot game asset built ONLY from classic Roblox parts: rectangular blocks and wedges, solid plastic colors (blue, white, yellow), small square studs on the surfaces. Three-quarter view from the front-right, whole robot visible and centred. BACKGROUND: flat uniform pure magenta (#FF00FF), no floor, no shadow.';
let t = Date.now();
const a = await comfyGenerate(cfg, { prompt: robot, refs: [], ...sizeFor('1:1', '1K', cfg.maxMP) });
fs.writeFileSync(path.join(out, 'generate.png'), a.image);
console.log(`generate: ${((Date.now() - t) / 1000).toFixed(1)} s -> ${path.join(out, 'generate.png')}`);

const sheet = 'Using image 1 as the exact design, create a turnaround sheet: ONE image with FOUR views of the same robot side by side, left to right: 1. FRONT VIEW (facing the viewer), 2. RIGHT SIDE VIEW (facing the right edge of the image), 3. BACK VIEW, 4. LEFT SIDE VIEW (facing the left edge). Four equal columns, same scale, orthographic, no text, no borders. Same blocks, wedges, colors and studs as image 1. BACKGROUND: flat uniform pure magenta (#FF00FF), no floor, no shadow.';
t = Date.now();
const b = await comfyGenerate(cfg, { prompt: sheet, refs: [{ label: 'HERO DESIGN', data: a.image, mime: 'image/png' }], ...sizeFor('4:1', '2K', cfg.maxMP) });
fs.writeFileSync(path.join(out, 'edit-sheet.png'), b.image);
console.log(`edit (sheet): ${((Date.now() - t) / 1000).toFixed(1)} s -> ${path.join(out, 'edit-sheet.png')}`);
