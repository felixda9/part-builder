// Body plans: what kind of thing the subject is decides the pose the image model is asked for,
// the anatomy it must respect (a fox has no arms), and the default bones of the build. Guessed
// from the idea; project_open {body} overrides it.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths';

export type BodyPlan = 'humanoid' | 'quadruped' | 'biped' | 'bird' | 'serpent' | 'fish' | 'object' | 'other';
export const BODY_PLANS: BodyPlan[] = ['humanoid', 'quadruped', 'biped', 'bird', 'serpent', 'fish', 'object', 'other'];

const WORDS: [BodyPlan, RegExp][] = [
  ['biped', /\b(t-?rex|tyrannosaur\w*|raptors?|velociraptors?|kangaroos?|dinosaur biped)\b/i],
  ['bird', /\b(birds?|chickens?|chicks?|hens?|roosters?|ducks?|ducklings?|geese|goose|owls?|eagles?|hawks?|parrots?|penguins?|flamingos?|crows?|ravens?|pigeons?|swans?|turkeys?|ostrich\w*|toucans?|peacocks?|phoenix)\b/i],
  ['serpent', /\b(snakes?|serpents?|cobras?|pythons?|vipers?|worms?|eels?|basilisks?)\b/i],
  ['fish', /\b(fish|fishes|sharks?|whales?|dolphins?|goldfish|piranhas?|koi|tuna|salmon|rays?|seahorses?)\b/i],
  ['quadruped', /\b(fox(es)?|dogs?|pupp(y|ies)|cats?|kittens?|wol(f|ves)|tigers?|lions?|leopards?|cheetahs?|panthers?|jaguars?|bears?|pandas?|horses?|ponies|pony|unicorns?|cows?|bulls?|pigs?|boars?|sheep|lambs?|goats?|deer|reindeer|elks?|moose|rabbits?|bunn(y|ies)|hares?|mice|mouse|rats?|hamsters?|squirrels?|raccoons?|otters?|beavers?|elephants?|rhinos?|hippos?|giraffes?|zebras?|camels?|llamas?|alpacas?|capybaras?|frogs?|toads?|turtles?|tortoises?|lizards?|geckos?|crocodiles?|alligators?|dragons?|triceratops|stegosaur\w*|dinosaurs?|sabertooth\w*|mammoths?|axolotls?|hedgehogs?|badgers?|skunks?|koalas?|sloths?|ferrets?|weasels?|lynx|hyenas?|beasts?)\b/i],
  ['humanoid', /\b(knights?|warriors?|soldiers?|robots?|androids?|mech|man|men|woman|women|boy|girl|person|people|character|humanoid|zombies?|skeletons?|ninjas?|wizards?|witch(es)?|kings?|queens?|princes?|princess(es)?|pirates?|goblins?|orcs?|elves|elf|dwarfs?|dwarves|vikings?|samurai|astronauts?|yetis?|monkeys?|gorillas?|apes?|chimps?|aliens?|noob|avatar|guard)\b/i],
  ['object', /\b(swords?|axes?|hammers?|guns?|blasters?|shields?|cars?|trucks?|vehicles?|planes?|boats?|ships?|houses?|huts?|towers?|castles?|chests?|crates?|barrels?|trees?|rocks?|lamps?|chairs?|tables?|eggs?|potions?|trophies|trophy|crowns?|keys?|cannons?)\b/i],
];

/** Best guess from the idea text; the first matching plan in WORDS wins (so "t-rex" beats "dinosaur"). */
export function guessBody(idea: string): BodyPlan {
  for (const [plan, re] of WORDS) if (re.test(idea)) return plan;
  return 'other';
}

/**
 * A picture of the body plan's neutral stance (a grey block mannequin from the hero camera angle,
 * made by scripts/make-pose-refs.ts), sent with hero prompts. The small local image model ignores
 * pose words for some animals - a panda came out as a teddy bear with arms every time.
 */
export function poseRefFile(body: BodyPlan): string | null {
  const f = path.join(ROOT, 'assets', 'poses', `${body}.png`);
  return fs.existsSync(f) ? f : null;
}

/** The pose sentence for image prompts - only this body plan's, so other anatomy never leaks in. */
export function poseText(body: BodyPlan): string {
  switch (body) {
    case 'humanoid':
      return 'POSE: neutral and symmetric: standing upright, legs straight and slightly apart, arms hanging straight down at the sides (not touching the body), not holding anything unless the description says so.';
    case 'quadruped':
      return 'POSE AND ANATOMY: a real four-legged animal standing on all fours like a dog, a cow or a real bear walking - NOT a teddy bear, NOT a humanoid, NOT a cartoon character standing up. ' +
        'The body is a long horizontal block: the back is level, the shoulders and the hips are at the same height, the chest is NOT raised and the belly is parallel to the ground. ' +
        'Four legs of the same length and thickness stand straight down like pillars, two at the front under the shoulders and two at the back under the hips, with ALL FOUR paws flat on the ground at the same level and clearly apart from the body. ' +
        'The front legs are legs, not arms: they go straight down to the ground, they do not hang at the sides of the chest, have no hands, no bent elbows and hold nothing. ' +
        'The head sits in front of the body at about shoulder height, looking forward; the tail is at the back. Never upright, never sitting, never on its hind legs. Neutral and symmetric.';
    case 'biped':
      return 'POSE AND ANATOMY: a two-legged animal (like a T-rex), NOT a humanoid: it stands on its two strong hind legs with its body leaning forward almost horizontal, head forward, tail stretched out behind for balance, small front limbs held in. Neutral and symmetric.';
    case 'bird':
      return 'POSE AND ANATOMY: a real bird, NOT a humanoid: it stands on its two legs with its body tilted slightly forward, wings folded against its sides, head forward. No arms and no hands. Neutral and symmetric.';
    case 'serpent':
      return 'POSE AND ANATOMY: a legless snake-like body, NOT a humanoid: it rests on the ground in a gentle, compact S-curve with its head raised a little and facing forward. No legs, no arms.';
    case 'fish':
      return 'POSE AND ANATOMY: a real fish-like body, NOT a humanoid: body straight and horizontal as if swimming, fins spread naturally, head forward. No legs, no arms.';
    case 'object':
      return 'POSE: shown upright in its natural, neutral orientation, symmetric where the object is symmetric.';
    default:
      return 'POSE: a neutral, symmetric resting pose that shows its whole shape clearly.';
  }
}

/** Default bones for the build plan (right side only; mirror groups follow). */
export function defaultBones(body: BodyPlan): string {
  switch (body) {
    case 'humanoid': return 'Torso (root) -> Head, RightArm, RightLeg; LeftArm/LeftLeg mirror groups';
    case 'quadruped': return 'Body (root) -> Head (-> Jaw), Tail (or Tail1 -> Tail2), FrontRightLeg, BackRightLeg; FrontLeftLeg/BackLeftLeg mirror groups';
    case 'biped': return 'Body (root) -> Neck/Head (-> Jaw), Tail1 -> Tail2, RightLeg, RightArm; LeftLeg/LeftArm mirror groups';
    case 'bird': return 'Body (root) -> Head (-> Beak), RightWing, RightLeg, Tail; LeftWing/LeftLeg mirror groups';
    case 'serpent': return 'a chain of segments: Head <- Seg1 <- Seg2 <- ... <- TailTip (root in the middle), no mirror groups';
    case 'fish': return 'Body (root) -> Head, Tail, RightFin (+ DorsalFin); LeftFin mirror group';
    case 'object': return 'one root group, plus a group for every part that moves (lid, wheels, blade)';
    default: return 'a root group plus one group per part that should move on its own';
  }
}
