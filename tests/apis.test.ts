import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { falGenerate, nearestRatio, openaiGenerate, replicateGenerate } from '../src/server/apis';
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
    expect(JSON.parse(String(calls[0].init!.body))).toMatchObject({ model: 'gpt-image-1', size: '1024x1536', prompt: 'a fox' });
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

  it('fal: edit model with data-URI references, then downloads the result', async () => {
    process.env.FAL_KEY = 'fal-test';
    route((url) => (url.startsWith('https://fal.run/') ? json({ images: [{ url: 'https://cdn.example/out.png' }] }) : new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } })));
    const r = await falGenerate({ prompt: 'back view', refs: [ref('HERO')], aspectRatio: '3:4' });
    expect(calls[0].url).toBe('https://fal.run/fal-ai/nano-banana/edit');
    expect((calls[0].init!.headers as Record<string, string>).authorization).toBe('Key fal-test');
    const body = JSON.parse(String(calls[0].init!.body));
    expect(body.image_urls[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(body.aspect_ratio).toBe('3:4');
    expect(calls[1].url).toBe('https://cdn.example/out.png');
    expect(r.image.equals(png)).toBe(true);
    expect(r.model).toBe('fal:fal-ai/nano-banana/edit');
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
