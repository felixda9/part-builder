// References panel: similarity level, hero candidates, normalized views (with flags + per-view
// feedback), approval, consistency report, overlay, palette, per-part close-ups and a note box.
//
// The panel is split into sections that re-render only when their own data changes, so typing
// in a feedback box is never interrupted by unrelated updates (e.g. the feedback list growing).

import { DEFAULT_SIMILARITY, SHOWN_VIEWS, SIMILARITY_LEVELS, type RefImage, type RefsState, type Similarity, viewLabel } from '../src/core/protocol';
import { clear, h, lightbox, put, timeAgo, toast } from './dom';
import type { Store } from './store';

type Built = Node | null | (Node | null)[];

interface Section {
  el: HTMLDivElement;
  sig: (r: RefsState) => unknown;
  build: (r: RefsState) => Built;
  last: string | null;
  waiting: boolean;
}

export class RefsPanel {
  private body: HTMLDivElement;
  private head: HTMLDivElement;
  private badge: HTMLSpanElement;
  private simSelect: HTMLSelectElement;
  private simBlurb: HTMLDivElement;
  private collapsed = false;
  private sections: Section[] = [];
  /** Unsent text per feedback box. */
  private drafts = new Map<string, string>();

  constructor(root: HTMLElement, private store: Store) {
    this.badge = h('span', { class: 'count' });
    this.head = h('div', { class: 'phead toggle', onclick: () => this.toggle() }, 'References', this.badge);
    this.body = h('div', { class: 'refs' });
    root.append(this.head, this.body);

    // Similarity: how close Claude's build stays to these references.
    this.simSelect = h('select', {
      title: 'How close the build stays to the references',
      onchange: () => {
        const level = this.simSelect.value as Similarity;
        if (this.store.send({ type: 'ui', action: 'set_similarity', level })) toast(`Similarity set to ${this.simSelect.selectedOptions[0]?.text ?? level} - Claude sees it on the next step`, 'ok');
      },
    }, SIMILARITY_LEVELS.map((l) => h('option', { value: l.id }, l.label)));
    this.simBlurb = h('div', { class: 'simblurb' });
    this.body.append(h('div', { class: 'similarity' }, h('h3', null, 'Similarity to the references'), h('div', { class: 'simrow' }, this.simSelect, this.simBlurb)));
    try { this.collapsed = localStorage.getItem('mb.refs.collapsed') === '1'; } catch { /* ignore */ }
    this.applyCollapsed();

    const sec = (sig: Section['sig'], build: Section['build']) => {
      const s: Section = { el: h('div'), sig, build, last: null, waiting: false };
      this.sections.push(s);
      this.body.append(s.el);
    };
    sec((r) => isEmpty(r), (r) => (isEmpty(r) ? h('div', { class: 'empty', style: { padding: '4px 0 8px' } }, 'No reference images yet. Claude generates them during the reference stage.') : null));
    sec((r) => [r.hero, this.store.state?.busy ?? null], (r) => this.hero(r));
    sec((r) => [r.views, r.viewsApproved], (r) => this.views(r));
    sec((r) => r.sheet, (r) => (r.sheet ? [h('h3', null, 'Sheet'), this.wide(r.sheet.url, r.sheet.label ?? 'reference sheet')] : null));
    sec((r) => r.report, (r) => (r.report ? [h('h3', null, 'Consistency report'), h('pre', { class: 'report' }, r.report)] : null));
    sec((r) => r.overlayUrl, (r) => (r.overlayUrl ? [h('h3', null, 'Segmentation overlay'), this.wide(r.overlayUrl, 'segmentation overlay')] : null));
    sec((r) => r.palette, (r) => this.palette(r));
    sec((r) => r.parts, (r) => this.partRefs(r));
    sec(() => 'static', () => this.note());
    sec((r) => r.feedback.slice(-5), (r) => this.feedList(r));

    store.on('state', () => this.render());
    this.render();
  }

  private toggle(): void {
    this.collapsed = !this.collapsed;
    try { localStorage.setItem('mb.refs.collapsed', this.collapsed ? '1' : '0'); } catch { /* ignore */ }
    this.applyCollapsed();
  }

  private applyCollapsed(): void {
    this.head.classList.toggle('collapsed', this.collapsed);
    this.body.style.display = this.collapsed ? 'none' : '';
  }

  render(): void {
    const refs = this.store.state?.refs;
    if (!refs) return;
    const sim = this.store.state?.project.similarity ?? DEFAULT_SIMILARITY;
    if (document.activeElement !== this.simSelect) this.simSelect.value = sim;
    this.simBlurb.textContent = SIMILARITY_LEVELS.find((l) => l.id === sim)?.blurb ?? '';
    const nViews = Object.keys(refs.views).length;
    this.badge.textContent = refs.viewsApproved ? '· views approved' : nViews ? `· ${nViews} views` : refs.hero.candidates.length ? `· ${refs.hero.candidates.length} hero` : '';
    for (const s of this.sections) this.renderSection(s, refs);
  }

  private renderSection(s: Section, refs: RefsState): void {
    const sig = JSON.stringify(s.sig(refs) ?? null);
    if (sig === s.last) return;
    if (editingIn(s.el)) {
      // Don't yank a text box out from under the cursor: wait until focus leaves this section.
      if (s.waiting) return;
      s.waiting = true;
      const onOut = () => setTimeout(() => {
        if (editingIn(s.el)) return;
        document.removeEventListener('focusout', onOut, true);
        s.waiting = false;
        const r = this.store.state?.refs;
        if (r) this.renderSection(s, r);
      }, 0);
      document.addEventListener('focusout', onOut, true);
      return;
    }
    s.last = sig;
    clear(s.el);
    put(s.el, s.build(refs));
  }

  private wide(url: string, caption: string): HTMLElement {
    return h('div', { class: 'wide' }, h('img', { src: url, alt: caption, loading: 'lazy', onclick: () => lightbox(url, caption) }));
  }

  private thumbImg(img: { url: string }, caption: string): HTMLImageElement {
    return h('img', { src: img.url, alt: caption, loading: 'lazy', onclick: () => lightbox(img.url, caption) });
  }

  private hero(refs: RefsState): Built {
    const c = refs.hero.candidates;
    const busy = this.store.state?.busy ?? null;
    if (!c.length) return busy ? [h('h3', null, 'Hero'), h('div', { class: 'busy' }, h('span', { class: 'spinner' }), busy)] : null;
    // Remake all: none of the candidates is right -> new ones (old images are archived).
    const note = this.draftInput('input', 'remake', { type: 'text', placeholder: 'what should be different? (optional)' }, (text) => {
      if (!confirm('Replace all hero candidates with new ones?')) return false;
      const ok = this.store.send({ type: 'ui', action: 'remake_heroes', note: text });
      if (ok) toast('Making new hero candidates…', 'ok');
      return ok;
    }, true);
    return [
      h('h3', null, 'Hero', refs.hero.picked ? h('span', { class: 'badge-ok' }, 'picked') : h('span', { class: 'badge-no' }, 'pick one')),
      h('div', { class: 'thumbs' }, c.map((img: RefImage) => {
        const picked = refs.hero.picked === img.id;
        return h('div', { class: `thumb${picked ? ' picked' : ''}` },
          picked ? h('span', { class: 'tag' }, 'PICKED') : null,
          this.thumbImg(img, img.label ?? img.id),
          h('div', { class: 'cap' }, h('span', { class: 'grow', title: img.label ?? img.id }, img.label ?? img.id),
            picked ? null : h('button', { class: 'mini', disabled: !!busy, onclick: () => this.store.send({ type: 'ui', action: 'pick_hero', id: img.id }) }, 'Pick')),
        );
      })),
      busy
        ? h('div', { class: 'busy' }, h('span', { class: 'spinner' }), busy)
        : h('div', { class: 'fb remake' }, note.el, h('button', {
          class: 'btn', title: 'Replace all candidates with new ones (the old images are kept in refs/archive)',
          onclick: note.submit,
        }, '↻ Remake all')),
    ];
  }

  /** A text box whose unsent text survives re-renders. */
  private draftInput<K extends 'input' | 'textarea'>(tag: K, key: string, attrs: Record<string, unknown>, send: (text: string) => boolean, allowEmpty = false): { el: HTMLElementTagNameMap[K]; submit: () => void } {
    const el = h(tag, {
      ...attrs,
      value: this.drafts.get(key) ?? '',
      oninput: () => this.drafts.set(key, (el as HTMLInputElement).value),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' && (tag === 'input' || e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          submit();
        }
      },
    });
    const submit = () => {
      const text = (el as HTMLInputElement).value.trim();
      if (!text && !allowEmpty) return;
      if (send(text)) {
        this.drafts.delete(key);
        (el as HTMLInputElement).value = '';
      }
    };
    return { el, submit };
  }

  private views(refs: RefsState): Built {
    const present = SHOWN_VIEWS.filter((v) => refs.views[v]);
    if (!present.length) return null;
    return [
      h('h3', null, 'Views', refs.viewsApproved ? h('span', { class: 'badge-ok' }, '✓ approved') : h('span', { class: 'badge-no' }, 'not approved')),
      h('div', { class: 'thumbs views' }, present.map((v) => {
        const rv = refs.views[v]!;
        const name = viewLabel(v);
        const fb = this.draftInput('input', `view:${v}`, { type: 'text', placeholder: `feedback on ${name}…` }, (text) => {
          const ok = this.store.send({ type: 'ui', action: 'feedback', view: name, text });
          if (ok) toast(`Feedback on ${name} sent to Claude`, 'ok');
          return ok;
        });
        return h('div', { class: `thumb${rv.flag ? ' flagged' : ''}` },
          this.thumbImg(rv, `${name}${rv.flag ? ` — ${rv.flag}` : ''}`),
          h('div', { class: 'cap' }, h('span', { class: 'grow' }, name),
            rv.rawUrl ? h('button', { class: 'mini', title: 'as generated', onclick: () => lightbox(rv.rawUrl!, `${name} (raw)`) }, 'raw') : null,
            rv.maskUrl ? h('button', { class: 'mini', title: 'silhouette mask', onclick: () => lightbox(rv.maskUrl!, `${name} (mask)`) }, 'mask') : null),
          rv.flag ? h('div', { class: 'flag' }, '⚠ ', rv.flag) : null,
          h('div', { class: 'fb' }, fb.el, h('button', { class: 'mini', onclick: fb.submit }, 'Send')),
        );
      })),
      h('div', { class: 'btns' },
        h('button', {
          class: `btn${refs.viewsApproved ? '' : ' primary'}`, disabled: refs.viewsApproved,
          onclick: () => this.store.send({ type: 'ui', action: 'approve_views' }),
        }, refs.viewsApproved ? '✓ Views approved' : 'Approve views')),
    ];
  }

  private palette(refs: RefsState): Built {
    if (!refs.palette.length) return null;
    return [h('h3', null, 'Palette'), h('div', { class: 'palette' }, refs.palette.map((c) => h('span', {
      class: 'sw', style: { background: c }, title: `${c} (click to copy)`,
      onclick: () => { void navigator.clipboard?.writeText(c).then(() => toast(`Copied ${c}`, 'ok', 1500), () => {}); },
    })))];
  }

  private partRefs(refs: RefsState): Built {
    const entries = Object.entries(refs.parts).filter(([, imgs]) => imgs.length);
    if (!entries.length) return null;
    const box = h('div', { class: 'partrefs' });
    for (const [name, imgs] of entries) {
      box.append(h('div', { class: 'pname' }, name), h('div', { class: 'thumbs' }, imgs.map((img) =>
        h('div', { class: `thumb${img.flag ? ' flagged' : ''}` },
          this.thumbImg(img, `${name}: ${img.label ?? img.id}${img.flag ? ` — ${img.flag}` : ''}`),
          img.label ? h('div', { class: 'cap' }, h('span', { class: 'grow' }, img.label)) : null,
          img.flag ? h('div', { class: 'flag' }, '⚠ ', img.flag) : null))));
    }
    return [h('h3', null, 'Part close-ups', h('span', { class: 'badge-no' }, 'detail only, not scored')), box];
  }

  private note(): Built {
    const note = this.draftInput('textarea', 'note', { placeholder: 'Anything Claude should know or change… (Ctrl+Enter sends)', rows: '3' }, (text) => {
      const ok = this.store.send({ type: 'ui', action: 'feedback', text });
      if (ok) toast('Note sent to Claude', 'ok');
      return ok;
    });
    return [
      h('h3', null, 'Note to Claude'),
      note.el,
      h('div', { class: 'btns' }, h('button', { class: 'btn primary', title: 'Ctrl+Enter', onclick: note.submit }, 'Send note')),
    ];
  }

  private feedList(refs: RefsState): Built {
    const recent = refs.feedback.slice(-5).reverse();
    if (!recent.length) return null;
    return h('ul', { class: 'feedlist' }, recent.map((f) => h('li', null, h('b', null, f.view ?? 'note'), ` · ${timeAgo(f.time)} ago — `, f.text)));
  }
}

function isEmpty(r: RefsState): boolean {
  return !r.hero.candidates.length && !Object.keys(r.views).length && !r.sheet && !r.report && !r.overlayUrl && !r.palette.length && !Object.keys(r.parts).length;
}

function editingIn(el: HTMLElement): boolean {
  const a = document.activeElement as HTMLElement | null;
  return !!a && el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
}
