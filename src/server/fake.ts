// Offline stand-in for the image model (PART_BUILDER_FAKE_IMAGES=1): renders a known demo
// model on a key-color background. Normalizing these and evaluating the same model must score
// IoU ~1, which makes the whole reference -> evaluation pipeline testable without an API key.

import sharp from 'sharp';
import { applyBatch, type Command } from '../core/commands';
import { type OrthoView, autoFrame, renderOrtho, renderPerspective, threeQuarterCamera } from '../core/raster';
import { type Part, type SceneDoc, emptyScene } from '../core/scene';

export const DEMO_COMMANDS: Command[] = [
  { op: 'palette', colors: ['#3b4a5a', '#c9ced6', '#f2c39b', '#1b1f24', '#b8860b'] },
  { op: 'box', name: 'Torso', min: [-1, 2, -0.5], max: [1, 4, 0.5], color: 'p1' },
  { op: 'box', name: 'Belt', min: [-1.05, 2.05, -0.55], max: [1.05, 2.35, 0.55], color: 'p0' },
  { op: 'box', name: 'Head', min: [-0.6, 4, -0.6], max: [0.6, 5.2, 0.6], color: 'p2' },
  { op: 'wedge', name: 'Crest', min: [-0.15, 5.2, -0.6], max: [0.15, 5.7, 0.6], tall: '+z', color: 'p4' },
  { op: 'attach', name: 'RightEye', to: 'Head', face: '-z', size: [0.2, 0.2, 0.1], offset: [0.25, 0.1, 0], color: 'p3' },
  { op: 'attach', name: 'LeftEye', to: 'Head', face: '-z', size: [0.2, 0.2, 0.1], offset: [-0.25, 0.1, 0], color: 'p3' },
  { op: 'box', name: 'RightArm', min: [1, 2, -0.5], max: [2, 4, 0.5], color: 'p1' },
  { op: 'wedge', name: 'RightPauldron', min: [1, 4, -0.55], max: [2.1, 4.5, 0.55], tall: '-x', color: 'p0' },
  { op: 'box', name: 'RightLeg', min: [0.05, 0, -0.5], max: [1, 2, 0.5], color: 'p0' },
  { op: 'box', name: 'Sword', min: [2.05, 0.6, -1.6], max: [2.25, 0.9, 1.4], color: 'p1' },
  { op: 'group', name: 'TorsoG', parts: ['Torso', 'Belt'], pivot: [0, 3, 0] },
  { op: 'group', name: 'HeadG', parts: ['Head', 'Crest', 'RightEye', 'LeftEye'], parent: 'TorsoG', pivot: [0, 4, 0], main: 'Head' },
  { op: 'group', name: 'RightArmG', parts: ['RightArm', 'RightPauldron', 'Sword'], parent: 'TorsoG', pivot: [1.5, 3.8, 0], main: 'RightArm' },
  { op: 'group', name: 'RightLegG', parts: ['RightLeg'], parent: 'TorsoG', pivot: [0.5, 2, 0] },
  { op: 'mirror_group', source: 'RightLegG', name: 'LeftLegG' },
  { op: 'box', name: 'LeftArm', min: [-2, 2, -0.5], max: [-1, 4, 0.5], color: 'p1', group: 'TorsoG' },
  { op: 'wedge', name: 'LeftPauldron', min: [-2.1, 4, -0.55], max: [-1, 4.5, 0.55], tall: '+x', color: 'p0', group: 'TorsoG' },
];

let demo: SceneDoc | null = null;
export function demoScene(): SceneDoc {
  demo ??= applyBatch(emptyScene('demo'), DEMO_COMMANDS).scene;
  return demo;
}

function onKey(rgba: Uint8ClampedArray, key: [number, number, number]): Buffer {
  const out = Buffer.alloc((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3] / 255;
    out[j] = rgba[i] * a + key[0] * (1 - a);
    out[j + 1] = rgba[i + 1] * a + key[1] * (1 - a);
    out[j + 2] = rgba[i + 2] * a + key[2] * (1 - a);
  }
  return out;
}

async function orthoImage(parts: Part[], view: OrthoView, ppu: number, key: [number, number, number], w: number, h: number): Promise<Buffer> {
  // Centre the subject in a w x h canvas.
  const f = autoFrame(parts, view, ppu, 0);
  const frame = { ...f, u0: f.u0 - (w - f.width) / 2 / ppu, v0: f.v0 + (h - f.height) / 2 / ppu, width: w, height: h };
  const res = renderOrtho(parts, frame);
  return sharp(onKey(res.color, key), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

export async function fakeHero(key: [number, number, number]): Promise<Buffer> {
  const parts = demoScene().parts;
  const res = renderPerspective(parts, threeQuarterCamera(parts, 1024, 1024));
  return sharp(onKey(res.color, key), { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
}

export async function fakeView(view: OrthoView, key: [number, number, number], size = 1024): Promise<Buffer> {
  return orthoImage(demoScene().parts, view, 120, key, size, size);
}

export async function fakeSheet(key: [number, number, number]): Promise<Buffer> {
  // Same layout as a real sheet: front | side | back.
  const panels = await Promise.all((['front', 'right', 'back'] as OrthoView[]).map((v) => orthoImage(demoScene().parts, v, 70, key, 512, 512)));
  return sharp({ create: { width: 1536, height: 512, channels: 3, background: { r: key[0], g: key[1], b: key[2] } } })
    .composite(panels.map((p, i) => ({ input: p, left: i * 512, top: 0 })))
    .png()
    .toBuffer();
}

/** A "close-up" of the demo model: only its parts whose centre lies in the box, filling the image. */
export async function fakeCloseup(box: { min: [number, number, number]; max: [number, number, number] }, view: OrthoView | 'threequarter', key: [number, number, number], size = 1024): Promise<Buffer> {
  const inBox = (p: Part) => p.position.every((c, i) => c >= Math.min(box.min[i], box.max[i]) - 1e-6 && c <= Math.max(box.min[i], box.max[i]) + 1e-6);
  const parts = demoScene().parts.filter(inBox);
  if (!parts.length) throw new Error('fake close-up: no demo parts in that box');
  if (view === 'threequarter') {
    const res = renderPerspective(parts, threeQuarterCamera(parts, size, size));
    return sharp(onKey(res.color, key), { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
  }
  const f = autoFrame(parts, view, 100, 0); // width/height in 1/100 studs
  return orthoImage(parts, view, (0.8 * size * 100) / Math.max(f.width, f.height, 10), key, size, size);
}
