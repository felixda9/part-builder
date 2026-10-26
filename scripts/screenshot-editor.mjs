// Visual self-check for the browser editor (Playwright + headless Chromium).
//
//   node scripts/screenshot-editor.mjs seed [--port=5191]            reset the open project and build a sample knight over the WS
//   node scripts/screenshot-editor.mjs fake-refs <projectDir>       write fake reference images + refs/refs.json (restart the server after)
//   node scripts/screenshot-editor.mjs shots [--port=5191] [--out=dir]   drive the editor and save screenshots
//
// The editor server must already be running (e.g. PART_BUILDER_PORT=5191 node bin/editor.mjs) with dist/web built.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const port = Number(opt('port', process.env.PART_BUILDER_PORT ?? 5191));
const base = `http://localhost:${port}`;

const KNIGHT = [
  { op: 'palette', colors: ['#3b4a5a', '#c9ced6', '#f2c39b', '#1b1f24', '#8a2be2'] },
  { op: 'box', name: 'Torso', min: [-1, 2, -0.5], max: [1, 4, 0.5], color: 'p1' },
  { op: 'box', name: 'Belt', min: [-1.05, 2, -0.55], max: [1.05, 2.3, 0.55], color: 'p0' },
  { op: 'box', name: 'Head', min: [-0.6, 4, -0.6], max: [0.6, 5.2, 0.6], color: 'p2' },
  { op: 'wedge', name: 'HelmetTop', min: [-0.65, 4.8, -0.65], max: [0.65, 5.2, 0.65], tall: '+z', color: 'p1' },
  { op: 'attach', name: 'RightEye', to: 'Head', face: '-z', size: [0.2, 0.2, 0.1], offset: [0.25, 0.1, 0], color: 'p3' },
  { op: 'attach', name: 'LeftEye', to: 'Head', face: '-z', size: [0.2, 0.2, 0.1], offset: [-0.25, 0.1, 0], color: 'p3' },
  { op: 'box', name: 'RightArm', min: [1, 2, -0.5], max: [2, 4, 0.5], color: 'p1' },
  { op: 'wedge', name: 'RightPauldron', min: [1, 4, -0.55], max: [2.1, 4.5, 0.55], tall: '-x', color: 'p0' },
  { op: 'cornerwedge', name: 'RightSpike', min: [1.6, 4.5, -0.2], max: [2.0, 4.9, 0.2], apex: '+x+y-z', color: 'p4', material: 'Neon' },
  { op: 'box', name: 'RightLeg', min: [0, 0, -0.5], max: [1, 2, 0.5], color: 'p0' },
  { op: 'box', name: 'RightBoot', min: [0, 0, -0.75], max: [1, 0.5, 0.5], color: 'p3', surfaces: { top: 'Inlet' } },
  { op: 'group', name: 'TorsoG', parts: ['Torso', 'Belt'], pivot: [0, 3, 0] },
  { op: 'group', name: 'HeadG', parts: ['Head', 'HelmetTop', 'RightEye', 'LeftEye'], parent: 'TorsoG', pivot: [0, 4, 0], main: 'Head' },
  { op: 'group', name: 'RightArmG', parts: ['RightArm', 'RightPauldron', 'RightSpike'], parent: 'TorsoG', pivot: [1.5, 3.8, 0], main: 'RightArm' },
  { op: 'group', name: 'RightLegG', parts: ['RightLeg', 'RightBoot'], parent: 'TorsoG', pivot: [0.5, 2, 0] },
  { op: 'mirror_group', source: 'RightArmG', name: 'LeftArmG' },
  { op: 'mirror_group', source: 'RightLegG', name: 'LeftLegG' },
];

async function wsSession(fn) {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const queue = [];
  let waiter = null;
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (waiter) { const w = waiter; waiter = null; w(m); } else queue.push(m);
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const next = () => new Promise((res) => (queue.length ? res(queue.shift()) : (waiter = res)));
  try {
    return await fn({ send: (m) => ws.send(JSON.stringify(m)), next });
  } finally {
    ws.close();
  }
}

async function seed() {
  await wsSession(async ({ send, next }) => {
    const first = await next();
    const groups = first.scene.groups.filter((g) => !g.mirrorOf).map((g) => g.name);
    const reset = [...groups.map((name) => ({ op: 'delete_group', name, deleteParts: true })), { op: 'delete', parts: '*' }];
    if (first.scene.parts.length || groups.length) {
      send({ type: 'apply', ops: reset, label: 'reset' });
      const r = await next();
      if (r.type === 'error') throw new Error(r.message);
    }
    send({ type: 'apply', ops: KNIGHT, label: 'knight blockout' });
    const r = await next();
    if (r.type === 'error') throw new Error(r.message);
    console.log(`seeded: rev ${r.rev}, ${r.scene.parts.length} parts, ${r.scene.groups.length} groups`);
  });
}

async function fakeRefs(projectDir) {
  const { register } = await import('tsx/esm/api');
  register();
  const raster = await import(pathToFileURL(path.join(root, 'src/core/raster.ts')).href);
  const { default: sharp } = await import('sharp');
  const dir = path.resolve(projectDir);
  const refsDir = path.join(dir, 'refs');
  fs.mkdirSync(refsDir, { recursive: true });
  const scene = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
  const parts = scene.parts;
  const png = async (res, file, recolor = false) => {
    if (recolor) raster.recolorByPart(res);
    raster.drawOutlines(res, 0.5);
    await sharp(Buffer.from(res.color.buffer), { raw: { width: res.width, height: res.height, channels: 4 } }).png().toFile(path.join(refsDir, file));
  };
  const v = Date.now();
  const url = (f) => `/files/refs/${f}?v=${v}`;
  const views = {};
  for (const view of ['front', 'right', 'back', 'left', 'top']) {
    const frame = raster.autoFrame(parts, view, 32, 1);
    const res = raster.renderOrtho(parts, frame);
    await png(res, `view_${view}.png`, true);
    const mask = raster.maskOf(res);
    const mbuf = Buffer.alloc(mask.length);
    for (let i = 0; i < mask.length; i++) mbuf[i] = mask[i] ? 255 : 0;
    await sharp(mbuf, { raw: { width: res.width, height: res.height, channels: 1 } }).png().toFile(path.join(refsDir, `mask_${view}.png`));
    const { view: _v, ...f } = frame;
    views[view] = { url: url(`view_${view}.png`), maskUrl: url(`mask_${view}.png`), rawUrl: url(`view_${view}.png`), frame: f };
  }
  views.left.flag = 'left arm is missing the pauldron spike seen in the hero image';
  const heroes = [];
  for (const [i, yaw] of [[1, 45], [2, 30], [3, 60]]) {
    const cam = raster.threeQuarterCamera(parts, 384, 384, yaw, 20);
    await png(raster.renderPerspective(parts, cam), `hero_${i}.png`);
    heroes.push({ id: `hero_${i}`, url: url(`hero_${i}.png`), label: `candidate ${i} (yaw ${yaw}°)` });
  }
  const closeups = {};
  for (const name of ['Head', 'RightArm']) {
    const ps = parts.filter((p) => p.name === name);
    if (!ps.length) continue;
    const cam = raster.threeQuarterCamera(ps, 256, 256, 35, 15);
    await png(raster.renderPerspective(ps, cam), `part_${name}.png`);
    closeups[name] = [{ id: `part_${name}`, url: url(`part_${name}.png`), label: `${name} close-up` }];
  }
  const refs = {
    hero: { candidates: heroes, picked: 'hero_1' },
    sheet: null,
    views,
    viewsApproved: false,
    parts: closeups,
    report: 'front/back silhouettes agree (IoU 0.97)\nleft view: arm spike missing (flagged)\ntop view: OK',
    overlayUrl: url('hero_2.png'),
    palette: scene.palette.length ? scene.palette : ['#3b4a5a', '#c9ced6', '#f2c39b'],
    feedback: [{ view: 'front', text: 'helmet looks too tall', time: new Date(Date.now() - 600000).toISOString() }],
  };
  fs.writeFileSync(path.join(refsDir, 'refs.json'), JSON.stringify(refs, null, 2));
  const iters = [
    { iter: 1, rev: 1, score: 0.71, perView: { front: 0.74, right: 0.69, top: 0.7 }, time: new Date().toISOString(), note: 'blockout' },
    { iter: 2, rev: 2, score: 0.86, perView: { front: 0.9, right: 0.81, top: 0.86 }, time: new Date().toISOString() },
  ];
  fs.writeFileSync(path.join(dir, 'iterations.jsonl'), iters.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.log(`wrote ${path.join(refsDir, 'refs.json')} (+ images, iterations.jsonl); restart the server to load them`);
}

async function shots() {
  const out = path.resolve(opt('out', path.join(root, '.runtime', 'editor-shots')));
  fs.mkdirSync(out, { recursive: true });
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') { problems.push(`[${m.type()}] ${m.text()}`); } });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  const shot = async (name) => {
    await page.waitForTimeout(350);
    const f = path.join(out, name);
    await page.screenshot({ path: f });
    console.log('shot', f);
  };
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const state = () => ev(() => { const s = window.mb.store.state; return { rev: s.rev, labels: s.revisions.map((r) => r.label), sel: window.mb.store.selection }; });
  const partId = (name) => ev((n) => window.mb.store.state.scene.parts.find((p) => p.name === n)?.id, name);
  const waitRev = async (rev) => page.waitForFunction((r) => window.mb.store.state.rev !== r, rev, { timeout: 5000 });

  await page.goto(base + '/');
  await page.waitForFunction(() => window.mb?.store.state && window.mb.store.state.scene.parts.length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(1500); // textures
  await shot('01-threequarter.png');

  // Views
  for (const [key, name] of [['1', 'front'], ['3', 'right'], ['5', 'top'], ['2', 'back']]) {
    await page.keyboard.press(key);
    await shot(`02-${name}-ortho.png`);
  }
  await page.keyboard.press('6');

  // Click-select the torso in the viewport
  const torsoPt = await ev(() => window.mb.viewport.screenPoint([0.3, 3.2, -0.5]));
  await page.mouse.click(torsoPt.x, torsoPt.y);
  const sel1 = await state();
  console.log('click-select ->', sel1.sel, '(torso id', await partId('Torso'), ')');
  await shot('03-selected-gizmo.png');

  // Gizmo drag along X (translate)
  {
    const a = await ev(() => window.mb.viewport.gizmoAnchor());
    const p0 = await ev((p) => window.mb.viewport.screenPoint(p), a);
    const p1 = await ev((p) => window.mb.viewport.screenPoint([p[0] + 1, p[1], p[2]]), a);
    const dx = p1.x - p0.x, dy = p1.y - p0.y, len = Math.hypot(dx, dy);
    let found = null;
    for (let t = 20; t < 160 && !found; t += 6) {
      const x = p0.x + (dx / len) * t, y = p0.y + (dy / len) * t;
      await page.mouse.move(x, y);
      if ((await ev(() => window.mb.viewport.gizmo.axis)) === 'X') found = { x, y };
    }
    if (!found) console.log('!! could not find the X arrow of the gizmo');
    else {
      const before = (await state()).rev;
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(found.x + (dx / len) * 9 * i, found.y + (dy / len) * 9 * i);
      await shot('04-dragging.png');
      await page.mouse.up();
      await waitRev(before).catch(() => console.log('!! no new rev after drag'));
      console.log('after drag:', (await state()).labels.slice(-1)[0]);
      await shot('05-after-drag.png');
      // undo it
      await page.keyboard.press('Control+z');
      await waitRev((await state()).rev).catch(() => {});
    }
  }

  // Rotate gizmo: drag the Y ring
  {
    await page.keyboard.press('r');
    const a = await ev(() => window.mb.viewport.gizmoAnchor());
    let found = null;
    outer: for (let r = 0.5; r < 2.2; r += 0.08) {
      for (const t of [0.6, -0.9, 2.2]) {
        const p = await ev((q) => window.mb.viewport.screenPoint(q), [a[0] + Math.cos(t) * r, a[1], a[2] + Math.sin(t) * r]);
        await page.mouse.move(p.x, p.y);
        if ((await ev(() => window.mb.viewport.gizmo.axis)) === 'Y') { found = p; break outer; }
      }
    }
    await shot('06-rotate-gizmo.png');
    if (!found) console.log('!! could not find the Y ring');
    else {
      const before = (await state()).rev;
      await page.mouse.down();
      for (let i = 1; i <= 12; i++) await page.mouse.move(found.x + 12 * i, found.y + 2 * i);
      await page.mouse.up();
      await waitRev(before).catch(() => console.log('!! no new rev after rotate'));
      console.log('after rotate:', (await state()).labels.slice(-1)[0]);
      await shot('07-after-rotate.png');
      await page.keyboard.press('Control+z');
      await waitRev((await state()).rev).catch(() => {});
    }
    await page.keyboard.press('g');
  }

  // Group in outliner
  await page.locator('#outliner .row.group', { hasText: 'RightArmG' }).first().click();
  await shot('08-group-selected.png');

  // Linked-mirror part
  await page.locator('#outliner .row.part', { hasText: 'LeftArm' }).first().click();
  await shot('09-mirror-part.png');

  // Multi-select with shift-click in the outliner
  await page.locator('#outliner .row.part', { hasText: 'Torso' }).first().click();
  await page.locator('#outliner .row.part', { hasText: 'Belt' }).first().click({ modifiers: ['Shift'] });
  await page.locator('#outliner .row.part', { hasText: 'Head' }).first().click({ modifiers: ['Shift'] });
  await shot('10-multi-select.png');

  // Property edit: change Torso's color via the hex box
  await page.locator('#outliner .row.part', { hasText: 'Torso' }).first().click();
  {
    const before = (await state()).rev;
    const hex = page.locator('#properties .colorrow input[type=text]').first();
    await hex.fill('#d04a4a');
    await hex.press('Enter');
    await waitRev(before).catch(() => console.log('!! color edit did not create a rev'));
    console.log('after color edit:', (await state()).labels.slice(-1)[0]);
    await page.locator('#viewport canvas').click({ position: { x: 5, y: 300 } });
    await shot('11-after-color-edit.png');
    await page.keyboard.press('Control+z');
    await waitRev((await state()).rev).catch(() => {});
  }

  // Add a block next to the selection, then delete it
  {
    await page.locator('#outliner .row.part', { hasText: 'RightArm' }).first().click();
    const before = (await state()).rev;
    await page.locator('#toolbar button', { hasText: 'Block' }).click();
    await waitRev(before).catch(() => console.log('!! add block failed'));
    const s = await state();
    console.log('after add:', s.labels.slice(-1)[0], 'selected', s.sel);
    await shot('12-added-block.png');
    await page.keyboard.press('Delete');
    await waitRev(s.rev).catch(() => console.log('!! delete failed'));
    console.log('after delete:', (await state()).labels.slice(-1)[0]);
  }

  // Surfaces close-up: Studs / Inlet / Smooth plates, framed with F, then undone
  {
    const before = (await state()).rev;
    await ev(() => window.mb.store.apply([
      { op: 'box', name: 'PlateStuds', min: [4, 0, -2], max: [6, 0.4, 0], color: '#4b8f3a' },
      { op: 'box', name: 'PlateInlet', min: [6.5, 0, -2], max: [8.5, 0.4, 0], color: '#4b8f3a', surfaces: 'Inlet' },
      { op: 'box', name: 'PlateSmooth', min: [9, 0, -2], max: [11, 0.4, 0], color: '#4b8f3a', surfaces: 'Smooth' },
      { op: 'wedge', name: 'SlopeStuds', min: [4, 0, 0.5], max: [6, 1.5, 2.5], tall: '+z', color: '#c8a03c' },
      { op: 'cornerwedge', name: 'CornerStuds', min: [6.5, 0, 0.5], max: [8.5, 1.5, 2.5], apex: '+x+y-z', color: '#c8a03c' },
      { op: 'wedge', name: 'SlopeInlet', min: [9, 0, 0.5], max: [11, 1.5, 2.5], tall: '+z', color: '#c8a03c', surfaces: 'Inlet' },
    ], 'surface test'));
    await waitRev(before).catch(() => console.log('!! surface test parts failed'));
    const ids = await ev(() => window.mb.store.state.scene.parts.filter((p) => /^(Plate|Slope|Corner)/.test(p.name)).map((p) => p.id));
    await ev((x) => window.mb.store.select(x), ids);
    await page.keyboard.press('6');
    await page.keyboard.press('f');
    await ev(() => window.mb.store.select([]));
    await shot('12b-surfaces-closeup.png');
    await page.keyboard.press('Control+z');
    await waitRev((await state()).rev).catch(() => {});
    await page.keyboard.press('6');
  }

  // Flat colors
  await page.keyboard.press('Escape');
  await page.locator('#toolbar button', { hasText: 'Studs' }).click();
  await shot('13-flat-colors.png');
  await page.locator('#toolbar button', { hasText: 'Studs' }).click();

  // Refs panel + backdrop
  await page.keyboard.press('1');
  await shot('14-front-backdrop.png');
  await ev(() => { window.mb.viewport.partsRoot.visible = false; window.mb.viewport.invalidate(); });
  await shot('14b-front-backdrop-only.png');
  await ev(() => { window.mb.viewport.partsRoot.visible = true; window.mb.viewport.invalidate(); });
  // Orbiting away from an ortho preset drops to perspective
  {
    const box = await page.locator('#viewport canvas').boundingBox();
    await page.mouse.move(box.x + 60, box.y + 420);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + 60 + i * 12, box.y + 420 + i * 4);
    await page.mouse.up();
    console.log('after orbiting the front ortho view:', await page.locator('.vlabel').textContent());
    await shot('14c-orbit-from-ortho.png');
    await page.keyboard.press('1');
  }
  await page.keyboard.press('3');
  await shot('15-right-backdrop.png');
  await page.keyboard.press('6');
  await page.evaluate(() => { const r = document.querySelector('#refs'); r?.scrollIntoView(); });
  await shot('16-refs-panel.png');
  const right = page.locator('#right');
  await right.screenshot({ path: path.join(out, '17-right-sidebar.png') });
  console.log('shot', path.join(out, '17-right-sidebar.png'));
  await page.evaluate(() => { const r = document.querySelector('#right'); if (r) r.scrollTop = r.scrollHeight; });
  await right.screenshot({ path: path.join(out, '18-right-sidebar-bottom.png') });
  console.log('shot', path.join(out, '18-right-sidebar-bottom.png'));

  // Lightbox
  const img = page.locator('#refs .thumb img').first();
  if (await img.count()) {
    await img.click();
    await shot('19-lightbox.png');
    await page.keyboard.press('Escape');
  }

  // Reference UI actions -> server
  {
    const refsOf = () => ev(() => { const r = window.mb.store.state.refs; return { picked: r.hero.picked, approved: r.viewsApproved, feedback: r.feedback.length }; });
    const r0 = await refsOf();
    await page.locator('#refs .thumb:not(.picked)').first().locator('button', { hasText: 'Pick' }).click();
    await page.waitForFunction((p) => window.mb.store.state.refs.hero.picked !== p, r0.picked, { timeout: 5000 }).catch(() => console.log('!! pick_hero failed'));
    const fb = page.locator('#refs .views .thumb', { hasText: 'front' }).locator('input');
    await fb.fill('the helmet should be shorter');
    await fb.press('Enter');
    await page.waitForFunction((n) => window.mb.store.state.refs.feedback.length > n, r0.feedback, { timeout: 5000 }).catch(() => console.log('!! view feedback failed'));
    await page.locator('#refs textarea').fill('Use darker grey for the armour');
    await page.locator('#refs button', { hasText: 'Send note' }).click();
    await page.waitForFunction((n) => window.mb.store.state.refs.feedback.length > n + 1, r0.feedback, { timeout: 5000 }).catch(() => console.log('!! note failed'));
    if (!r0.approved) {
      await page.locator('#refs button', { hasText: 'Approve views' }).click();
      await page.waitForFunction(() => window.mb.store.state.refs.viewsApproved, null, { timeout: 5000 }).catch(() => console.log('!! approve failed'));
    }
    console.log('refs before', r0, 'after', await refsOf());
    await page.evaluate(() => { const r = document.querySelector('#right'); if (r) r.scrollTop = 0; });
    await right.screenshot({ path: path.join(out, '20-refs-after-actions.png') });
    console.log('shot', path.join(out, '20-refs-after-actions.png'));
  }

  // Export
  await page.locator('#toolbar button', { hasText: 'Export' }).click();
  const exportToast = page.locator('.toast', { hasText: /Export/ }).last();
  await exportToast.waitFor({ timeout: 15000 }).catch(() => console.log('!! no export toast'));
  console.log('export toast:', (await exportToast.innerText()).split('\n').join(' | '));
  await shot('21-export-toast.png');

  // Numeric property edit (size X) then undo
  await page.keyboard.press('6');
  await page.locator('#outliner .row.part', { hasText: 'Torso' }).first().click();
  {
    const before = (await state()).rev;
    const sx = page.locator('#properties .field', { hasText: 'Size' }).locator('input').first();
    await sx.fill('2.5');
    await sx.press('Enter');
    await waitRev(before).catch(() => console.log('!! size edit failed'));
    const sz = await ev(() => window.mb.store.state.scene.parts.find((p) => p.name === 'Torso').size);
    console.log('after size edit:', (await state()).labels.slice(-1)[0], sz);
    await page.locator('#viewport canvas').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press('Control+z');
    await waitRev((await state()).rev).catch(() => {});
  }

  // Duplicate (Ctrl+D) then undo
  await page.locator('#outliner .row.part', { hasText: 'RightLeg' }).first().click();
  {
    const before = (await state()).rev;
    await page.keyboard.press('Control+d');
    await waitRev(before).catch(() => console.log('!! duplicate failed'));
    const s = await state();
    console.log('after duplicate:', s.labels.slice(-1)[0], 'selected', await ev(() => window.mb.store.selectedParts().map((p) => p.name)));
    await page.keyboard.press('Control+z');
    await waitRev(s.rev).catch(() => {});
  }

  // Linked mirror: HeadG fails (RightEye -> LeftEye name clash), TorsoG succeeds
  await page.locator('#outliner .row.group', { hasText: 'HeadG' }).first().click();
  await page.locator('#properties button', { hasText: 'Create linked mirror' }).click();
  await page.waitForSelector('.toast.error', { timeout: 5000 }).catch(() => console.log('!! expected an error toast'));
  console.log('mirror HeadG error:', await ev(() => window.mb.store.lastError));
  await shot('22-error-toast.png');
  await page.locator('#outliner .row.group', { hasText: 'TorsoG' }).first().click();
  {
    const before = (await state()).rev;
    await page.locator('#properties button', { hasText: 'Create linked mirror' }).click();
    await waitRev(before).catch(() => console.log('!! mirror TorsoG failed'));
    console.log('after mirror:', (await state()).labels.slice(-1)[0], await ev(() => window.mb.store.state.scene.groups.map((g) => g.name)));
    await shot('23-mirror-created.png');
    await page.keyboard.press('Control+z');
    await waitRev((await state()).rev).catch(() => {});
  }

  // Timeline checkout
  {
    const revs = await ev(() => window.mb.store.state.revisions.map((r) => [r.rev, r.label]));
    const knight = revs.find((r) => r[1] === 'knight blockout');
    const cur = (await state()).rev;
    if (knight && knight[0] !== cur) {
      await page.locator('#timeline .revs .row', { hasText: 'knight blockout' }).first().click();
      await waitRev(cur).catch(() => console.log('!! checkout failed'));
      console.log(`checkout: rev ${cur} -> ${(await state()).rev}`);
      await shot('24-checkout.png');
    }
  }

  console.log(problems.length ? `browser problems:\n${problems.join('\n')}` : 'no browser errors');
  await browser.close();
}

if (cmd === 'seed') await seed();
else if (cmd === 'fake-refs') await fakeRefs(args[1] ?? path.join(root, 'projects', 'scratch'));
else if (cmd === 'shots') await shots();
else {
  console.log('usage: node scripts/screenshot-editor.mjs seed|fake-refs <projectDir>|shots [--port=5191] [--out=dir]');
  process.exit(1);
}
