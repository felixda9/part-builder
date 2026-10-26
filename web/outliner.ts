// Outliner: group tree (by parent) with parts under their groups, ungrouped parts at the end.

import type { Group, Part } from '../src/core/scene';
import { clear, h } from './dom';
import type { Store } from './store';

const SHAPE_ICON: Record<Part['shape'], string> = { Block: '■', Wedge: '◢', CornerWedge: '◣' };

export class Outliner {
  private body: HTMLDivElement;
  private count: HTMLSpanElement;
  private collapsed = new Set<string>();
  private rows = new Map<string, HTMLElement>();

  constructor(root: HTMLElement, private store: Store) {
    this.count = h('span', { class: 'count' });
    this.body = h('div', { class: 'pbody tree' });
    root.append(h('div', { class: 'phead' }, 'Outliner', this.count), this.body);
    store.on('state', () => this.render());
    store.on('selection', () => this.highlight(true));
    this.render();
  }

  render(): void {
    const s = this.store.scene;
    const scrollTop = this.body.scrollTop;
    clear(this.body);
    this.rows.clear();
    if (!s) {
      this.body.append(h('div', { class: 'empty' }, 'Waiting for the server…'));
      return;
    }
    this.count.textContent = `${s.parts.length} parts · ${s.groups.length} groups`;
    if (!s.parts.length && !s.groups.length) {
      this.body.append(h('div', { class: 'empty' }, 'Empty scene. Add a part from the toolbar, or let Claude build.'));
      return;
    }
    const ids = new Set(s.groups.map((g) => g.id));
    const kids = (pid: string | null) => s.groups.filter((g) => (pid === null ? !g.parent || !ids.has(g.parent) : g.parent === pid));
    const walk = (g: Group, depth: number, seen: Set<string>) => {
      if (seen.has(g.id)) return;
      seen.add(g.id);
      this.body.append(this.groupRow(g, depth));
      if (this.collapsed.has(g.id)) return;
      for (const p of s.parts.filter((q) => q.group === g.id)) this.body.append(this.partRow(p, depth + 1));
      for (const c of kids(g.id)) walk(c, depth + 1, seen);
    };
    const seen = new Set<string>();
    for (const g of kids(null)) walk(g, 0, seen);
    const loose = s.parts.filter((p) => !p.group || !ids.has(p.group));
    if (loose.length) {
      if (s.groups.length) this.body.append(h('div', { class: 'divider' }, 'Ungrouped'));
      for (const p of loose) this.body.append(this.partRow(p, 0));
    }
    this.highlight(false);
    this.body.scrollTop = scrollTop;
  }

  private groupRow(g: Group, depth: number): HTMLElement {
    const s = this.store.scene!;
    const src = g.mirrorOf ? s.groups.find((x) => x.id === g.mirrorOf) : undefined;
    const n = s.parts.filter((p) => p.group === g.id).length;
    const hasKids = n > 0 || s.groups.some((x) => x.parent === g.id);
    const row = h('div', {
      class: `row group${g.mirrorOf ? ' mirror' : ''}`,
      style: { paddingLeft: `${4 + depth * 12}px` },
      title: g.mirrorOf ? `Linked mirror of ${src?.name ?? '?'} (read-only, regenerated after every edit)` : `Group ${g.name}: click to select its parts`,
      onclick: () => this.store.selectGroup(g.id),
    },
      h('span', {
        class: 'caret',
        onclick: (e: Event) => {
          e.stopPropagation();
          if (this.collapsed.has(g.id)) this.collapsed.delete(g.id);
          else this.collapsed.add(g.id);
          this.render();
        },
      }, hasKids ? (this.collapsed.has(g.id) ? '▶' : '▼') : ''),
      h('span', { class: 'gico' }, '▣'),
      h('span', { class: 'name' }, g.name),
      g.mirrorOf ? h('span', { class: 'badge' }, `⇋ ${src?.name ?? ''}`) : null,
      h('span', { class: 'meta' }, String(n)),
    );
    this.rows.set(`g:${g.id}`, row);
    return row;
  }

  private partRow(p: Part, depth: number): HTMLElement {
    const src = p.mirrorOf ? this.store.part(p.mirrorOf) : undefined;
    const row = h('div', {
      class: `row part${p.mirrorOf ? ' mirror' : ''}`,
      style: { paddingLeft: `${16 + depth * 12}px` },
      title: p.mirrorOf ? `Linked mirror of ${src?.name ?? '?'}: edit the source part` : `${p.shape} ${p.size.join(' × ')}`,
      onclick: (e: MouseEvent) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey) this.store.toggle(p.id);
        else this.store.select([p.id]);
      },
    },
      h('span', { class: 'swatch', style: { background: p.color } }),
      h('span', { class: 'shape' }, SHAPE_ICON[p.shape]),
      h('span', { class: 'name' }, p.name),
      p.mirrorOf ? h('span', { class: 'badge', title: `mirror of ${src?.name ?? '?'}` }, '⇋') : null,
    );
    this.rows.set(`p:${p.id}`, row);
    return row;
  }

  private highlight(scroll: boolean): void {
    const sel = new Set(this.store.selection);
    let first: HTMLElement | null = null;
    for (const [key, row] of this.rows) {
      const isPart = key.startsWith('p:');
      const on = isPart ? sel.has(key.slice(2)) : this.store.group === key.slice(2);
      row.classList.toggle(isPart ? 'sel' : 'gsel', on);
      if (on && !first) first = row;
    }
    if (scroll && first) first.scrollIntoView({ block: 'nearest' });
  }
}
