// Call part-builder MCP tools from the command line (same server Claude Code uses):
//   npx tsx scripts/mcp-call.ts '<json array of {tool, args}>' [outDir]
//   npx tsx scripts/mcp-call.ts calls.json [outDir]
// Prints each result; images are saved to outDir (default .runtime/mcp-call).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
if (!arg) throw new Error('usage: mcp-call.ts <calls.json | json> [outDir]');
const calls = JSON.parse(fs.existsSync(arg) ? fs.readFileSync(arg, 'utf8') : arg) as { tool: string; args?: Record<string, unknown> }[];
const outDir = path.resolve(process.argv[3] ?? path.join(root, '.runtime', 'mcp-call'));
fs.mkdirSync(outDir, { recursive: true });

// Pass the whole environment (the SDK otherwise passes only a few variables, dropping e.g. PART_BUILDER_*).
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bin', 'mcp.mjs')], stderr: 'inherit', env: { ...process.env } as Record<string, string> });
const client = new Client({ name: 'mcp-call', version: '0' });
await client.connect(transport);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(11, 19);
let n = 0;
for (const c of calls) {
  const t = Date.now();
  const r = await client.callTool({ name: c.tool, arguments: c.args ?? {} }, undefined, { timeout: 30 * 60_000 }) as {
    content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean;
  };
  console.log(`\n=== ${c.tool} ${JSON.stringify(c.args ?? {}).slice(0, 160)} (${((Date.now() - t) / 1000).toFixed(1)} s)${r.isError ? '  ** ERROR **' : ''}`);
  for (const part of r.content) {
    if (part.type === 'text') console.log(part.text);
    if (part.type === 'image') {
      const f = path.join(outDir, `${stamp}_${String(++n).padStart(2, '0')}_${c.tool}.${part.mimeType === 'image/png' ? 'png' : 'jpg'}`);
      fs.writeFileSync(f, Buffer.from(part.data!, 'base64'));
      console.log(`[image] ${f}`);
    }
  }
  if (r.isError) break;
}
await client.close();
