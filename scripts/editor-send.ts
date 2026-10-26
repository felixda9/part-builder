// Send one editor (WebSocket) message to the running server and wait until it is no longer
// busy - e.g. the "Remake all" hero button:
//   npx tsx scripts/editor-send.ts '{"type":"ui","action":"remake_heroes","note":""}' [port]
import WebSocket from 'ws';

const [msg, port = '5178'] = process.argv.slice(2);
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
let sawBusy = false;
const done = (code: number) => { ws.close(); process.exit(code); };
setTimeout(() => { console.log('timed out'); done(1); }, 10 * 60 * 1000);
ws.on('open', () => ws.send(msg));
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'error') { console.log(`error: ${m.message}`); done(1); }
  if (m.type === 'notice') console.log(`notice: ${m.message}`);
  if (m.type === 'state') {
    if (m.busy) { if (!sawBusy) console.log(`busy: ${m.busy}`); sawBusy = true; }
    else if (sawBusy) { console.log(`done: heroes ${m.refs.hero.candidates.map((c: { id: string }) => c.id).join(', ')}`); done(0); }
  }
});
