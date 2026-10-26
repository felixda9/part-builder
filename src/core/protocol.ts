// Messages between the editor (browser) and the server over WebSocket /ws.

import type { Command } from './commands';
import type { SceneDoc } from './scene';

export type RefView = 'front' | 'right' | 'back' | 'left' | 'top';
export const REF_VIEWS: RefView[] = ['front', 'right', 'back', 'left', 'top'];
/**
 * References are front, side, back (+ top): "side" is the model's right side (camera at
 * +X, facing image-right). A left view is just the mirrored side view of a symmetric model, so it
 * is not generated or shown any more ('left' stays valid for old projects).
 */
export const SHOWN_VIEWS: RefView[] = ['front', 'right', 'back', 'top'];
export const viewLabel = (v: string): string => (v === 'right' ? 'side' : v);
/** Accept "side" wherever a reference view is named. */
export const toRefView = (v: string): RefView => (v === 'side' ? 'right' : v) as RefView;

/**
 * How close the build should stay to the references. The user picks it (editor References panel or
 * project_open); the plan, evaluate and the skill read it.
 */
export type Similarity = 'close' | 'balanced' | 'distinct' | 'free';
export const SIMILARITY_LEVELS: { id: Similarity; label: string; blurb: string }[] = [
  { id: 'close', label: 'Close', blurb: 'as close to the references as possible' },
  { id: 'balanced', label: 'Balanced', blurb: 'like the references, with a few deliberate differences' },
  { id: 'distinct', label: 'Distinct', blurb: 'same subject and theme, its own take with more differences' },
  { id: 'free', label: 'Free', blurb: 'only the overall theme - its own design, not a copy of the references' },
];
export const DEFAULT_SIMILARITY: Similarity = 'balanced';

/** Where a normalized reference image sits in world space (same meaning as raster OrthoFrame). */
export interface RefFrame {
  ppu: number; // pixels per stud
  u0: number; // world coordinate (along the view's image-right axis) of the image's left edge
  v0: number; // world coordinate (along the view's image-up axis) of the image's top edge
  width: number;
  height: number;
}

export interface RefImage {
  id: string;
  url: string; // served by the editor server, e.g. /files/refs/hero_1.png?v=123
  label?: string;
  flag?: string; // problem worth a look (close-up proportions differ from the views, ...)
}

export interface RefViewState {
  url: string; // normalized (cropped, scaled, key color removed) image
  maskUrl?: string;
  rawUrl?: string; // as generated
  frame?: RefFrame;
  flag?: string; // consistency problem, if any
}

export interface RefsState {
  hero: { candidates: RefImage[]; picked: string | null };
  sheet: RefImage | null;
  views: Partial<Record<RefView, RefViewState>>;
  viewsApproved: boolean;
  /** Close-up references per part: the part alone, one image per view (detail references, never scored). */
  parts: Record<string, RefImage[]>;
  report: string | null; // consistency report text
  overlayUrl: string | null; // segmentation overlay sheet
  palette: string[];
  feedback: { view?: string; text: string; time: string }[];
  /** Latest reference analysis for the plan (plan_build analyze). */
  analysis?: AnalysisData | null;
}

export const emptyRefs = (): RefsState => ({
  hero: { candidates: [], picked: null },
  sheet: null,
  views: {},
  viewsApproved: false,
  parts: {},
  report: null,
  overlayUrl: null,
  palette: [],
  feedback: [],
});

/** Scores of one view or of the whole model, 0..1 (details is null where the reference has none). */
export interface LikenessParts { silhouette: number; structure: number; color: number; detail: number | null }

/** One evaluation round as the editor's Review screen shows it (renders/review/<id>.json). */
export interface ReviewData {
  id: string;
  iter: number | null;
  rev: number;
  time: string;
  note?: string;
  likeness: number;
  components: LikenessParts;
  weights: { silhouette: number; structure: number; color: number; detail: number };
  similarity: { level: string; label: string; guide: string };
  views: ReviewView[];
  /** Hero image next to the model's 3/4 render (paths relative to the project). */
  hero?: { hero: string; model: string };
  parts: { name: string; score: number; outline: number; lines: number; color: number }[];
  landmarks: { name: string; view: string; axis: string; planned: number; model: number | null; reference: number | null; mark: 'OK' | '~' | 'X' | '?' }[];
  checks: { kind: string; message: string }[];
  differences: { what: string; where?: string }[];
  hints: string[];
  /** The full text report, exactly as Claude reads it. */
  report: string;
}
export interface ReviewView {
  view: string;
  label: string;
  weight: number;
  score: number;
  components: LikenessParts;
  boundary: { mean: number; p95: number };
  /** Paths relative to the project: reference, model render, the two blended, and the line map
   * (also alone on a transparent background, in the view's frame: `layer`). */
  images: { ref: string; model: string; overlay: string; lines: string; layer?: string };
  issues: { missingLines: string[]; extraLines: string[]; details: string[]; extraDetails: string[]; color: string[]; outline: string[] };
}

/** The reference analysis behind the build plan (plan_build analyze), per view. */
export interface AnalysisData {
  time: string;
  views: { view: string; label: string; image: string; heights: string[]; widths: string[]; details: string[] }[];
}

export interface IterationRecord {
  iter: number;
  rev: number;
  score: number; // weighted mean IoU, 0..1
  perView: Record<string, number>;
  boundary?: Record<string, { mean: number; p95: number }>; // silhouette boundary error in studs
  /** Likeness components, 0..1: outline, inner lines/edges, palette colors, small details. */
  components?: { silhouette: number; structure: number; color: number; detail: number | null };
  time: string;
  note?: string;
  /** Set when its revision was dropped (history branched from an earlier revision). */
  discarded?: boolean;
  /** Path (relative to the project) of this round's ReviewData JSON. */
  review?: string;
}

export interface ProjectInfo {
  name: string;
  idea: string;
  style: string;
  heightStuds: number;
  symmetric: boolean;
  similarity: Similarity;
  stage: string;
}

export interface StateMessage {
  type: 'state';
  project: ProjectInfo;
  scene: SceneDoc;
  rev: number;
  canUndo: boolean;
  canRedo: boolean;
  revisions: { rev: number; label: string; time: string; parts: number; current: boolean }[];
  refs: RefsState;
  iterations: IterationRecord[];
  /** Model checks (z-fighting, symmetry, floating, ...). */
  checks?: { kind: string; message: string; parts: string[] }[];
  /** The saved build plan as text, if any. */
  plan?: string | null;
  /** A long job the server is running (e.g. making hero images), or null. */
  busy?: string | null;
}

export type ServerMessage =
  | StateMessage
  | { type: 'error'; message: string }
  | { type: 'notice'; message: string; level?: 'info' | 'warn' };

export type ClientMessage =
  | { type: 'apply'; ops: Command[]; label?: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'checkout'; rev: number }
  | { type: 'ui'; action: 'pick_hero'; id: string }
  | { type: 'ui'; action: 'approve_views' }
  | { type: 'ui'; action: 'feedback'; view?: string; text: string }
  | { type: 'ui'; action: 'set_similarity'; level: Similarity }
  | { type: 'ui'; action: 'remake_heroes'; note?: string };
