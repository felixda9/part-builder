// Small linear-algebra helpers in Roblox conventions.
// Mat3 is row-major [R00,R01,R02, R10,R11,R12, R20,R21,R22], the same order as a
// Roblox CFrame's components. Columns are the part's local X (Right), Y (Up), Z (Back)
// axes in world space, so world = position + R * local.

export type Vec3 = [number, number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const DEG = Math.PI / 180;

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const abs3 = (v: Vec3): Vec3 => [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])];
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l === 0 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
};

export function matVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function matMul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

export const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

export const det = (m: Mat3): number =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

/** Column i of the matrix (local axis i expressed in world space). */
export const column = (m: Mat3, i: number): Vec3 => [m[i], m[3 + i], m[6 + i]];

export const fromColumns = (x: Vec3, y: Vec3, z: Vec3): Mat3 => [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];

export function rotX(deg: number): Mat3 {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return clean([1, 0, 0, 0, c, -s, 0, s, c]);
}
export function rotY(deg: number): Mat3 {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return clean([c, 0, s, 0, 1, 0, -s, 0, c]);
}
export function rotZ(deg: number): Mat3 {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return clean([c, -s, 0, s, c, 0, 0, 0, 1]);
}

export function axisRot(axis: 'x' | 'y' | 'z', deg: number): Mat3 {
  return axis === 'x' ? rotX(deg) : axis === 'y' ? rotY(deg) : rotZ(deg);
}

/** Roblox Orientation (degrees). CFrame.fromOrientation(rx, ry, rz) = Ry * Rx * Rz. */
export function fromOrientation(o: Vec3): Mat3 {
  return clean(matMul(rotY(o[1]), matMul(rotX(o[0]), rotZ(o[2]))));
}

/** Inverse of fromOrientation; matches Roblox's Orientation property. */
export function toOrientation(m: Mat3): Vec3 {
  const r12 = Math.max(-1, Math.min(1, m[5]));
  const rx = Math.asin(-r12);
  let ry: number, rz: number;
  if (Math.abs(r12) < 0.999999) {
    ry = Math.atan2(m[2], m[8]);
    rz = Math.atan2(m[3], m[4]);
  } else {
    ry = Math.atan2(-m[6], m[0]);
    rz = 0;
  }
  return [round(rx / DEG, 4), round(ry / DEG, 4), round(rz / DEG, 4)].map((v) => (Object.is(v, -0) ? 0 : v)) as Vec3;
}

/** Snap entries that are within eps of 0 / ±1 / ±0.5 so axis-aligned rotations stay exact. */
export function clean(m: Mat3, eps = 1e-9): Mat3 {
  return m.map((v) => {
    for (const t of [0, 1, -1, 0.5, -0.5]) if (Math.abs(v - t) < eps) return t === 0 ? 0 : t;
    return v;
  }) as Mat3;
}

/** Gram-Schmidt re-orthonormalisation (keeps column 0 direction, then column 1). */
export function orthonormalize(m: Mat3): Mat3 {
  const x = normalize(column(m, 0));
  let y = column(m, 1);
  y = normalize(sub(y, scale(x, dot(x, y))));
  const z = cross(x, y);
  return clean(fromColumns(x, y, z));
}

export function isRotation(m: Mat3, eps = 1e-6): boolean {
  const p = matMul(m, transpose(m));
  for (let i = 0; i < 9; i++) if (Math.abs(p[i] - IDENTITY[i]) > eps) return false;
  return Math.abs(det(m) - 1) < eps;
}

export const round = (v: number, digits = 4): number => {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
};
export const roundVec = (v: Vec3, digits = 4): Vec3 => [round(v[0], digits), round(v[1], digits), round(v[2], digits)];
/** Snap to a grid, rounding halves away from zero so mirrored values snap to mirrored values (Math.round(-5.5) is -5). */
export const snap = (v: number, step: number): number => (step > 0 ? round(Math.sign(v) * Math.round(Math.abs(v) / step) * step, 6) : v);

/** A rigid transform (CFrame): world = p + R * local. */
export interface CFrame {
  p: Vec3;
  R: Mat3;
}
export const cf = (p: Vec3, R: Mat3 = IDENTITY): CFrame => ({ p, R });
export function cfMul(a: CFrame, b: CFrame): CFrame {
  return { p: add(a.p, matVec(a.R, b.p)), R: matMul(a.R, b.R) };
}
export function cfInv(a: CFrame): CFrame {
  const Rt = transpose(a.R);
  return { p: scale(matVec(Rt, a.p), -1), R: Rt };
}
export const cfPoint = (a: CFrame, v: Vec3): Vec3 => add(a.p, matVec(a.R, v));

/** Axis direction names used by commands, e.g. '+x', '-z'. */
export type AxisDir = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
export const AXIS_DIRS: AxisDir[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
export function dirVec(d: AxisDir): Vec3 {
  const s = d[0] === '-' ? -1 : 1;
  const i = d[1] === 'x' ? 0 : d[1] === 'y' ? 1 : 2;
  const v: Vec3 = [0, 0, 0];
  v[i] = s;
  return v;
}
export const axisIndex = (d: AxisDir): number => (d[1] === 'x' ? 0 : d[1] === 'y' ? 1 : 2);
