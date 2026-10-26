// Image APIs besides Gemini: OpenAI (and services with the same API), fal.ai and Replicate.
// Each takes a prompt plus optional reference images and returns one image. Model ids come from
// .env, so any model on those services works; the defaults are good general image models.

import sharp from 'sharp';
import { log } from './paths';
import type { RefInput } from './gemini';

export interface ApiRequest {
  prompt: string;
  refs: RefInput[];
  aspectRatio: string; // "3:4"
  tag?: string;
}

export interface ApiResult {
  image: Buffer;
  mime: string;
  model: string;
  costUsd: number;
}

const env = (k: string) => process.env[k]?.trim() || '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ratio = (a: string) => { const [w, h] = a.split(':').map(Number); return w / h; };
const dataUri = (r: RefInput) => `data:${r.mime};base64,${r.data.toString('base64')}`;

/** Reference images at most 1024 px, as JPEG: small uploads, under every API's size limit. */
async function compact(req: ApiRequest): Promise<ApiRequest> {
  const refs = await Promise.all(req.refs.map(async (r) => ({
    ...r, mime: 'image/jpeg',
    data: await sharp(r.data).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer(),
  })));
  return { ...req, refs };
}

/** APIs don't see image labels, so the prompt says which image is which. */
export function labelled(req: ApiRequest): string {
  if (!req.refs.length) return req.prompt;
  return `Input images: ${req.refs.map((r, i) => `image ${i + 1} = ${r.label}`).join('; ')}.\n\n${req.prompt}`;
}

/** The allowed value closest to the wanted aspect ratio. */
export function nearestRatio(want: string, allowed: string[]): string {
  return allowed.reduce((b, a) => (Math.abs(Math.log(ratio(a) / ratio(want))) < Math.abs(Math.log(ratio(b) / ratio(want))) ? a : b));
}

async function fetchJson(url: string, init: RequestInit, what: string): Promise<unknown> {
  let lastErr: Error | null = null;
  for (const wait of [0, 3000, 10000]) {
    if (wait) await sleep(wait);
    const res = await fetch(url, init).catch((e: Error) => { lastErr = e; return null; });
    if (!res) continue;
    const body = await res.text();
    if (res.ok) return body ? JSON.parse(body) : {};
    lastErr = new Error(`${what}: HTTP ${res.status} ${body.slice(0, 400)}`);
    if (res.status !== 429 && res.status < 500) break;
    log(`${what} failed, retrying: ${lastErr.message}`);
  }
  throw lastErr ?? new Error(`${what} failed`);
}

async function download(url: string): Promise<{ image: Buffer; mime: string }> {
  if (url.startsWith('data:')) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
    if (!m) throw new Error('bad data URI in the response');
    return { image: Buffer.from(m[2], 'base64'), mime: m[1] };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`downloading the image failed: HTTP ${res.status}`);
  return { image: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') ?? 'image/png' };
}

// ------------------------------------------------------------------ OpenAI

export const hasOpenAI = () => !!env('OPENAI_API_KEY');
export const openaiModel = () => env('OPENAI_IMAGE_MODEL') || 'gpt-image-1';

/** OpenAI Images API (generations, or edits with the reference images). OPENAI_BASE_URL points it at a compatible service. */
export async function openaiGenerate(request: ApiRequest): Promise<ApiResult> {
  const req = await compact(request);
  const base = (env('OPENAI_BASE_URL') || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = openaiModel();
  const size = { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536' }[nearestRatio(req.aspectRatio, ['1:1', '3:2', '2:3'])]!;
  const headers = { authorization: `Bearer ${env('OPENAI_API_KEY')}` };
  let body: unknown;
  if (req.refs.length) {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', labelled(req));
    form.append('size', size);
    req.refs.forEach((r, i) => form.append('image[]', new Blob([new Uint8Array(r.data)], { type: r.mime }), `image_${i + 1}.${r.mime.split('/')[1] ?? 'png'}`));
    body = await fetchJson(`${base}/images/edits`, { method: 'POST', headers, body: form }, 'OpenAI image edit');
  } else {
    body = await fetchJson(`${base}/images/generations`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: req.prompt, size, n: 1 }),
    }, 'OpenAI image');
  }
  const d = (body as { data?: { b64_json?: string; url?: string }[] }).data?.[0];
  const img = d?.b64_json ? { image: Buffer.from(d.b64_json, 'base64'), mime: 'image/png' } : d?.url ? await download(d.url) : null;
  if (!img) throw new Error('OpenAI returned no image');
  return { ...img, model: `openai:${model}`, costUsd: Number(env('OPENAI_PRICE_PER_IMAGE') || 0.05) };
}

// ------------------------------------------------------------------ fal.ai

export const hasFal = () => !!env('FAL_KEY');
/** FAL_MODEL makes images from text, FAL_EDIT_MODEL from reference images + text. */
export const falModels = () => ({ text: env('FAL_MODEL') || 'fal-ai/nano-banana', edit: env('FAL_EDIT_MODEL') || 'fal-ai/nano-banana/edit' });
const FAL_RATIOS = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'];

/** fal.ai, synchronous endpoint. Reference images go as data URIs, under both common field names. */
export async function falGenerate(request: ApiRequest): Promise<ApiResult> {
  const req = await compact(request);
  const { text, edit } = falModels();
  const model = req.refs.length ? edit : text;
  const input: Record<string, unknown> = {
    prompt: labelled(req), num_images: 1, output_format: 'png', aspect_ratio: nearestRatio(req.aspectRatio, FAL_RATIOS),
  };
  if (req.refs.length) {
    input.image_urls = req.refs.map(dataUri);
    input.image_url = dataUri(req.refs[0]);
  }
  const body = await fetchJson(`https://fal.run/${model}`, {
    method: 'POST', headers: { authorization: `Key ${env('FAL_KEY')}`, 'content-type': 'application/json' }, body: JSON.stringify(input),
  }, `fal ${model}`) as { images?: { url?: string }[]; image?: { url?: string } };
  const url = body.images?.[0]?.url ?? body.image?.url;
  if (!url) throw new Error(`fal ${model} returned no image`);
  return { ...(await download(url)), model: `fal:${model}`, costUsd: Number(env('FAL_PRICE_PER_IMAGE') || 0.04) };
}

// ------------------------------------------------------------------ Replicate

export const hasReplicate = () => !!env('REPLICATE_API_TOKEN');
export const replicateModel = () => env('REPLICATE_MODEL') || 'google/nano-banana';

interface ReplicateInputs { images: string | null; many: boolean; aspect: string[] | null; png: boolean }
const schemas = new Map<string, ReplicateInputs>();

/** Which inputs the model takes, from its published schema (field names differ per model). */
async function replicateInputs(model: string, headers: Record<string, string>): Promise<ReplicateInputs> {
  const hit = schemas.get(model);
  if (hit) return hit;
  const m = await fetchJson(`https://api.replicate.com/v1/models/${model}`, { headers }, `Replicate ${model}`) as {
    latest_version?: { openapi_schema?: { components?: { schemas?: Record<string, { properties?: Record<string, Prop>; enum?: string[] }> } } };
  };
  type Prop = { type?: string; format?: string; items?: { format?: string }; enum?: string[]; allOf?: { $ref?: string }[] };
  const all = m.latest_version?.openapi_schema?.components?.schemas ?? {};
  const props = all.Input?.properties ?? {};
  const enumOf = (p?: Prop) => p?.enum ?? (p?.allOf?.[0]?.$ref ? all[p.allOf[0].$ref.split('/').pop()!]?.enum : undefined) ?? null;
  const names = ['image_input', 'input_images', 'images', 'image_urls', 'reference_images', 'input_image', 'image', 'image_url'];
  const images = names.find((n) => props[n]) ?? Object.keys(props).find((n) => props[n].format === 'uri' || props[n].items?.format === 'uri') ?? null;
  const out: ReplicateInputs = {
    images, many: !!images && props[images].type === 'array',
    aspect: props.aspect_ratio ? enumOf(props.aspect_ratio) : null,
    png: !!enumOf(props.output_format)?.includes('png'),
  };
  schemas.set(model, out);
  return out;
}

/** Replicate: one prediction, waiting for it (then polling if it takes longer). */
export async function replicateGenerate(request: ApiRequest): Promise<ApiResult> {
  const req = await compact(request);
  const model = replicateModel();
  const headers = { authorization: `Bearer ${env('REPLICATE_API_TOKEN')}` };
  const s = await replicateInputs(model, headers);
  const input: Record<string, unknown> = { prompt: labelled(req) };
  if (req.refs.length) {
    if (!s.images) throw new Error(`Replicate model ${model} takes no input images; set REPLICATE_MODEL to an image-editing model`);
    input[s.images] = s.many ? req.refs.map(dataUri) : dataUri(req.refs[0]);
  }
  if (s.aspect?.length) input.aspect_ratio = nearestRatio(req.aspectRatio, s.aspect.filter((a) => /^\d+:\d+$/.test(a)));
  if (s.png) input.output_format = 'png';
  type Pred = { status?: string; output?: string | string[]; error?: string; urls?: { get?: string } };
  let p = await fetchJson(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json', prefer: 'wait' }, body: JSON.stringify({ input }),
  }, `Replicate ${model}`) as Pred;
  const until = Date.now() + 10 * 60_000;
  while (p.status !== 'succeeded') {
    if (p.status === 'failed' || p.status === 'canceled') throw new Error(`Replicate ${model} ${p.status}: ${p.error ?? ''}`);
    if (!p.urls?.get || Date.now() > until) throw new Error(`Replicate ${model} did not finish`);
    await sleep(2000);
    p = await fetchJson(p.urls.get, { headers }, `Replicate ${model}`) as Pred;
  }
  const url = Array.isArray(p.output) ? p.output[0] : p.output;
  if (!url) throw new Error(`Replicate ${model} returned no image`);
  return { ...(await download(url)), model: `replicate:${model}`, costUsd: Number(env('REPLICATE_PRICE_PER_IMAGE') || 0.04) };
}
