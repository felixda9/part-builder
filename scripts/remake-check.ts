// Offline check of the editor's "Remake all" hero button: fake images, a real server and
// WebSocket client. npx tsx scripts/remake-check.ts
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { startHttp } from '../src/server/http';
import { PROJECTS_DIR } from '../src/server/paths';
import { Refs } from '../src/server/refs';
import { Session } from '../src/server/session';
import type { StateMessage } from '../src/core/protocol';

process.env.PART_BUILDER_FAKE_IMAGES = '1';
process.env.PART_BUILDER_NO_REMEMBER = '1';
const name = 'remake_check_tmp';
fs.rmSync(path.join(PROJECTS_DIR, name), { recursive: true, force: true });
const s = new Session();
s.open(name, { idea: 'a blocky test knight', heightStuds: 5.7 });
await new Refs(s).generateHero(3);
s.handleUi({ type: 'ui', action: 'pick_hero', id: 'hero_2' });
const before = s.refs.hero.candidates.map((c) => c.url);

const srv = await startHttp(s, 5290);
const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
const states: StateMessage[] = [];
const notices: string[] = [];
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'state') states.push(m);
  if (m.type === 'notice' || m.type === 'error') notices.push(`${m.type}: ${m.message}`);
});
await new Promise((r) => ws.once('open', r));
ws.send(JSON.stringify({ type: 'ui', action: 'remake_heroes', note: 'taller helmet' }));
const t0 = Date.now();
while (Date.now() - t0 < 60000 && !(states.some((x) => x.busy) && states.at(-1)?.busy === null && states.at(-1)!.refs.hero.candidates.length === 3)) await new Promise((r) => setTimeout(r, 100));
ws.close(); srv.close();

const last = states.at(-1)!;
const archive = path.join(PROJECTS_DIR, name, 'refs', 'archive');
const archived = fs.existsSync(archive) ? fs.readdirSync(archive).flatMap((d) => fs.readdirSync(path.join(archive, d))) : [];
const ok = states.some((x) => x.busy) && last.busy === null && last.refs.hero.candidates.length === 3 && last.refs.hero.picked === null
  && archived.length === 3 && last.refs.feedback.some((f) => /taller helmet/.test(f.text)) && last.refs.hero.candidates.every((c) => !before.includes(c.url));
console.log(`busy seen: ${states.some((x) => x.busy)}, candidates ${last.refs.hero.candidates.map((c) => c.id).join(',')}, picked ${last.refs.hero.picked}, archived ${archived.length}, notices: ${notices.join(' | ')}`);
console.log(ok ? 'PASS' : 'FAIL');
fs.rmSync(path.join(PROJECTS_DIR, name), { recursive: true, force: true });
process.exit(ok ? 0 : 1);
