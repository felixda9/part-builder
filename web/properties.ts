// Properties panel: single part, multi-selection, or group. Every edit sends one command batch.

import { type Command, mirrorName } from '../src/core/commands';
import { type Vec3, toOrientation } from '../src/core/math';
import { FACES, MATERIALS, SHAPES, SURFACES, type Face, type Group, type Part, type Surface } from '../src/core/scene';
import { clear, fmtNum, h, put, toast } from './dom';
import type { Store } from './store';

type Ctl = HTMLInputElement | HTMLSelectElement;
interface Field {
  el: Ctl;
  get: () => string;
}

const MIXED = '__mixed__';
const FACE_LABEL: Record<Face, string> = { top: 'Top', bottom: 'Bottom', front: 'Front', back: 'Back', left: 'Left', right: 'Right' };

export class Properties {
  private body: HTMLDivElement;
  private title: HTMLSpanElement;
  private fields: Field[] = [];
  private key = '';

  constructor(root: HTMLElement, private store: Store) {
    this.title = h('span', null, 'Properties');
    this.body = h('div', { class: 'props' });
    root.append(h('div', { class: 'phead' }, this.title), this.body);
    store.on('state', () => this.refresh());
    store.on('selection', () => this.refresh());
    this.refresh();
  }

  // ------------------------------------------------------------------------------- render

  private structureKey(): string {
    const s = this.store.scene;
    if (!s) return 'none';
    const g = this.store.groupById(this.store.group);
    const parts = this.store.selectedParts();
    return JSON.stringify([
      this.store.selection, this.store.group,
      s.groups.map((x) => [x.id, x.name, x.mirrorOf, x.parent]),
      parts.map((p) => [p.mirrorOf, p.group]),
      g ? s.parts.filter((p) => p.group === g.id).map((p) => p.name) : null,
      s.palette,
    ]);
  }

  refresh(): void {
    const key = this.structureKey();
    if (key === this.key && this.fields.length) {
      // Same layout: update values in place so a focused input keeps its caret.
      for (const f of this.fields) if (f.el !== document.activeElement) f.el.value = f.get();
      return;
    }
    this.key = key;
    this.fields = [];
    clear(this.body);
    const s = this.store.scene;
    if (!s) {
      this.body.append(h('div', { class: 'empty' }, 'Waiting for the server…'));
      return;
    }
    const g = this.store.groupById(this.store.group);
    const parts = this.store.selectedParts();
    if (g) this.renderGroup(g, parts);
    else if (parts.length === 1) this.renderPart(parts[0]);
    else if (parts.length > 1) this.renderMulti(parts, `${parts.length} parts selected`);
    else this.renderScene();
    for (const f of this.fields) f.el.value = f.get();
  }

  private field(label: string, ctl: Node, title?: string): HTMLElement {
    return h('div', { class: 'field', title }, h('label', null, label), ctl);
  }

  private reg<T extends Ctl>(el: T, get: () => string): T {
    this.fields.push({ el, get });
    return el;
  }

  private text(get: () => string, set: (v: string) => void, disabled = false): HTMLInputElement {
    return this.reg(h('input', { type: 'text', disabled, spellcheck: 'false', onchange: (e: Event) => set((e.target as HTMLInputElement).value.trim()) }), get);
  }

  private select(options: [string, string][], get: () => string, set: (v: string) => void, disabled = false): HTMLSelectElement {
    const el = h('select', { disabled, onchange: (e: Event) => set((e.target as HTMLSelectElement).value) },
      options.map(([v, l]) => h('option', { value: v }, l)));
    return this.reg(el, get);
  }

  private vec(get: () => Vec3, set: (v: Vec3) => void, step: number, disabled = false): HTMLElement {
    const wrap = h('div', { class: 'vec' });
    (['x', 'y', 'z'] as const).forEach((ax, i) => {
      const input = h('input', {
        type: 'number', step: String(step), disabled,
        onchange: (e: Event) => {
          const raw = (e.target as HTMLInputElement).value;
          const v = Number(raw);
          if (raw.trim() === '' || !Number.isFinite(v)) {
            toast(`"${raw}" is not a number`, 'warn');
            (e.target as HTMLInputElement).value = fmtNum(get()[i], 4);
            return;
          }
          const cur = [...get()] as Vec3;
          if (cur[i] === v) return;
          cur[i] = v;
          set(cur);
        },
      });
      this.reg(input, () => fmtNum(get()[i], 4));
      wrap.append(h('div', { class: `ax ${ax}` }, input));
    });
    return wrap;
  }

  private color(get: () => string, set: (hex: string) => void, disabled = false): HTMLElement {
    const picker = this.reg(h('input', { type: 'color', disabled, onchange: (e: Event) => set((e.target as HTMLInputElement).value) }), () => get() || '#a3a2a5');
    const hex = this.text(get, (v) => {
      const x = v.startsWith('#') ? v : `#${v}`;
      if (!/^#[0-9a-fA-F]{6}$/.test(x)) {
        toast(`"${v}" is not a #RRGGBB color`, 'warn');
        hex.value = get();
        return;
      }
      set(x.toLowerCase());
    }, disabled);
    hex.placeholder = 'mixed';
    const row = h('div', { class: 'colorrow' }, picker, hex);
    const pal = this.store.scene?.palette ?? [];
    if (!pal.length || disabled) return row;
    return h('div', null, row, h('div', { class: 'palette', style: { marginTop: '4px' } },
      pal.map((c, i) => h('span', { class: 'sw', style: { background: c }, title: `p${i} ${c}`, onclick: () => set(c) }))));
  }

  private apply(ops: Command[], label: string): void {
    this.store.apply(ops, label);
  }

  // ------------------------------------------------------------------------------- single part

  private renderPart(part: Part): void {
    const id = part.id;
    const P = () => this.store.part(id) ?? part;
    const ro = !!part.mirrorOf;
    const snap = this.store.scene?.snap ?? 0.05;
    const upd = (set: Record<string, unknown>, what: string) =>
      this.apply([{ op: 'update', part: P().name, set } as Command], `edit ${P().name} ${what}`);
    this.title.textContent = 'Part';
    const b = this.body;
    if (ro) {
      const src = this.store.mirrorSource(part);
      b.append(h('div', { class: 'note' }, `Generated by a linked mirror of "${src?.name ?? '?'}". Read-only: edit the source part, or unlink the mirror group.`,
        src ? h('div', { style: { marginTop: '4px' } }, h('button', { class: 'btn', onclick: () => this.store.select([src.id]) }, `Select ${src.name}`)) : null));
    }
    b.append(
      this.field('Name', this.text(() => P().name, (v) => {
        if (!v) { toast('Name cannot be empty', 'warn'); this.refreshValues(); return; }
        if (v !== P().name) upd({ name: v }, 'name');
      }, ro)),
      this.field('Shape', this.select(SHAPES.map((s) => [s, s]), () => P().shape, (v) => upd({ shape: v }, 'shape'), ro)),
      this.field('Size', this.vec(() => P().size, (v) => upd({ size: v }, 'size'), snap, ro)),
      this.field('Position', this.vec(() => P().position, (v) => upd({ position: v }, 'position'), snap, ro)),
      this.field('Orientation', this.vec(() => toOrientation(P().rotation), (v) => upd({ orientation: v }, 'orientation'), 15, ro), 'Roblox Orientation in degrees (applied Y, X, Z)'),
      h('h3', null, 'Look'),
      this.field('Color', this.color(() => P().color, (c) => upd({ color: c }, 'color'), ro)),
      this.field('Material', this.select(MATERIALS.map((m) => [m, m]), () => P().material, (v) => upd({ material: v }, 'material'), ro)),
      this.field('Transparency', this.reg(h('input', {
        type: 'number', min: '0', max: '1', step: '0.05', disabled: ro,
        onchange: (e: Event) => {
          const v = Math.min(1, Math.max(0, Number((e.target as HTMLInputElement).value) || 0));
          upd({ transparency: v }, 'transparency');
        },
      }), () => fmtNum(P().transparency, 3))),
      this.surfacesBlock(() => [P()], (s, what) => upd({ surfaces: s }, what), ro, true),
      h('h3', null, 'Rig'),
      this.field('Group', this.groupSelect(() => P().group ?? '', (gid) => {
        const g = this.store.groupById(gid);
        upd({ group: g ? g.name : null }, 'group');
      }, ro)),
      h('div', { class: 'kv', style: { marginTop: '6px' } }, 'id ', h('b', null, part.id)),
    );
  }

  private refreshValues(): void {
    for (const f of this.fields) f.el.value = f.get();
  }

  /** Surfaces: one "all faces" select plus (for a single part) one per face. */
  private surfacesBlock(parts: () => Part[], send: (s: Surface | Partial<Record<Face, Surface>>, what: string) => void, ro: boolean, perFace: boolean): HTMLElement {
    const opts: [string, string][] = SURFACES.map((s) => [s, s]);
    const uniform = (faces: readonly Face[]) => {
      const vals = new Set(parts().flatMap((p) => faces.map((f) => p.surfaces[f])));
      return vals.size === 1 ? [...vals][0] : '';
    };
    const all = this.select([['', '— mixed —'], ...opts], () => uniform(FACES), (v) => { if (v) send(v as Surface, 'surfaces'); }, ro);
    const wrap = h('div', null, h('h3', null, 'Surfaces'), this.field('All faces', all));
    if (perFace) {
      wrap.append(h('div', { class: 'faces' }, FACES.map((f) =>
        this.field(FACE_LABEL[f], this.select(opts, () => parts()[0]?.surfaces[f] ?? 'Smooth', (v) => send({ [f]: v as Surface }, `${f} surface`), ro)))));
    }
    return wrap;
  }

  /** Group picker. Linked-mirror groups only appear when they are the current value (read-only views). */
  private groupSelect(get: () => string, set: (gid: string) => void, disabled: boolean, exclude?: string, mixed = false): HTMLSelectElement {
    const cur = get();
    const groups = (this.store.scene?.groups ?? []).filter((g) => g.id !== exclude && (!g.mirrorOf || g.id === cur));
    const opts: [string, string][] = [['', '(none)'], ...groups.map((g) => [g.id, g.mirrorOf ? `${g.name} (mirror)` : g.name] as [string, string])];
    if (mixed) opts.unshift([MIXED, '— mixed —']);
    return this.select(opts, get, (v) => { if (v !== MIXED) set(v); }, disabled);
  }

  // ------------------------------------------------------------------------------- multi

  private renderMulti(parts: Part[], title: string, heading = true): void {
    const ids = parts.map((p) => p.id);
    const P = () => ids.map((id) => this.store.part(id)).filter((p): p is Part => !!p);
    const editable = () => P().filter((p) => !p.mirrorOf).map((p) => p.name);
    const mirrors = parts.filter((p) => p.mirrorOf).length;
    const ro = mirrors === parts.length;
    const paint = (props: Record<string, unknown>, what: string) => {
      const names = editable();
      if (!names.length) return toast('Linked-mirror parts are read-only; edit their sources', 'warn');
      this.apply([{ op: 'paint', parts: names, ...props } as Command], `paint ${names.length} parts ${what}`);
    };
    const same = <T,>(f: (p: Part) => T): string => {
      const vals = new Set(P().map((p) => String(f(p))));
      return vals.size === 1 ? [...vals][0] : '';
    };
    if (heading) {
      this.title.textContent = 'Selection';
      this.body.append(h('h3', null, title));
    }
    if (mirrors) this.body.append(h('div', { class: 'note' }, `${mirrors} linked-mirror part${mirrors > 1 ? 's are' : ' is'} read-only and will be skipped.`));
    this.body.append(
      this.field('Color', this.color(() => same((p) => p.color), (c) => paint({ color: c }, 'color'), ro)),
      this.field('Material', this.select([['', '— mixed —'], ...MATERIALS.map((m) => [m, m] as [string, string])], () => same((p) => p.material), (v) => { if (v) paint({ material: v }, 'material'); }, ro)),
      this.surfacesBlock(P, (s, what) => paint({ surfaces: s }, what), ro, false),
    );
    if (heading) {
      this.body.append(
        h('h3', null, 'Rig'),
        this.field('Group', this.groupSelect(() => {
          const gs = new Set(P().map((p) => p.group ?? ''));
          return gs.size === 1 ? [...gs][0] : MIXED;
        }, (gid) => {
          const g = this.store.groupById(gid);
          const names = editable();
          this.apply(names.map((n) => ({ op: 'update', part: n, set: { group: g ? g.name : null } }) as Command), `group ${names.length} parts → ${g?.name ?? 'none'}`);
        }, ro, undefined, new Set(parts.map((p) => p.group ?? '')).size > 1)),
        h('div', { class: 'btns' },
          h('button', { class: 'btn danger', disabled: ro, onclick: () => {
            const names = editable();
            this.apply([{ op: 'delete', parts: names }], `delete ${names.length} parts`);
          } }, `Delete ${parts.length - mirrors} parts`)),
      );
    }
  }

  // ------------------------------------------------------------------------------- group

  private renderGroup(group: Group, parts: Part[]): void {
    const gid = group.id;
    const G = () => this.store.groupById(gid) ?? group;
    const s = this.store.scene!;
    const ro = !!group.mirrorOf;
    const src = ro ? s.groups.find((x) => x.id === group.mirrorOf) : undefined;
    const mirror = s.groups.find((x) => x.mirrorOf === gid);
    const snap = s.snap;
    const grp = (props: Record<string, unknown>, what: string) => this.apply([{ op: 'group', name: G().name, ...props } as Command], `group ${G().name} ${what}`);
    this.title.textContent = 'Group';
    const b = this.body;
    if (ro) b.append(h('div', { class: 'note' }, `Linked mirror of "${src?.name ?? '?'}" across X = 0. Its parts, pivot and main part are regenerated from the source after every edit.`));
    const inGroup = s.parts.filter((p) => p.group === gid);
    b.append(
      this.field('Name', this.text(() => G().name, (v) => {
        if (!v) { toast('Name cannot be empty', 'warn'); this.refreshValues(); return; }
        if (v !== G().name) grp({ rename: v }, 'rename');
      })),
      this.field('Parent', this.groupSelect(() => G().parent ?? '', (pid) => {
        const p = this.store.groupById(pid);
        grp({ parent: p ? p.name : null }, 'parent');
      }, ro, gid)),
      this.field('Pivot', this.vec(() => G().pivot, (v) => grp({ pivot: v }, 'pivot'), snap, ro), 'Joint position (Motor6D) for this bone'),
      this.field('Main part', this.select([['', '(none)'], ...inGroup.map((p) => [p.id, p.name] as [string, string])], () => G().mainPart ?? '', (pid) => {
        const p = this.store.part(pid);
        if (p) grp({ main: p.name }, 'main part');
      }, ro)),
      h('div', { class: 'kv', style: { margin: '4px 0' } }, h('b', null, String(inGroup.length)), ` part${inGroup.length === 1 ? '' : 's'}`,
        mirror ? [' · mirrored by ', h('b', null, mirror.name)] : null),
      h('div', { class: 'btns' },
        !ro && !mirror ? h('button', {
          class: 'btn primary', title: 'Create a linked mirror of this group across X = 0',
          onclick: () => {
            const name = mirrorName(G().name);
            this.apply([{ op: 'mirror_group', source: G().name, name }], `mirror ${G().name} → ${name}`);
          },
        }, `Create linked mirror (${mirrorName(group.name)})`) : null,
        ro ? h('button', { class: 'btn', title: 'Turn the mirrored parts into normal editable parts', onclick: () => this.apply([{ op: 'unlink', group: G().name }], `unlink ${G().name}`) }, 'Unlink mirror') : null,
        src ? h('button', { class: 'btn', onclick: () => this.store.selectGroup(src.id) }, `Select ${src.name}`) : null,
        h('button', { class: 'btn danger', title: 'Delete the group; its parts move to the parent group', onclick: () => this.apply([{ op: 'delete_group', name: G().name }], `delete group ${G().name}`) }, 'Delete group'),
      ),
    );
    if (parts.length && !ro) {
      b.append(h('h3', null, `Paint ${parts.length} parts`));
      this.renderMulti(parts, '', false);
    }
  }

  // ------------------------------------------------------------------------------- scene

  private renderScene(): void {
    const s = this.store.scene!;
    this.title.textContent = 'Scene';
    put(this.body,
      h('div', { class: 'kv' }, 'Name ', h('b', null, s.name)),
      h('div', { class: 'kv' }, 'Parts ', h('b', null, String(s.parts.length)), ' · groups ', h('b', null, String(s.groups.length)), ' · snap ', h('b', null, String(s.snap))),
      s.palette.length ? [h('h3', null, 'Palette'), h('div', { class: 'palette' }, s.palette.map((c, i) => h('span', { class: 'sw', style: { background: c }, title: `p${i} ${c}` })))] : null,
      h('div', { class: 'empty', style: { padding: '10px 0 0' } }, 'Click a part in the viewport or the outliner to edit it. Shift+click adds to the selection.'),
    );
  }
}
