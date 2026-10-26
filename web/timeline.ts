// Timeline: fit-loop iterations (if any) above the revision history. Clicking checks a rev out.

import { clear, h, timeAgo } from './dom';
import type { Store } from './store';

export class Timeline {
  private body: HTMLDivElement;
  private count: HTMLSpanElement;
  private lastKey = '';

  constructor(root: HTMLElement, private store: Store, private onReview?: (path: string) => void) {
    this.count = h('span', { class: 'count' });
    this.body = h('div', { class: 'pbody' });
    root.append(h('div', { class: 'phead' }, 'History', this.count), this.body);
    store.on('state', () => this.render());
    this.render();
  }

  private checkout(rev: number): void {
    if (rev === this.store.state?.rev) return;
    this.store.send({ type: 'checkout', rev });
  }

  render(): void {
    const s = this.store.state;
    const key = JSON.stringify([s?.rev, s?.revisions, s?.iterations]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    const scrollTop = this.body.scrollTop;
    clear(this.body);
    if (!s) return;
    this.count.textContent = `rev ${s.rev}`;

    if (s.iterations.length) {
      const views = [...new Set(s.iterations.flatMap((it) => Object.keys(it.perView)))];
      const cls = (v: number) => (v >= 0.9 ? 'score-good' : v >= 0.75 ? 'score-mid' : 'score-bad');
      const table = h('table', { class: 'iters' },
        h('thead', null, h('tr', null, h('th', null, 'iter'), h('th', null, 'rev'), h('th', null, 'score'), views.map((v) => h('th', { title: `${v} likeness` }, v === 'right' ? 'side' : v.slice(0, 5))), h('th', null, ''))),
        h('tbody', null, [...s.iterations].reverse().map((it) => h('tr', {
          class: `click${it.rev === s.rev ? ' cur' : ''}`,
          title: `${it.note ?? ''}${it.note ? '\n' : ''}click to check out rev ${it.rev}`,
          onclick: () => this.checkout(it.rev),
        },
          h('td', null, `#${it.iter}`),
          h('td', null, String(it.rev)),
          h('td', { class: cls(it.score) }, `${(it.score * 100).toFixed(1)}%`),
          views.map((v) => {
            const x = it.perView[v];
            return h('td', { class: x === undefined ? '' : cls(x) }, x === undefined ? '–' : x.toFixed(2));
          }),
          h('td', null, it.review && this.onReview ? h('button', {
            class: 'mini', title: 'open this round in Review (pictures, scores, fixes)',
            onclick: (e: MouseEvent) => { e.stopPropagation(); this.onReview!(it.review!); },
          }, '◎') : null),
        ))),
      );
      this.body.append(h('div', { class: 'iterwrap' }, table));
    }

    const revs = [...s.revisions].reverse();
    if (!revs.length) {
      this.body.append(h('div', { class: 'empty' }, 'No revisions yet.'));
      return;
    }
    this.body.append(h('div', { class: 'revs' }, revs.map((r) => h('div', {
      class: `row${r.current ? ' cur' : ''}`,
      title: `${r.label}\n${new Date(r.time).toLocaleString()} · ${r.parts} parts${r.current ? '' : '\nclick to check out'}`,
      onclick: () => this.checkout(r.rev),
    },
      h('span', { class: 'rev' }, `r${r.rev}`),
      h('span', { class: 'name' }, r.label || '(no label)'),
      h('span', { class: 'meta' }, `${r.parts}p · ${timeAgo(r.time)}`),
    ))));
    this.body.scrollTop = scrollTop;
  }
}
