// Three.js meshes for parts, built from the same local geometry the server renderer uses.
// Each face gets its own material slot so Studs / Inlet / Smooth surfaces show per face.

import * as THREE from 'three';
import { type Vec3, cross, dot, normalize, scale, sub } from '../src/core/math';
import type { Part, Surface } from '../src/core/scene';
import { localGeometry } from '../src/core/shapes';

/** One 1024px stud tile covers 2x2 studs. */
const STUDS_PER_TILE = 2;

export interface PartObject {
  root: THREE.Group;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  xray: THREE.LineSegments;
}

export class PartMeshes {
  private diffuse: THREE.Texture;
  private normal: THREE.Texture;
  private mats = new Map<string, THREE.Material>();
  studs = true;
  readonly edgeMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.38 });
  readonly selEdgeMat = new THREE.LineBasicMaterial({ color: 0xffa31a });
  readonly xrayMat = new THREE.LineBasicMaterial({ color: 0xffa31a, transparent: true, opacity: 0.35, depthTest: false });
  readonly mirrorSelEdgeMat = new THREE.LineBasicMaterial({ color: 0xb48cf2 });

  constructor(onLoad: () => void) {
    const loader = new THREE.TextureLoader();
    const setup = (t: THREE.Texture) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      return t;
    };
    this.diffuse = setup(loader.load('studs_diffuse.png', onLoad));
    this.diffuse.colorSpace = THREE.SRGBColorSpace;
    this.normal = setup(loader.load('studs_normal.png', onLoad));
    this.normal.colorSpace = THREE.NoColorSpace;
  }

  setAnisotropy(n: number): void {
    this.diffuse.anisotropy = n;
    this.normal.anisotropy = n;
  }

  setStuds(on: boolean): void {
    if (on === this.studs) return;
    this.studs = on;
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
  }

  material(color: string, surface: Surface, material: Part['material'], transparency: number): THREE.Material {
    const textured = this.studs && surface !== 'Smooth';
    const key = `${color}|${textured ? surface : 'Smooth'}|${material}|${transparency}`;
    let m = this.mats.get(key);
    if (m) return m;
    const c = new THREE.Color(color);
    const std = new THREE.MeshStandardMaterial({
      color: c,
      roughness: material === 'Plastic' ? 0.75 : material === 'SmoothPlastic' ? 0.5 : 0.6,
      metalness: 0,
      // Faces sit slightly behind their edge lines so the outlines never z-fight.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    if (material === 'Neon') {
      std.emissive = c.clone();
      std.emissiveIntensity = 0.85;
    }
    if (textured) {
      std.map = this.diffuse;
      std.normalMap = this.normal;
      std.normalScale = surface === 'Inlet' ? new THREE.Vector2(-1, -1) : new THREE.Vector2(1, 1);
    }
    if (transparency > 0) {
      std.transparent = true;
      std.opacity = 1 - transparency;
      std.depthWrite = false;
    }
    m = std;
    this.mats.set(key, m);
    return m;
  }

  build(part: Part): PartObject {
    const geo = localGeometry(part.shape, part.size);
    const pos: number[] = [];
    const nrm: number[] = [];
    const uv: number[] = [];
    const g = new THREE.BufferGeometry();
    const materials: THREE.Material[] = [];
    let start = 0;
    geo.faces.forEach((f, fi) => {
      const vs = f.idx.map((i) => geo.verts[i]);
      const n = normalize(cross(sub(vs[1], vs[0]), sub(vs[2], vs[0])));
      const { U, V } = faceAxes(n);
      // UVs in stud units measured from the face's corner (min of its in-plane extent).
      const raw = vs.map((v) => [dot(v, U), dot(v, V)]);
      const u0 = Math.min(...raw.map((r) => r[0]));
      const v0 = Math.min(...raw.map((r) => r[1]));
      const fuv = raw.map((r) => [(r[0] - u0) / STUDS_PER_TILE, (r[1] - v0) / STUDS_PER_TILE]);
      let count = 0;
      for (let i = 1; i + 1 < vs.length; i++) {
        for (const k of [0, i, i + 1]) {
          pos.push(...vs[k]);
          nrm.push(...n);
          uv.push(fuv[k][0], fuv[k][1]);
          count++;
        }
      }
      g.addGroup(start, count, fi);
      start += count;
      materials.push(this.material(part.color, part.surfaces[f.surface], part.material, part.transparency));
    });
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeBoundingSphere();
    g.computeBoundingBox();

    const mesh = new THREE.Mesh(g, materials);
    mesh.userData.partId = part.id;

    // Outline: every polygon edge once (no triangulation diagonals).
    const seen = new Set<string>();
    const ep: number[] = [];
    for (const f of geo.faces) {
      for (let i = 0; i < f.idx.length; i++) {
        const a = f.idx[i], b = f.idx[(i + 1) % f.idx.length];
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ep.push(...geo.verts[a], ...geo.verts[b]);
      }
    }
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3));
    const edges = new THREE.LineSegments(eg, this.edgeMat);
    const xray = new THREE.LineSegments(eg, this.xrayMat);
    xray.visible = false;
    xray.renderOrder = 10;

    const root = new THREE.Group();
    root.add(mesh, edges, xray);
    root.userData.partId = part.id;
    setPartTransform(root, part);
    return { root, mesh, edges, xray };
  }

  setSelected(o: PartObject, selected: boolean, mirror: boolean): void {
    o.edges.material = selected ? (mirror ? this.mirrorSelEdgeMat : this.selEdgeMat) : this.edgeMat;
    o.xray.visible = selected;
  }
}

/** In-plane axes for a face: V follows the part's up direction where possible. */
function faceAxes(n: Vec3): { U: Vec3; V: Vec3 } {
  if (Math.abs(n[1]) > 0.999) {
    const U: Vec3 = [1, 0, 0];
    return { U, V: normalize(cross(n, U)) };
  }
  const up: Vec3 = [0, 1, 0];
  const V = normalize(sub(up, scale(n, dot(n, up))));
  return { U: normalize(cross(V, n)), V };
}

export function partMatrix(part: Pick<Part, 'position' | 'rotation'>, out = new THREE.Matrix4()): THREE.Matrix4 {
  const R = part.rotation, p = part.position;
  return out.set(R[0], R[1], R[2], p[0], R[3], R[4], R[5], p[1], R[6], R[7], R[8], p[2], 0, 0, 0, 1);
}

export function setPartTransform(obj: THREE.Object3D, part: Pick<Part, 'position' | 'rotation'>): void {
  partMatrix(part, obj.matrix);
  obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
  obj.updateMatrixWorld(true);
}

export function disposePart(o: PartObject): void {
  o.mesh.geometry.dispose();
  o.edges.geometry.dispose();
}
