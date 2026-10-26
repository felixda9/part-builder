// Editor entry: wires the store, network, viewport and panels; toolbar, shortcuts, status bar.

import type { Command } from '../src/core/commands';
import type { Vec3 } from '../src/core/math';
import { partAABB, unionAABB } from '../src/core/shapes';
import { $, clear, h, put, toast, typing } from './dom';
import { PartMeshes } from './meshes';
import { connect } from './net';
import { Outliner } from './outliner';
import { Properties } from './properties';
import { RefsPanel } from './refs';
import { store } from './store';
import { Timeline } from './timeline';
import { Checks } from './checks';
import { Review } from './review';
import { type AiMode, VIEWS, Viewport } from './viewport';

let viewport: Viewport;
const meshes = new PartMeshes(() => viewport?.invalidate());
viewport = new Viewport($('#viewport'), store, meshes);
new Outliner($('#outliner'), store);
const review = new Review(store);
new Timeline($('#timeline'), store, (path) => review.open(path));
new Checks($('#checks'), store);
new Properties($('#properties'), store);
new RefsPanel($('#refs'), store);

// Expose for debugging / screenshot scripts.
(window as unknown as Record<string, unknown>).mb = { store, viewport, review };

// ----------------------------------------------------------------------------------- actions

function addPart(shape: 'Block' | 'Wedge' | 'CornerWedge'): void {
  const s = store.scene;
  if (!s) return;
  const sel = store.selectedParts();
  const bb = unionAABB(sel.map(partAABB));
  let min: Vec3, max: Vec3;
  if (bb) {
    const cz = (bb.min[2] + bb.max[2]) / 2;
    min = [bb.max[0], bb.min[1], cz - 0.5];
    max = [bb.max[0] + 1, bb.min[1] + 1, cz + 0.5];
  } else {
    min = [-0.5, 0, -0.5];
    max = [0.5, 1, 0.5];
  }
  const name = store.uniqueName(shape);
  // Join the selection's group when it is unambiguous and editable.
  const groups = new Set(sel.map((p) => p.group));
  const g = groups.size === 1 ? store.groupById([...groups][0]) : undefined;
  const group = g && !g.mirrorOf ? g.name : undefined;
  let op: Command;
  if (shape === 'Block') op = { op: 'box', name, min, max, group };
  else if (shape === 'Wedge') op = { op: 'wedge', name, min, max, tall: '+z', group };
  else op = { op: 'cornerwedge', name, min, max, apex: '+x+y-z', group };
  store.selectAfterApply([name]);
  store.apply([op], `add ${name}`);
}

function editableSelection(what: string) {
  const parts = store.selectedParts();
  const ok = parts.filter((p) => !p.mirrorOf);
  if (parts.length && !ok.length) toast(`Linked-mirror parts are read-only; ${what} their source parts instead`, 'warn');
  else if (ok.length < parts.length) toast(`Skipping ${parts.length - ok.length} linked-mirror part(s)`, 'warn');
  return ok;
}

function duplicate(): void {
  const parts = editableSelection('duplicate');
  if (!parts.length) return;
  const taken = new Set<string>();
  const ops: Command[] = parts.map((p) => {
    const name = store.uniqueName(p.name, taken);
    taken.add(name);
    return { op: 'duplicate', part: p.name, name };
  });
  store.selectAfterApply([...taken]);
  store.apply(ops, parts.length === 1 ? `duplicate ${parts[0].name}` : `duplicate ${parts.length} parts`);
}

function del(): void {
  const parts = editableSelection('delete');
  if (!parts.length) return;
  store.apply([{ op: 'delete', parts: parts.map((p) => p.name) }], parts.length === 1 ? `delete ${parts[0].name}` : `delete ${parts.length} parts`);
}

async function exportModel(): Promise<void> {
  try {
    const r = await fetch('/api/export?rig=1', { method: 'POST' });
    const j = (await r.json()) as { files?: string[] | Record<string, string>; summary?: unknown; error?: string };
    if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
    const files = Array.isArray(j.files) ? j.files : Object.values(j.files ?? {});
    toast(`Exported:\n${files.join('\n')}`, 'ok', 10000);
  } catch (e) {
    toast(`Export failed: ${(e as Error).message}`, 'error');
    store.setError(`export: ${(e as Error).message}`);
  }
}

// ----------------------------------------------------------------------------------- toolbar

const btn = (label: string, title: string, onclick: () => void, ico?: string) =>
  h('button', { class: 'tbtn', title, onclick }, ico ? h('span', { class: 'ico' }, ico) : null, label);

const undoBtn = btn('Undo', 'Undo (Ctrl+Z)', () => store.send({ type: 'undo' }), '↶');
const redoBtn = btn('Redo', 'Redo (Ctrl+Y / Ctrl+Shift+Z)', () => store.send({ type: 'redo' }), '↷');
const dupBtn = btn('Duplicate', 'Duplicate selection in place (Ctrl+D)', duplicate, '⧉');
const delBtn = btn('Delete', 'Delete selection (Del)', del, '✕');
const studBtn = btn('Studs', 'Toggle stud textures / flat colors', () => {
  store.studs = !store.studs;
  try { localStorage.setItem('mb.studs', store.studs ? '1' : '0'); } catch { /* ignore */ }
  applyStuds();
}, '⠿');

function applyStuds(): void {
  meshes.setStuds(store.studs);
  studBtn.classList.toggle('on', store.studs);
  viewport.rebuildAll();
}
try { store.studs = localStorage.getItem('mb.studs') !== '0'; } catch { /* ignore */ }
meshes.setStuds(store.studs);
studBtn.classList.toggle('on', store.studs);

const reviewBtn = btn('Review', 'Review: the reference next to the model per view, scores and what they mean, the reference analysis', () => review.toggle(), '◎');
const reviewScore = h('span', { class: 'rscore' });
reviewBtn.append(reviewScore);
store.on('state', () => {
  const it = review.latest();
  reviewScore.textContent = it ? `${Math.round(it.score * 100)}%` : '';
});

// The project's image-to-3D AI model (if one was made): off / next to the parts / alone.
const aiBtns = new Map<AiMode, HTMLButtonElement>();
const aiSeg = h('span', { class: 'seg', title: 'The 3D model the image-to-3D AI made from the hero (exports/<project>_3d.glb): hide it, show it next to the part model, or show it alone' },
  h('span', { class: 'seglabel' }, '3D AI'));
for (const [m, label] of [['off', 'Off'], ['beside', 'Beside'], ['only', 'Only']] as [AiMode, string][]) {
  const b = btn(label, '', () => viewport.setAiMode(m));
  aiBtns.set(m, b);
  aiSeg.append(b);
}
const aiInfo = h('span', { class: 'seginfo' });
aiSeg.append(aiInfo);
const showAi = (state: 'loading' | 'ready' | 'missing' | 'none') => {
  for (const [m, b] of aiBtns) b.classList.toggle('on', m === viewport.aiMode);
  aiInfo.textContent = state === 'loading' ? '…' : state === 'missing' ? 'none yet' : '';
  aiInfo.title = state === 'missing' ? 'No 3D AI model for this project yet (npx tsx scripts/make-3d.ts <project> --faces 15000 --texture 1024, then view-3d and export-3d)' : '';
};
viewport.onAiChange = showAi;
try { const m = localStorage.getItem('mb.ai3d') as AiMode | null; if (m === 'beside' || m === 'only') viewport.aiMode = m; } catch { /* ignore */ }
showAi('none');

$('#toolbar').append(
  h('span', { class: 'brand' }, 'part-builder'),
  btn('Block', 'Add a Block', () => addPart('Block'), '■'),
  btn('Wedge', 'Add a Wedge', () => addPart('Wedge'), '◢'),
  btn('Corner', 'Add a CornerWedge', () => addPart('CornerWedge'), '◣'),
  h('div', { class: 'sep' }),
  dupBtn, delBtn,
  h('div', { class: 'sep' }),
  undoBtn, redoBtn,
  h('div', { class: 'sep' }),
  studBtn,
  h('div', { class: 'sep' }),
  aiSeg,
  h('div', { class: 'grow' }),
  reviewBtn,
  h('div', { class: 'sep' }),
  btn('Export', 'Export .rbxmx + Luau (rigged)', () => void exportModel(), '⇩'),
);

function updateToolbar(): void {
  const s = store.state;
  undoBtn.disabled = !s?.canUndo;
  redoBtn.disabled = !s?.canRedo;
  const parts = store.selectedParts();
  const editable = parts.some((p) => !p.mirrorOf);
  dupBtn.disabled = !editable;
  delBtn.disabled = !editable;
}
store.on('state', updateToolbar);
store.on('selection', updateToolbar);
updateToolbar();

// ----------------------------------------------------------------------------------- status bar

const statusEl = $('#status');
function renderStatus(): void {
  clear(statusEl);
  const s = store.state;
  const p = s?.project;
  put(statusEl,
    h('span', null, h('b', null, p?.name ?? '—'), p?.idea ? ` · ${p.idea}` : '', p?.stage ? ` · ${p.stage}` : ''),
    h('span', null, `${s?.scene.parts.length ?? 0} parts`),
    h('span', null, `rev ${s?.rev ?? '—'}`),
    store.selection.length ? h('span', null, `${store.selection.length} selected`) : null,
    h('span', { class: 'grow' }),
    store.lastError ? h('span', { class: 'err', title: `${store.lastError}\n(click to clear)`, onclick: () => store.setError(null) }, `⚠ ${store.lastError}`) : null,
    h('span', null, h('span', { class: `dot ${store.conn}` }), store.conn === 'open' ? 'connected' : store.conn === 'connecting' ? 'connecting…' : 'disconnected'),
  );
}
store.on('status', renderStatus);
store.on('selection', renderStatus);
renderStatus();

// ----------------------------------------------------------------------------------- shortcuts

window.addEventListener('keydown', (e) => {
  if (typing() || document.querySelector('.lightbox')) return;
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); store.send({ type: 'undo' }); return; }
  if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); store.send({ type: 'redo' }); return; }
  if (mod && k === 'd') { e.preventDefault(); duplicate(); return; }
  if (mod && k === 'a') { e.preventDefault(); store.select(store.scene?.parts.map((p) => p.id) ?? []); return; }
  if (mod || e.altKey) return;
  const view = VIEWS.find((v) => v.key === e.key);
  if (view) { viewport.setView(view.id); return; }
  if (k === 'f') viewport.frame();
  else if (k === 'g') viewport.setMode('translate');
  else if (k === 'r') viewport.setMode('rotate');
  else if (k === 'escape') store.select([]);
  else if (k === 'delete' || k === 'backspace') { e.preventDefault(); del(); }
});

connect(store);
