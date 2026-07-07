/**
 * Curated tactic-sheet pool for the league meta-audit (scripts/league/audit.ts).
 *
 * This is a script-local, non-serializable contract — the real TacticSheet
 * serialization + clamped weight dials land in Task AG. TEAM_WEIGHTS
 * (src/sim/weights.ts) is a shared module global, so both teams always play
 * with identical attack weights; a sheet here differentiates only formation +
 * the 4 TeamTactics scalars.
 */
import type { FormationName } from '../../src/sim/formation.ts';
import type { TeamTactics } from '../../src/sim/types.ts';

export interface TacticSheet {
  name: string;
  formation: FormationName;
  tactics: TeamTactics;
}

const BASE: TeamTactics = { manMark: 0, pressIntensity: 0.5, lineHeight: 0, wideRuns: 0.5 };

export const SHEETS: TacticSheet[] = [
  // Reference.
  { name: 'default-442', formation: '4-4-2', tactics: { ...BASE } },

  // Known exploit #1 (README.md:112): manMark=1 blowouts vs mirror tactics.
  { name: 'manmark-442', formation: '4-4-2', tactics: { ...BASE, manMark: 1 } },

  // Known exploit #2 (reports/task-a.md:65): high/deep line asymmetry -> 26-1.
  { name: 'highline-442', formation: '4-4-2', tactics: { ...BASE, lineHeight: 1 } },
  { name: 'lowblock-442', formation: '4-4-2', tactics: { ...BASE, lineHeight: -1, pressIntensity: 0.2 } },

  // Corner combinations.
  { name: 'gegenpress-442', formation: '4-4-2', tactics: { ...BASE, pressIntensity: 1, lineHeight: 1 } },
  { name: 'catenaccio-442', formation: '4-4-2', tactics: { ...BASE, manMark: 1, lineHeight: -1 } },
  { name: 'wide-442', formation: '4-4-2', tactics: { ...BASE, wideRuns: 1 } },

  // One default sheet per remaining formation, for formation-only coverage.
  { name: 'default-433', formation: '4-3-3', tactics: { ...BASE } },
  { name: 'default-4231', formation: '4-2-3-1', tactics: { ...BASE } },
  { name: 'default-352', formation: '3-5-2', tactics: { ...BASE } },
  { name: 'default-343', formation: '3-4-3', tactics: { ...BASE } },
  { name: 'default-532', formation: '5-3-2', tactics: { ...BASE } },
];
