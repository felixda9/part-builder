// Screenshot of the editor's main view with the evaluation line map on top (headless Chromium):
//   npx tsx scripts/lines-shot.ts <project> <out.png> [view] [port]
import { chromium } from 'playwright';
import { startHttp } from '../src/server/http';
import { Session } from '../src/server/session';

process.env.PART_BUILDER_NO_REMEMBER = '1';
const [project, out, view = 'right', port = '5194'] = process.argv.slice(2);
const s = new Session();
s.open(project, {});
const srv = await startHttp(s, Number(port));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await page.goto(`http://localhost:${srv.port}/`);
await page.waitForTimeout(1500);
await page.evaluate((v) => { const mb = (window as unknown as { mb: { viewport: { setView: (v: string) => void } } }).mb; mb.viewport.setView(v); }, view);
await page.waitForTimeout(800);
const box = page.locator('.vpanel .vlines input');
if (!(await box.isChecked())) await box.check();
await page.waitForTimeout(1200);
await page.screenshot({ path: out });
console.log('shot', out);
await browser.close();
srv.close();
process.exit(0);
