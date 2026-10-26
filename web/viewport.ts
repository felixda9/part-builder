// 3D viewport: parts, grid, cameras (perspective + ortho presets), selection, transform gizmo
// and the reference-image backdrop for ortho views.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Command } from '../src/core/commands';
import { type Vec3, round } from '../src/core/math';
import type { RefView } from '../src/core/protocol';
import { type OrthoView, VIEW_BASIS } from '../src/core/raster';
import { partAABB, unionAABB } from '../src/core/shapes';
import { fmtNum, h } from './dom';
import { type PartMeshes, type PartObject, disposePart, partMatrix } from './meshes';
import type { Store } from './store';

export type ViewName = 'front' | 'back' | 'right' | 'left' | 'top' | 'threequarter';
/** How the project's image-to-3D AI model is shown: hidden, next to the part model, or alone. */
export type AiMode = 'off' | 'beside' | 'only';
export const VIEWS: { id: ViewName; label: string; key: string }[] = [
  { id: 'front', label: 'Front', key: '1' },
  { id: 'back', label: 'Back', key: '2' },
  { id: 'right', label: 'Right', key: '3' },
  { id: 'left', label: 'Left', key: '4' },
  { id: 'top', label: 'Top', key: '5' },
  { id: 'threequarter', label: '3/4', key: '6' },
];
type OrthoName = Exclude<ViewName, 'threequarter'>;
const isOrtho = (v: ViewName | null): v is OrthoName => !!v && v !== 'threequarter';

const v3 = (a: Vec3) => new THREE.Vector3(a[0], a[1], a[2]);
const FOV = 35;
const ORTHO_DIST = 500;
const BACKDROP_DEPTH = 40;

interface DragState {
  mode: 'translate' | 'rotate';
  axis: string | null;
  startPos: THREE.Vector3;
  startQuat: THREE.Quaternion;
  parts: { id: string; m: THREE.Matrix4 }[];
  selector: string | string[];
  names: string[];
}

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly persp = new THREE.PerspectiveCamera(FOV, 1, 0.05, 5000);
  readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  cam: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.persp;
  readonly controls: OrbitControls;
  readonly gizmo: TransformControls;
  private anchor = new THREE.Object3D();
  private partsRoot = new THREE.Group();
  private objs = new Map<string, { json: string; o: PartObject }>();
  view: ViewName | null = 'threequarter';
  mode: 'translate' | 'rotate' = 'translate';
  private orthoHeight = 10;
  private dirty = true;
  private drag: DragState | null = null;
  private framedOnce = false;
  private grid: THREE.LineSegments;
  private frontMarker: THREE.Mesh;
  private pivotMarker: THREE.Group;
  private backdrop: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
  /** The last evaluation's line map drawn on top of the model (ortho views). */
  private linesLayer: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
  private linesKey = '';
  showLines = false;
  private linesBox!: HTMLInputElement;
  private linesInfo!: HTMLSpanElement;
  private backdropKey = '';
  backdropOpacity = 0.5;
  private down: { x: number; y: number; gizmo: boolean } | null = null;
  /** The project's 3D AI model (exports/<project>_3d.glb, made by scripts/make-3d + export-3d). */
  aiMode: AiMode = 'off';
  private ai: { url: string; root: THREE.Object3D | null; state: 'loading' | 'ready' | 'missing' } | null = null;
  /** Called when the 3D AI model finishes loading or turns out to be missing. */
  onAiChange: (state: 'loading' | 'ready' | 'missing' | 'none') => void = () => {};
  private raycaster = new THREE.Raycaster();

  // overlay UI
  private viewBtns = new Map<ViewName, HTMLButtonElement>();
  private modeBtns = new Map<string, HTMLButtonElement>();
  private label: HTMLDivElement;
  private hint: HTMLDivElement;
  private refPanel: HTMLDivElement;

  constructor(private container: HTMLElement, private store: Store, private meshes: PartMeshes) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(this.renderer.domElement);
    this.renderer.domElement.tabIndex = 0;
    meshes.setAnisotropy(Math.min(8, this.renderer.capabilities.getMaxAnisotropy()));

    this.scene.background = new THREE.Color(0x2a2d33);
    // Tuned so a face's on-screen color stays close to its hex: top ~100%, front ~90%,
    // right ~75%, left/back ~60% (Studio-like), which keeps ortho views comparable to refs.
    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8a90, 1.6);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(0.28, 0.69, -0.66).multiplyScalar(20); // front-right-top (front = -Z, right = +X)
    this.scene.add(hemi, sun);

    this.grid = makeGrid(40);
    this.frontMarker = makeFrontMarker();
    this.pivotMarker = makePivotMarker();
    this.scene.add(this.grid, this.frontMarker, this.partsRoot, this.pivotMarker, this.anchor);

    this.persp.position.set(8, 7, -12);
    this.ortho.up.set(0, 1, 0);
    this.controls = new OrbitControls(this.persp, this.renderer.domElement);
    this.controls.target.set(0, 2.5, 0);
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('change', () => {
      this.onCameraChange();
      this.invalidate();
    });

    this.gizmo = new TransformControls(this.persp, this.renderer.domElement);
    this.gizmo.setSpace('world');
    this.gizmo.setRotationSnap(THREE.MathUtils.degToRad(15));
    this.gizmo.showE = false;
    this.gizmo.showXYZE = false;
    this.gizmo.setSize(0.9);
    this.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('change', () => this.invalidate());
    this.gizmo.addEventListener('dragging-changed', (e) => this.onDragging(Boolean((e as unknown as { value: boolean }).value)));
    this.gizmo.addEventListener('objectChange', () => this.onGizmoMove());

    // ---- overlay
    const vbar = h('div', { class: 'vbar' });
    for (const v of VIEWS) {
      const b = h('button', { class: 'tbtn', title: `${v.label} view (${v.key})`, onclick: () => this.setView(v.id) }, v.label);
      this.viewBtns.set(v.id, b);
      vbar.append(b);
    }
    vbar.append(
      h('div', { class: 'sep' }),
      h('button', { class: 'tbtn', title: 'Frame selection / model (F)', onclick: () => this.frame() }, 'Frame'),
      h('div', { class: 'sep' }),
    );
    for (const [m, label, key] of [['translate', 'Move', 'G'], ['rotate', 'Rotate', 'R']] as const) {
      const b = h('button', { class: 'tbtn', title: `${label} gizmo (${key})`, onclick: () => this.setMode(m) }, label, ' ', h('kbd', null, key));
      this.modeBtns.set(m, b);
      vbar.append(b);
    }
    this.label = h('div', { class: 'vlabel' });
    this.hint = h('div', { class: 'hint', style: { display: 'none' } });
    const slider = h('input', {
      type: 'range', min: '0', max: '1', step: '0.05', value: String(this.backdropOpacity),
      oninput: (e: Event) => this.setBackdropOpacity(Number((e.target as HTMLInputElement).value)),
    });
    try { this.showLines = localStorage.getItem('mb.lines') === '1'; } catch { /* ignore */ }
    this.linesBox = h('input', { type: 'checkbox', checked: this.showLines, onchange: () => {
      this.showLines = this.linesBox.checked;
      try { localStorage.setItem('mb.lines', this.showLines ? '1' : '0'); } catch { /* ignore */ }
      this.updateBackdrop();
    } });
    this.linesInfo = h('span', { class: 'vlegend' });
    this.refPanel = h('div', { class: 'vpanel', style: { display: 'none' } },
      h('span', { title: 'Reference image behind the model (this view only)' }, 'Ref', slider),
      h('label', { class: 'vlines', title: 'Line map of the last evaluation drawn over the model: red = line only in the reference, blue = only in the model, black = both' },
        this.linesBox, 'Lines', this.linesInfo));
    container.append(vbar, h('div', { class: 'vtools' }, this.refPanel), this.label, this.hint);
    this.updateOverlay();

    // ---- events
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      this.down = e.button === 0 ? { x: e.clientX, y: e.clientY, gizmo: this.gizmo.dragging || this.gizmo.axis !== null } : null;
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || e.button !== 0 || d.gizmo) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      this.pick(e);
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();

    store.on('state', () => this.syncScene());
    store.on('selection', () => this.syncSelection());
    store.on('error', () => this.resetPreview());

    const tick = () => {
      requestAnimationFrame(tick);
      if (!this.dirty) return;
      this.dirty = false;
      this.renderer.render(this.scene, this.cam);
    };
    requestAnimationFrame(tick);
  }

  invalidate(): void {
    this.dirty = true;
  }

  // ------------------------------------------------------------------------------- scene sync

  syncScene(): void {
    const s = this.store.scene;
    if (!s) return;
    const seen = new Set<string>();
    for (const p of s.parts) {
      seen.add(p.id);
      const json = JSON.stringify(p);
      const cur = this.objs.get(p.id);
      if (cur && cur.json === json) continue;
      if (cur) {
        this.partsRoot.remove(cur.o.root);
        disposePart(cur.o);
      }
      const o = this.meshes.build(p);
      this.partsRoot.add(o.root);
      this.objs.set(p.id, { json, o });
    }
    for (const [id, e] of this.objs) {
      if (seen.has(id)) continue;
      this.partsRoot.remove(e.o.root);
      disposePart(e.o);
      this.objs.delete(id);
    }
    if (!this.drag) this.resetPreview();
    this.updateFrontMarker();
    this.updateBackdrop();
    this.syncSelection();
    this.updateAi();
    if (!this.framedOnce && s.parts.length) {
      this.framedOnce = true;
      this.setView(this.view ?? 'threequarter');
    }
    this.invalidate();
  }

  /** Rebuild every mesh (after the stud look changes). */
  rebuildAll(): void {
    for (const e of this.objs.values()) {
      this.partsRoot.remove(e.o.root);
      disposePart(e.o);
    }
    this.objs.clear();
    this.syncScene();
  }

  /** Put every part object back where the scene says it is (drops any drag preview). */
  resetPreview(): void {
    const s = this.store.scene;
    if (!s) return;
    for (const p of s.parts) {
      const e = this.objs.get(p.id);
      if (!e) continue;
      partMatrix(p, e.o.root.matrix);
      e.o.root.matrix.decompose(e.o.root.position, e.o.root.quaternion, e.o.root.scale);
    }
    if (!this.drag) this.updateGizmo();
    this.invalidate();
  }

  syncSelection(): void {
    const sel = new Set(this.store.selection);
    for (const [id, e] of this.objs) {
      const p = this.store.part(id);
      this.meshes.setSelected(e.o, sel.has(id), !!p?.mirrorOf);
    }
    this.updateGizmo();
    this.updatePivotMarker();
    this.updateHint();
    this.invalidate();
  }

  private updateGizmo(): void {
    if (this.drag) return;
    const parts = this.store.selectedParts();
    if (!parts.length || parts.some((p) => p.mirrorOf)) {
      this.gizmo.detach();
      return;
    }
    const g = this.store.groupById(this.store.group);
    const c = g && this.mode === 'rotate' ? g.pivot : this.store.selectionCentre(parts)!;
    this.anchor.position.set(c[0], c[1], c[2]);
    this.anchor.quaternion.identity();
    this.anchor.updateMatrixWorld(true);
    this.gizmo.setMode(this.mode);
    this.gizmo.attach(this.anchor);
  }

  private updatePivotMarker(): void {
    const g = this.store.groupById(this.store.group);
    this.pivotMarker.visible = !!g;
    if (g) this.pivotMarker.position.set(g.pivot[0], g.pivot[1], g.pivot[2]);
  }

  private updateHint(): void {
    const mirrors = this.store.selectedParts().filter((p) => p.mirrorOf);
    if (!mirrors.length) {
      this.hint.style.display = 'none';
      return;
    }
    const p = mirrors[0];
    const src = this.store.mirrorSource(p);
    const grp = this.store.groupById(p.group);
    this.hint.textContent = `"${p.name}" is generated by a linked mirror${grp ? ` (${grp.name})` : ''}: edit "${src?.name ?? '?'}" instead, or unlink the group.`;
    this.hint.style.display = '';
  }

  private updateFrontMarker(): void {
    const s = this.store.scene;
    const bb = s && s.parts.length ? unionAABB(s.parts.map(partAABB)) : null;
    const z = bb ? bb.min[2] : -1;
    this.frontMarker.position.set(0, 0.002, Math.min(-1, z) - 1.4);
  }

  // ------------------------------------------------------------------------------- selection

  private pick(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.cam);
    const meshes = [...this.objs.values()].map((x) => x.o.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    const id = hit?.object.userData.partId as string | undefined;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (id) {
      if (additive) this.store.toggle(id);
      else this.store.select([id]);
    } else if (!additive) this.store.select([]);
  }

  setMode(m: 'translate' | 'rotate'): void {
    this.mode = m;
    this.updateOverlay();
    this.updateGizmo();
    this.invalidate();
  }

  // ------------------------------------------------------------------------------- gizmo drag

  private onDragging(active: boolean): void {
    this.controls.enabled = !active;
    if (active) {
      const parts = this.store.selectedParts();
      this.drag = {
        mode: this.gizmo.mode as 'translate' | 'rotate',
        axis: this.gizmo.axis,
        startPos: this.anchor.position.clone(),
        startQuat: this.anchor.quaternion.clone(),
        parts: parts.map((p) => ({ id: p.id, m: partMatrix(p) })),
        selector: this.store.selector(),
        names: parts.map((p) => p.name),
      };
    } else if (this.drag) {
      this.finishDrag();
    }
  }

  private onGizmoMove(): void {
    const d = this.drag;
    if (!d) return;
    if (d.mode === 'translate') {
      // Snap the offset (not the absolute position) to the scene's snap step.
      const step = this.store.scene?.snap ?? 0.05;
      const delta = this.anchor.position.clone().sub(d.startPos);
      delta.set(snapTo(delta.x, step), snapTo(delta.y, step), snapTo(delta.z, step));
      this.anchor.position.copy(d.startPos).add(delta);
    }
    const qd = this.anchor.quaternion.clone().multiply(d.startQuat.clone().invert());
    const D = new THREE.Matrix4()
      .makeTranslation(this.anchor.position)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(qd))
      .multiply(new THREE.Matrix4().makeTranslation(d.startPos.clone().negate()));
    for (const p of d.parts) {
      const e = this.objs.get(p.id);
      if (!e) continue;
      e.o.root.matrix.multiplyMatrices(D, p.m);
      e.o.root.matrix.decompose(e.o.root.position, e.o.root.quaternion, e.o.root.scale);
    }
    this.invalidate();
  }

  private finishDrag(): void {
    const d = this.drag!;
    this.drag = null;
    const what = d.names.length === 1 ? d.names[0] : typeof d.selector === 'string' ? d.selector.replace(/^group:/, '') : `${d.names.length} parts`;
    let ops: Command[] = [];
    let label = '';
    if (d.mode === 'translate') {
      const step = this.store.scene?.snap ?? 0.05;
      const delta = this.anchor.position.clone().sub(d.startPos);
      const by: Vec3 = [snapTo(delta.x, step), snapTo(delta.y, step), snapTo(delta.z, step)];
      if (by.some((v) => v !== 0)) {
        ops = [{ op: 'move', parts: d.selector, by }];
        label = `move ${what} by ${by.map((v) => fmtNum(v)).join(', ')}`;
      }
    } else {
      const qd = this.anchor.quaternion.clone().multiply(d.startQuat.clone().invert()).normalize();
      const pivot: Vec3 = [round(d.startPos.x, 6), round(d.startPos.y, 6), round(d.startPos.z, 6)];
      const ax = (d.axis ?? '').toLowerCase();
      if (ax === 'x' || ax === 'y' || ax === 'z') {
        const comp = ax === 'x' ? qd.x : ax === 'y' ? qd.y : qd.z;
        const deg = normDeg(round(THREE.MathUtils.radToDeg(2 * Math.atan2(comp, qd.w)), 6));
        if (deg !== 0) {
          ops = [{ op: 'rotate', parts: d.selector, axis: ax, degrees: deg, pivot }];
          label = `rotate ${what} ${deg}° about ${ax}`;
        }
      } else {
        // Free rotation: decompose into world-axis rotations applied x, then y, then z.
        const eul = new THREE.Euler().setFromQuaternion(qd, 'ZYX');
        for (const [axis, rad] of [['x', eul.x], ['y', eul.y], ['z', eul.z]] as const) {
          const deg = normDeg(round(THREE.MathUtils.radToDeg(rad), 4));
          if (deg !== 0) ops.push({ op: 'rotate', parts: d.selector, axis, degrees: deg, pivot });
        }
        label = `rotate ${what}`;
      }
    }
    if (!ops.length || !this.store.apply(ops, label)) this.resetPreview();
  }

  // ------------------------------------------------------------------------------- cameras

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const hgt = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, hgt);
    this.persp.aspect = w / hgt;
    this.persp.updateProjectionMatrix();
    this.updateOrthoFrustum();
    this.invalidate();
  }

  private aspect(): number {
    return Math.max(1, this.container.clientWidth) / Math.max(1, this.container.clientHeight);
  }

  private updateOrthoFrustum(): void {
    const a = this.aspect();
    const hh = this.orthoHeight / 2;
    this.ortho.left = -hh * a;
    this.ortho.right = hh * a;
    this.ortho.top = hh;
    this.ortho.bottom = -hh;
    this.ortho.updateProjectionMatrix();
  }

  private useCamera(cam: THREE.PerspectiveCamera | THREE.OrthographicCamera): void {
    this.cam = cam;
    this.controls.object = cam;
    this.gizmo.camera = cam;
  }

  private bounds(selectionOnly: boolean): THREE.Box3 {
    const s = this.store.scene;
    const parts = selectionOnly ? this.store.selectedParts() : s?.parts ?? [];
    const bb = unionAABB(parts.map(partAABB));
    const aiBox = !selectionOnly && this.ai?.root?.visible ? new THREE.Box3().setFromObject(this.ai.root) : null;
    if (this.aiMode === 'only' && aiBox) return aiBox;
    const box = bb ? new THREE.Box3(v3(bb.min), v3(bb.max)) : null;
    if (box && aiBox) return box.union(aiBox);
    return box ?? aiBox ?? new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 4, 2));
  }

  // ------------------------------------------------------------------------- 3D AI model

  setAiMode(mode: AiMode): void {
    this.aiMode = mode;
    try { localStorage.setItem('mb.ai3d', mode); } catch { /* ignore */ }
    this.updateAi();
    this.onAiChange(this.ai?.state ?? 'none');
    this.frame();
  }

  /** Load (once per project) and place the 3D AI model for the current mode. */
  private updateAi(): void {
    const name = this.store.state?.project.name;
    const url = name ? `/files/exports/${encodeURIComponent(name)}_3d.glb` : '';
    if (this.ai && this.ai.url !== url) {
      if (this.ai.root) this.scene.remove(this.ai.root);
      this.ai = null;
    }
    this.partsRoot.visible = !(this.aiMode === 'only' && this.ai?.state === 'ready');
    if (this.aiMode === 'off' || !url) {
      if (this.ai?.root) this.ai.root.visible = false;
      this.invalidate();
      return;
    }
    if (!this.ai) {
      const ai = { url, root: null as THREE.Object3D | null, state: 'loading' as 'loading' | 'ready' | 'missing' };
      this.ai = ai;
      this.onAiChange('loading');
      new GLTFLoader().load(`${url}?t=${Date.now()}`, (gltf) => {
        if (this.ai !== ai) return;
        gltf.scene.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          // Baked AI textures look metallic-dark without an environment map: keep them diffuse.
          if (m && 'metalness' in m) { m.metalness = 0; m.metalnessMap = null; m.needsUpdate = true; }
        });
        ai.root = new THREE.Group().add(gltf.scene);
        ai.state = 'ready';
        this.scene.add(ai.root);
        this.onAiChange('ready');
        this.updateAi();
        this.frame();
      }, undefined, () => {
        if (this.ai !== ai) return;
        ai.state = 'missing';
        this.onAiChange('missing');
      });
      return;
    }
    const root = this.ai.root;
    if (!root) return;
    root.visible = true;
    root.position.set(0, 0, 0);
    if (this.aiMode === 'beside') {
      // Next to the part model, on its right (+x) side, with a stud of space.
      const parts = unionAABB((this.store.scene?.parts ?? []).map(partAABB));
      const own = new THREE.Box3().setFromObject(root);
      if (parts) root.position.x = parts.max[0] + 1 - own.min.x;
    }
    this.invalidate();
  }

  setView(v: ViewName): void {
    const box = this.bounds(false);
    const centre = box.getCenter(new THREE.Vector3());
    this.controls.target.copy(centre);
    if (v === 'threequarter') {
      const dir = new THREE.Vector3(1, 0.62, -1.25).normalize();
      this.persp.up.set(0, 1, 0);
      this.persp.position.copy(centre).addScaledVector(dir, this.perspDistance(box));
      this.persp.lookAt(centre);
      this.useCamera(this.persp);
    } else {
      const B = VIEW_BASIS[v];
      this.ortho.up.copy(v3(B.up));
      this.ortho.position.copy(centre).addScaledVector(v3(B.forward), -ORTHO_DIST);
      this.ortho.lookAt(centre);
      this.ortho.zoom = 1;
      this.orthoHeight = this.orthoFit(box, v);
      this.updateOrthoFrustum();
      this.useCamera(this.ortho);
    }
    this.view = v;
    this.controls.update();
    this.updateBackdrop();
    this.updateOverlay();
    this.invalidate();
  }

  private perspDistance(box: THREE.Box3): number {
    const r = Math.max(0.5, box.getBoundingSphere(new THREE.Sphere()).radius);
    const vfov = THREE.MathUtils.degToRad(FOV) / 2;
    const hfov = Math.atan(Math.tan(vfov) * this.aspect());
    return (r * 1.08) / Math.sin(Math.min(vfov, hfov));
  }

  private orthoFit(box: THREE.Box3, v: OrthoName): number {
    const B = VIEW_BASIS[v];
    const right = v3(B.right), up = v3(B.up);
    let w = 0, hh = 0;
    const size = box.getSize(new THREE.Vector3());
    w = Math.abs(right.x) * size.x + Math.abs(right.y) * size.y + Math.abs(right.z) * size.z;
    hh = Math.abs(up.x) * size.x + Math.abs(up.y) * size.y + Math.abs(up.z) * size.z;
    return Math.max(2, Math.max(hh, w / this.aspect()) * 1.18);
  }

  /** Fit the selection (or the whole model) keeping the current view direction. */
  frame(): void {
    const box = this.bounds(this.store.selection.length > 0);
    const centre = box.getCenter(new THREE.Vector3());
    const dir = this.cam.getWorldDirection(new THREE.Vector3());
    this.controls.target.copy(centre);
    if (this.cam === this.persp) {
      this.persp.position.copy(centre).addScaledVector(dir, -this.perspDistance(box));
    } else {
      this.ortho.position.copy(centre).addScaledVector(dir, -ORTHO_DIST);
      this.ortho.zoom = 1;
      this.orthoHeight = isOrtho(this.view) ? this.orthoFit(box, this.view) : Math.max(2, box.getSize(new THREE.Vector3()).length());
      this.updateOrthoFrustum();
    }
    this.controls.update();
    this.invalidate();
  }

  /** Orbiting away from an ortho preset drops back to perspective (like Blockbench). */
  private onCameraChange(): void {
    if (this.cam !== this.ortho || !isOrtho(this.view)) return;
    const preset = v3(VIEW_BASIS[this.view].forward);
    const dir = this.ortho.getWorldDirection(new THREE.Vector3());
    if (dir.angleTo(preset) < 0.01) return;
    const target = this.controls.target;
    const visible = this.orthoHeight / this.ortho.zoom;
    const dist = visible / 2 / Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
    this.persp.up.set(0, 1, 0);
    this.persp.position.copy(target).addScaledVector(dir, -dist);
    this.persp.lookAt(target);
    this.useCamera(this.persp);
    this.view = null;
    this.updateBackdrop();
    this.updateOverlay();
  }

  private updateOverlay(): void {
    for (const [id, b] of this.viewBtns) b.classList.toggle('on', id === this.view);
    for (const [m, b] of this.modeBtns) b.classList.toggle('on', m === this.mode);
    const v = VIEWS.find((x) => x.id === this.view);
    this.label.textContent = !v ? 'Perspective' : isOrtho(this.view) ? `${v.label} · ortho` : '3/4 · perspective';
  }

  // ------------------------------------------------------------------------------- backdrop

  setBackdropOpacity(o: number): void {
    this.backdropOpacity = o;
    if (this.backdrop) this.backdrop.material.opacity = o;
    this.invalidate();
  }

  private updateBackdrop(): void {
    const v = this.view;
    const rv = isOrtho(v) ? this.store.state?.refs.views[v satisfies RefView] : undefined;
    const f = rv?.frame;
    if (!rv || !f || !rv.url || !isOrtho(v)) {
      if (this.backdrop) this.backdrop.visible = false;
      if (this.linesLayer) this.linesLayer.visible = false;
      this.refPanel.style.display = 'none';
      this.invalidate();
      return;
    }
    const key = `${v}|${rv.url}|${JSON.stringify(f)}`;
    if (key !== this.backdropKey || !this.backdrop) {
      this.disposeBackdrop();
      this.backdropKey = key;
      const B = VIEW_BASIS[v];
      const right = v3(B.right), up = v3(B.up), fwd = v3(B.forward);
      const W = f.width / f.ppu, H = f.height / f.ppu;
      const tex = new THREE.TextureLoader().load(rv.url, () => this.invalidate());
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: this.backdropOpacity, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
      const centre = right.clone().multiplyScalar(f.u0 + W / 2)
        .addScaledVector(up, f.v0 - H / 2)
        .addScaledVector(fwd, BACKDROP_DEPTH);
      mesh.position.copy(centre);
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, fwd.clone().negate()));
      mesh.renderOrder = -1;
      this.backdrop = mesh;
      this.scene.add(mesh);
    }
    this.backdrop.visible = true;
    this.refPanel.style.display = '';
    this.updateLines(v, f);
    this.invalidate();
  }

  /** The latest evaluation round's line map for this view, on top of the model. */
  private updateLines(v: OrthoView, f: { ppu: number; u0: number; v0: number; width: number; height: number }): void {
    const rounds = (this.store.state?.iterations ?? []).filter((it) => it.review && it.perView[v] !== undefined);
    const last = rounds[rounds.length - 1];
    const rel = last?.review?.replace(/\.json$/, `_${v}_layer.png`);
    this.linesInfo.innerHTML = last
      ? ` <i style="color:#eb2828">■</i> ref only <i style="color:#285ff0">■</i> model only <span style="opacity:.7">#${last.iter}</span>`
      : ' (no round yet)';
    if (!this.showLines || !rel) {
      if (this.linesLayer) this.linesLayer.visible = false;
      return;
    }
    const url = `/files/${rel.split('/').map(encodeURIComponent).join('/')}`;
    const key = `${v}|${url}|${JSON.stringify(f)}`;
    if (key !== this.linesKey || !this.linesLayer) {
      this.disposeLines();
      this.linesKey = key;
      const B = VIEW_BASIS[v];
      const right = v3(B.right), up = v3(B.up), fwd = v3(B.forward);
      const W = f.width / f.ppu, H = f.height / f.ppu;
      const tex = new THREE.TextureLoader().load(url, () => this.invalidate());
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, H), mat);
      mesh.position.copy(right.clone().multiplyScalar(f.u0 + W / 2).addScaledVector(up, f.v0 - H / 2).addScaledVector(fwd, -BACKDROP_DEPTH));
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, fwd.clone().negate()));
      mesh.renderOrder = 999;
      this.linesLayer = mesh;
      this.scene.add(mesh);
    }
    this.linesLayer.visible = true;
  }

  private disposeLines(): void {
    if (!this.linesLayer) return;
    this.scene.remove(this.linesLayer);
    this.linesLayer.geometry.dispose();
    this.linesLayer.material.map?.dispose();
    this.linesLayer.material.dispose();
    this.linesLayer = null;
    this.linesKey = '';
  }

  private disposeBackdrop(): void {
    if (!this.backdrop) return;
    this.scene.remove(this.backdrop);
    this.backdrop.geometry.dispose();
    this.backdrop.material.map?.dispose();
    this.backdrop.material.dispose();
    this.backdrop = null;
    this.backdropKey = '';
  }

  /** Re-evaluate the backdrop after the refs change. */
  refreshRefs(): void {
    this.updateBackdrop();
  }

  /** Client (page) coordinates of a world point; used by tests and screenshot scripts. */
  screenPoint(p: Vec3): { x: number; y: number } {
    const v = v3(p).project(this.cam);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  /** World position of the gizmo anchor (selection centre / group pivot), or null when hidden. */
  gizmoAnchor(): Vec3 | null {
    return this.gizmo.object ? [this.anchor.position.x, this.anchor.position.y, this.anchor.position.z] : null;
  }
}

function snapTo(v: number, step: number): number {
  return step > 0 ? round(Math.round(v / step) * step, 6) : round(v, 6);
}

function normDeg(d: number): number {
  let x = ((d % 360) + 360) % 360;
  if (x > 180) x -= 360;
  return round(x, 4);
}

// ----------------------------------------------------------------------------------- helpers

function makeGrid(n: number): THREE.LineSegments {
  const pos: number[] = [];
  const col: number[] = [];
  const minor = new THREE.Color(0x353940), major = new THREE.Color(0x4a4f58);
  const xAxis = new THREE.Color(0x9a4040), zAxis = new THREE.Color(0x3f62a8);
  for (let i = -n; i <= n; i++) {
    const c = i % 5 === 0 ? major : minor;
    // line along X at z = i
    pos.push(-n, 0, i, n, 0, i);
    const cx = i === 0 ? xAxis : c;
    col.push(cx.r, cx.g, cx.b, cx.r, cx.g, cx.b);
    // line along Z at x = i
    pos.push(i, 0, -n, i, 0, n);
    const cz = i === 0 ? zAxis : c;
    col.push(cz.r, cz.g, cz.b, cz.r, cz.g, cz.b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }));
  lines.renderOrder = -2;
  return lines;
}

/** "FRONT (-Z)" lettering on the ground in front of the model, readable from the front. */
function makeFrontMarker(): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = 'bold 64px Segoe UI, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('FRONT (-Z)', 256, 56);
  // arrow pointing at the viewer (towards -Z)
  ctx.beginPath();
  ctx.moveTo(256 - 34, 106);
  ctx.lineTo(256 + 34, 106);
  ctx.lineTo(256, 150);
  ctx.closePath();
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.6, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1), mat);
  // text right = -X (viewer at -Z looking +Z), text up = +Z, normal = +Y
  mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)));
  mesh.renderOrder = -1;
  return mesh;
}

function makePivotMarker(): THREE.Group {
  const g = new THREE.Group();
  const L = 0.7;
  const axes: [number, number[]][] = [[0xff5555, [L, 0, 0]], [0x55dd55, [0, L, 0]], [0x5599ff, [0, 0, L]]];
  for (const [color, end] of axes) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-end[0], -end[1], -end[2], ...end], 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
    line.renderOrder = 30;
    g.add(line);
  }
  const ball = new THREE.Mesh(new THREE.OctahedronGeometry(0.12), new THREE.MeshBasicMaterial({ color: 0xffd34d, depthTest: false }));
  ball.renderOrder = 31;
  g.add(ball);
  g.visible = false;
  return g;
}
