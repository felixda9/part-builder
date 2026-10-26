// Image -> 3D model on the GPU PC (ComfyUI, Pixal3D or TRELLIS.2 via comfy/workflows/pixal3d.json).
// Saves every file the workflow outputs (the textured .glb, previews) into projects/<p>/3d/:
//   npx tsx scripts/make-3d.ts <project> [image.png] [--trellis] [--seed N] [--faces N] [--texture N]
// The image defaults to the project's picked hero. --faces / --texture make a lighter mesh (the
// workflow decimates and bakes the detail into the texture): Roblox takes at most ~20k triangles
// per MeshPart and shows textures at up to 1024 px, so --faces 15000 --texture 1024 for Studio.
import fs from 'node:fs';
import path from 'node:path';
import { comfyConfig, loadWorkflow } from '../src/server/comfy';
import { loadEnv } from '../src/server/env';
import { ensureRemoteComfy, stopRemoteComfy } from '../src/server/remote';

loadEnv();
const args = process.argv.slice(2);
const project = args[0];
const trellis = args.includes('--trellis');
const seedArg = args.indexOf('--seed');
const seed = seedArg >= 0 ? Number(args[seedArg + 1]) : 42;
const opt = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : null; };
const faces = opt('--faces'), textureSize = opt('--texture');
const dir = path.resolve('projects', project);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
const image = args[1] && !args[1].startsWith('--') ? args[1] : path.join(dir, 'refs', `${meta.checkpoints?.hero}.png`);
const outDir = path.join(dir, '3d');
fs.mkdirSync(outDir, { recursive: true });

const cfg = comfyConfig();
if (!cfg) throw new Error('no ComfyUI configured (.env COMFYUI_SSH / COMFYUI_URL)');
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
await ensureRemoteComfy(cfg.url, cfg.ssh);
console.log(`ComfyUI up (${secs()})`);

const wf = loadWorkflow(path.resolve('comfy/workflows/pixal3d.json')) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
// Upload the picture and point the LoadImage node at it.
const form = new FormData();
const name = `mb3d_${project}_${path.basename(image)}`;
form.append('image', new Blob([new Uint8Array(fs.readFileSync(image))], { type: 'image/png' }), name);
form.append('overwrite', 'true');
form.append('type', 'input');
const up = await fetch(`${cfg.url}/upload/image`, { method: 'POST', body: form });
if (!up.ok) throw new Error(`upload failed: HTTP ${up.status}`);
const loadImage = Object.entries(wf).find(([, n]) => n.class_type === 'LoadImage')!;
loadImage[1].inputs.image = (await up.json() as { name: string }).name;
// Model switch: false = Pixal3D, true = TRELLIS.2.
for (const n of Object.values(wf)) if (n.class_type === 'PrimitiveBoolean') n.inputs.value = trellis;
for (const n of Object.values(wf)) if (n.class_type === 'KSampler') n.inputs.seed = seed;
for (const n of Object.values(wf)) if (n.class_type === 'Save3DAdvanced' || n.class_type === 'SaveGLB') n.inputs.filename_prefix = `3d/mb_${project}`;
if (faces) for (const n of Object.values(wf)) if (n.class_type === 'DecimateMesh') n.inputs.target_face_count = faces;
if (textureSize) {
  for (const n of Object.values(wf)) {
    if (n.class_type === 'PrimitiveInt' && typeof n.inputs.value === 'number' && n.inputs.value >= 1024) n.inputs.value = textureSize;
    if ((n.class_type === 'BakeNormalMapFromMesh' || n.class_type === 'BakeAmbientOcclusion') && typeof n.inputs.resolution === 'number') n.inputs.resolution = Math.min(n.inputs.resolution, textureSize);
  }
}

const res = await fetch(`${cfg.url}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'part-builder-3d' }) });
const body = await res.json() as { prompt_id?: string; error?: unknown; node_errors?: unknown };
if (!body.prompt_id) throw new Error(`ComfyUI rejected the workflow: ${JSON.stringify(body).slice(0, 800)}`);
console.log(`queued ${body.prompt_id} (${trellis ? 'TRELLIS.2' : 'Pixal3D'}, seed ${seed})`);

type FileRef = { filename: string; subfolder?: string; type?: string };
while (true) {
  await new Promise((r) => setTimeout(r, 3000));
  if (Date.now() - t0 > 30 * 60_000) throw new Error('timed out after 30 min');
  const h = await (await fetch(`${cfg.url}/history/${body.prompt_id}`)).json() as Record<string, { outputs?: Record<string, Record<string, unknown>>; status?: { status_str?: string; completed?: boolean; messages?: unknown[] } }>;
  const entry = h[body.prompt_id];
  if (!entry) continue;
  if (entry.status?.status_str === 'error') throw new Error(`ComfyUI failed: ${JSON.stringify(entry.status.messages).slice(0, 1500)}`);
  if (!entry.status?.completed) continue;
  const files: FileRef[] = [];
  for (const out of Object.values(entry.outputs ?? {})) {
    for (const v of Object.values(out)) if (Array.isArray(v)) for (const f of v) if (f && typeof f === 'object' && 'filename' in f) files.push(f as FileRef);
  }
  console.log(`done in ${secs()}; outputs: ${JSON.stringify(entry.outputs).slice(0, 600)}`);
  const tag = `${trellis ? 'trellis' : 'pixal3d'}_s${seed}${faces ? `_${faces}f` : ''}`;
  for (const f of files) {
    const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output' });
    const v = await fetch(`${cfg.url}/view?${q}`);
    if (!v.ok) { console.log(`  could not fetch ${f.filename}: HTTP ${v.status}`); continue; }
    const file = path.join(outDir, `${tag}_${f.filename}`);
    fs.writeFileSync(file, Buffer.from(await v.arrayBuffer()));
    console.log(`  saved ${file} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
  }
  break;
}
stopRemoteComfy();
process.exit(0);
