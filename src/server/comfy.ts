// Image generation through a ComfyUI server (on this PC or another one).
//
// Works with any workflow exported from ComfyUI with "Export (API)":
//   comfy/workflows/generate.json   text -> image (hero, style tests)
//   comfy/workflows/edit.json       reference images + text -> image (sheet, views, parts, edits)
// The client finds the prompt, reference-image, size, seed and output nodes by itself; nodes
// titled MB_PROMPT, MB_NEGATIVE, MB_REF_1..n, MB_SIZE, MB_OUTPUT override the guesses.
// ComfyUI HTTP API: POST /upload/image, POST /prompt, GET /history/{id}, GET /view, GET /system_stats.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { RefInput } from './gemini';
import { ROOT } from './paths';
import { type SshConfig, ensureRemoteComfy, remoteSessionState, sshConfig } from './remote';

export interface ComfyConfig {
  url: string;
  generate: string; // workflow file paths
  edit: string;
  timeoutMs: number;
  maxMP: number; // cap on output megapixels
  /** When set, ComfyUI is started on the GPU PC over SSH on first use and tunnelled to `url`. */
  ssh: SshConfig | null;
}

export function comfyConfig(): ComfyConfig | null {
  const ssh = sshConfig();
  const url = process.env.COMFYUI_URL?.trim() || (ssh ? `http://127.0.0.1:${ssh.localPort}` : '');
  if (!url) return null;
  const file = (v: string | undefined, def: string) => path.resolve(ROOT, v?.trim() || def);
  return {
    ssh,
    url: url.replace(/\/+$/, ''),
    generate: file(process.env.COMFYUI_WORKFLOW_GENERATE, 'comfy/workflows/generate.json'),
    edit: file(process.env.COMFYUI_WORKFLOW_EDIT, 'comfy/workflows/edit.json'),
    timeoutMs: Number(process.env.COMFYUI_TIMEOUT_S || 900) * 1000,
    maxMP: Number(process.env.COMFYUI_MAX_MP || 2),
  };
}

interface WfNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}
export type Workflow = Record<string, WfNode>;

export interface Slots {
  prompt: { id: string; field: string } | null;
  negative: { id: string; field: string } | null;
  refs: string[]; // LoadImage node ids, in the order references are assigned
  size: string[]; // nodes whose width/height set the output size
  seeds: { id: string; field: string }[];
  outputs: string[];
}

const byId = (a: string, b: string) => (Number(a) - Number(b)) || a.localeCompare(b);
const titleOf = (n: WfNode) => (n._meta?.title ?? '').trim();
const textField = (n: WfNode): string | null =>
  typeof n.inputs.text === 'string' ? 'text' : typeof n.inputs.prompt === 'string' ? 'prompt' : null;

/** True for API-format exports (node id -> {class_type, inputs}); false for the UI save format. */
export function isApiFormat(wf: unknown): wf is Workflow {
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) return false;
  const o = wf as Record<string, unknown>;
  if ('nodes' in o && 'links' in o) return false;
  const vals = Object.values(o);
  return vals.length > 0 && vals.every((n) => !!n && typeof n === 'object' && typeof (n as WfNode).class_type === 'string');
}

export function analyzeWorkflow(wf: Workflow): Slots {
  const ids = Object.keys(wf).sort(byId);
  const marked = (re: RegExp) => ids.filter((id) => re.test(titleOf(wf[id])));
  const encoders = ids.filter((id) => /TextEncode|Prompt/i.test(wf[id].class_type) && textField(wf[id]));

  let prompt: Slots['prompt'] = null;
  const mp = marked(/^MB_PROMPT$/i).find((id) => textField(wf[id]));
  if (mp) prompt = { id: mp, field: textField(wf[mp])! };
  else {
    const positives = encoders.filter((id) => !/neg/i.test(titleOf(wf[id])));
    const pick = positives.find((id) => String(wf[id].inputs[textField(wf[id])!]).trim()) ?? positives[0];
    if (pick) prompt = { id: pick, field: textField(wf[pick])! };
  }
  let negative: Slots['negative'] = null;
  const mn = marked(/^MB_NEGATIVE$/i).find((id) => textField(wf[id])) ?? encoders.find((id) => /neg/i.test(titleOf(wf[id])) && id !== prompt?.id);
  if (mn) negative = { id: mn, field: textField(wf[mn])! };

  const refNum = (id: string) => Number(titleOf(wf[id]).replace(/\D/g, ''));
  const markedRefs = ids.filter((id) => /^MB_REF_?\d+$/i.test(titleOf(wf[id]))).sort((a, b) => refNum(a) - refNum(b));
  const refs = markedRefs.length ? markedRefs : ids.filter((id) => wf[id].class_type === 'LoadImage');

  const markedSize = marked(/^MB_SIZE$/i);
  const size = markedSize.length ? markedSize
    : ids.filter((id) => /Empty.*Latent/i.test(wf[id].class_type) && 'width' in wf[id].inputs && 'height' in wf[id].inputs);

  const seeds = ids.flatMap((id) => ['seed', 'noise_seed'].filter((f) => typeof wf[id].inputs[f] === 'number').map((field) => ({ id, field })));

  const markedOut = marked(/^MB_OUTPUT$/i);
  const outputs = markedOut.length ? markedOut
    : [...ids.filter((id) => wf[id].class_type === 'SaveImage'), ...ids.filter((id) => wf[id].class_type === 'PreviewImage')];

  return { prompt, negative, refs, size, seeds, outputs };
}

export function describeSlots(wf: Workflow, s: Slots): { text: string; problems: string[] } {
  const n = (id: string) => `${id} ${wf[id].class_type}${titleOf(wf[id]) ? ` "${titleOf(wf[id])}"` : ''}`;
  const problems: string[] = [];
  if (!s.prompt) problems.push('no prompt node found (title one text-encode node MB_PROMPT)');
  if (!s.outputs.length) problems.push('no SaveImage node');
  if (!s.size.length) problems.push('no Empty*Latent node: output size will follow the workflow/reference images (title the size node MB_SIZE)');
  const text = [
    `prompt: ${s.prompt ? `${n(s.prompt.id)}.${s.prompt.field}` : '-'}`,
    `negative: ${s.negative ? `${n(s.negative.id)}.${s.negative.field}` : '-'}`,
    `reference images: ${s.refs.length ? s.refs.map(n).join(', ') : 'none'}`,
    `size: ${s.size.map(n).join(', ') || '-'}`,
    `seeds: ${s.seeds.map((x) => `${x.id}.${x.field}`).join(', ') || '-'}`,
    `output: ${s.outputs.map(n).join(', ') || '-'}`,
  ].join(' | ');
  return { text, problems };
}

/** Output size for an aspect ratio, about 1 MP for 1K and 2 MP for 2K (capped), multiples of 16. */
export function sizeFor(aspect: string, imageSize: string, maxMP = 2): { width: number; height: number } {
  const [a, b] = aspect.split(':').map(Number);
  const ratio = a > 0 && b > 0 ? a / b : 1;
  const mp = Math.min(maxMP, imageSize === '4K' ? 4 : imageSize === '2K' ? 2 : 1) * 1e6;
  const r16 = (v: number) => Math.max(256, Math.round(v / 16) * 16);
  const w = Math.sqrt(mp * ratio);
  return { width: r16(w), height: r16(w / ratio) };
}

async function http(cfg: ComfyConfig, pathname: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  try {
    return await fetch(cfg.url + pathname, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 30000) });
  } catch (e) {
    throw new Error(cfg.ssh
      ? `cannot reach ComfyUI through the SSH tunnel to ${cfg.ssh.target} (${(e as Error).message}). Is the GPU PC on and connected to Tailscale?`
      : `cannot reach ComfyUI at ${cfg.url} (${(e as Error).message}). Is the GPU PC on, ComfyUI running with --listen, and its port open?`);
  }
}

export function loadWorkflow(file: string): Workflow {
  if (!fs.existsSync(file)) throw new Error(`ComfyUI workflow not found: ${file}. Export it from ComfyUI with Workflow > Export (API) (see docs/local-gpu.md).`);
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isApiFormat(wf)) throw new Error(`${file} is not in API format. In ComfyUI use Workflow > Export (API), not the normal Save.`);
  return wf;
}

export async function comfyStatus(cfg: ComfyConfig, start = false): Promise<string> {
  const lines = [`ComfyUI: ${cfg.url}${cfg.ssh ? ` (started on demand on ${cfg.ssh.target} over SSH; ${remoteSessionState()})` : ''}`];
  try {
    if (start) await ensureRemoteComfy(cfg.url, cfg.ssh);
    const r = await http(cfg, '/system_stats', { timeoutMs: 5000 });
    const j = await r.json() as { devices?: { name?: string; vram_total?: number; vram_free?: number }[]; system?: { comfyui_version?: string } };
    const d = j.devices?.[0];
    lines.push(`  reachable: yes${j.system?.comfyui_version ? `, ComfyUI ${j.system.comfyui_version}` : ''}${d ? `, ${d.name}, ${((d.vram_total ?? 0) / 2 ** 30).toFixed(1)} GB VRAM (${((d.vram_free ?? 0) / 2 ** 30).toFixed(1)} free)` : ''}`);
  } catch (e) {
    lines.push(cfg.ssh && !start ? '  not running right now; it starts automatically on the first image (~30-60 s)' : `  reachable: NO - ${(e as Error).message}`);
  }
  for (const [kind, file] of [['generate', cfg.generate], ['edit', cfg.edit]] as const) {
    try {
      const wf = loadWorkflow(file);
      const { text, problems } = describeSlots(wf, analyzeWorkflow(wf));
      lines.push(`  ${kind}.json: ${text}`);
      for (const p of problems) lines.push(`    ! ${p}`);
      if (kind === 'edit' && !analyzeWorkflow(wf).refs.length) lines.push('    ! the edit workflow has no LoadImage node for reference images');
    } catch (e) {
      lines.push(`  ${kind}.json: ${(e as Error).message}`);
    }
  }
  return lines.join('\n');
}

async function upload(cfg: ComfyConfig, png: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), filename);
  form.append('overwrite', 'true');
  form.append('type', 'input');
  const res = await http(cfg, '/upload/image', { method: 'POST', body: form, timeoutMs: 60000 });
  if (!res.ok) throw new Error(`ComfyUI image upload failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  const j = await res.json() as { name: string; subfolder?: string };
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

function errorSummary(body: unknown): string {
  const b = body as { error?: { message?: string; details?: string }; node_errors?: Record<string, { class_type?: string; errors?: { message?: string; details?: string }[] }> };
  const parts: string[] = [];
  if (b?.error?.message) parts.push(b.error.message + (b.error.details ? ` (${b.error.details})` : ''));
  for (const [id, ne] of Object.entries(b?.node_errors ?? {})) {
    parts.push(`node ${id} ${ne.class_type ?? ''}: ${(ne.errors ?? []).map((e) => `${e.message ?? ''} ${e.details ?? ''}`.trim()).join('; ')}`);
  }
  return parts.join(' | ') || JSON.stringify(body).slice(0, 400);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ComfyRequest {
  prompt: string;
  negative?: string;
  refs: RefInput[];
  width: number;
  height: number;
  /** Poll interval (tests use a short one). */
  pollMs?: number;
  /** A specific workflow file in comfy/workflows/ instead of generate.json / edit.json. */
  workflow?: string;
  /** Send the prompt exactly as given (no "Input images: ..." line), e.g. for a LoRA's trigger format. */
  rawPrompt?: boolean;
  /** Key color for nodes titled MB_KEY (an EmptyImage the subject is composited onto). */
  keyColor?: [number, number, number];
}

export async function comfyGenerate(cfg: ComfyConfig, req: ComfyRequest): Promise<{ image: Buffer; workflow: string }> {
  await ensureRemoteComfy(cfg.url, cfg.ssh);
  const file = req.workflow ? path.join(path.dirname(cfg.edit), req.workflow) : req.refs.length ? cfg.edit : cfg.generate;
  const wf = loadWorkflow(file);
  const s = analyzeWorkflow(wf);
  // A named workflow may have no prompt at all (e.g. rembg.json).
  if (!s.prompt && !req.workflow) throw new Error(`${path.basename(file)}: no prompt node found; title the positive text-encode node MB_PROMPT`);
  if (!s.outputs.length) throw new Error(`${path.basename(file)}: no SaveImage node`);
  if (req.refs.length && !s.refs.length) throw new Error(`${path.basename(file)}: no LoadImage node for the reference images`);

  // Reference images: one per LoadImage slot, most important first; extra slots repeat them.
  const labels: string[] = [];
  for (let i = 0; i < s.refs.length; i++) {
    if (!req.refs.length) break;
    const ref = req.refs[i % req.refs.length];
    const png = await sharp(ref.data).resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    wf[s.refs[i]].inputs.image = await upload(cfg, png, `mb_ref_${i + 1}.png`);
    labels.push(i < req.refs.length ? ref.label : `${ref.label} (again)`);
  }
  const text = labels.length && !req.rawPrompt ? `Input images: ${labels.map((l, i) => `image ${i + 1} = ${l}`).join('; ')}.\n\n${req.prompt}` : req.prompt;
  if (s.prompt) wf[s.prompt.id].inputs[s.prompt.field] = text;
  for (const id of Object.keys(wf).filter((k) => /^MB_KEY$/i.test(wf[k]._meta?.title ?? ''))) {
    wf[id].inputs.width = req.width;
    wf[id].inputs.height = req.height;
    if (req.keyColor) wf[id].inputs.color = (req.keyColor[0] << 16) | (req.keyColor[1] << 8) | req.keyColor[2];
  }
  if (s.negative && req.negative) wf[s.negative.id].inputs[s.negative.field] = req.negative;
  for (const id of s.size) { wf[id].inputs.width = req.width; wf[id].inputs.height = req.height; }
  for (const { id, field } of s.seeds) wf[id].inputs[field] = Math.floor(Math.random() * 2 ** 32);

  const res = await http(cfg, '/prompt', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: wf, client_id: 'part-builder' }),
  });
  const body = await res.json().catch(() => ({})) as { prompt_id?: string };
  if (!res.ok || !body.prompt_id) throw new Error(`ComfyUI rejected ${path.basename(file)}: ${errorSummary(body)}`);

  const id = body.prompt_id;
  const started = Date.now();
  while (Date.now() - started < cfg.timeoutMs) {
    await sleep(req.pollMs ?? 1000);
    const h = await (await http(cfg, `/history/${id}`)).json() as Record<string, {
      outputs?: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }>;
      status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
    }>;
    const entry = h[id];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') {
      throw new Error(`ComfyUI failed while running ${path.basename(file)}: ${JSON.stringify(entry.status.messages ?? []).slice(0, 600)}`);
    }
    const order = [...s.outputs, ...Object.keys(entry.outputs ?? {})];
    const img = order.map((nid) => entry.outputs?.[nid]?.images?.[0]).find(Boolean);
    if (img) {
      const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' });
      const v = await http(cfg, `/view?${q}`, { timeoutMs: 60000 });
      if (!v.ok) throw new Error(`ComfyUI /view failed: HTTP ${v.status}`);
      return { image: await sharp(Buffer.from(await v.arrayBuffer())).png().toBuffer(), workflow: path.basename(file) };
    }
    if (entry.status?.completed) throw new Error(`${path.basename(file)} finished without an image (is its SaveImage node connected?)`);
  }
  throw new Error(`ComfyUI did not finish within ${cfg.timeoutMs / 1000}s (raise COMFYUI_TIMEOUT_S; the first run loads the model and is slow)`);
}
