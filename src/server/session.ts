// The open project: metadata, scene history and on-disk persistence. One Session per server;
// the MCP tools and the editor (over WebSocket) both act on it, so they share undo history.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { type Command, applyBatch } from '../core/commands';
import { History } from '../core/history';
import { type Lint, lintScene } from '../core/lints';
import { type ClientMessage, type IterationRecord, type RefsState, type Similarity, DEFAULT_SIMILARITY, SIMILARITY_LEVELS, emptyRefs } from '../core/protocol';
import { type SceneDoc, emptyScene, parseScene } from '../core/scene';
import { PROJECTS_DIR, RUNTIME_DIR } from './paths';
import { DEFAULT_STYLE_NAME } from './styles';
import { type BodyPlan, guessBody } from './body';

const LAST_PROJECT = path.join(RUNTIME_DIR, 'last-project.txt');

export interface ProjectMeta {
  name: string;
  idea: string;
  style: string;
  heightStuds: number;
  symmetric: boolean;
  /** How close the build stays to the references (missing in older projects = balanced). */
  similarity?: Similarity;
  /** What kind of body the subject has (pose in prompts, default bones); missing = guessed from the idea. */
  body?: BodyPlan;
  stage: 'new' | 'hero' | 'views' | 'building' | 'done';
  created: string;
  currentRev: number;
  checkpoints: { hero: string | null; viewsApproved: boolean };
}

export interface ApplyOutcome {
  rev: number;
  created: string[];
  updated: string[];
  deleted: string[];
  lints: Lint[];
}

const safeName = (n: string) => {
  const s = n.trim().replace(/[^A-Za-z0-9_\- ]/g, '').replace(/\s+/g, '_');
  if (!s) throw new Error('project name must contain letters or digits');
  return s;
};

export class Session extends EventEmitter {
  meta!: ProjectMeta;
  dir!: string;
  history!: History;
  refs: RefsState = emptyRefs();
  /** Evaluation rounds on the current history branch. */
  iterations: IterationRecord[] = [];
  /** Every round ever logged, including ones on abandoned branches. */
  private iterLog: IterationRecord[] = [];
  /** A long job in progress (shown in the editor), or null. Not saved. */
  busy: string | null = null;

  constructor() {
    super();
    // Reopen the last project, so a server restart (MCP reconnect) doesn't leave the editor on
    // an empty scratch project.
    let last = 'scratch';
    try {
      const n = fs.readFileSync(LAST_PROJECT, 'utf8').trim();
      if (n && fs.existsSync(path.join(PROJECTS_DIR, n, 'project.json'))) last = n;
    } catch { /* first run */ }
    this.open(last, {});
  }

  get scene(): SceneDoc {
    return this.history.current;
  }

  static list(): string[] {
    if (!fs.existsSync(PROJECTS_DIR)) return [];
    return fs.readdirSync(PROJECTS_DIR).filter((d) => fs.existsSync(path.join(PROJECTS_DIR, d, 'project.json')));
  }

  setBusy(what: string | null): void {
    this.busy = what;
    this.emit('change');
  }

  get body(): BodyPlan {
    return this.meta.body ?? guessBody(this.meta.idea);
  }

  get similarity(): Similarity {
    return this.meta.similarity ?? DEFAULT_SIMILARITY;
  }

  open(name: string, opts: Partial<Pick<ProjectMeta, 'idea' | 'style' | 'heightStuds' | 'symmetric' | 'similarity' | 'body'>>): { created: boolean } {
    const id = safeName(name);
    const dir = path.join(PROJECTS_DIR, id);
    const metaPath = path.join(dir, 'project.json');
    let created = false;
    if (fs.existsSync(metaPath)) {
      this.meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      Object.assign(this.meta, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)));
    } else {
      created = true;
      this.meta = {
        name: id, idea: opts.idea ?? '', style: opts.style ?? DEFAULT_STYLE_NAME, heightStuds: opts.heightStuds ?? 5,
        symmetric: opts.symmetric ?? true, similarity: opts.similarity ?? DEFAULT_SIMILARITY, ...(opts.body ? { body: opts.body } : {}), stage: 'new', created: new Date().toISOString(), currentRev: 0,
        checkpoints: { hero: null, viewsApproved: false },
      };
    }
    this.dir = dir;
    for (const sub of ['refs', 'parts', 'history', 'renders', 'exports']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    this.loadHistory();
    const refsPath = path.join(dir, 'refs', 'refs.json');
    this.refs = fs.existsSync(refsPath) ? { ...emptyRefs(), ...JSON.parse(fs.readFileSync(refsPath, 'utf8')) } : emptyRefs();
    const itPath = path.join(dir, 'iterations.jsonl');
    this.iterLog = fs.existsSync(itPath)
      ? fs.readFileSync(itPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    this.iterations = this.iterLog.filter((it) => !it.discarded);
    this.saveMeta();
    // Test scripts set PART_BUILDER_NO_REMEMBER=1 so their throwaway projects aren't reopened.
    if (process.env.PART_BUILDER_NO_REMEMBER !== '1') {
      try {
        fs.mkdirSync(path.dirname(LAST_PROJECT), { recursive: true });
        fs.writeFileSync(LAST_PROJECT, id);
      } catch { /* not important */ }
    }
    this.emit('project');
    this.emit('change');
    return { created };
  }

  private loadHistory(): void {
    const hdir = path.join(this.dir, 'history');
    const files = fs.readdirSync(hdir).filter((f) => /^r\d+\.json$/.test(f)).sort();
    if (!files.length) {
      const modelPath = path.join(this.dir, 'model.json');
      const scene = fs.existsSync(modelPath) ? parseScene(JSON.parse(fs.readFileSync(modelPath, 'utf8'))) : emptyScene(this.meta.name);
      this.history = new History(scene, 'start');
      this.persistRevision();
      return;
    }
    const revs = files.slice(-300).map((f) => JSON.parse(fs.readFileSync(path.join(hdir, f), 'utf8')));
    this.history = new History(parseScene(revs[0].scene), revs[0].label);
    this.history.revisions[0].rev = revs[0].rev;
    this.history.revisions[0].time = revs[0].time;
    for (const r of revs.slice(1)) {
      const rec = this.history.push(parseScene(r.scene), r.label);
      rec.rev = r.rev;
      rec.time = r.time;
    }
    this.history.checkout(this.meta.currentRev) || this.history.checkout(revs[revs.length - 1].rev);
  }

  private persistRevision(): void {
    const r = this.history.revisions[this.history.index];
    fs.writeFileSync(path.join(this.dir, 'history', `r${String(r.rev).padStart(5, '0')}.json`), JSON.stringify(r));
    this.saveScene();
  }

  private saveScene(): void {
    fs.writeFileSync(path.join(this.dir, 'model.json'), JSON.stringify(this.scene, null, 1));
    this.meta.currentRev = this.history.rev;
    this.saveMeta();
  }

  saveMeta(): void {
    fs.writeFileSync(path.join(this.dir, 'project.json'), JSON.stringify(this.meta, null, 2));
  }

  apply(commands: Command[], label?: string): ApplyOutcome {
    const res = applyBatch(this.scene, commands);
    // History branches from the current revision: drop the redo tail on disk too, and retire the
    // evaluation rounds that belonged to it (their revision numbers are about to be reused).
    const dropped = new Set(this.history.revisions.slice(this.history.index + 1).map((r) => r.rev));
    for (const rev of dropped) {
      fs.rmSync(path.join(this.dir, 'history', `r${String(rev).padStart(5, '0')}.json`), { force: true });
    }
    if (this.iterLog.some((it) => !it.discarded && dropped.has(it.rev))) {
      for (const it of this.iterLog) if (dropped.has(it.rev)) it.discarded = true;
      fs.writeFileSync(path.join(this.dir, 'iterations.jsonl'), this.iterLog.map((it) => JSON.stringify(it)).join('\n') + '\n');
      this.iterations = this.iterLog.filter((it) => !it.discarded);
    }
    this.history.push(res.scene, label ?? commands.map((c) => c.op).slice(0, 4).join('+'));
    this.persistRevision();
    this.emit('change');
    return { rev: this.history.rev, created: res.created, updated: res.updated, deleted: res.deleted, lints: this.lints() };
  }

  undo(): boolean {
    const ok = this.history.undo();
    if (ok) { this.saveScene(); this.emit('change'); }
    return ok;
  }
  redo(): boolean {
    const ok = this.history.redo();
    if (ok) { this.saveScene(); this.emit('change'); }
    return ok;
  }
  checkout(rev: number): boolean {
    const ok = this.history.checkout(rev);
    if (ok) { this.saveScene(); this.emit('change'); }
    return ok;
  }

  path(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  /** Model checks: floating / disconnected / z-fighting / hidden / ungrouped, plus symmetry for symmetric projects. */
  lints(): Lint[] {
    // Animals and creatures get the blunt-end check (flat box ends read as cut off); objects and
    // humanoids (armor, robots) are allowed to be boxy.
    return lintScene(this.scene, { symmetric: this.meta.symmetric, organic: !['object', 'humanoid'].includes(this.body) });
  }

  /** URL under which the editor server serves a file inside the project folder. */
  url(absPath: string): string {
    const rel = path.relative(this.dir, absPath).split(path.sep).join('/');
    let v = 0;
    try { v = Math.round(fs.statSync(absPath).mtimeMs); } catch { /* missing file */ }
    return `/files/${rel.split('/').map(encodeURIComponent).join('/')}?v=${v}`;
  }

  saveRefs(): void {
    fs.writeFileSync(path.join(this.dir, 'refs', 'refs.json'), JSON.stringify(this.refs, null, 2));
    this.emit('change');
  }

  addIteration(rec: Omit<IterationRecord, 'iter' | 'time'>): IterationRecord {
    const full: IterationRecord = { ...rec, iter: this.iterLog.reduce((m, it) => Math.max(m, it.iter), 0) + 1, time: new Date().toISOString() };
    this.iterLog.push(full);
    this.iterations.push(full);
    fs.appendFileSync(path.join(this.dir, 'iterations.jsonl'), JSON.stringify(full) + '\n');
    this.emit('change');
    return full;
  }

  /** Checkpoint actions from the editor's reference panel. */
  handleUi(m: Extract<ClientMessage, { type: 'ui' }>): void {
    if (m.action === 'pick_hero') {
      if (!this.refs.hero.candidates.some((c) => c.id === m.id)) throw new Error(`no hero candidate "${m.id}"`);
      this.refs.hero.picked = m.id;
      this.meta.checkpoints.hero = m.id;
      this.meta.stage = 'views';
    } else if (m.action === 'approve_views') {
      if (!Object.keys(this.refs.views).length) throw new Error('no views to approve yet');
      this.refs.viewsApproved = true;
      this.meta.checkpoints.viewsApproved = true;
      this.meta.stage = 'building';
    } else if (m.action === 'feedback') {
      this.refs.feedback.push({ view: m.view, text: m.text, time: new Date().toISOString() });
    } else if (m.action === 'set_similarity') {
      const lvl = SIMILARITY_LEVELS.find((l) => l.id === m.level);
      if (!lvl) throw new Error(`unknown similarity level "${m.level}"`);
      this.meta.similarity = lvl.id;
      // Also a note, so Claude sees the change in project_open / the notes list.
      this.refs.feedback.push({ text: `similarity set to ${lvl.label}: ${lvl.blurb}`, time: new Date().toISOString() });
    }
    this.saveMeta();
    this.saveRefs();
    this.emit('notice', { message: `checkpoint: ${m.action}`, level: 'info' });
  }
}
