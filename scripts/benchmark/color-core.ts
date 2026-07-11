/**
 * Task AV color-probe core — pure functions shared by color-probe.ts's serial
 * path (`--workers 1`) and color-worker.ts's parallel path. No console output,
 * no process-level side effects, so both paths produce byte-identical results
 * regardless of thread count or completion order (audit-core.ts precedent).
 *
 * Identical-sheet pairings ONLY: both world teams play the SAME tactic sheet,
 * same seed — a fully symmetric match whose only asymmetry is color / global
 * id order / per-tick decision order. This is the pure "mirror-calibration"
 * channel (reports/task-at.md Part 3): a systematic team0-vs-team1 win split
 * here can only be caused by that channel.
 *
 * The DECISION_ORDER global (src/sim/ai.ts setDecisionOrder) is set ONCE per
 * process/worker by the caller before any job runs — it is not a job param,
 * so a single run measures exactly one arm.
 */
import { runMatch } from '../league/match.ts';
import type { TacticSheet } from '../league/sheets.ts';

/** Per-sheet seed stride — matches-per-sheet must be < this to stay collision-free. */
export const COLOR_SEED_STRIDE = 1000;

export interface ColorJob {
  sheetIndex: number;
  m: number;
}

export interface ColorResult {
  g0: number; // world team 0 goals
  g1: number; // world team 1 goals
}

export function colorSeed(seedBase: number, sheetIndex: number, m: number): number {
  return seedBase + sheetIndex * COLOR_SEED_STRIDE + m;
}

/** Run one identical-sheet match; returns team0/team1 goals under the active DECISION_ORDER. */
export function runColorJob(
  sheets: TacticSheet[],
  job: ColorJob,
  minutes: number,
  seedBase: number,
): ColorResult {
  const s = sheets[job.sheetIndex];
  const seed = colorSeed(seedBase, job.sheetIndex, job.m);
  // aTeam=0: sheet s on team0, same sheet s on team1 → goalsA=score[0], goalsB=score[1].
  const { goalsA, goalsB } = runMatch(s, s, 0, seed, minutes);
  return { g0: goalsA, g1: goalsB };
}
