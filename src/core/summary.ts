// Compact text views of a scene for Claude (scene_get) - one line per part, numbers rounded.

import { round, toOrientation, type Vec3 } from './math';
import type { Part, SceneDoc } from './scene';
import { partAABB, unionAABB } from './shapes';

const fmt = (v: Vec3) => v.map((x) => round(x, 3)).join(',');
const SURF: Record<string, string> = { Studs: 'S', Inlet: 'I', Smooth: '-' };

function surfCode(p: Part): string {
  const s = p.surfaces;
  const all = [s.top, s.bottom, s.front, s.back, s.left, s.right];
  if (all.every((x) => x === all[0])) return all[0].toLowerCase();
  return all.map((x) => SURF[x]).join('');
}

export function sceneBounds(scene: SceneDoc, parts = scene.parts) {
  const bb = unionAABB(parts.map(partAABB));
  if (!bb) return null;
  return { min: bb.min.map((v) => round(v, 3)) as Vec3, max: bb.max.map((v) => round(v, 3)) as Vec3, size: bb.max.map((v, i) => round(v - bb.min[i], 3)) as Vec3 };
}

export function describeScene(scene: SceneDoc, groupFilter?: string): string {
  const lines: string[] = [];
  const gname = (id: string | null) => (id ? scene.groups.find((g) => g.id === id)?.name ?? id : '-');
  let parts = scene.parts;
  if (groupFilter) {
    const g = scene.groups.find((x) => x.name === groupFilter || x.id === groupFilter);
    if (!g) return `no group "${groupFilter}"`;
    parts = parts.filter((p) => p.group === g.id);
  }
  const b = sceneBounds(scene, parts);
  lines.push(`scene "${scene.name}": ${parts.length} parts${groupFilter ? ` in ${groupFilter}` : ''}, ${scene.groups.length} groups` +
    (b ? `, bounds min(${fmt(b.min)}) max(${fmt(b.max)}) size(${fmt(b.size)})` : ''));
  if (scene.palette.length) lines.push(`palette: ${scene.palette.map((c, i) => `p${i}=${c}`).join(' ')}`);
  if (!groupFilter && scene.groups.length) {
    lines.push('groups (name | parent | pivot | main | mirror-of):');
    for (const g of scene.groups) {
      const main = g.mainPart ? scene.parts.find((p) => p.id === g.mainPart)?.name ?? '?' : 'auto';
      lines.push(`  ${g.name} | ${gname(g.parent)} | ${fmt(g.pivot)} | ${main} | ${g.mirrorOf ? gname(g.mirrorOf) : '-'}`);
    }
  }
  lines.push('parts (name | shape | size | position | orientation | color | material | surfaces t,b,f,bk,l,r | group | box min..max):');
  for (const p of parts) {
    const bb = partAABB(p);
    const tag = p.mirrorOf ? ' (mirror)' : '';
    lines.push(`  ${p.name}${tag} | ${p.shape} | ${fmt(p.size)} | ${fmt(p.position)} | ${fmt(toOrientation(p.rotation))} | ${p.color} | ${p.material} | ${surfCode(p)} | ${gname(p.group)} | ${fmt(bb.min)}..${fmt(bb.max)}`);
  }
  return lines.join('\n');
}
