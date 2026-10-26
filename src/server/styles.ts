// Style presets: styles/<name>/style.json + example images in the same folder.

import fs from 'node:fs';
import path from 'node:path';
import { STYLES_DIR } from './paths';

export interface StylePreset {
  name: string;
  /** What the render should look like (construction + rendering). */
  description: string;
  /** Things to avoid. */
  avoid: string;
  /** Optional palette guidance in words. */
  palette?: string;
  /** Model to use: 'flash' (Nano Banana 2.1) or 'pro' (accepts real style references). */
  model?: 'flash' | 'pro';
  notes?: string;
}

/** Preset new projects use: the look of models in popular Roblox games (styles/roblox-game). */
export const DEFAULT_STYLE_NAME = 'roblox-game';

/** Fallback fields for presets missing some (the older classic look of plain Roblox parts with studs). */
export const DEFAULT_STYLE: StylePreset = {
  name: 'roblox-parts',
  description:
    'A 3D game asset built ONLY from classic Roblox parts: rectangular blocks, wedges and corner wedges, like a model made in Roblox Studio. ' +
    'Every surface is flat solid plastic in a single color, with small square Roblox studs on the surfaces. Crisp hard edges and right angles. ' +
    'Chunky, simple, readable proportions with a limited palette. Clean neutral studio lighting with soft, even shading.',
  avoid: 'curves, spheres, cylinders, rounded or organic shapes, fur, cloth folds, realistic or painted textures, gradients, outlines, text, logos, watermarks, ground shadows, floors, scenery',
  model: 'flash',
};

export function listStyles(): string[] {
  if (!fs.existsSync(STYLES_DIR)) return [];
  return fs.readdirSync(STYLES_DIR).filter((d) => fs.existsSync(path.join(STYLES_DIR, d, 'style.json')));
}

export function loadStyle(name: string): { preset: StylePreset; images: { file: string; data: Buffer; mime: string }[] } {
  const dir = path.join(STYLES_DIR, name);
  const file = path.join(dir, 'style.json');
  const preset: StylePreset = fs.existsSync(file) ? { ...DEFAULT_STYLE, ...JSON.parse(fs.readFileSync(file, 'utf8')), name } : { ...DEFAULT_STYLE, name };
  const images = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort().slice(0, 6).map((f) => ({
      file: path.join(dir, f),
      data: fs.readFileSync(path.join(dir, f)),
      mime: f.toLowerCase().endsWith('.png') ? 'image/png' : f.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg',
    }))
    : [];
  return { preset, images };
}

export function saveStyle(p: StylePreset): string {
  const dir = path.join(STYLES_DIR, p.name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'style.json');
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  return file;
}
