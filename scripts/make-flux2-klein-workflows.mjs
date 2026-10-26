// Writes comfy/workflows/edit.json and generate.json (ComfyUI API format) for FLUX.2 [klein] 4B
// distilled, following ComfyUI's official template (4 steps, cfg 1, references as ReferenceLatent).
//   node scripts/make-flux2-klein-workflows.mjs [unet] [clip] [vae] [refSlots]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [unet = 'flux-2-klein-4b-fp8.safetensors', clip = 'qwen_3_4b.safetensors', vae = 'flux2-vae.safetensors', slots = '4'] = process.argv.slice(2);
const n = (class_type, inputs, title) => ({ class_type, inputs, ...(title ? { _meta: { title } } : {}) });

function build(refSlots) {
  const wf = {
    1: n('UNETLoader', { unet_name: unet, weight_dtype: 'default' }),
    2: n('CLIPLoader', { clip_name: clip, type: 'flux2', device: 'default' }),
    3: n('VAELoader', { vae_name: vae }),
    10: n('CLIPTextEncode', { text: '', clip: ['2', 0] }, 'MB_PROMPT'),
    11: n('ConditioningZeroOut', { conditioning: ['10', 0] }),
  };
  let pos = ['10', 0], neg = ['11', 0];
  for (let i = 1; i <= refSlots; i++) {
    wf[20 + i] = n('LoadImage', { image: 'example.png' }, `MB_REF_${i}`);
    wf[30 + i] = n('ImageScaleToTotalPixels', { image: [String(20 + i), 0], upscale_method: 'lanczos', megapixels: 1.0, resolution_steps: 1 });
    wf[40 + i] = n('VAEEncode', { pixels: [String(30 + i), 0], vae: ['3', 0] });
    wf[50 + i] = n('ReferenceLatent', { conditioning: pos, latent: [String(40 + i), 0] });
    wf[60 + i] = n('ReferenceLatent', { conditioning: neg, latent: [String(40 + i), 0] });
    pos = [String(50 + i), 0];
    neg = [String(60 + i), 0];
  }
  Object.assign(wf, {
    70: n('EmptyFlux2LatentImage', { width: 1024, height: 1024, batch_size: 1 }, 'MB_SIZE'),
    71: n('Flux2Scheduler', { steps: 4, width: 1024, height: 1024 }, 'MB_SIZE'),
    72: n('CFGGuider', { model: ['1', 0], positive: pos, negative: neg, cfg: 1 }),
    73: n('RandomNoise', { noise_seed: 0 }),
    74: n('KSamplerSelect', { sampler_name: 'euler' }),
    75: n('SamplerCustomAdvanced', { noise: ['73', 0], guider: ['72', 0], sampler: ['74', 0], sigmas: ['71', 0], latent_image: ['70', 0] }),
    76: n('VAEDecode', { samples: ['75', 0], vae: ['3', 0] }),
    77: n('SaveImage', { images: ['76', 0], filename_prefix: 'part-builder' }, 'MB_OUTPUT'),
  });
  return wf;
}

const dir = path.join(root, 'comfy', 'workflows');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'edit.json'), JSON.stringify(build(Number(slots)), null, 2));
fs.writeFileSync(path.join(dir, 'generate.json'), JSON.stringify(build(0), null, 2));
console.log(`wrote edit.json (${slots} reference slots) and generate.json in ${dir} for ${unet}`);
