// Turn the scene into images for Claude: one contact sheet with the requested views.

import sharp from 'sharp';
import {
  type OrthoFrame, type OrthoView, type RasterResult, type ViewName, ORTHO_VIEWS, autoFrame, drawOutlines, partsOf,
  recolorByPart, renderOrtho, renderPerspective, threeQuarterCamera, viewBounds,
} from '../core/raster';
import type { Part, SceneDoc } from '../core/scene';
import { contactSheet, rasterToPng, withGrid } from './images';

export type RenderMode = 'color' | 'parts' | 'silhouette';

export interface RenderOptions {
  views: ViewName[];
  mode: RenderMode;
  group?: string;
  grid: boolean;
  size: number;
}

export function fitFrame(parts: Part[], view: OrthoView, size: number, margin = 0.5): OrthoFrame {
  if (!parts.length) return autoFrame(parts, view, 16, margin);
  const b = viewBounds(parts, view);
  const extent = Math.max(b.uMax - b.uMin, b.vMax - b.vMin) + 2 * margin;
  const ppu = Math.max(4, Math.min(64, Math.floor(size / extent)));
  return autoFrame(parts, view, ppu, margin);
}

function silhouette(res: RasterResult): void {
  for (let i = 0; i < res.partIndex.length; i++) {
    if (res.partIndex[i] < 0) continue;
    res.color[i * 4] = res.color[i * 4 + 1] = res.color[i * 4 + 2] = 25;
  }
}

/** Name labels at the visible centre of each part (parts mode). */
function labelSvg(res: RasterResult, parts: Part[]): string {
  const acc = new Map<number, { x: number; y: number; n: number }>();
  for (let y = 0; y < res.height; y++) for (let x = 0; x < res.width; x++) {
    const p = res.partIndex[y * res.width + x];
    if (p < 0) continue;
    const a = acc.get(p) ?? { x: 0, y: 0, n: 0 };
    a.x += x; a.y += y; a.n++;
    acc.set(p, a);
  }
  const items = [...acc.entries()].filter(([, a]) => a.n >= 40).sort((a, b) => b[1].n - a[1].n).slice(0, 60);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const texts = items.map(([p, a]) =>
    `<text x="${a.x / a.n}" y="${a.y / a.n + 4}" font-family="Arial, sans-serif" font-size="10" text-anchor="middle" fill="#000" stroke="#fff" stroke-width="2.5" paint-order="stroke">${esc(parts[p].name)}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${res.width}" height="${res.height}">${texts.join('')}</svg>`;
}

export async function renderView(scene: SceneDoc, view: ViewName, opts: Omit<RenderOptions, 'views'>, frame?: OrthoFrame): Promise<{ png: Buffer; frame?: OrthoFrame; res: RasterResult; parts: Part[] }> {
  const parts = partsOf(scene, opts.group);
  let res: RasterResult;
  let f: OrthoFrame | undefined;
  if (view === 'threequarter') {
    res = renderPerspective(parts, threeQuarterCamera(parts, opts.size, opts.size));
  } else {
    f = frame ?? fitFrame(parts, view, opts.size);
    res = renderOrtho(parts, f);
  }
  if (opts.mode === 'parts') recolorByPart(res);
  if (opts.mode === 'silhouette') silhouette(res);
  else drawOutlines(res);
  let png = await rasterToPng(res);
  if (opts.mode === 'parts') png = await sharp(png).composite([{ input: Buffer.from(labelSvg(res, parts)), top: 0, left: 0 }]).png().toBuffer();
  if (f && opts.grid) png = await withGrid(png, f);
  return { png, frame: f, res, parts };
}

export async function renderSheet(scene: SceneDoc, opts: RenderOptions): Promise<{ image: Buffer; frames: OrthoFrame[] }> {
  const tiles = [];
  const frames: OrthoFrame[] = [];
  for (const v of opts.views) {
    const r = await renderView(scene, v, opts);
    if (r.frame) frames.push(r.frame);
    tiles.push({ png: r.png, label: v + (opts.group ? ` · ${opts.group}` : '') });
  }
  return { image: await contactSheet(tiles, { tileHeight: opts.size }), frames };
}

export const ALL_VIEWS: ViewName[] = [...ORTHO_VIEWS, 'threequarter'];
