// Entry point. `--mcp` speaks MCP over stdio (Claude Code launches it via .mcp.json); the editor
// server always runs alongside so the model can be watched live in the browser.

import fs from 'node:fs';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadEnv } from './env';
import { startHttp } from './http';
import { createMcpServer } from './mcp';
import { RUNTIME_DIR, log } from './paths';
import { Session } from './session';

const args = process.argv.slice(2);
const mcp = args.includes('--mcp');
const portArg = args.find((a) => a.startsWith('--port='));
const preferredPort = portArg ? Number(portArg.split('=')[1]) : Number(process.env.PART_BUILDER_PORT ?? 5178);

// stdout belongs to the MCP protocol: route stray console.log calls to stderr.
if (mcp) console.log = (...a: unknown[]) => console.error(...a);

async function main() {
  loadEnv();
  const session = new Session();
  const { port, close } = await startHttp(session, preferredPort);
  const editorUrl = () => `http://localhost:${port}/`;

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // Drop lock files left by servers that were killed without running their exit handler.
  for (const f of fs.readdirSync(RUNTIME_DIR).filter((n) => /^server-\d+\.json$/.test(n))) {
    const pid = Number(f.slice(7, -5));
    try { process.kill(pid, 0); } catch { fs.rmSync(path.join(RUNTIME_DIR, f), { force: true }); }
  }
  const lock = path.join(RUNTIME_DIR, `server-${process.pid}.json`);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, port, url: editorUrl(), mcp, started: new Date().toISOString() }));
  const cleanup = () => {
    try { fs.rmSync(lock, { force: true }); } catch { /* ignore */ }
    close();
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  if (mcp) {
    const server = createMcpServer(session, { editorUrl });
    const transport = new StdioServerTransport();
    transport.onclose = () => process.exit(0);
    await server.connect(transport);
    process.stdin.on('end', () => process.exit(0));
    log('MCP server ready');
  } else {
    log(`open ${editorUrl()} (Ctrl+C to stop)`);
  }
}

main().catch((e) => {
  log('fatal', e);
  process.exit(1);
});
