// Convert one of ComfyUI's built-in workflow templates (UI format, with subgraphs and widgets)
// into API format, using ComfyUI's own frontend in headless Chromium - so big official templates
// (e.g. Pixal3D image -> 3D) don't have to be rewritten by hand.
//   node scripts/comfy-template-to-api.mjs <templateName> <out.json> [comfyUrl]
// e.g. node scripts/comfy-template-to-api.mjs 3d_pixal3d_trellis2_image_to_model comfy/workflows/pixal3d.json
// ComfyUI must be running (the MCP server starts it on the GPU PC and tunnels it to :18188).
import fs from 'node:fs';
import { chromium } from 'playwright';

const [name, out, base = 'http://127.0.0.1:18188'] = process.argv.slice(2);
if (!name || !out) throw new Error('usage: comfy-template-to-api.mjs <templateName> <out.json> [comfyUrl]');
const template = await (await fetch(`${base}/templates/${name}.json`)).json();

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base);
await page.waitForFunction(() => window.app?.graph && typeof window.app.graphToPrompt === 'function', null, { timeout: 120000 });
const api = await page.evaluate(async (wf) => {
  await window.app.loadGraphData(wf, true, false, 'template');
  const p = await window.app.graphToPrompt();
  return p.output;
}, template);
await browser.close();

// Preview-only nodes would just add work; the saved file is what we need. Some templates pass
// images on THROUGH preview nodes (Pixal3D does), so only drop previews nothing depends on.
const previews = /^(PreviewImage|MaskPreview|Preview3D|Preview3DAdvanced|PreviewAny)$/;
const used = new Set(Object.values(api).flatMap((n) => Object.values(n.inputs).filter((v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string').map((v) => v[0])));
let dropped = 0;
for (const [id, node] of Object.entries(api)) if (previews.test(node.class_type) && !used.has(id)) { delete api[id]; dropped++; }
fs.writeFileSync(out, JSON.stringify(api, null, 2));
const classes = Object.values(api).map((n) => n.class_type);
console.log(`wrote ${out}: ${classes.length} nodes (${dropped} preview nodes dropped)`);
console.log([...new Set(classes)].sort().join(', '));
