// Run the likeness evaluation on a project without logging an iteration:
//   npx tsx scripts/evaluate-check.ts <project> [outImage]
import fs from 'node:fs';
import { evaluate } from '../src/server/evaluate';
import { Refs } from '../src/server/refs';
import { Session } from '../src/server/session';

const [project = 'test_knight', out] = process.argv.slice(2);
const s = new Session();
s.open(project, {});
const t = Date.now();
const r = await evaluate(s, new Refs(s), { log: false });
console.log(r.text);
console.log(`(${((Date.now() - t) / 1000).toFixed(1)} s)`);
if (out) { fs.writeFileSync(out, r.image); console.log('sheet ->', out); }
