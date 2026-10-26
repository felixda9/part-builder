// Writes ComfyUI API-format workflows for Qwen-Image-2.1 + turbo LoRA (8 steps), following
// ComfyUI's official "Qwen Image 2.1 Turbo: Image edit" template:
//   qwen-angles.json - + akhaliq's Multiple-Angles LoRA v2, one reference image (the hero); the
//                      prompt is the LoRA's own format, e.g. "<mva> back view, eye-level shot".
//   qwen-edit.json   - plain image edit with two reference images (part close-ups).
//   rembg.json       - background removal only (BiRefNet): one image in, the subject on the key color out.
// Qwen often swaps the key-color background for a pale studio one, which makes white parts
// impossible to cut out, so every workflow ends with BiRefNet + a fill in the key color
// (node "MB_KEY": the client sets its color and size per call).
//   node scripts/make-qwen-workflows.mjs [anglesStrength]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strength = Number(process.argv[2] ?? 1.0);
const n = (class_type, inputs, title) => ({ class_type, inputs, ...(title ? { _meta: { title } } : {}) });

function build({ angles, refs }) {
  const model = angles ? ['3', 0] : ['2', 0];
  const wf = {
    1: n('UNETLoader', { unet_name: 'qwen_image_2.1_int8_convrot.safetensors', weight_dtype: 'default' }),
    2: n('LoraLoaderModelOnly', { model: ['1', 0], lora_name: 'qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors', strength_model: 1.0 }),
    ...(angles ? { 3: n('LoraLoaderModelOnly', { model: ['2', 0], lora_name: 'qwen21_multiple_angles_v2.safetensors', strength_model: strength }) } : {}),
    4: n('QwenImage21Cache', { model, device: 'auto', dtype: 'default' }),
    5: n('CLIPLoader', { clip_name: 'qwen3vl_8b_int8_convrot.safetensors', type: 'qwen_image', device: 'default' }),
    6: n('VAELoader', { vae_name: 'qwen_image_2.1_vae_bf16.safetensors' }),
  };
  const enc = { clip: ['5', 0], prompt: '', negative_prompt: '', resolution: 1024, vae: ['6', 0] };
  for (let i = 1; i <= refs; i++) {
    wf[9 + i] = n('LoadImage', { image: 'example.png' }, `MB_REF_${i}`);
    enc[`images.image_${i}`] = [String(9 + i), 0];
  }
  Object.assign(wf, {
    30: n('TextEncodeQwenImage21', enc, 'MB_PROMPT'),
    20: n('EmptyLatentImage', { width: 1024, height: 1024, batch_size: 1 }, 'MB_SIZE'),
    21: n('ManualSigmas', { sigmas: '1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0' }),
    22: n('KSamplerSelect', { sampler_name: 'euler' }),
    23: n('RandomNoise', { noise_seed: 0 }),
    24: n('CFGGuider', { model: ['4', 0], positive: ['30', 0], negative: ['30', 1], cfg: 1 }),
    25: n('SamplerCustomAdvanced', { noise: ['23', 0], guider: ['24', 0], sampler: ['22', 0], sigmas: ['21', 0], latent_image: ['20', 0] }),
    26: n('VAEDecode', { samples: ['25', 0], vae: ['6', 0] }),
    ...onKey(['26', 0]),
    27: n('SaveImage', { images: ['43', 0], filename_prefix: 'part-builder-qwen' }, 'MB_OUTPUT'),
  });
  return wf;
}

/** BiRefNet mask -> the image composited onto a key-color canvas (node 43). */
function onKey(image) {
  return {
    40: n('LoadBackgroundRemovalModel', { bg_removal_name: 'birefnet.safetensors' }),
    41: n('RemoveBackground', { bg_removal_model: ['40', 0], image }),
    42: n('EmptyImage', { width: 1024, height: 1024, batch_size: 1, color: 0xff00ff }, 'MB_KEY'),
    43: n('ImageCompositeMasked', { destination: ['42', 0], source: image, x: 0, y: 0, resize_source: false, mask: ['41', 0] }),
  };
}

function rembg() {
  return {
    10: n('LoadImage', { image: 'example.png' }, 'MB_REF_1'),
    ...onKey(['10', 0]),
    27: n('SaveImage', { images: ['43', 0], filename_prefix: 'part-builder-rembg' }, 'MB_OUTPUT'),
  };
}

const dir = path.join(root, 'comfy', 'workflows');
fs.writeFileSync(path.join(dir, 'qwen-angles.json'), JSON.stringify(build({ angles: true, refs: 1 }), null, 2));
fs.writeFileSync(path.join(dir, 'qwen-edit.json'), JSON.stringify(build({ angles: false, refs: 2 }), null, 2));
fs.writeFileSync(path.join(dir, 'rembg.json'), JSON.stringify(rembg(), null, 2));
console.log(`wrote qwen-angles.json (angles LoRA strength ${strength}), qwen-edit.json and rembg.json in ${dir}`);
