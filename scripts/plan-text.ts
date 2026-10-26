// Prints a project's build plan as text (and its check results):
//   npx tsx scripts/plan-text.ts <project | plan.json>
import fs from 'node:fs';
import { checkPlan, planText, zBuildPlan } from '../src/server/plan';

const arg = process.argv[2] ?? 'fox';
const file = arg.endsWith('.json') ? arg : `projects/${arg}/parts/plan.json`;
const plan = zBuildPlan.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
console.log(planText(plan));
const { errors, warnings } = checkPlan(plan);
for (const e of errors) console.log(`ERROR ${e}`);
for (const w of warnings) console.log(`warning ${w}`);
