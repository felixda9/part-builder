// Builds a plan in the running editor (over its WebSocket) with this checkout's plan code, and
// saves it as the project's plan - for when the editor's server runs older code than the repo:
//   npx tsx scripts/apply-plan.ts <plan.json> [port]
// The editor must have the plan's project open.
import fs from 'node:fs';
import WebSocket from 'ws';
import { checkPlan, planToCommands, zBuildPlan } from '../src/server/plan';

const [planFile, port = '5178'] = process.argv.slice(2);
const plan = zBuildPlan.parse(JSON.parse(fs.readFileSync(planFile, 'utf8')));
const { errors } = checkPlan(plan);
if (errors.length) { console.log(errors.join('\n')); process.exit(1); }

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
let sentAt = -1;
const done = (code: number) => { ws.close(); process.exit(code); };
setTimeout(() => { console.log('timed out'); done(1); }, 120000);
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'error') { console.log(`error: ${m.message}`); done(1); }
  if (m.type !== 'state') return;
  if (sentAt < 0) {
    const ops = planToCommands(plan, m.scene.groups.map((g: { name: string }) => g.name), true);
    fs.writeFileSync(`projects/${m.project.name}/parts/plan.json`, JSON.stringify(plan, null, 1));
    console.log(`project ${m.project.name}: sending ${ops.length} commands`);
    sentAt = m.rev;
    ws.send(JSON.stringify({ type: 'apply', ops, label: 'plan build (bevelled)' }));
  } else if (m.rev !== sentAt) {
    console.log(`rev ${m.rev}: ${m.scene.parts.length} parts`);
    for (const c of m.checks ?? []) console.log(`- ${c.kind}: ${c.message}`);
    done(0);
  }
});
