// Image APIs besides Gemini: OpenAI, fal.ai and Replicate. Each takes a prompt plus optional
// reference images and returns one image. Model ids come from .env, so any image model on those
// services works: fal and Replicate field names are read from the model's published schema.

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
  costUsd: number; // estimate
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

// ------------------------------------------------------------------ model schemas (fal, Replicate)

type Prop = { type?: string; format?: string; items?: Prop; enum?: string[]; anyOf?: Prop[]; allOf?: Prop[]; $ref?: string; properties?: Record<string, Prop> };

/** The inputs a model takes: where the reference images go, and which sizes it allows. */
export interface Inputs {
  images: string | null;
  many: boolean;
  aspect: string[] | null; // aspect_ratio values like "3:4"
  sizes: string[] | null; // image_size names like "portrait_4_3" (models without aspect_ratio)
  png: boolean;
}

const RATIOS = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'];
/** Nano Banana's field names, used when a model's schema can't be read. */
const NANO = (images: string): Inputs => ({ images, many: true, aspect: RATIOS, sizes: null, png: true });
const IMAGE_FIELDS = ['image_urls', 'image_input', 'input_images', 'images', 'reference_images', 'image_url', 'input_image', 'image'];
const NAMED_SIZES: Record<string, string> = { square_hd: '1:1', portrait_4_3: '3:4', portrait_16_9: '9:16', landscape_4_3: '4:3', landscape_16_9: '16:9' };

export function readInputs(props: Record<string, Prop>, all: Record<string, Prop>): Inputs {
  const resolve = (p?: Prop) => (p?.$ref ? all[p.$ref.split('/').pop()!] : p);
  const enumOf = (p?: Prop): string[] | null => {
    const r = resolve(p);
    if (!r) return null;
    if (r.enum) return r.enum;
    for (const q of [...(r.anyOf ?? []), ...(r.allOf ?? [])]) { const e = enumOf(q); if (e) return e; }
    return null;
  };
  const isArray = (p?: Prop): boolean => { const r = resolve(p); return r?.type === 'array' || !!r?.anyOf?.some(isArray); };
  const isUri = (p?: Prop): boolean => { const r = resolve(p); return r?.format === 'uri' || r?.items?.format === 'uri' || !!r?.anyOf?.some(isUri); };
  const images = IMAGE_FIELDS.find((n) => props[n]) ?? Object.keys(props).find((n) => isUri(props[n])) ?? null;
  const aspect = enumOf(props.aspect_ratio)?.filter((a) => /^\d+:\d+$/.test(a)) ?? null;
  const sizes = aspect?.length ? null : enumOf(props.image_size)?.filter((s) => NAMED_SIZES[s]) ?? null;
  return { images, many: !!images && isArray(props[images]), aspect: aspect?.length ? aspect : null, sizes: sizes?.length ? sizes : null, png: !!enumOf(props.output_format)?.includes('png') };
}

/** Size fields for one request, from what the model allows. */
function sizeFields(s: Inputs, want: string): Record<string, string> {
  if (s.aspect) return { aspect_ratio: nearestRatio(want, s.aspect) };
  if (s.sizes) {
    const r = nearestRatio(want, s.sizes.map((n) => NAMED_SIZES[n]));
    return { image_size: s.sizes.find((n) => NAMED_SIZES[n] === r)! };
  }
  return {};
}

// ------------------------------------------------------------------ OpenAI

export const hasOpenAI = () => !!env('OPENAI_API_KEY');
export const openaiModel = () => env('OPENAI_IMAGE_MODEL') || 'gpt-image-2.5-sunburst';

/** OpenAI Images API: generations, or edits with the reference images. */
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
    form.append('quality', 'medium');
    req.refs.forEach((r, i) => form.append('image[]', new Blob([new Uint8Array(r.data)], { type: r.mime }), `image_${i + 1}.jpg`));
    body = await fetchJson(`${base}/images/edits`, { method: 'POST', headers, body: form }, 'OpenAI image edit');
  } else {
    body = await fetchJson(`${base}/images/generations`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: req.prompt, size, quality: 'medium', n: 1 }),
    }, 'OpenAI image');
  }
  const d = (body as { data?: { b64_json?: string; url?: string }[] }).data?.[0];
  const img = d?.b64_json ? { image: Buffer.from(d.b64_json, 'base64'), mime: 'image/png' } : d?.url ? await download(d.url) : null;
  if (!img) throw new Error('OpenAI returned no image');
  return { ...img, model: `openai:${model}`, costUsd: 0.02 };
}

// ------------------------------------------------------------------ fal.ai

export const hasFal = () => !!env('FAL_KEY');
/** FAL_MODEL makes images from text, FAL_EDIT_MODEL from reference images + text. */
export const falModels = () => ({ text: env('FAL_MODEL') || 'google/nano-banana-2.1', edit: env('FAL_EDIT_MODEL') || 'google/nano-banana-2.1/edit' });
const falSchemas = new Map<string, Inputs>();

async function falInputs(model: string): Promise<Inputs> {
  const hit = falSchemas.get(model);
  if (hit) return hit;
  let out = NANO('image_urls');
  try {
    const j = await fetchJson(`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${encodeURIComponent(model)}`, {}, `fal schema ${model}`) as {
      paths?: Record<string, { post?: { requestBody?: { content?: Record<string, { schema?: Prop }> } } }>; components?: { schemas?: Record<string, Prop> };
    };
    const all = j.components?.schemas ?? {};
    const ref = j.paths?.[`/${model}`]?.post?.requestBody?.content?.['application/json']?.schema?.$ref;
    const props = ref ? all[ref.split('/').pop()!]?.properties : undefined;
    if (props) out = readInputs(props, all);
  } catch (e) {
    log(`fal: could not read the schema of ${model}, using Nano Banana's fields (${(e as Error).message})`);
  }
  falSchemas.set(model, out);
  return out;
}

/** Put a reference image on fal's CDN (the way their client does) and return its URL. */
async function falUpload(r: RefInput, i: number): Promise<string> {
  const init = await fetchJson('https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3', {
    method: 'POST', headers: { authorization: `Key ${env('FAL_KEY')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content_type: r.mime, file_name: `ref_${Date.now()}_${i + 1}.jpg` }),
  }, 'fal upload') as { upload_url?: string; file_url?: string };
  if (!init.upload_url || !init.file_url) throw new Error('fal upload: no upload URL returned');
  const put = await fetch(init.upload_url, { method: 'PUT', body: new Uint8Array(r.data), headers: { 'content-type': r.mime } });
  if (!put.ok) throw new Error(`fal upload failed: HTTP ${put.status}`);
  return init.file_url;
}

/** fal.ai, synchronous endpoint. */
export async function falGenerate(request: ApiRequest): Promise<ApiResult> {
  const req = await compact(request);
  const { text, edit } = falModels();
  const model = req.refs.length ? edit : text;
  const s = await falInputs(model);
  const input: Record<string, unknown> = { prompt: labelled(req), num_images: 1, ...sizeFields(s, req.aspectRatio), ...(s.png ? { output_format: 'png' } : {}) };
  if (req.refs.length) {
    if (!s.images) throw new Error(`fal model ${model} takes no input images; set FAL_EDIT_MODEL to an image-editing model`);
    const urls = await Promise.all(req.refs.map(falUpload));
    input[s.images] = s.many ? urls : urls[0];
  }
  const body = await fetchJson(`https://fal.run/${model}`, {
    method: 'POST', headers: { authorization: `Key ${env('FAL_KEY')}`, 'content-type': 'application/json' }, body: JSON.stringify(input),
  }, `fal ${model}`) as { images?: { url?: string }[]; image?: { url?: string } };
  const url = body.images?.[0]?.url ?? body.image?.url;
  if (!url) throw new Error(`fal ${model} returned no image`);
  return { ...(await download(url)), model: `fal:${model}`, costUsd: 0.04 };
}

// ------------------------------------------------------------------ Replicate

export const hasReplicate = () => !!env('REPLICATE_API_TOKEN');
export const replicateModel = () => env('REPLICATE_MODEL') || 'google/nano-banana-2.1';
const replicateSchemas = new Map<string, Inputs>();

async function replicateInputs(model: string, headers: Record<string, string>): Promise<Inputs> {
  const hit = replicateSchemas.get(model);
  if (hit) return hit;
  let out = NANO('image_input');
  try {
    const m = await fetchJson(`https://api.replicate.com/v1/models/${model}`, { headers }, `Replicate ${model}`) as {
      latest_version?: { openapi_schema?: { components?: { schemas?: Record<string, Prop> } } };
    };
    const all = m.latest_version?.openapi_schema?.components?.schemas ?? {};
    if (all.Input?.properties) out = readInputs(all.Input.properties, all);
    else log(`Replicate: ${model} publishes no schema, using Nano Banana's fields`);
  } catch (e) {
    log(`Replicate: could not read the schema of ${model}, using Nano Banana's fields (${(e as Error).message})`);
  }
  replicateSchemas.set(model, out);
  return out;
}

/** Replicate: one prediction, waiting for it (then polling if it takes longer). */
export async function replicateGenerate(request: ApiRequest): Promise<ApiResult> {
  const req = await compact(request);
  const model = replicateModel();
  const headers = { authorization: `Bearer ${env('REPLICATE_API_TOKEN')}` };
  const s = await replicateInputs(model, headers);
  const input: Record<string, unknown> = { prompt: labelled(req), ...sizeFields(s, req.aspectRatio), ...(s.png ? { output_format: 'png' } : {}) };
  if (req.refs.length) {
    if (!s.images) throw new Error(`Replicate model ${model} takes no input images; set REPLICATE_MODEL to an image-editing model`);
    input[s.images] = s.many ? req.refs.map(dataUri) : dataUri(req.refs[0]);
  }
  type Pred = { status?: string; output?: string | string[]; error?: string; urls?: { get?: string } };
  let p = await fetchJson(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json', prefer: 'wait' }, body: JSON.stringify({ input }),
  }, `Replicate ${model}`) as Pred;
  const until = Date.now() + 10 * 60_000;
  while (p.status !== 'succeeded') {
    if (p.status === 'failed' || p.status === 'canceled' || p.status === 'aborted') throw new Error(`Replicate ${model} ${p.status}: ${p.error ?? ''}`);
    if (!p.urls?.get || Date.now() > until) throw new Error(`Replicate ${model} did not finish`);
    await sleep(2000);
    p = await fetchJson(p.urls.get, { headers }, `Replicate ${model}`) as Pred;
  }
  const url = Array.isArray(p.output) ? p.output[0] : p.output;
  if (!url) throw new Error(`Replicate ${model} returned no image`);
  return { ...(await download(url)), model: `replicate:${model}`, costUsd: 0.035 };
}
