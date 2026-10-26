// Replace a project's hero candidates with images from elsewhere (e.g. test projects), archiving
// the old ones:  npx tsx scripts/import-heroes.ts <project> <png> [<png> ...] [--note "text"]
import fs from 'node:fs';
import path from 'node:path';
import { Session } from '../src/server/session';

process.env.PART_BUILDER_NO_REMEMBER = '1';
const args = process.argv.slice(2);
const noteAt = args.indexOf('--note');
const note = noteAt >= 0 ? args.splice(noteAt, 2)[1] : '';
const [project, ...files] = args;
if (!project || !files.length) throw new Error('usage: import-heroes.ts <project> <png...> [--note text]');
const s = new Session();
s.open(project, {});
const refs = s.path('refs');
const archive = path.join(refs, 'archive', `heroes_${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(archive, { recursive: true });
for (const c of s.refs.hero.candidates) {
  const f = path.join(refs, `${c.id}.png`);
  if (fs.existsSync(f)) fs.renameSync(f, path.join(archive, `${c.id}.png`));
}
s.refs.hero = { candidates: [], picked: null };
s.meta.checkpoints.hero = null;
files.forEach((src, i) => {
  const id = `hero_${i + 1}`;
  const dst = path.join(refs, `${id}.png`);
  fs.copyFileSync(src, dst);
  s.refs.hero.candidates.push({ id, url: s.url(dst), label: `Hero ${i + 1}` });
});
if (note) s.refs.feedback.push({ text: note, time: new Date().toISOString() });
s.meta.stage = 'hero';
s.saveMeta();
s.saveRefs();
console.log(`${project}: ${files.length} hero candidates imported, old ones in ${archive}`);
