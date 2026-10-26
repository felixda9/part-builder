// Offline test of "use your own pictures": renders of the demo knight saved the way a user might
// have them (transparent PNG, white JPEG, paper-colored background), imported over MCP, normalized and
// scored against the same knight. A busy background must be refused.
//   npx tsx scripts/smoke-import.ts [outDir]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { DEMO_COMMANDS, fakeHero, fakeView } from '../src/server/fake';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] ?? path.join(root, '.runtime', 'smoke-import'));
fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(path.join(root, 'projects', 'import_knight'), { recursive: true, force: true });

// User pictures: the knight rendered on magenta, then the background swapped.
const KEY: [number, number, number] = [255, 0, 255];
async function userPicture(png: Buffer, bg: 'transparent' | [number, number, number] | 'noise', file: string): Promise<string> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    const [r, g, b] = [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
    const isBg = Math.abs(r - KEY[0]) + Math.abs(g - KEY[1]) + Math.abs(b - KEY[2]) < 60;
    const fill = bg === 'noise' ? [(i * 37) % 256, (i * 91) % 256, (i * 53) % 256] : bg === 'transparent' ? [0, 0, 0] : bg;
    const px = isBg ? [...fill, bg === 'transparent' ? 0 : 255] : [r, g, b, 255];
    px.forEach((v, c) => { out[i * 4 + c] = v; });
  }
  const img = sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } });
  const f = path.join(outDir, file);
  await (file.endsWith('.jpg') ? img.jpeg({ quality: 80 }) : img.png()).toFile(f);
  return f;
}
const pics = {
  hero: await userPicture(await fakeHero(KEY), 'transparent', 'my_hero.png'),
  front: await userPicture(await fakeView('front', KEY), [255, 255, 255], 'my_front.jpg'),
  side: await userPicture(await fakeView('right', KEY), 'transparent', 'my_side.png'),
  back: await userPicture(await fakeView('back', KEY), [245, 240, 220], 'my_back.png'),
  busy: await userPicture(await fakeView('front', KEY), 'noise', 'my_busy.png'),
};

const transport = new StdioClientTransport({
  command: process.execPath, args: [path.join(root, 'bin', 'mcp.mjs')], stderr: 'inherit',
  env: { ...process.env, PART_BUILDER_FAKE_IMAGES: '1', PART_BUILDER_PORT: '5196', PART_BUILDER_NO_REMEMBER: '1' } as Record<string, string>,
});
const client = new Client({ name: 'smoke-import', version: '0' });
await client.connect(transport);
let n = 0;
async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await client.callTool({ name, arguments: args }) as { content: { type: string; text?: string; data?: string }[]; isError?: boolean };
  let txt = '';
  for (const c of r.content) {
    if (c.type === 'text') txt += c.text;
    if (c.type === 'image') fs.writeFileSync(path.join(outDir, `${String(++n).padStart(2, '0')}_${name}.jpg`), Buffer.from(c.data!, 'base64'));
  }
  console.log(`=== ${name} ${JSON.stringify(args).slice(0, 100)}${r.isError ? '  ** ERROR **' : ''}\n${txt.slice(0, 600)}`);
  return txt;
}

await call('project_open', { name: 'import_knight', idea: 'a blocky knight holding a sword', heightStuds: 5.7 });
const hero = await call('refs_import', { kind: 'hero', file: pics.hero });
await call('refs_import', { kind: 'view', view: 'front', file: pics.front });
await call('refs_import', { kind: 'view', view: 'side', file: pics.side });
await call('refs_import', { kind: 'view', view: 'back', file: pics.back });
const busy = await call('refs_import', { kind: 'view', view: 'top', file: pics.busy });
await call('refs_normalize', {});
await call('refs_pick', { approve_views: true });
await call('scene_apply', { ops: DEMO_COMMANDS, label: 'demo knight' });
const ev = await call('evaluate', { note: 'exact demo model' });
await client.close();

const score = Number(/likeness (\d\.\d+)/.exec(ev)?.[1] ?? 0);
const ok = score >= 0.9 && /transparent background/.test(hero) && /Could not find the background/.test(busy);
console.log(`\nRESULT likeness ${score} from imported pictures; busy background ${/Could not find/.test(busy) ? 'refused' : 'NOT refused'}`);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
