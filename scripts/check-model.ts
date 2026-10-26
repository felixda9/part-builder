// Run the model checks on a project's current model and print them (with timing):
//   npx tsx scripts/check-model.ts <project>
import { Session } from '../src/server/session';

process.env.PART_BUILDER_NO_REMEMBER = '1';
const s = new Session();
s.open(process.argv[2] ?? 'fox', {});
const t = Date.now();
const lints = s.lints();
console.log(`${s.scene.parts.length} parts, ${Date.now() - t} ms`);
for (const l of lints) console.log(`- ${l.kind}: ${l.message}`);
process.exit(0);
