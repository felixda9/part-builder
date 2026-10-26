// Try single-view generation (the tool's own view prompts) from a hero image on the ComfyUI source:
//   COMFYUI_URL=... npx tsx scripts/comfy-views-check.ts <hero.png> [outDir] [views...]
import fs from 'node:fs';
import path from 'node:path';
import { comfyConfig, comfyGenerate, sizeFor } from '../src/server/comfy';
import { loadEnv } from '../src/server/env';
import { KEY_COLORS, type SingleView, viewPrompt } from '../src/server/prompts';
import { DEFAULT_STYLE } from '../src/server/styles';

loadEnv();
const cfg = comfyConfig();
if (!cfg) throw new Error('set COMFYUI_URL');
const [hero, outArg, ...viewArgs] = process.argv.slice(2);
const out = path.resolve(outArg ?? '.runtime/comfy-views');
fs.mkdirSync(out, { recursive: true });
const views = (viewArgs.length ? viewArgs : ['front', 'right']) as SingleView[];
for (const v of views) {
  const t = Date.now();
  const prompt = viewPrompt(v, 'a small blocky robot', DEFAULT_STYLE, KEY_COLORS[0], false).split('\n').filter((l) => !/^AVOID:/i.test(l)).join('\n');
  const r = await comfyGenerate(cfg, { prompt, refs: [{ label: 'HERO DESIGN', data: fs.readFileSync(hero), mime: 'image/png' }], ...sizeFor(v === 'top' ? '1:1' : '3:4', '2K', cfg.maxMP) });
  const f = path.join(out, `view-${v}.png`);
  fs.writeFileSync(f, r.image);
  console.log(`${v}: ${((Date.now() - t) / 1000).toFixed(1)} s -> ${f}`);
}
