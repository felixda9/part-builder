// Roblox XML model (.rbxmx) writer. Format reference: https://dom.rojo.space/xml.html and
// rbx-dom's property patches. Studio: right-click Workspace -> Insert from File.

import type { CFrame, Vec3 } from '../math';
import type { SceneDoc, Surface } from '../scene';
import { type RigPlan, planRig } from './rig';

const MATERIAL_TOKEN = { Plastic: 256, SmoothPlastic: 272, Neon: 288 } as const;
const SURFACE_TOKEN: Record<Surface, number> = { Smooth: 0, Studs: 3, Inlet: 4 };

const num = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return String(Object.is(r, -0) ? 0 : r);
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const vec3 = (name: string, v: Vec3) => `<Vector3 name="${name}"><X>${num(v[0])}</X><Y>${num(v[1])}</Y><Z>${num(v[2])}</Z></Vector3>`;
const cframe = (name: string, c: CFrame) => {
  const R = c.R;
  const rs = ['R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'].map((k, i) => `<${k}>${num(R[i])}</${k}>`).join('');
  return `<CoordinateFrame name="${name}"><X>${num(c.p[0])}</X><Y>${num(c.p[1])}</Y><Z>${num(c.p[2])}</Z>${rs}</CoordinateFrame>`;
};
const str = (name: string, v: string) => `<string name="${name}">${esc(v)}</string>`;
const bool = (name: string, v: boolean) => `<bool name="${name}">${v}</bool>`;
const float = (name: string, v: number) => `<float name="${name}">${num(v)}</float>`;
const token = (name: string, v: number) => `<token name="${name}">${v}</token>`;
const ref = (name: string, v: string) => `<Ref name="${name}">${v}</Ref>`;
const color3uint8 = (hex: string) => `<Color3uint8 name="Color3uint8">${0xff000000 + parseInt(hex.slice(1), 16)}</Color3uint8>`;

export function toRbxmx(scene: SceneDoc, opts: { rig: boolean; offset?: Vec3; name?: string }): { xml: string; plan: RigPlan } {
  const plan = planRig(scene, opts);
  let n = 0;
  const referent = () => `RBX${(++n).toString(16).toUpperCase().padStart(32, '0')}`;
  const refs = new Map<string, string>(plan.parts.map((p) => [p.key, referent()]));
  const lines: string[] = [];
  const item = (cls: string, props: string[], children: string[] = []) =>
    `<Item class="${cls}" referent="${referent()}"><Properties>${props.join('')}</Properties>${children.join('')}</Item>`;

  const jointXml = (cls: 'Motor6D' | 'Weld', j: RigPlan['motors'][number]) =>
    item(cls, [str('Name', j.name), ref('Part0', refs.get(j.part0)!), ref('Part1', refs.get(j.part1)!), cframe('C0', j.c0), cframe('C1', j.c1)]);

  for (const e of plan.parts) {
    const p = e.part;
    const s = p?.surfaces;
    const surfaces = s
      ? [token('TopSurface', SURFACE_TOKEN[s.top]), token('BottomSurface', SURFACE_TOKEN[s.bottom]), token('FrontSurface', SURFACE_TOKEN[s.front]),
        token('BackSurface', SURFACE_TOKEN[s.back]), token('LeftSurface', SURFACE_TOKEN[s.left]), token('RightSurface', SURFACE_TOKEN[s.right])]
      : ['TopSurface', 'BottomSurface', 'FrontSurface', 'BackSurface', 'LeftSurface', 'RightSurface'].map((f) => token(f, 0));
    const props = [
      str('Name', e.name),
      bool('Anchored', e.anchored),
      bool('CanCollide', e.canCollide),
      bool('Locked', false),
      cframe('CFrame', e.cframe),
      color3uint8(p?.color ?? '#a3a2a5'),
      token('Material', MATERIAL_TOKEN[p?.material ?? 'SmoothPlastic']),
      vec3('size', e.size),
      float('Transparency', e.transparency),
      ...surfaces,
      ...(e.className === 'Part' ? [token('shape', 1)] : []),
    ];
    // Motor6Ds live under Part0 (classic R6 layout), welds under Part1.
    const children = [
      ...plan.motors.filter((j) => j.part0 === e.key).map((j) => jointXml('Motor6D', j)),
      ...plan.welds.filter((j) => j.part1 === e.key).map((j) => jointXml('Weld', j)),
    ];
    lines.push(`<Item class="${e.className}" referent="${refs.get(e.key)}"><Properties>${props.join('')}</Properties>${children.join('')}</Item>`);
  }
  if (plan.rigged) lines.push(item('AnimationController', [str('Name', 'AnimationController')], [item('Animator', [str('Name', 'Animator')])]));

  const modelRef = referent();
  const xml = [
    '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">',
    '<External>null</External><External>nil</External>',
    `<Item class="Model" referent="${modelRef}"><Properties>${str('Name', opts.name ?? scene.name)}${ref('PrimaryPart', refs.get(plan.primary)!)}</Properties>`,
    ...lines,
    '</Item>',
    '</roblox>',
  ].join('\n');
  return { xml, plan };
}
