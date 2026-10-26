// Offline end-to-end test of the reference -> evaluation pipeline over MCP, with fake images:
//   npx tsx scripts/smoke-refs.ts [outDir]
// The fake "image model" renders a known demo knight, so building that same knight must score
// IoU ~1, and moving its arm must be reported near RightArm.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_COMMANDS } from '../src/server/fake';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] ?? path.join(root, '.runtime', 'smoke-refs'));
fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(path.join(root, 'projects', 'fake_knight'), { recursive: true, force: true });

const transport = new StdioClientTransport({
  command: process.execPath, args: [path.join(root, 'bin', 'mcp.mjs')], stderr: 'inherit',
  env: { ...process.env, PART_BUILDER_FAKE_IMAGES: '1', PART_BUILDER_PORT: '5195', PART_BUILDER_NO_REMEMBER: '1' } as Record<string, string>,
});
const client = new Client({ name: 'smoke-refs', version: '0' });
await client.connect(transport);

let img = 0;
async function call(name: string, args: Record<string, unknown>, show = 1600): Promise<string> {
  const r = await client.callTool({ name, arguments: args }) as { content: { type: string; text?: string; data?: string }[]; isError?: boolean };
  let txt = '';
  for (const c of r.content) {
    if (c.type === 'text') txt += c.text + '\n';
    if (c.type === 'image') {
      const f = path.join(outDir, `${String(++img).padStart(2, '0')}_${name}.jpg`);
      fs.writeFileSync(f, Buffer.from(c.data!, 'base64'));
      txt += `[image -> ${f}]\n`;
    }
  }
  console.log(`=== ${name} ${JSON.stringify(args).slice(0, 120)}${r.isError ? '  ** ERROR **' : ''}\n${txt.length > show ? txt.slice(0, show) + '…' : txt}`);
  if (r.isError) process.exitCode = 1;
  return txt;
}

await call('project_open', { name: 'fake_knight', idea: 'a blocky knight holding a sword', heightStuds: 5.7 });
await call('refs_generate', { kind: 'hero', count: 2 });
await call('refs_pick', { hero: 'hero_1' });
await call('refs_generate', { kind: 'sheet' });
await call('refs_generate', { kind: 'view', view: 'top' });
await call('refs_normalize', {});
await call('refs_measure', { view: 'front', mode: 'profile', step: 0.5 });
await call('refs_measure', { view: 'right', mode: 'colors', v: [2, 4] });
await call('refs_pick', { approve_views: true });
await call('scene_apply', { ops: DEMO_COMMANDS, label: 'demo knight' });
const good = await call('evaluate', { note: 'exact demo model' });
await call('scene_apply', { ops: [{ op: 'move', parts: 'group:RightArmG', by: [0.6, -0.4, 0] }], label: 'arm off' });
const bad = await call('evaluate', { note: 'arm moved' });
// Close-ups: the head alone, fitted onto the views; its eyes must measure where they are
// (x +-0.25, y 4.7, 0.2 studs) in world studs.
const cu = await call('refs_generate', { kind: 'part', part: 'Head', notes: 'helmeted head', box: { min: [-0.6, 4, -0.75], max: [0.6, 5.7, 0.6] }, views: ['front', 'side', 'threequarter'] });
const cuSpots = await call('refs_measure', { view: 'front', mode: 'spots', part: 'Head' });
await call('plan_build', { action: 'analyze', part: 'Head', views: ['front', 'side'] });
const fits = [...cu.matchAll(/outline vs view IoU (\d\.\d+)/g)].map((m) => Number(m[1]));
const eyes = [...cuSpots.matchAll(/(?:dark hole|raised bit)\s+x (-?\d+\.\d+), y (-?\d+\.\d+)\s+size (\d\.\d+) x (\d\.\d+)/g)].map((m) => m.slice(1).map(Number));
const eyeOk = [0.25, -0.25].every((x) => eyes.some(([ex, ey]) => Math.abs(ex - x) <= 0.05 && Math.abs(ey - 4.7) <= 0.05));
const closeupOk = fits.length === 2 && fits.every((f) => f >= 0.9) && !/FLAG/.test(cu) && eyeOk;

// Blockout straight from the silhouettes, on an empty model.
await call('scene_apply', { ops: [{ op: 'delete', parts: '*' }], label: 'clear' });
await call('refs_blockout', { box: { min: [-2.2, 0, -1.7], max: [2.3, 5.75, 1.5] }, maxBlocks: 24, apply: true }, 600);
const hull = await call('evaluate', { note: 'blockout only' });
await call('render', { views: ['front', 'threequarter'] });
await client.close();

const score = (t: string) => Number(/likeness (\d\.\d+)/.exec(t)?.[1] ?? 0);
const outline = (t: string) => Number(/outline (\d\.\d+)/.exec(t)?.[1] ?? 0);
console.log(`\nRESULT exact model likeness ${score(good)} (outline ${outline(good)}), moved arm ${score(bad)}, blockout ${score(hull)}; close-up fit ${fits.join('/')}, eyes ${eyeOk ? 'found' : 'MISSING'} (${eyes.map((e) => e.slice(0, 2).join(',')).join(' ')})`);
if (!closeupOk) {
  console.log('FAIL: close-ups must fit the views (IoU >= 0.9, no flags) and show both eyes at x +-0.25, y 4.7');
  process.exitCode = 1;
}
if (!(score(good) > 0.9 && outline(good) > 0.97 && score(bad) < score(good) - 0.05 && /near Right(Arm|Pauldron)|near Sword|\(Right(Arm|Pauldron)\)|Sword/.test(bad) && score(hull) < score(good) - 0.1 && outline(hull) > 0.85)) {
  console.log('FAIL: expected high likeness for the exact model, a clearly lower one with the arm moved, and the plain blockout below the detailed model');
  process.exitCode = 1;
} else console.log('PASS');
