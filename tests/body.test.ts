import { describe, expect, it } from 'vitest';
import { guessBody, poseText } from '../src/server/body';
import { heroPrompt, KEY_COLORS } from '../src/server/prompts';
import { DEFAULT_STYLE } from '../src/server/styles';

describe('body plans', () => {
  it('guesses the body from the idea', () => {
    expect(guessBody('a fox pet with a bushy tail')).toBe('quadruped');
    expect(guessBody('a chunky blocky knight in silver armor')).toBe('humanoid');
    expect(guessBody('a t-rex dinosaur')).toBe('biped');
    expect(guessBody('a stegosaurus dinosaur')).toBe('quadruped');
    expect(guessBody('a little chicken')).toBe('bird');
    expect(guessBody('a desert snake')).toBe('serpent');
    expect(guessBody('a golden treasure chest')).toBe('object');
    expect(guessBody('a strange glowing blob')).toBe('other');
  });

  it('only the subject\'s own anatomy goes into the prompt', () => {
    const fox = heroPrompt('a fox', DEFAULT_STYLE, KEY_COLORS[0], false, '', 'quadruped');
    expect(fox).toMatch(/all four legs/);
    expect(fox).not.toMatch(/arms hanging/);
    expect(heroPrompt('a knight', DEFAULT_STYLE, KEY_COLORS[0], false, '', 'humanoid')).toMatch(/arms hanging straight down/);
    expect(poseText('serpent')).toMatch(/No legs/);
  });
});
