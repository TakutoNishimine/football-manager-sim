/**
 * Single-match runner shared by audit.ts and fixture.ts (Task AK).
 *
 * Pure, side-effect-free (besides the sim's own internal state): given two
 * tactic sheets and a seed it always produces the same score. This is what
 * makes both the serial and worker-pool code paths byte-identical — both
 * call this exact function.
 */
import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import { SIM_DT } from '../../src/sim/constants.ts';
import type { FormationName } from '../../src/sim/formation.ts';
import type { TacticSheet } from './sheets.ts';

/** aTeam = which world team slot (0/1) sheetA occupies for this match. */
export function runMatch(sheetA: TacticSheet, sheetB: TacticSheet, aTeam: 0 | 1, seed: number, minutes: number): { goalsA: number; goalsB: number } {
  const bTeam: 0 | 1 = aTeam === 0 ? 1 : 0;
  const formations: [FormationName, FormationName] = aTeam === 0 ? [sheetA.formation, sheetB.formation] : [sheetB.formation, sheetA.formation];
  const world = createWorld(formations, seed);
  world.tactics[aTeam] = { ...sheetA.tactics };
  world.tactics[bTeam] = { ...sheetB.tactics };

  const totalSteps = Math.round((minutes * 60) / SIM_DT);
  for (let step = 0; step < totalSteps; step++) {
    aiStep(world, SIM_DT);
    stepPhysics(world, SIM_DT);
  }
  return { goalsA: world.score[aTeam], goalsB: world.score[bTeam] };
}
