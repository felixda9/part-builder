// HTTP + WebSocket server for the editor. Serves the built editor (dist/web), project files
// (reference images, renders) and pushes every scene change to connected browsers.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { CommandError } from '../core/commands';
import type { ClientMessage, StateMessage } from '../core/protocol';
import { exportModel } from './exporter';
import { loadPlan, planText } from './plan';
import { WEB_DIST, log } from './paths';
import { Refs } from './refs';
import type { Session } from './session';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
};

function stateMessage(s: Session): string {
  const { name, idea, style, heightStuds, symmetric, stage } = s.meta;
  const msg: StateMessage = {
    type: 'state',
    project: { name, idea, style, heightStuds, symmetric, similarity: s.similarity, stage },
    busy: s.busy,
    scene: s.scene,
    rev: s.history.rev,
    canUndo: s.history.canUndo,
    canRedo: s.history.canRedo,
    revisions: s.history.list().slice(-80),
    refs: s.refs,
    iterations: s.iterations,
    checks: s.lints(),
    plan: (() => { try { const p = loadPlan(s); return p ? planText(p) : null; } catch { return null; } })(),
  };
  return JSON.stringify(msg);
}

function sendFile(res: http.ServerResponse, file: string): void {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

/** Resolve `rel` inside `base`, refusing anything that escapes it. */
function inside(base: string, rel: string): string | null {
  const p = path.resolve(base, '.' + path.sep + rel);
  return p.startsWith(path.resolve(base) + path.sep) ? p : null;
}

export async function startHttp(session: Session, preferredPort: number): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(stateMessage(session));
      return;
    }
    if (url.pathname === '/api/export' && req.method === 'POST') {
      try {
        const r = exportModel(session, { rig: url.searchParams.get('rig') !== '0' });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ files: r.files, summary: r.summary }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }
    if (url.pathname.startsWith('/files/')) {
      const f = inside(session.dir, decodeURIComponent(url.pathname.slice(7)));
      if (!f) { res.writeHead(403); res.end(); return; }
      sendFile(res, f);
      return;
    }
    if (!fs.existsSync(WEB_DIST)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>part-builder</h1><p>The editor is not built yet. Run <code>npm run build:web</code>.</p>');
      return;
    }
    const f = url.pathname === '/' ? path.join(WEB_DIST, 'index.html') : inside(WEB_DIST, decodeURIComponent(url.pathname.slice(1)));
    if (!f) { res.writeHead(403); res.end(); return; }
    sendFile(res, fs.existsSync(f) ? f : path.join(WEB_DIST, 'index.html'));
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  // The WS server re-emits the HTTP server's errors; a taken port is handled by the port loop
  // below, so don't let it crash the process (e.g. a second session while another holds 5178).
  wss.on('error', () => {});
  const clients = new Set<WebSocket>();
  const broadcast = () => {
    const msg = stateMessage(session);
    for (const c of clients) if (c.readyState === c.OPEN) c.send(msg);
  };
  session.on('change', broadcast);
  session.on('notice', (n: unknown) => {
    const msg = JSON.stringify({ type: 'notice', ...(n as object) });
    for (const c of clients) if (c.readyState === c.OPEN) c.send(msg);
  });

  // "Remake all" in the editor: new hero candidates straight from the server (the image source
  // is the same one Claude uses). Runs in the background; the editor shows the busy state.
  function remakeHeroes(note?: string): void {
    if (session.busy) throw new Error(`busy: ${session.busy}`);
    if (!session.meta.idea) throw new Error('this project has no idea text yet');
    session.setBusy('Making new hero candidates…');
    new Refs(session).remakeHeroes(3, note?.trim() ?? '')
      .then(() => session.emit('notice', { message: 'New hero candidates are ready - pick one', level: 'info' }))
      .catch((e: Error) => session.emit('notice', { message: `Making heroes failed: ${e.message}`, level: 'warn' }))
      .finally(() => session.setBusy(null));
  }

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(stateMessage(session));
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw)) as ClientMessage;
        if (m.type === 'apply') session.apply(m.ops, m.label ?? 'editor');
        else if (m.type === 'undo') session.undo();
        else if (m.type === 'redo') session.redo();
        else if (m.type === 'checkout') session.checkout(Number(m.rev));
        else if (m.type === 'ui' && m.action === 'remake_heroes') remakeHeroes(m.note);
        else if (m.type === 'ui') session.handleUi(m);
      } catch (e) {
        const message = e instanceof CommandError ? e.message : (e as Error).message;
        ws.send(JSON.stringify({ type: 'error', message }));
      }
    });
  });

  for (let port = preferredPort; port < preferredPort + 20; port++) {
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) {
      log(`editor at http://localhost:${port}`);
      return { port, close: () => { wss.close(); server.close(); } };
    }
  }
  throw new Error(`no free port in ${preferredPort}..${preferredPort + 19}`);
}
