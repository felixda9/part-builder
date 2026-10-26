// Screenshots of the editor's Review screen for a project (headless Chromium):
//   npx tsx scripts/review-shots.ts <project> <outDir> [port]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startHttp } from '../src/server/http';
import { Session } from '../src/server/session';

process.env.PART_BUILDER_NO_REMEMBER = '1';
const [project, out, port = '5193'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const s = new Session();
s.open(project, {});
const srv = await startHttp(s, Number(port));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(`http://localhost:${srv.port}/`);
await page.waitForTimeout(1500);
const shot = async (name: string) => { await page.waitForTimeout(700); await page.screenshot({ path: path.join(out, `${name}.png`) }); console.log('shot', name); };
await shot('0_editor');
await page.click('button:has-text("Review")');
await shot('1_overlay_front');
await page.click('.review .modes button:has-text("Lines")');
await shot('2_lines_front');
await page.click('.review .views button:has-text("side")');
await page.click('.review .modes button:has-text("All four")');
await shot('3_all_side');
await page.click('.review .views button:has-text("3/4")');
await shot('4_hero');
await page.click('.review .rhead button:has-text("Reference analysis")');
await shot('5_analysis');
await page.click('.review .rhead button:has-text("How it works")');
await shot('6_help');
await browser.close();
srv.close();
process.exit(0);
