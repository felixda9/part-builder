// Client-side state: the last StateMessage from the server plus local UI state (selection,
// connection). Panels subscribe to events and re-render themselves.

import type { Command } from '../src/core/commands';
import type { ClientMessage, StateMessage } from '../src/core/protocol';
import type { Group, Part, SceneDoc } from '../src/core/scene';
import { partAABB, unionAABB } from '../src/core/shapes';
import type { Vec3 } from '../src/core/math';

export type Conn = 'connecting' | 'open' | 'closed';
export type StoreEvent = 'state' | 'selection' | 'status' | 'error' | 'look';

export class Store {
  state: StateMessage | null = null;
  /** Selected part ids. */
  selection: string[] = [];
  /** Group picked in the outliner (its parts are the selection). */
  group: string | null = null;
  conn: Conn = 'connecting';
  lastError: string | null = null;
  studs = true;
  /** Part names to select once they show up in a state message (after add / duplicate). */
  private pendingSelect: string[] | null = null;
  private listeners = new Map<StoreEvent, Set<() => void>>();

  send: (m: ClientMessage) => boolean = () => false;

  on(ev: StoreEvent, fn: () => void): void {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev)!.add(fn);
  }
  emit(ev: StoreEvent): void {
    for (const fn of this.listeners.get(ev) ?? []) {
      try { fn(); } catch (e) { console.error(`listener for ${ev} failed`, e); }
    }
  }

  get scene(): SceneDoc | null {
    return this.state?.scene ?? null;
  }
  part(id: string): Part | undefined {
    return this.state?.scene.parts.find((p) => p.id === id);
  }
  groupById(id: string | null | undefined): Group | undefined {
    return id ? this.state?.scene.groups.find((g) => g.id === id) : undefined;
  }
  selectedParts(): Part[] {
    const s = this.scene;
    if (!s) return [];
    const ids = new Set(this.selection);
    return s.parts.filter((p) => ids.has(p.id));
  }
  /** Source part for a linked-mirror part. */
  mirrorSource(p: Part): Part | undefined {
    return p.mirrorOf ? this.part(p.mirrorOf) : undefined;
  }

  setState(s: StateMessage): void {
    this.state = s;
    const ids = new Set(s.scene.parts.map((p) => p.id));
    const before = this.selection.join();
    this.selection = this.selection.filter((id) => ids.has(id));
    if (this.group && !s.scene.groups.some((g) => g.id === this.group)) this.group = null;
    if (this.pendingSelect) {
      const names = new Set(this.pendingSelect);
      const found = s.scene.parts.filter((p) => names.has(p.name)).map((p) => p.id);
      if (found.length) {
        this.selection = found;
        this.group = null;
        this.pendingSelect = null;
      }
    }
    // A group selection follows the group's current parts.
    if (this.group) this.selection = s.scene.parts.filter((p) => p.group === this.group).map((p) => p.id);
    this.emit('state');
    if (this.selection.join() !== before) this.emit('selection');
    this.emit('status');
  }

  select(ids: string[], group: string | null = null): void {
    this.selection = [...new Set(ids)];
    this.group = group;
    this.emit('selection');
  }
  toggle(id: string): void {
    const i = this.selection.indexOf(id);
    this.select(i >= 0 ? this.selection.filter((x) => x !== id) : [...this.selection, id]);
  }
  selectGroup(id: string): void {
    const s = this.scene;
    if (!s) return;
    this.select(s.parts.filter((p) => p.group === id).map((p) => p.id), id);
  }
  selectAfterApply(names: string[]): void {
    this.pendingSelect = names;
  }

  apply(ops: Command[], label: string): boolean {
    if (!ops.length) return false;
    return this.send({ type: 'apply', ops, label });
  }

  setConn(c: Conn): void {
    this.conn = c;
    this.emit('status');
  }
  setError(msg: string | null): void {
    this.lastError = msg;
    this.emit('status');
    if (msg) this.emit('error');
  }

  /** Centre of the selected parts' bounding box. */
  selectionCentre(parts = this.selectedParts()): Vec3 | null {
    const bb = unionAABB(parts.map(partAABB));
    if (!bb) return null;
    return [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
  }

  /** A unique part name: base, base2, base3... (or Block1, Block2 for generic bases). */
  uniqueName(base: string, taken: Set<string> = new Set()): string {
    const names = new Set([...(this.scene?.parts.map((p) => p.name) ?? []), ...taken]);
    const m = /^(.*?)(\d+)$/.exec(base);
    const stem = m ? m[1] : base;
    let n = m ? Number(m[2]) + 1 : ['Block', 'Wedge', 'CornerWedge'].includes(base) ? 1 : 2;
    if (!m && !names.has(base) && n === 2) return base;
    while (names.has(`${stem}${n}`)) n++;
    return `${stem}${n}`;
  }

  /** Selector for the current selection: "group:<name>" when a whole group is picked. */
  selector(): string | string[] {
    const g = this.groupById(this.group);
    if (g) return `group:${g.name}`;
    return this.selectedParts().map((p) => p.name);
  }
}

export const store = new Store();
