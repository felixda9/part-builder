// What each similarity level means for the build. The user picks the level (editor References panel
// or project_open); the plan check, evaluate and project_open all read these rules.

import { type Similarity, SIMILARITY_LEVELS } from '../core/protocol';

export interface SimilarityRules {
  /** What the level asks of the build, in words Claude acts on. */
  guide: string;
  /** How many deliberate differences the plan should list, [min, max]; null = not tracked. */
  differences: [number, number] | null;
  /** Likeness at which the model is close enough: stop polishing and show the user. null = no such point. */
  enough: number | null;
  /** Below this likeness the model no longer reads as the referenced subject. */
  floor: number | null;
  /** Fix lists (structure/details/color/outline) are targets (true) or only information (false). */
  chase: boolean;
}

export const SIMILARITY_RULES: Record<Similarity, SimilarityRules> = {
  close: {
    guide: 'match the references as closely as the parts allow - every proportion, plate, band and detail; no deliberate differences.',
    differences: [0, 0], enough: null, floor: null, chase: true,
  },
  balanced: {
    guide: 'match the proportions, outline, colors and main details, but make 1-3 deliberate differences that make it a better part-built Roblox model (simplify a fussy detail, a cleaner or chunkier shape, a color accent). List them in the plan; evaluate does not chase them.',
    differences: [1, 3], enough: 0.72, floor: null, chase: true,
  },
  distinct: {
    guide: 'same subject, theme, palette family and overall outline, but clearly its own take - 4 or more deliberate differences (proportions, plate/armor design, details, accents). The references give scale and theme; the likeness score only checks it still reads as the subject.',
    differences: [4, 12], enough: 0.55, floor: 0.45, chase: false,
  },
  free: {
    guide: 'take only the overall theme (what it is, its mood, its palette family) and design the build yourself - do not reproduce the references. Use them for scale; likeness is information only.',
    differences: null, enough: null, floor: null, chase: false,
  },
};

export const similarityLabel = (s: Similarity): string => SIMILARITY_LEVELS.find((l) => l.id === s)?.label ?? s;

export function similarityText(s: Similarity): string {
  return `${similarityLabel(s).toLowerCase()} - ${SIMILARITY_RULES[s].guide}`;
}
