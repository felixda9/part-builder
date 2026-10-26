// Image helpers on top of sharp: raster -> PNG, stud-grid overlays with world-coordinate labels,
// and contact sheets (several labelled views in one image, so Claude gets one compact image).

import sharp, { type OverlayOptions } from 'sharp';
import { type OrthoFrame, type RasterResult, viewAxes } from '../core/raster';

export const BG = { r: 226, g: 230, b: 236 };

export async function rasterToPng(res: RasterResult, bg = BG): Promise<Buffer> {
  return sharp(Buffer.from(res.color.buffer, res.color.byteOffset, res.color.byteLength), { raw: { width: res.width, height: res.height, channels: 4 } })
    .flatten({ background: bg })
    .png()
    .toBuffer();
}

export async function maskToPng(mask: Uint8Array, width: number, height: number): Promise<Buffer> {
  const px = Buffer.alloc(width * height);
  for (let i = 0; i < mask.length; i++) px[i] = mask[i] ? 255 : 0;
  return sharp(px, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** SVG stud grid for an orthographic frame: thin lines every stud, labels in world coordinates. */
export function gridSvg(frame: OrthoFrame): string {
  const { width: W, height: H, ppu, u0, v0 } = frame;
  const ax = viewAxes(frame.view);
  // Close-ups run at hundreds of px/stud: finer lines there.
  const cell = ppu >= 160 ? 0.25 : ppu >= 80 ? 0.5 : 1;
  const labelEvery = cell < 1 ? cell : ppu >= 28 ? 1 : ppu >= 12 ? 2 : 5;
  const out: string[] = [];
  const label = (x: number, y: number, t: string, anchor = 'start') =>
    `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="11" text-anchor="${anchor}" fill="#1b1f24" stroke="#ffffff" stroke-width="3" paint-order="stroke">${xmlEsc(t)}</text>`;
  const isMult = (w: number, m: number) => Math.abs(w / m - Math.round(w / m)) < 1e-6;
  const lineStyle = (w: number) => `stroke="${w === 0 ? '#c0392b' : '#000'}" stroke-opacity="${w === 0 ? 0.6 : isMult(w, 5) ? 0.28 : isMult(w, 1) ? 0.12 : 0.06}" stroke-width="1"`;
  const name = (w: number) => (isMult(w, 1) ? String(Math.round(w)) : w.toFixed(2));
  const range = (a: number, b: number) => {
    const [lo, hi] = [a, b].sort((x, y) => x - y);
    const ws: number[] = [];
    for (let k = Math.ceil(lo / cell); k <= Math.floor(hi / cell); k++) ws.push(Math.round(k * cell * 1e4) / 1e4);
    return ws;
  };
  // vertical lines: world coordinate along the horizontal axis
  for (const w of range(u0 * ax.h.sign, (u0 + W / ppu) * ax.h.sign)) {
    const x = (w * ax.h.sign - u0) * ppu;
    out.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" ${lineStyle(w)}/>`);
    if (isMult(w, labelEvery)) out.push(label(x + 2, H - 4, `${ax.h.axis}${name(w)}`));
  }
  for (const w of range((v0 - H / ppu) * ax.v.sign, v0 * ax.v.sign)) {
    const y = (v0 - w * ax.v.sign) * ppu;
    out.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" ${lineStyle(w)}/>`);
    if (isMult(w, labelEvery)) out.push(label(3, y - 3, `${ax.v.axis}${name(w)}`));
  }
  const dir = (a: { axis: string; sign: number }) => `${a.sign > 0 ? '+' : '-'}${a.axis}`;
  out.push(label(W - 4, 14, `right ${dir(ax.h)}  up ${dir(ax.v)}`, 'end'));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${out.join('')}</svg>`;
}

export async function withGrid(png: Buffer, frame: OrthoFrame): Promise<Buffer> {
  return sharp(png).composite([{ input: Buffer.from(gridSvg(frame)), top: 0, left: 0 }]).png().toBuffer();
}

export interface Tile {
  png: Buffer;
  label: string;
}

/** Explicit rows of tiles (e.g. one row per view), same tile height, optional title line. */
export async function gridSheet(rows: Tile[][], opts: { tileHeight?: number; title?: string } = {}): Promise<Buffer> {
  const th = opts.tileHeight ?? 260;
  const pad = 8, cap = 20, head = opts.title ? 24 : 0;
  const scaled = await Promise.all(rows.map((row) => Promise.all(row.map(async (t) => {
    const meta = await sharp(t.png).metadata();
    const w = Math.max(1, Math.round((meta.width! * th) / meta.height!));
    return { buf: await sharp(t.png).resize(w, th).png().toBuffer(), w, label: t.label };
  }))));
  const W = Math.max(...scaled.map((r) => r.reduce((s, t) => s + t.w + pad, pad)));
  const H = head + scaled.length * (th + cap + pad) + pad;
  const comps: OverlayOptions[] = [];
  const text: string[] = [];
  if (opts.title) text.push(`<text x="${pad}" y="17" font-family="Arial, sans-serif" font-size="14" fill="#1b1f24">${xmlEsc(opts.title)}</text>`);
  scaled.forEach((row, ri) => {
    let x = pad;
    const y = head + pad + ri * (th + cap + pad);
    for (const t of row) {
      text.push(`<text x="${x + 2}" y="${y + 14}" font-family="Arial, sans-serif" font-size="13" font-weight="bold" fill="#1b1f24">${xmlEsc(t.label)}</text>`);
      comps.push({ input: t.buf, left: x, top: y + cap });
      x += t.w + pad;
    }
  });
  comps.unshift({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${text.join('')}</svg>`), left: 0, top: 0 });
  return sharp({ create: { width: W, height: H, channels: 3, background: { r: 248, g: 249, b: 251 } } }).composite(comps).jpeg({ quality: 85 }).toBuffer();
}

/** Lay tiles out in rows (same height), each with a caption bar. Returns JPEG by default. */
export async function contactSheet(tiles: Tile[], opts: { tileHeight?: number; maxWidth?: number; format?: 'jpeg' | 'png' } = {}): Promise<Buffer> {
  const tileH = opts.tileHeight ?? 380;
  const maxW = opts.maxWidth ?? 1600;
  const pad = 8, cap = 22;
  const scaled = await Promise.all(tiles.map(async (t) => {
    const meta = await sharp(t.png).metadata();
    const h = Math.min(tileH, meta.height!);
    const w = Math.max(1, Math.round((meta.width! * h) / meta.height!));
    const s = Math.min(1, (maxW - 2 * pad) / w);
    const fw = Math.max(1, Math.round(w * s)), fh = Math.max(1, Math.round(h * s));
    return { buf: await sharp(t.png).resize(fw, fh, { kernel: 'nearest' }).png().toBuffer(), w: fw, h: fh, label: t.label };
  }));
  // Row packing
  const rows: { items: typeof scaled; h: number; w: number }[] = [];
  for (const s of scaled) {
    const row = rows[rows.length - 1];
    if (row && row.w + s.w + pad <= maxW) { row.items.push(s); row.w += s.w + pad; row.h = Math.max(row.h, s.h); }
    else rows.push({ items: [s], w: pad + s.w + pad, h: s.h });
  }
  const W = Math.max(...rows.map((r) => r.w));
  const H = rows.reduce((a, r) => a + r.h + cap + pad, pad);
  const comps: OverlayOptions[] = [];
  const captions: string[] = [];
  let y = pad;
  for (const r of rows) {
    let x = pad;
    for (const it of r.items) {
      captions.push(`<text x="${x + 2}" y="${y + 15}" font-family="Arial, sans-serif" font-size="14" font-weight="bold" fill="#1b1f24">${xmlEsc(it.label)}</text>`);
      comps.push({ input: it.buf, left: x, top: y + cap });
      x += it.w + pad;
    }
    y += r.h + cap + pad;
  }
  comps.unshift({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${captions.join('')}</svg>`), left: 0, top: 0 });
  const img = sharp({ create: { width: W, height: H, channels: 3, background: { r: 248, g: 249, b: 251 } } }).composite(comps);
  return opts.format === 'png' ? img.png().toBuffer() : img.jpeg({ quality: 85 }).toBuffer();
}
