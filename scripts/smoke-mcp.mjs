// End-to-end smoke test of the MCP server, the way Claude Code drives it:
//   node scripts/smoke-mcp.mjs [outDir]
// Builds a small blocky character, renders it and exports it. Images go to outDir (default .runtime/smoke).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] ?? path.join(root, '.runtime', 'smoke'));
fs.mkdirSync(outDir, { recursive: true });
// Start from a fresh project: groups left by an earlier run make the mirror step fail.
fs.rmSync(path.join(root, 'projects', 'smoke_test'), { recursive: true, force: true });

const transport = new StdioClientTransport({
  command: process.execPath, args: [path.join(root, 'bin', 'mcp.mjs')], stderr: 'pipe',
  env: { ...process.env, PART_BUILDER_NO_REMEMBER: '1' },
});
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  let n = 0;
  for (const c of r.content) {
    if (c.type === 'text') console.log(`--- ${name}${r.isError ? ' (ERROR)' : ''}\n${c.text.length > 1500 ? c.text.slice(0, 1500) + '…' : c.text}`);
    if (c.type === 'image') {
      const f = path.join(outDir, `${name}_${n++}.${c.mimeType === 'image/png' ? 'png' : 'jpg'}`);
      fs.writeFileSync(f, Buffer.from(c.data, 'base64'));
      console.log(`--- ${name}: image -> ${f}`);
    }
  }
  return r;
};

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

await call('project_open', { name: 'smoke_test', idea: 'blocky knight', heightStuds: 5.2 });
await call('scene_apply', {
  label: 'knight blockout',
  ops: [
    { op: 'palette', colors: ['#3b4a5a', '#c9ced6', '#f2c39b', '#1b1f24', '#8a2be2'] },
    { op: 'box', name: 'Torso', min: [-1, 2, -0.5], max: [1, 4, 0.5], color: 'p1' },
    { op: 'box', name: 'Belt', min: [-1.05, 2, -0.55], max: [1.05, 2.3, 0.55], color: 'p0' },
    { op: 'box', name: 'Head', min: [-0.6, 4, -0.6], max: [0.6, 5.2, 0.6], color: 'p2' },
    { op: 'wedge', name: 'HelmetTop', min: [-0.65, 4.8, -0.65], max: [0.65, 5.2, 0.65], tall: '+z', color: 'p1' },
    { op: 'attach', name: 'RightEye', to: 'Head', face: '-z', size: [0.2, 0.2, 0.1], offset: [0.25, 0.1, 0], color: 'p3' },
    { op: 'attach', name: 'LeftEye', to: 'Head', face: '-z', size: [0.2, 0.2, 0.1], offset: [-0.25, 0.1, 0], color: 'p3' },
    { op: 'box', name: 'RightArm', min: [1, 2, -0.5], max: [2, 4, 0.5], color: 'p1' },
    { op: 'wedge', name: 'RightPauldron', min: [1, 4, -0.55], max: [2.1, 4.5, 0.55], tall: '-x', color: 'p0' },
    { op: 'cornerwedge', name: 'RightSpike', min: [1.6, 4.5, -0.2], max: [2.0, 4.9, 0.2], apex: '+x+y-z', color: 'p4' },
    { op: 'box', name: 'RightLeg', min: [0, 0, -0.5], max: [1, 2, 0.5], color: 'p0' },
    { op: 'group', name: 'TorsoG', parts: ['Torso', 'Belt'], pivot: [0, 3, 0] },
    { op: 'group', name: 'HeadG', parts: ['Head', 'HelmetTop', 'RightEye', 'LeftEye'], parent: 'TorsoG', pivot: [0, 4, 0], main: 'Head' },
    { op: 'group', name: 'RightArmG', parts: ['RightArm', 'RightPauldron', 'RightSpike'], parent: 'TorsoG', pivot: [1.5, 3.8, 0], main: 'RightArm' },
    { op: 'group', name: 'RightLegG', parts: ['RightLeg'], parent: 'TorsoG', pivot: [0.5, 2, 0] },
    { op: 'mirror_group', source: 'RightArmG', name: 'LeftArmG' },
    { op: 'mirror_group', source: 'RightLegG', name: 'LeftLegG' },
  ],
});
await call('scene_get', {});
await call('render', { mode: 'color' });
await call('render', { mode: 'parts', views: ['front', 'threequarter'] });
await call('export', { format: 'both' });
await client.close();
