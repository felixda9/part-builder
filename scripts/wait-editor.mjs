// Wait until the user does something in the editor (sends a note, picks a hero, approves views),
// then print what changed and exit. Run in the background while Claude waits at a checkpoint:
//   node scripts/wait-editor.mjs [maxMinutes]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxMs = Number(process.argv[2] ?? 120) * 60_000;
const runtime = path.join(root, '.runtime');

function serverUrls() {
  // Prefer the MCP-launched server (the one Claude is using), newest first.
  const locks = fs.existsSync(runtime) ? fs.readdirSync(runtime).filter((f) => /^server-\d+\.json$/.test(f)) : [];
  return locks.map((f) => JSON.parse(fs.readFileSync(path.join(runtime, f), 'utf8')))
    .sort((a, b) => Number(b.mcp) - Number(a.mcp) || String(b.started).localeCompare(String(a.started)))
    .map((l) => l.url.replace(/\/$/, ''));
}

let pinned = null; // stick to the first server found (tests may start others later)
async function state() {
  for (const url of pinned ? [pinned] : serverUrls()) {
    try {
      const r = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) { pinned = url; return await r.json(); }
    } catch { /* try the next one */ }
  }
  return null;
}

const snap = (s) => ({
  project: s.project.name,
  notes: s.refs.feedback.length,
  hero: s.refs.hero.picked,
  approved: s.refs.viewsApproved,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let first = null;
while (!first) {
  const s = await state();
  if (s) first = s;
  else await sleep(3000);
}
const before = snap(first);
const started = Date.now();
while (Date.now() - started < maxMs) {
  await sleep(2000);
  const s = await state();
  if (!s) continue;
  const now = snap(s);
  if (now.project !== before.project) { console.log(`project switched to ${now.project}`); break; }
  const changes = [];
  if (now.notes > before.notes) for (const f of s.refs.feedback.slice(before.notes)) changes.push(`NOTE${f.view ? ` [${f.view}]` : ''}: ${f.text}`);
  if (now.hero !== before.hero) changes.push(`HERO PICKED: ${now.hero}`);
  if (now.approved && !before.approved) changes.push('VIEWS APPROVED');
  if (changes.length) {
    await sleep(4000); // let a burst of clicks/notes settle
    const s2 = (await state()) ?? s;
    const extra = s2.refs.feedback.slice(now.notes).map((f) => `NOTE${f.view ? ` [${f.view}]` : ''}: ${f.text}`);
    console.log(`editor activity in project ${now.project}:\n${[...changes, ...extra].join('\n')}`);
    process.exit(0);
  }
}
console.log('no editor activity before the timeout');
