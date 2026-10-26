// Prompt templates for Nano Banana. Directions are always stated in IMAGE terms ("faces the
// right of the image"), never only anatomically, because "left view" is ambiguous to the model.

import { type BodyPlan, poseText } from './body';
import type { StylePreset } from './styles';

export interface KeyColor {
  name: string;
  hex: string;
}

export const KEY_COLORS: KeyColor[] = [
  { name: 'pure magenta', hex: '#FF00FF' },
  { name: 'pure green', hex: '#00FF00' },
  { name: 'pure cyan', hex: '#00FFFF' },
  { name: 'pure blue', hex: '#0000FF' },
  { name: 'pure yellow', hex: '#FFFF00' },
];

const background = (k: KeyColor) =>
  `BACKGROUND: one flat, perfectly uniform ${k.name} (${k.hex}) color filling the entire image edge to edge. No gradient, no vignette, no floor, no ground line, no cast shadow, no reflection, no other objects. Never use ${k.name} or anything close to it on the subject itself.\n` +
  `LIGHTING: bright, neutral white studio light, soft and even from the front and above, so every color of the subject reads true. The background is NOT a light source: no ${k.name} reflections, glow, rim light or tint anywhere on the subject - grey and white parts stay pure neutral grey and white - and crisp edges with no colored halo.`;

const style = (s: StylePreset, hasStyleRefs: boolean) =>
  `STYLE: ${s.description}${s.palette ? ` Palette: ${s.palette}.` : ''}${hasStyleRefs ? ' Match the construction, colors and rendering of the STYLE EXAMPLE images, but NOT their subject.' : ''}\nAVOID: ${s.avoid}.`;

export function heroPrompt(idea: string, s: StylePreset, key: KeyColor, hasStyleRefs: boolean, extra = '', body: BodyPlan = 'other', hasPoseRef = false): string {
  return [
    `Create one 3D game-asset render of: ${idea}.`,
    'VIEW: three-quarter view from the front-right and slightly above. The subject is turned about 45 degrees so it faces toward the LEFT side of the image; we see its front and its right side. The whole subject is visible, centred, filling about 75% of the image height.' +
      (body === 'quadruped' ? ' We see the whole length of its body and all four legs standing on the ground.' : ''),
    poseText(body),
    hasPoseRef ? 'POSE REFERENCE: the grey block mannequin image shows ONLY the stance and the camera angle. Copy exactly how it stands - level body, four straight legs under it, every paw flat on the ground, the head in front at shoulder height - and the same camera angle, facing the same way. Do NOT copy its grey color, its plain boxes or its proportions: the subject keeps its own look from the description and the STYLE.' : '',
    style(s, hasStyleRefs),
    background(key),
    extra,
  ].filter(Boolean).join('\n\n');
}

/**
 * Hero from the pose mannequin (local GPU, Qwen-Image-2.1 edit): the grey block mannequin is
 * redrawn as the subject, so the stance can't drift (FLUX.2 klein kept drawing upright pandas
 * with arms even with the mannequin as a reference).
 */
export function heroFromPosePrompt(idea: string, s: StylePreset, key: KeyColor, extra = '', body: BodyPlan = 'other'): string {
  return [
    `Redraw the grey block mannequin in the image as: ${idea}.`,
    'Keep EXACTLY the mannequin\'s pose, stance and camera angle: the same level body, the same four straight legs standing on the ground in the same places (every paw flat on the ground, none lifted, nothing held), the head in the same place in front, facing the same way, the same size in the picture. The front legs are legs like the back legs - not arms.',
    'Replace the plain grey blocks with the animal\'s own body, colors, markings and face as described; keep the chunky proportions.',
    poseText(body),
    style(s, false),
    background(key),
    extra,
  ].filter(Boolean).join('\n\n');
}

export function sheetPrompt(idea: string, s: StylePreset, key: KeyColor, hasStyleRefs: boolean, extra = '', withTemplate = true, body: BodyPlan = 'other'): string {
  return [
    `Using the HERO DESIGN image as the exact design (${idea}), create a turnaround sheet: ONE image with THREE views of the same subject side by side, left to right:`,
    '1. FRONT VIEW: the subject faces the viewer straight on. Its own right side is on the LEFT of the image.',
    '2. SIDE VIEW: exact profile of its right side; the subject faces toward the RIGHT edge of the image.',
    '3. BACK VIEW: seen from directly behind; its own right side is on the RIGHT of the image.',
    (withTemplate ? 'Follow the LAYOUT TEMPLATE only for placement: t' : 'T') +
      'hree equal columns, one view centred in each column, every view at exactly the same scale, bottoms on the same ground line and tops at the same height. Do NOT draw lines, column borders, labels or any text.',
    'Orthographic projection (no perspective), camera level with the middle of the subject. Identical design, proportions, colors and details in all three views.',
    poseText(body),
    style(s, hasStyleRefs),
    background(key),
    extra,
  ].filter(Boolean).join('\n');
}

export type SingleView = 'front' | 'right' | 'back' | 'left' | 'top';

const VIEW_TEXT: Record<SingleView, string> = {
  front: 'FRONT VIEW: the subject faces the viewer straight on. Its own right side is on the LEFT of the image.',
  right: 'SIDE VIEW: exact profile of its right side; the subject faces toward the RIGHT edge of the image (its nose/front points right).',
  back: 'BACK VIEW: seen from directly behind; its own right side is on the RIGHT of the image.',
  left: 'LEFT SIDE VIEW: exact profile; the subject faces toward the LEFT edge of the image (we see its left side).',
  top: 'TOP VIEW: seen from directly above, camera looking straight down. The subject\'s FRONT points toward the BOTTOM edge of the image and its own right side is on the LEFT of the image.',
};

export function viewPrompt(view: SingleView, idea: string, s: StylePreset, key: KeyColor, hasStyleRefs: boolean, extra = '', body: BodyPlan = 'other'): string {
  return [
    `Using the HERO DESIGN image as the exact design (${idea}), show the same subject in this view:`,
    VIEW_TEXT[view],
    'Orthographic projection (no perspective). Same design, proportions, colors and details as the hero. The whole subject is visible and centred, filling about 80% of the image.',
    view === 'top' ? '' : poseText(body),
    style(s, hasStyleRefs),
    background(key),
    extra,
  ].filter(Boolean).join('\n');
}

export type CloseupView = SingleView | 'threequarter';

const CLOSEUP_VIEW: Record<CloseupView, string> = {
  front: 'FRONT VIEW: facing the viewer straight on; its own right side is on the LEFT of the image.',
  right: 'SIDE VIEW: exact profile of its right side, facing toward the RIGHT edge of the image.',
  back: 'BACK VIEW: seen from directly behind; its own right side is on the RIGHT of the image.',
  left: 'LEFT SIDE VIEW: exact profile of its left side, facing toward the LEFT edge of the image.',
  top: 'TOP VIEW: seen from directly above; its front points toward the BOTTOM edge of the image.',
  threequarter: 'THREE-QUARTER VIEW: from the front-right and slightly above, turned about 45 degrees toward the LEFT of the image, like the whole design image.',
};

/** One part on its own (one picture per part): a detail reference; the main views stay the targets. */
export function closeupPrompt(part: string, view: CloseupView, notes: string, idea: string, s: StylePreset, key: KeyColor, hasStyleRefs: boolean, extra = ''): string {
  const P = part.toUpperCase();
  const from = view === 'threequarter' || view === 'front' ? 'front' : view === 'right' ? 'side' : view;
  return [
    `The first reference image shows ONLY the ${P} of ${idea}, cut out of a ${from} view of it; the second shows the whole design.`,
    `Make a picture of ONLY the ${P}${notes ? ` (${notes})` : ''} as one separate, complete 3D game-model piece, like a single part laid out on its own: cut off cleanly and flat where it joins the rest, and NOTHING else of the subject anywhere in the picture - no body, no legs, no tail, no other parts.`,
    CLOSEUP_VIEW[view],
    `${view === 'threequarter' ? '' : 'Orthographic projection (no perspective). '}Large and centred, filling about 80% of the image, every detail crisp and visible.`,
    'Exactly the same design, colors and construction as in the reference images; do not invent new details.',
    style(s, hasStyleRefs),
    background(key),
    extra,
  ].filter(Boolean).join('\n');
}

export function stylePrompt(subject: string, s: StylePreset, key: KeyColor, hasStyleRefs: boolean): string {
  return heroPrompt(subject, s, key, hasStyleRefs, 'This is a quick style test.');
}

export function editPrompt(instruction: string, key: KeyColor): string {
  return `Edit the image: ${instruction}\nKeep everything else exactly the same: same design, layout, scale, view and the same flat ${key.name} (${key.hex}) background.`;
}
