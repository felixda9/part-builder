// Review screen: what the tool sees, so the user can follow how a model is judged.
//   Model vs reference - per view: the reference, the model rendered from the same camera, the
//     two blended, the line map (red = only in the reference, blue = only in the model, black =
//     both), or blinking between them; the scores and what they mean; the fix lists, landmarks
//     and checks of that round.
//   Reference analysis - the lines and small details found in each reference (the build plan's
//     measurements), plus how the references were cut out.
//   Report / How it works - the exact text Claude reads after each round, and the pipeline in words.

import type { IterationRecord, LikenessParts, ReviewData, ReviewView } from '../src/core/protocol';
import { clear, h, lightbox, timeAgo } from './dom';
import type { Store } from './store';

type Mode = 'ref' | 'model' | 'overlay' | 'lines' | 'blink' | 'all';
type Tab = 'compare' | 'analysis' | 'report' | 'help';

const fileUrl = (rel: string) => `/files/${rel.split('/').map(encodeURIComponent).join('/')}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const scoreClass = (x: number) => (x >= 0.8 ? 'score-good' : x >= 0.6 ? 'score-mid' : 'score-bad');

const COMPONENTS: { key: keyof LikenessParts; label: string; weight: keyof ReviewData['weights']; what: string }[] = [
  { key: 'silhouette', label: 'Outline', weight: 'silhouette', what: 'how well the two silhouettes overlap' },
  { key: 'structure', label: 'Structure', weight: 'structure', what: 'whether the lines inside the shape (bands, plate edges, where the legs start) are in the same places' },
  { key: 'color', label: 'Color', weight: 'color', what: 'whether each area has the same color family as the reference' },
  { key: 'detail', label: 'Details', weight: 'detail', what: 'whether small features (eyes, rivets, buttons) have a small part at the same spot' },
];

const MODES: { id: Mode; label: string; legend: string }[] = [
  { id: 'ref', label: 'Reference', legend: 'The reference view, cut out and scaled to studs - this is what the model is compared against.' },
  { id: 'model', label: 'Model', legend: 'The model rendered from exactly the same camera and scale.' },
  { id: 'overlay', label: 'Overlay', legend: 'The model drawn over the reference at half strength: offsets and size differences show as doubled edges.' },
  { id: 'lines', label: 'Lines', legend: '' },
  { id: 'blink', label: 'Blink', legend: 'Switches between the reference and the model twice a second - the eye catches what moves.' },
  { id: 'all', label: 'All four', legend: 'Reference, model, overlay and line map side by side.' },
];

export class Review {
  private root: HTMLDivElement;
  private body: HTMLDivElement;
  private roundSel: HTMLSelectElement;
  private tabBtns = new Map<Tab, HTMLButtonElement>();
  private isOpen = false;
  private tab: Tab = 'compare';
  private view = 'front';
  private mode: Mode = 'overlay';
  private path: string | null = null;
  private followLatest = true;
  private data: ReviewData | null = null;
  private cache = new Map<string, ReviewData>();
  private blink: number | null = null;
  private lastRounds = '';

  constructor(private store: Store) {
    this.roundSel = h('select', { class: 'rsel', title: 'Evaluation round', onchange: () => { this.followLatest = false; void this.load(this.roundSel.value); } });
    const tabs: [Tab, string][] = [['compare', 'Model vs reference'], ['analysis', 'Reference analysis'], ['report', 'Report'], ['help', 'How it works']];
    const head = h('div', { class: 'rhead' },
      h('b', null, 'Review'),
      this.roundSel,
      h('div', { class: 'seg' }, tabs.map(([id, label]) => {
        const b = h('button', { onclick: () => { this.tab = id; this.render(); } }, label);
        this.tabBtns.set(id, b);
        return b;
      })),
      h('div', { class: 'grow' }),
      h('button', { class: 'tbtn', title: 'Close (Esc)', onclick: () => this.close() }, '✕ Close'),
    );
    this.body = h('div', { class: 'rbody' });
    this.root = h('div', { class: 'review', style: { display: 'none' } }, head, this.body);
    document.body.append(this.root);
    window.addEventListener('keydown', (e) => { if (this.isOpen && e.key === 'Escape') { e.stopPropagation(); this.close(); } }, true);
    store.on('state', () => this.onState());
  }

  /** Rounds that have a review, newest first. */
  private rounds(): IterationRecord[] {
    return [...(this.store.state?.iterations ?? [])].filter((it) => it.review).reverse();
  }

  latest(): IterationRecord | null {
    return this.rounds()[0] ?? null;
  }

  open(path?: string): void {
    this.isOpen = true;
    this.root.style.display = '';
    this.followLatest = !path;
    const target = path ?? this.latest()?.review ?? null;
    if (target) void this.load(target);
    else { this.data = null; this.render(); }
  }

  close(): void {
    this.isOpen = false;
    this.root.style.display = 'none';
    this.stopBlink();
  }

  toggle(): void {
    if (this.isOpen) this.close(); else this.open();
  }

  private onState(): void {
    const key = JSON.stringify(this.rounds().map((r) => r.review));
    if (key === this.lastRounds) return;
    this.lastRounds = key;
    if (!this.isOpen) return;
    const latest = this.latest()?.review;
    if (this.followLatest && latest && latest !== this.path) void this.load(latest);
    else this.renderRounds();
  }

  private async load(path: string): Promise<void> {
    this.path = path;
    let d = this.cache.get(path);
    if (!d) {
      try {
        const r = await fetch(fileUrl(path));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        d = await r.json() as ReviewData;
        this.cache.set(path, d);
      } catch (e) {
        this.data = null;
        this.render(`Could not load this round (${(e as Error).message}).`);
        return;
      }
    }
    if (this.path !== path) return;
    this.data = d;
    if (!d.views.some((v) => v.view === this.view) && this.view !== 'hero') this.view = d.views[0]?.view ?? 'front';
    this.render();
  }

  private renderRounds(): void {
    clear(this.roundSel);
    const rounds = this.rounds();
    if (!rounds.length) this.roundSel.append(h('option', { value: '' }, 'no evaluation rounds yet'));
    for (const it of rounds) {
      this.roundSel.append(h('option', { value: it.review!, selected: it.review === this.path },
        `#${it.iter} · rev ${it.rev} · ${pct(it.score)}${it.note ? ` · ${it.note.slice(0, 60)}` : ''} · ${timeAgo(it.time)} ago`));
    }
  }

  private render(error?: string): void {
    this.stopBlink();
    this.renderRounds();
    for (const [id, b] of this.tabBtns) b.classList.toggle('on', id === this.tab);
    clear(this.body);
    if (this.tab === 'help') { this.body.append(this.help()); return; }
    if (this.tab === 'analysis') { this.body.append(this.analysis()); return; }
    if (error) { this.body.append(h('div', { class: 'empty' }, error)); return; }
    const d = this.data;
    if (!d) {
      this.body.append(h('div', { class: 'empty big' }, 'No evaluation rounds yet. Claude runs one after every build step; each one appears here with its pictures and scores.'));
      return;
    }
    if (this.tab === 'report') {
      this.body.append(h('div', { class: 'card' },
        h('h3', null, 'Report - exactly what Claude reads after this round'),
        h('pre', { class: 'report' }, d.report)));
      return;
    }
    this.body.append(this.compare(d));
  }

  // ------------------------------------------------------------------------------ compare

  private compare(d: ReviewData): HTMLElement {
    const left = h('div', { class: 'cmain' });
    const right = h('div', { class: 'cside' });

    // View tabs (with each view's score) and display modes.
    const viewTabs = h('div', { class: 'seg views' }, d.views.map((v) => h('button', {
      class: this.view === v.view ? 'on' : '', onclick: () => { this.view = v.view; this.render(); },
      title: `${v.label}: likeness ${pct(v.score)} (counts ${v.weight === 1 ? 'fully' : 'half'} in the total)`,
    }, v.label, h('span', { class: `sc ${scoreClass(v.score)}` }, pct(v.score)))),
    d.hero ? h('button', { class: this.view === 'hero' ? 'on' : '', onclick: () => { this.view = 'hero'; this.render(); }, title: 'The hero image next to the model from the same kind of angle' }, '3/4: hero vs model') : null);
    left.append(viewTabs);

    if (this.view === 'hero' && d.hero) {
      left.append(
        h('div', { class: 'legend' }, 'The picked hero image next to the model in a similar three-quarter view. Not scored (the hero is a perspective picture), but it is the best check of the overall look.'),
        h('div', { class: 'stage two' },
          this.figure(d.hero.hero, 'hero (reference)'), this.figure(d.hero.model, 'model 3/4')),
      );
    } else {
      const v = d.views.find((x) => x.view === this.view) ?? d.views[0];
      const modes = h('div', { class: 'seg modes' }, MODES.map((m) => h('button', { class: this.mode === m.id ? 'on' : '', onclick: () => { this.mode = m.id; this.render(); } }, m.label)));
      left.append(modes, this.legend(), this.stage(v), this.viewIssues(v));
    }

    right.append(this.scoreCard(d), this.partsCard(d), this.landmarksCard(d), this.checksCard(d));
    return h('div', { class: 'cmp' }, left, right);
  }

  private legend(): HTMLElement {
    if (this.mode === 'lines') {
      return h('div', { class: 'legend' },
        'Line map - edges inside both pictures: ',
        h('span', { class: 'sw', style: { background: '#e12d2d' } }), ' only in the reference (the model is missing it) ',
        h('span', { class: 'sw', style: { background: '#2d5fe6' } }), ' only in the model (an edge the reference does not have) ',
        h('span', { class: 'sw', style: { background: '#000' } }), ' in both (matches).');
    }
    return h('div', { class: 'legend' }, MODES.find((m) => m.id === this.mode)?.legend ?? '');
  }

  private figure(rel: string, caption: string): HTMLElement {
    return h('figure', null, h('img', { src: fileUrl(rel), alt: caption, title: 'click to enlarge', onclick: () => lightbox(fileUrl(rel), caption) }), h('figcaption', null, caption));
  }

  private stage(v: ReviewView): HTMLElement {
    const im = v.images;
    if (this.mode === 'all') {
      return h('div', { class: 'stage four' },
        this.figure(im.ref, 'reference'), this.figure(im.model, 'model'), this.figure(im.overlay, 'overlay'), this.figure(im.lines, 'lines'));
    }
    if (this.mode === 'blink') {
      const img = h('img', { src: fileUrl(im.ref), alt: 'blink' });
      const cap = h('figcaption', null, 'reference');
      let showRef = true;
      this.blink = window.setInterval(() => {
        showRef = !showRef;
        img.src = fileUrl(showRef ? im.ref : im.model);
        cap.textContent = showRef ? 'reference' : 'model';
      }, 550);
      return h('div', { class: 'stage one' }, h('figure', null, img, cap));
    }
    const rel = this.mode === 'ref' ? im.ref : this.mode === 'model' ? im.model : this.mode === 'overlay' ? im.overlay : im.lines;
    return h('div', { class: 'stage one' }, this.figure(rel, MODES.find((m) => m.id === this.mode)!.label.toLowerCase()));
  }

  private stopBlink(): void {
    if (this.blink !== null) { window.clearInterval(this.blink); this.blink = null; }
  }

  private viewIssues(v: ReviewView): HTMLElement {
    const sections: [string, string, string[]][] = [
      ['Missing lines', 'red in the line map: the reference has an edge here, the model does not (a height or band that is off, a plate not built yet)', v.issues.missingLines],
      ['Extra lines', 'blue in the line map: seams in the model the reference does not have', v.issues.extraLines],
      ['Missing details', 'small features in the reference with no small part at that spot', v.issues.details],
      ['Unmatched small parts', 'small parts of the model with no detail at that spot in the reference', v.issues.extraDetails],
      ['Color', 'areas where the reference reads as a different palette color than the model', v.issues.color],
      ['Outline', 'areas where the silhouettes differ: MISSING = reference has material there, EXTRA = model sticks out', v.issues.outline],
    ];
    return h('div', { class: 'issues' },
      h('h3', null, `What differs in the ${v.label.toLowerCase()} view`,
        h('span', { class: 'dim' }, ` - likeness ${pct(v.score)} · outline off by ${v.boundary.mean} studs on average`)),
      this.componentBars(v.components),
      sections.map(([title, what, items]) => this.list(title, what, items)));
  }

  private list(title: string, what: string, items: string[]): HTMLElement {
    const shown = items.slice(0, 8);
    return h('details', { class: 'ilist', open: items.length > 0 && items.length <= 8 ? true : undefined },
      h('summary', null, h('b', null, title), h('span', { class: `cnt ${items.length ? '' : 'zero'}` }, String(items.length)), h('span', { class: 'what' }, what)),
      items.length ? h('ul', null, shown.map((t) => h('li', null, t)), items.length > shown.length ? h('li', { class: 'dim' }, `... and ${items.length - shown.length} more`) : null) : h('div', { class: 'dim pad' }, 'none'));
  }

  private componentBars(c: LikenessParts, weights?: ReviewData['weights']): HTMLElement {
    return h('div', { class: 'bars' }, COMPONENTS.map((k) => {
      const x = c[k.key];
      return h('div', { class: 'brow', title: `${k.label}: ${k.what}` },
        h('span', { class: 'bl' }, k.label, weights ? h('span', { class: 'dim' }, ` ${pct(weights[k.weight])}`) : null),
        h('span', { class: 'bar' }, h('i', { class: x === null ? '' : scoreClass(x), style: { width: x === null ? '0' : pct(x) } })),
        h('span', { class: 'bv' }, x === null ? '-' : pct(x)));
    }));
  }

  private scoreCard(d: ReviewData): HTMLElement {
    return h('div', { class: 'card' },
      h('div', { class: 'big' }, h('span', { class: scoreClass(d.likeness) }, pct(d.likeness)), h('span', { class: 'dim' }, ' likeness')),
      h('div', { class: 'dim small' }, `round #${d.iter} at rev ${d.rev}${d.note ? ` - ${d.note}` : ''}`),
      this.componentBars(d.components, d.weights),
      h('div', { class: 'small views' }, 'per view: ', d.views.map((v) => h('a', { onclick: () => { this.view = v.view; this.render(); } }, `${v.label} ${pct(v.score)}${v.weight < 1 ? ' (counts half)' : ''}`))),
      h('div', { class: 'small sim' }, h('b', null, `Similarity: ${d.similarity.label}. `), d.similarity.guide),
      d.differences.length ? h('div', { class: 'small' }, h('b', null, 'Deliberate differences (not chased): '), d.differences.map((x) => x.what).join('; ')) : null,
      d.hints.length ? h('div', { class: 'hints' }, d.hints.map((x) => h('div', null, x))) : null);
  }

  private partsCard(d: ReviewData): HTMLElement {
    return h('div', { class: 'card' },
      h('h3', null, 'By body part', h('span', { class: 'dim' }, ' - worst first')),
      d.parts.length ? h('div', { class: 'bars' }, d.parts.map((p) => h('div', { class: 'brow', title: `outline ${pct(p.outline)} · lines ${pct(p.lines)} · color ${pct(p.color)}` },
        h('span', { class: 'bl' }, p.name),
        h('span', { class: 'bar' }, h('i', { class: scoreClass(p.score), style: { width: pct(p.score) } })),
        h('span', { class: 'bv' }, pct(p.score))))) : h('div', { class: 'dim' }, 'one group only'));
  }

  private landmarksCard(d: ReviewData): HTMLElement {
    if (!d.landmarks.length) return h('div');
    const icon = { OK: '✓', '~': '~', X: '✗', '?': '?' } as const;
    return h('div', { class: 'card' },
      h('h3', null, 'Landmarks', h('span', { class: 'dim' }, ' - key heights/widths from the plan')),
      h('table', { class: 'lm' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'name'), h('th', null, 'plan'), h('th', null, 'model'), h('th', null, 'ref'))),
        h('tbody', null, d.landmarks.map((l) => h('tr', { class: `m-${l.mark === '~' ? 'near' : l.mark === '?' ? 'na' : l.mark}`, title: `${l.view} view, ${l.axis} axis` },
          h('td', null, icon[l.mark]), h('td', null, l.name), h('td', null, `${l.axis} ${l.planned}`),
          h('td', null, l.model === null ? '-' : String(l.model)), h('td', null, l.reference === null ? '-' : String(l.reference)))))),
      h('div', { class: 'dim small' }, '✓ within 0.05 studs, ~ within 0.12, ✗ further. The model value is the nearest line the model has there.'));
  }

  private checksCard(d: ReviewData): HTMLElement {
    return h('div', { class: 'card' },
      h('h3', null, 'Checks'),
      d.checks.length
        ? h('ul', { class: 'checks' }, d.checks.map((c) => h('li', null, h('b', null, c.kind), ' ', c.message)))
        : h('div', { class: 'score-good' }, 'No z-fighting, symmetric, nothing floating.'));
  }

  // ------------------------------------------------------------------------------ analysis

  private analysis(): HTMLElement {
    const refs = this.store.state?.refs;
    const a = refs?.analysis;
    const out = h('div', null);
    out.append(h('div', { class: 'legend' },
      'Before building, the references are measured: ',
      h('span', { class: 'sw', style: { background: '#ff7a00' } }), ' H lines = heights where something starts or ends (chest, belt, knees), ',
      h('span', { class: 'sw', style: { background: '#0096d6' } }), ' V lines = widths, ',
      h('span', { class: 'sw', style: { background: '#11a33a' } }), ' S boxes = small details (eyes, rivets). The plan\'s landmarks come from these numbers (world studs).'));
    if (!a?.views.length) {
      out.append(h('div', { class: 'empty big' }, 'No analysis yet - it is made when Claude plans the build (plan_build analyze).'));
    } else {
      out.append(h('div', { class: 'dim small' }, `made ${timeAgo(a.time)} ago`));
      out.append(h('div', { class: 'agrid' }, a.views.map((v) => h('div', { class: 'card' },
        h('h3', null, v.label),
        h('img', { src: fileUrl(v.image), class: 'aimg', title: 'click to enlarge', onclick: () => lightbox(fileUrl(v.image), `${v.label}: lines and details`) }),
        this.list('Heights (H)', 'horizontal lines', v.heights),
        this.list('Widths (V)', 'vertical lines', v.widths),
        this.list('Details (S)', 'small features', v.details)))));
    }
    if (refs?.overlayUrl || refs?.report) {
      out.append(h('div', { class: 'card' },
        h('h3', null, 'How the references were cut out and scaled'),
        h('div', { class: 'dim small' }, 'Red outline = what was kept as the subject. Every view is scaled to the same studs, feet on y = 0, centred on x = 0; the report checks that the views agree with each other.'),
        refs.overlayUrl ? h('img', { src: refs.overlayUrl, class: 'wide', onclick: () => lightbox(refs.overlayUrl!, 'segmentation overlay') }) : null,
        refs.report ? h('pre', { class: 'report' }, refs.report) : null));
    }
    return out;
  }

  // ------------------------------------------------------------------------------ help

  private help(): HTMLElement {
    const step = (n: number, title: string, text: string) => h('div', { class: 'step' }, h('span', { class: 'n' }, String(n)), h('div', null, h('b', null, title), h('div', null, text)));
    return h('div', { class: 'help' },
      h('div', { class: 'card' },
        h('h3', null, 'How a model is made'),
        step(1, 'Hero', 'The image model draws three-quarter pictures of the idea; you pick one. It sets the design.'),
        step(2, 'Views', 'Front, side, back and top pictures of the same subject (Qwen camera angles on your GPU). These are the targets the model is measured against.'),
        step(3, 'Cut out and scale', 'Each view is cut out of its background, cleaned of the background tint and scaled to studs, all in one shared coordinate system.'),
        step(4, 'Analysis and plan', 'Lines (heights, widths) and small details are measured in the views; Claude writes a build plan with landmarks, bones and parts - built once on the right side and mirrored.'),
        step(5, 'Build', 'The plan becomes Roblox parts in one step; checks look for z-fighting, missing mirror twins and floating parts.'),
        step(6, 'Evaluate', 'The model is rendered from exactly the same cameras as the views and compared - that is every picture in "Model vs reference".'),
        step(7, 'Fix and repeat', 'Claude works through the lists (missing lines first, then details, colors, outline) and evaluates again until it stops improving, then shows you.')),
      h('div', { class: 'card' },
        h('h3', null, 'How the likeness score works'),
        h('div', null, 'Per view, four things are scored from 0 to 100%:'),
        h('ul', null, COMPONENTS.map((c) => h('li', null, h('b', null, c.label), ` - ${c.what}.`))),
        h('div', null, 'Outline and structure count 30% each, color 25%, details 15%. Front and side count fully, back and top half (the image model is least reliable there). A good build of an AI reference usually lands around 75-90%; your eye is the final judge.')),
      h('div', { class: 'card' },
        h('h3', null, 'Reading the pictures'),
        h('ul', null,
          h('li', null, h('b', null, 'Overlay'), ' - doubled edges mean the model is shifted or a different size there.'),
          h('li', null, h('b', null, 'Lines'), ' - red = an edge only the reference has (often a height that is off), blue = an edge only the model has, black = matching.'),
          h('li', null, h('b', null, 'Blink'), ' - watch what jumps: that is where the model and the reference disagree.'))));
  }
}
