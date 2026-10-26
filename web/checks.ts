// Checks & plan: the model checks (z-fighting, symmetry, floating, ...) after every change, and
// the build plan Claude wrote from the references. Clicking a check selects its parts.

import { clear, h } from './dom';
import type { Store } from './store';

const LABEL: Record<string, string> = {
  zfight: 'Z-fighting', asymmetric: 'Not symmetric', gap: 'Thin gap', loose: 'Barely attached', blunt: 'Blunt end', floating: 'Floating', disconnected: 'Disconnected', hidden: 'Hidden', ungrouped: 'No group',
};

export class Checks {
  private body: HTMLDivElement;
  private count: HTMLSpanElement;
  private lastKey = '';
  private planOpen = false;

  constructor(root: HTMLElement, private store: Store) {
    this.count = h('span', { class: 'count' });
    this.body = h('div', { class: 'pbody' });
    root.append(h('div', { class: 'phead' }, 'Checks & plan', this.count), this.body);
    store.on('state', () => this.render());
    this.render();
  }

  render(): void {
    const s = this.store.state;
    const key = JSON.stringify([s?.checks, s?.plan, this.planOpen]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    clear(this.body);
    if (!s) return;
    const checks = s.checks ?? [];
    this.count.textContent = checks.length ? `${checks.length} issue${checks.length > 1 ? 's' : ''}` : 'all clear';
    this.count.className = `count ${checks.length ? 'score-bad' : 'score-good'}`;
    if (checks.length) {
      this.body.append(h('div', { class: 'checks' }, checks.map((c) => h('div', {
        class: `check check-${c.kind} click`,
        title: 'click to select these parts',
        onclick: () => {
          const ids = s.scene.parts.filter((p) => c.parts.includes(p.name)).map((p) => p.id);
          if (ids.length) this.store.select(ids);
        },
      }, h('span', { class: 'kind' }, LABEL[c.kind] ?? c.kind), h('span', { class: 'msg' }, c.message)))));
    } else {
      this.body.append(h('div', { class: 'empty' }, 'No z-fighting, no thin gaps, symmetric, nothing floating.'));
    }
    if (s.plan) {
      this.body.append(h('div', { class: 'phead toggle' + (this.planOpen ? '' : ' collapsed'), onclick: () => { this.planOpen = !this.planOpen; this.lastKey = ''; this.render(); } }, 'Build plan'));
      if (this.planOpen) this.body.append(h('pre', { class: 'plan' }, s.plan));
    }
  }
}
