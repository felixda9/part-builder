// Snapshot history. Scenes are small (a few hundred parts), so every revision stores the whole
// scene; undo/redo/checkout are just index moves.

import { type SceneDoc, clone } from './scene';

export interface Revision {
  rev: number;
  label: string;
  time: string;
  scene: SceneDoc;
}

export class History {
  revisions: Revision[] = [];
  index = -1;

  constructor(initial: SceneDoc, label = 'start') {
    this.push(initial, label);
  }

  get current(): SceneDoc {
    return this.revisions[this.index].scene;
  }
  get rev(): number {
    return this.revisions[this.index].rev;
  }
  get canUndo(): boolean {
    return this.index > 0;
  }
  get canRedo(): boolean {
    return this.index < this.revisions.length - 1;
  }

  push(scene: SceneDoc, label: string): Revision {
    this.revisions = this.revisions.slice(0, this.index + 1);
    const prev = this.revisions[this.revisions.length - 1];
    const r: Revision = { rev: prev ? prev.rev + 1 : 0, label, time: new Date().toISOString(), scene: clone(scene) };
    this.revisions.push(r);
    this.index = this.revisions.length - 1;
    return r;
  }

  undo(): boolean {
    if (!this.canUndo) return false;
    this.index--;
    return true;
  }
  redo(): boolean {
    if (!this.canRedo) return false;
    this.index++;
    return true;
  }
  /** Jump to a revision; later edits branch from there (redo list is dropped on the next push). */
  checkout(rev: number): boolean {
    const i = this.revisions.findIndex((r) => r.rev === rev);
    if (i < 0) return false;
    this.index = i;
    return true;
  }

  list(): { rev: number; label: string; time: string; parts: number; current: boolean }[] {
    return this.revisions.map((r, i) => ({ rev: r.rev, label: r.label, time: r.time, parts: r.scene.parts.length, current: i === this.index }));
  }
}
