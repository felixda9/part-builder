import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { falGenerate, nearestRatio, openaiGenerate, readInputs, replicateGenerate } from '../src/server/apis';
import { defaultProvider, pickProvider } from '../src/server/imagegen';

// A fake fetch: records every call and answers from a routing function.
type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let png: Buffer;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
function route(fn: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => { calls.push({ url, init }); return fn(url, init); });
}
const ref = (label: string) => ({ label, data: png, mime: 'image/png' });
const KEYS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_IMAGE_MODEL', 'FAL_KEY', 'FAL_MODEL', 'FAL_EDIT_MODEL', 'REPLICATE_API_TOKEN', 'REPLICATE_MODEL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'COMFYUI_URL', 'COMFYUI_SSH', 'IMAGE_PROVIDER', 'PART_BUILDER_FAKE_IMAGES'];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  calls = [];
  png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff00ff' } }).png().toBuffer();
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('image APIs', () => {
  it('picks the nearest allowed aspect ratio', () => {
    expect(nearestRatio('3:4', ['1:1', '3:2', '2:3'])).toBe('2:3');
    expect(nearestRatio('21:9', ['1:1', '16:9', '4:3'])).toBe('16:9');
    expect(nearestRatio('1:1', ['4:3', '1:1'])).toBe('1:1');
  });

  it('OpenAI: text only goes to generations, with references to edits', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    route(() => json({ data: [{ b64_json: png.toString('base64') }] }));
    const a = await openaiGenerate({ prompt: 'a fox', refs: [], aspectRatio: '3:4' });
    expect(calls[0].url).toBe('https://api.openai.com/v1/images/generations');
    expect(JSON.parse(String(calls[0].init!.body))).toMatchObject({ model: 'gpt-image-2.5-sunburst', size: '1024x1536', prompt: 'a fox', quality: 'medium' });
    expect((calls[0].init!.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    expect(a.image.equals(png)).toBe(true);

    process.env.OPENAI_BASE_URL = 'http://compat.example/v1/';
    await openaiGenerate({ prompt: 'side view', refs: [ref('HERO DESIGN'), ref('EXISTING FRONT VIEW')], aspectRatio: '1:1' });
    expect(calls[1].url).toBe('http://compat.example/v1/images/edits');
    const form = calls[1].init!.body as FormData;
    expect(form.getAll('image[]')).toHaveLength(2);
    expect(String(form.get('prompt'))).toMatch(/^Input images: image 1 = HERO DESIGN; image 2 = EXISTING FRONT VIEW\./);
    expect(form.get('size')).toBe('1024x1024');
  });

  // fal answers: the model schema (or 404), the CDN upload, the model run, the image download.
  function falRoutes(schema: unknown) {
    route((url, init) => {
      if (url.startsWith('https://fal.ai/api/openapi/')) return schema ? json(schema) : json({ detail: 'not found' }, 404);
      if (url.startsWith('https://rest.fal.ai/storage/upload/initiate')) return json({ upload_url: 'https://upload.example/put', file_url: 'https://v3.fal.media/files/ref.jpg' });
      if (url === 'https://upload.example/put') return new Response(null, { status: init?.method === 'PUT' ? 200 : 405 });
      if (url.startsWith('https://fal.run/')) return json({ images: [{ url: 'https://cdn.example/out.png' }] });
      return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
    });
  }
  const runBody = () => JSON.parse(String(calls.find((c) => c.url.startsWith('https://fal.run/'))!.init!.body));

  it('fal: uploads references to the CDN and uses the field names from the model schema', async () => {
    process.env.FAL_KEY = 'fal-test';
    process.env.FAL_EDIT_MODEL = 'fal-ai/flux-pro/kontext';
    // A model with ONE image field and its aspect ratios inside anyOf (like FLUX Kontext).
    falRoutes({
      paths: { '/fal-ai/flux-pro/kontext': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/KontextInput' } } } } } } },
      components: { schemas: { KontextInput: { properties: {
        prompt: { type: 'string' }, image_url: { type: 'string' },
        aspect_ratio: { anyOf: [{ type: 'string', enum: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] }, { type: 'null' }] },
        output_format: { enum: ['jpeg', 'png'] },
      } } } },
    });
    const r = await falGenerate({ prompt: 'back view', refs: [ref('HERO')], aspectRatio: '2:3' });
    const init = calls.find((c) => c.url.includes('/storage/upload/initiate'))!;
    expect((init.init!.headers as Record<string, string>).authorization).toBe('Key fal-test');
    expect(JSON.parse(String(init.init!.body)).content_type).toBe('image/jpeg');
    const body = runBody();
    expect(calls.find((c) => c.url.startsWith('https://fal.run/'))!.url).toBe('https://fal.run/fal-ai/flux-pro/kontext');
    expect(body.image_url).toBe('https://v3.fal.media/files/ref.jpg');
    expect(body.image_urls).toBeUndefined();
    expect(body.aspect_ratio).toBe('3:4');
    expect(body.output_format).toBe('png');
    expect(r.image.equals(png)).toBe(true);
    expect(r.model).toBe('fal:fal-ai/flux-pro/kontext');
  });

  it("fal: without a readable schema it uses Nano Banana's fields", async () => {
    process.env.FAL_KEY = 'fal-test';
    falRoutes(null);
    await falGenerate({ prompt: 'side view', refs: [ref('HERO'), ref('FRONT')], aspectRatio: '3:4' });
    const body = runBody();
    expect(calls.find((c) => c.url.startsWith('https://fal.run/'))!.url).toBe('https://fal.run/google/nano-banana-2.1/edit');
    expect(body.image_urls).toEqual(['https://v3.fal.media/files/ref.jpg', 'https://v3.fal.media/files/ref.jpg']);
    expect(body.aspect_ratio).toBe('3:4');
  });

  it('reads models that take named sizes instead of aspect ratios', () => {
    const s = readInputs({
      image_urls: { type: 'array', items: { format: 'uri' } },
      image_size: { anyOf: [{ $ref: '#/components/schemas/ImageSize' }, { enum: ['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9'], type: 'string' }, { type: 'null' }] },
    }, { ImageSize: { properties: { width: { type: 'integer' } } } });
    expect(s).toMatchObject({ images: 'image_urls', many: true, aspect: null, png: false });
    expect(s.sizes).toContain('portrait_4_3');
  });

  it('Replicate: reads the model schema, sends the right fields and polls until done', async () => {
    process.env.REPLICATE_API_TOKEN = 'r8-test';
    process.env.REPLICATE_MODEL = 'acme/image-model';
    let polls = 0;
    route((url) => {
      if (url === 'https://api.replicate.com/v1/models/acme/image-model') {
        return json({ latest_version: { openapi_schema: { components: { schemas: {
          Input: { properties: { prompt: { type: 'string' }, input_images: { type: 'array', items: { format: 'uri' } }, aspect_ratio: { allOf: [{ $ref: '#/components/schemas/aspect_ratio' }] }, output_format: { enum: ['jpg', 'png'] } } },
          aspect_ratio: { enum: ['match_input_image', '1:1', '3:4', '4:3'] },
        } } } } });
      }
      if (url.endsWith('/predictions')) return json({ status: 'processing', urls: { get: 'https://api.replicate.com/v1/predictions/p1' } });
      if (url.endsWith('/p1')) return json(++polls < 2 ? { status: 'processing', urls: { get: url } } : { status: 'succeeded', output: ['https://cdn.example/r.png'] });
      return new Response(new Uint8Array(png));
    });
    const r = await replicateGenerate({ prompt: 'front view', refs: [ref('HERO')], aspectRatio: '2:3' });
    const pred = calls.find((c) => c.url.endsWith('/predictions'))!;
    expect((pred.init!.headers as Record<string, string>).prefer).toBe('wait');
    const input = JSON.parse(String(pred.init!.body)).input;
    expect(input.input_images[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(input.aspect_ratio).toBe('3:4');
    expect(input.output_format).toBe('png');
    expect(r.image.equals(png)).toBe(true);
  }, 15_000);

  it('default source: IMAGE_PROVIDER, else the first one set up; clear error when none', () => {
    expect(defaultProvider()).toBeNull();
    expect(() => pickProvider()).toThrow(/No image source configured/);
    process.env.FAL_KEY = 'x';
    expect(defaultProvider()).toBe('fal');
    process.env.OPENAI_API_KEY = 'x';
    expect(defaultProvider()).toBe('openai');
    process.env.IMAGE_PROVIDER = 'fal';
    expect(defaultProvider()).toBe('fal');
    expect(() => pickProvider('replicate')).toThrow(/REPLICATE_API_TOKEN/);
  });
});
