import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ComfyConfig, type Workflow, analyzeWorkflow, comfyGenerate, comfyStatus, isApiFormat, sizeFor } from '../src/server/comfy';

// A FLUX.2-style edit workflow in API format (shape of a ComfyUI "Export (API)").
const EDIT: Workflow = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: 'flux-2-klein-9b.safetensors', weight_dtype: 'default' } },
  '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_8b.safetensors', type: 'flux2' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'turn the cat into a dog', clip: ['2', 0] }, _meta: { title: 'CLIP Text Encode (Positive Prompt)' } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] }, _meta: { title: 'CLIP Text Encode (Negative Prompt)' } },
  '10': { class_type: 'LoadImage', inputs: { image: 'example.png' } },
  '11': { class_type: 'LoadImage', inputs: { image: 'example2.png' } },
  '20': { class_type: 'EmptyFlux2LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  '25': { class_type: 'RandomNoise', inputs: { noise_seed: 42 } },
  '30': { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['29', 0] } },
};
const GENERATE: Workflow = Object.fromEntries(Object.entries(EDIT).filter(([id]) => id !== '10' && id !== '11'));

describe('workflow analysis', () => {
  it('finds prompt, refs, size, seed and output by itself', () => {
    const s = analyzeWorkflow(EDIT);
    expect(s.prompt).toEqual({ id: '6', field: 'text' });
    expect(s.negative).toEqual({ id: '7', field: 'text' });
    expect(s.refs).toEqual(['10', '11']);
    expect(s.size).toEqual(['20']);
    expect(s.seeds).toEqual([{ id: '25', field: 'noise_seed' }]);
    expect(s.outputs).toEqual(['30']);
  });
  it('MB_ titles override the guesses', () => {
    const wf: Workflow = JSON.parse(JSON.stringify(EDIT));
    wf['7']._meta = { title: 'MB_PROMPT' };
    wf['11']._meta = { title: 'MB_REF_1' };
    wf['10']._meta = { title: 'MB_REF_2' };
    const s = analyzeWorkflow(wf);
    expect(s.prompt).toEqual({ id: '7', field: 'text' });
    expect(s.refs).toEqual(['11', '10']);
  });
  it('rejects the normal (non-API) save format', () => {
    expect(isApiFormat(EDIT)).toBe(true);
    expect(isApiFormat({ nodes: [], links: [], version: 0.4 })).toBe(false);
  });
  it('sizes outputs by aspect ratio, in multiples of 16', () => {
    expect(sizeFor('1:1', '1K')).toEqual({ width: 1008, height: 1008 });
    const s = sizeFor('4:1', '2K', 2);
    expect(s.width % 16 + s.height % 16).toBe(0);
    expect(s.width / s.height).toBeCloseTo(4, 0);
    expect(s.width * s.height).toBeLessThan(2.1e6);
  });
});

describe('client against a fake ComfyUI server', () => {
  let server: http.Server;
  let cfg: ComfyConfig;
  const uploads: string[] = [];
  let queued: Workflow | null = null;
  let polls = 0;
  let outputPng: Buffer;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-comfy-'));

  beforeAll(async () => {
    outputPng = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 200, b: 30 } } }).png().toBuffer();
    fs.writeFileSync(path.join(dir, 'edit.json'), JSON.stringify(EDIT));
    fs.writeFileSync(path.join(dir, 'generate.json'), JSON.stringify(GENERATE));
    fs.writeFileSync(path.join(dir, 'ui.json'), JSON.stringify({ nodes: [], links: [] }));
    server = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://x');
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const json = (o: unknown, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (url.pathname === '/system_stats') return json({ system: { comfyui_version: '0.9.9' }, devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 3090', vram_total: 24 * 2 ** 30, vram_free: 22 * 2 ** 30 }] });
        if (url.pathname === '/upload/image') {
          const name = /filename="([^"]+)"/.exec(body.toString('latin1'))![1];
          uploads.push(name);
          return json({ name, subfolder: '', type: 'input' });
        }
        if (url.pathname === '/prompt') {
          queued = JSON.parse(body.toString()).prompt;
          polls = 0;
          return json({ prompt_id: 'abc', number: 1, node_errors: {} });
        }
        if (url.pathname === '/history/abc') {
          polls++;
          if (polls < 2) return json({}); // still running
          return json({ abc: { outputs: { '30': { images: [{ filename: 'ComfyUI_0001.png', subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true } } });
        }
        if (url.pathname === '/view') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(outputPng); return; }
        res.writeHead(404); res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    cfg = { url: `http://127.0.0.1:${port}`, generate: path.join(dir, 'generate.json'), edit: path.join(dir, 'edit.json'), timeoutMs: 10000, maxMP: 2, ssh: null };
  });
  afterAll(() => server.close());

  it('reports the GPU and how the workflows were read', async () => {
    const s = await comfyStatus(cfg);
    expect(s).toContain('RTX 3090');
    expect(s).toContain('24.0 GB VRAM');
    expect(s).toMatch(/edit\.json: prompt: 6 CLIPTextEncode/);
  });

  it('runs an edit: uploads refs, fills prompt/size/seed, returns the image', async () => {
    const ref = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 255, g: 0, b: 255 } } }).png().toBuffer();
    const r = await comfyGenerate(cfg, {
      prompt: 'Show four views', negative: 'curves', width: 2832, height: 704, pollMs: 10,
      refs: [{ label: 'HERO DESIGN', data: ref, mime: 'image/png' }],
    });
    expect(Buffer.compare(r.image, outputPng)).toBe(0);
    expect(uploads).toEqual(['mb_ref_1.png', 'mb_ref_2.png']); // one ref fills both slots
    const wf = queued!;
    expect(String(wf['6'].inputs.text)).toBe('Input images: image 1 = HERO DESIGN; image 2 = HERO DESIGN (again).\n\nShow four views');
    expect(wf['7'].inputs.text).toBe('curves');
    expect(wf['10'].inputs.image).toBe('mb_ref_1.png');
    expect(wf['20'].inputs).toMatchObject({ width: 2832, height: 704 });
    expect(wf['25'].inputs.noise_seed).not.toBe(42);
  });

  it('uses the generate workflow without references', async () => {
    uploads.length = 0;
    await comfyGenerate(cfg, { prompt: 'a robot', refs: [], width: 1008, height: 1008, pollMs: 10 });
    expect(uploads).toEqual([]);
    expect(queued!['6'].inputs.text).toBe('a robot');
    expect(queued!['10']).toBeUndefined();
  });

  it('explains a non-API export', async () => {
    await expect(comfyGenerate({ ...cfg, generate: path.join(dir, 'ui.json') }, { prompt: 'x', refs: [], width: 512, height: 512 }))
      .rejects.toThrow(/Export \(API\)/);
  });

  it('explains an unreachable server', async () => {
    await expect(comfyGenerate({ ...cfg, url: 'http://127.0.0.1:1' }, { prompt: 'x', refs: [], width: 512, height: 512 }))
      .rejects.toThrow(/cannot reach ComfyUI/);
  });
});
