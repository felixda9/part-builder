// Proposed blockout from the reference silhouettes (a "visual hull"): carve a voxel grid with
// the front, right and top masks inside a box, then cover the voxels with a few axis-aligned
// blocks. The result is a list of `box` commands for Claude to review, edit and apply.

import sharp from 'sharp';
import fs from 'node:fs';
import type { Command } from '../core/commands';
import { type Vec3, dot } from '../core/math';
import { VIEW_BASIS } from '../core/raster';
import type { RefView } from '../core/protocol';
import { type Mask, deltaE, dilate, hexToRgb, rgbToHex, rgbToLab } from './imaging';
import { type Refs, loadMask } from './refs';
import type { Session } from './session';

export interface BlockoutOptions {
  box: { min: Vec3; max: Vec3 };
  name: string; // prefix for part names
  group?: string;
  res?: number; // voxel size in studs (default 0.25)
  maxBlocks?: number; // default 12
}

export async function blockout(session: Session, refs: Refs, o: BlockoutOptions): Promise<{ commands: Command[]; summary: string }> {
  const internal = refs.internal();
  const res = o.res ?? 0.25;
  const views: RefView[] = ['front', 'right', 'top'];
  const masks: Partial<Record<RefView, Mask>> = {};
  for (const v of views) {
    const f = session.path('refs', `mask_${v}.png`);
    if (internal.frames[v] && fs.existsSync(f)) masks[v] = dilate(await loadMask(f), 2);
  }
  if (!masks.front || !masks.right) throw new Error('needs normalized front and right views (refs_normalize)');

  const inside = (v: RefView, p: Vec3): boolean => {
    const m = masks[v], fr = internal.frames[v];
    if (!m || !fr) return true;
    const B = VIEW_BASIS[v as keyof typeof VIEW_BASIS];
    const x = Math.floor((dot(p, B.right) - fr.u0) * fr.ppu), y = Math.floor((fr.v0 - dot(p, B.up)) * fr.ppu);
    return x >= 0 && y >= 0 && x < m.width && y < m.height && m.data[y * m.width + x] === 1;
  };

  const lo = o.box.min.map((v, i) => Math.min(v, o.box.max[i])) as Vec3;
  const hi = o.box.min.map((v, i) => Math.max(v, o.box.max[i])) as Vec3;
  const n = [0, 1, 2].map((i) => Math.max(1, Math.round((hi[i] - lo[i]) / res)));
  const [nx, ny, nz] = n;
  const idx = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  const vox = new Uint8Array(nx * ny * nz);
  let filled = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p: Vec3 = [lo[0] + (i + 0.5) * res, lo[1] + (j + 0.5) * res, lo[2] + (k + 0.5) * res];
    if (inside('front', p) && inside('right', p) && inside('top', p)) { vox[idx(i, j, k)] = 1; filled++; }
  }
  if (!filled) throw new Error('the silhouettes leave nothing inside that box; check the box against refs_measure');

  // Greedy cover: repeatedly take the biggest box that grows from a seed through voxels not yet
  // covered. Blocks therefore touch but never overlap, so they cannot z-fight.
  const remaining = vox.slice();
  const boxes: { a: number[]; b: number[]; vol: number }[] = [];
  const full = (a: number[], b: number[]) => {
    for (let k = a[2]; k <= b[2]; k++) for (let j = a[1]; j <= b[1]; j++) for (let i = a[0]; i <= b[0]; i++) if (!remaining[idx(i, j, k)]) return false;
    return true;
  };
  const maxBlocks = o.maxBlocks ?? 12;
  while (boxes.length < maxBlocks * 3) {
    let best: { a: number[]; b: number[]; vol: number; gain: number } | null = null;
    // Seeds: a sample of remaining voxels.
    const seeds: number[] = [];
    for (let s = 0; s < remaining.length; s++) if (remaining[s]) seeds.push(s);
    if (!seeds.length) break;
    const step = Math.max(1, Math.floor(seeds.length / 300));
    for (let t = 0; t < seeds.length; t += step) {
      const s = seeds[t];
      const i0 = s % nx, j0 = Math.floor(s / nx) % ny, k0 = Math.floor(s / (nx * ny));
      const a = [i0, j0, k0], b = [i0, j0, k0];
      // Grow along each axis in turn while the box stays inside the hull.
      let grew = true;
      while (grew) {
        grew = false;
        for (let ax = 0; ax < 3; ax++) for (const dir of [-1, 1]) {
          const na = [...a], nb = [...b];
          if (dir < 0) na[ax]--; else nb[ax]++;
          if (na[ax] < 0 || nb[ax] >= n[ax]) continue;
          if (full(na, nb)) { a[ax] = na[ax]; b[ax] = nb[ax]; grew = true; }
        }
      }
      let gain = 0;
      for (let k = a[2]; k <= b[2]; k++) for (let j = a[1]; j <= b[1]; j++) for (let i = a[0]; i <= b[0]; i++) gain += remaining[idx(i, j, k)];
      const vol = (b[0] - a[0] + 1) * (b[1] - a[1] + 1) * (b[2] - a[2] + 1);
      if (!best || gain > best.gain) best = { a, b, vol, gain };
    }
    if (!best || best.gain === 0) break;
    for (let k = best.a[2]; k <= best.b[2]; k++) for (let j = best.a[1]; j <= best.b[1]; j++) for (let i = best.a[0]; i <= best.b[0]; i++) remaining[idx(i, j, k)] = 0;
    boxes.push(best);
  }
  boxes.sort((x, y) => y.vol - x.vol);
  const kept = boxes.slice(0, maxBlocks);
  let covered = 0;
  const cov = new Uint8Array(vox.length);
  for (const bx of kept) for (let k = bx.a[2]; k <= bx.b[2]; k++) for (let j = bx.a[1]; j <= bx.b[1]; j++) for (let i = bx.a[0]; i <= bx.b[0]; i++) if (!cov[idx(i, j, k)]) { cov[idx(i, j, k)] = 1; covered++; }

  // Color each block from the front view (nearest palette entry).
  const frontPx = await sharp(session.path('refs', 'norm_front.png')).raw().toBuffer({ resolveWithObject: true });
  const fr = internal.frames.front!;
  const pal = session.refs.palette;
  const colorFor = (min: Vec3, max: Vec3): string | undefined => {
    const B = VIEW_BASIS.front;
    const us = [dot(min, B.right), dot(max, B.right)].sort((p, q) => p - q), vs = [min[1], max[1]];
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    for (let y = Math.floor((fr.v0 - vs[1]) * fr.ppu); y < Math.ceil((fr.v0 - vs[0]) * fr.ppu); y++) for (let x = Math.floor((us[0] - fr.u0) * fr.ppu); x < Math.ceil((us[1] - fr.u0) * fr.ppu); x++) {
      if (x < 0 || y < 0 || x >= fr.width || y >= fr.height) continue;
      const i = (y * fr.width + x) * frontPx.info.channels;
      if (frontPx.data[i + 3] < 128) continue;
      rs.push(frontPx.data[i]); gs.push(frontPx.data[i + 1]); bs.push(frontPx.data[i + 2]);
    }
    if (!rs.length) return pal[0];
    const med = (a: number[]) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];
    const hex = rgbToHex(med(rs), med(gs), med(bs));
    if (!pal.length) return hex;
    const lab = rgbToLab(...hexToRgb(hex));
    return pal.reduce((bestHex, p) => (deltaE(rgbToLab(...hexToRgb(p)), lab) < deltaE(rgbToLab(...hexToRgb(bestHex)), lab) ? p : bestHex), pal[0]);
  };

  const r2 = (v: number) => Math.round(v * 100) / 100;
  const commands: Command[] = kept.map((bx, t) => {
    const min = [0, 1, 2].map((ax) => r2(lo[ax] + bx.a[ax] * res)) as Vec3;
    const max = [0, 1, 2].map((ax) => r2(lo[ax] + (bx.b[ax] + 1) * res)) as Vec3;
    return { op: 'box', name: `${o.name}_B${t + 1}`, min, max, color: colorFor(min, max), ...(o.group ? { group: o.group } : {}) } as Command;
  });
  const summary = `${nx}x${ny}x${nz} voxels of ${res} studs, ${filled} inside the hull; ${kept.length} blocks cover ${Math.round((covered / filled) * 100)}% of it`;
  return { commands, summary };
}
