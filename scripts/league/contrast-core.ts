/**
 * Contrast core (Task AK) — pure functions shared by contrast.ts's serial
 * path (`--workers 1`) and contrast-worker.ts's parallel path. No console
 * output here: `runConfig` writes its own per-match progress line to
 * stderr (safe from worker threads — a Worker's stdout/stderr are piped
 * straight through to the parent's by default), but produces no other
 * side effects, so results are identical regardless of thread/order.
 */
import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import { SIM_DT, PITCH_LENGTH } from '../../src/sim/constants.ts';
import { GK_ROLE, type FormationName } from '../../src/sim/formation.ts';
import type { TeamTactics } from '../../src/sim/types.ts';
import { classifyThird } from '../benchmark/metrics.ts';
import { mean, toFwdX, isDfLine } from '../benchmark/tracking/metrics.ts';

export const BASE: TeamTactics = { manMark: 0, pressIntensity: 0.5, lineHeight: 0, wideRuns: 0.5 };

export const SEED_BASE = 300000;
export const SEED_CONFIG_STRIDE = 1000;
export const SAMPLE_EVERY_STEPS = 12; // 10Hz, matches the tracking benchmark

// ── One instrumented match ────────────────────────────────────────────────────

export interface ContrastSample {
  lineHeightM: number; // measureTeam DF-line height while defending
  markDistM: number; // measureTeam ALL outfield defenders' mean nearest-opponent distance while defending
  markDistDfM: number; // measureTeam DF-LINE-ONLY defenders' mean nearest-opponent distance while defending (Task AK #3 — the all-outfield mean dilutes manMark's signal)
  wingYM: number; // mean |y| of measureTeam on-ball events in attacking third
  ppda: number; // opponent passes / (measureTeam steals + interceptions); NaN if 0 defensive actions (Task AK #2)
  oppPassesPerMin: number;
  possChangesPerMin: number;
  goalsMeasure: number;
  goalsOpp: number;
}

/**
 * Runs one match with `tactics` on each team and measures all lever axes from
 * the perspective of `measureTeam`.
 */
export function runContrastMatch(
  measureTeam: 0 | 1,
  tactics: [TeamTactics, TeamTactics],
  formation: FormationName,
  seed: number,
  minutes: number,
): ContrastSample {
  const oppTeam: 0 | 1 = measureTeam === 0 ? 1 : 0;
  const world = createWorld([formation, formation], seed);
  world.tactics[0] = { ...tactics[0] };
  world.tactics[1] = { ...tactics[1] };

  const totalSteps = Math.round((minutes * 60) / SIM_DT);

  const lineHeightSamples: number[] = [];
  const markDistSamples: number[] = [];
  const markDistDfSamples: number[] = [];
  const wingYSamples: number[] = [];

  const prevPassCounts: [number, number] = [0, 0];
  const prevShotCounts: [number, number] = [0, 0];

  let lastOwnerTeam: number | null = null;
  let possChanges = 0;

  for (let step = 0; step < totalSteps; step++) {
    aiStep(world, SIM_DT);
    stepPhysics(world, SIM_DT);

    const owner = world.ball.ownerId !== null ? world.players[world.ball.ownerId] : null;
    const ownerTeam = owner ? owner.team : null;

    // ── Possession changes ────────────────────────────────────────────────────
    if (ownerTeam !== null) {
      if (lastOwnerTeam !== null && ownerTeam !== lastOwnerTeam) possChanges++;
      lastOwnerTeam = ownerTeam;
    }

    // ── On-ball events: wing usage (mean |y| in the attacking third) ──────────
    for (const team of [0, 1] as const) {
      const passed = world.stats[team].passes > prevPassCounts[team];
      const shot = world.stats[team].shots > prevShotCounts[team];
      prevPassCounts[team] = world.stats[team].passes;
      prevShotCounts[team] = world.stats[team].shots;
      if ((passed || shot) && team === measureTeam) {
        const fwdX = toFwdX(world.ball.pos.x, measureTeam);
        if (classifyThird(fwdX, PITCH_LENGTH) === 'attacking') {
          wingYSamples.push(Math.abs(world.ball.pos.y));
        }
      }
    }

    // ── 10Hz defensive-shape sample (only while measureTeam is defending) ─────
    if (step % SAMPLE_EVERY_STEPS === 0 && ownerTeam !== null && ownerTeam === oppTeam) {
      const outfield = world.players.filter((p) => p.team === measureTeam && p.role !== GK_ROLE);
      const opponents = world.players.filter((p) => p.team === oppTeam && p.role !== GK_ROLE);

      // Line height: mean forward-x of the DF line.
      const dfLine = outfield.filter((p) => isDfLine(formation, p.role));
      if (dfLine.length > 0) {
        lineHeightSamples.push(mean(dfLine.map((p) => toFwdX(p.pos.x, measureTeam))));
      }

      // Marking tightness: each defender's distance to its nearest opponent.
      // Reported both for ALL outfield players and for the DF-line only
      // (Task AK #3): the all-outfield mean mixes in midfielders/forwards who
      // aren't targets of manMark's assignment logic, diluting the axis.
      if (opponents.length > 0) {
        for (const d of outfield) {
          let best = Infinity;
          for (const o of opponents) {
            const dd = Math.hypot(d.pos.x - o.pos.x, d.pos.y - o.pos.y);
            if (dd < best) best = dd;
          }
          markDistSamples.push(best);
          if (isDfLine(formation, d.role)) markDistDfSamples.push(best);
        }
      }
    }
  }

  const oppPasses = world.stats[oppTeam].passes;
  const defActions = world.stats[measureTeam].steals + world.stats[measureTeam].interceptions;

  return {
    lineHeightM: mean(lineHeightSamples),
    markDistM: mean(markDistSamples),
    markDistDfM: mean(markDistDfSamples),
    wingYM: mean(wingYSamples),
    // Task AK #2: 0 defensive actions makes PPDA undefined, not "opponent
    // passes" (that discontinuous fallback blended a spurious value into the
    // axis mean). runConfig() skips NaN samples from the axis mean and
    // reports the skip count instead.
    ppda: defActions > 0 ? oppPasses / defActions : NaN,
    oppPassesPerMin: oppPasses / minutes,
    possChangesPerMin: possChanges / minutes,
    goalsMeasure: world.score[measureTeam],
    goalsOpp: world.score[oppTeam],
  };
}

// ── Config runner ──────────────────────────────────────────────────────────────

export function pointsFor(own: number, opp: number): number {
  if (own > opp) return 3;
  if (own === opp) return 1;
  return 0;
}

export interface ConfigResult {
  axis: number[]; // designated-axis value per match, EXCLUDING skipped (NaN) matches
  skipped: number; // count of matches excluded from `axis` (currently: PPDA with 0 defensive actions)
  points: number[]; // measureTeam points vs default per match (all n matches, unaffected by axis skips)
  samples: ContrastSample[]; // all n matches' full samples, for secondary-axis reporting (e.g. manMark's DF-line axis)
}

export type AxisKey = 'lineHeightM' | 'ppda' | 'wingYM' | 'markDistM' | 'markDistDfM';

/** One unit of work for the contrast worker pool (Task AK): a single lever value's N-match run. */
export interface ConfigJob {
  configIndex: number;
  lever: keyof TeamTactics;
  value: number;
  axisKey: AxisKey;
  label: string;
}

/**
 * Runs N matches for one lever value. The lever is set on the measure team; the
 * opponent plays BASE. measureTeam alternates 0/1 across matches (color balance).
 */
export function runConfig(
  lever: keyof TeamTactics,
  value: number,
  axisKey: AxisKey,
  configIndex: number,
  n: number,
  minutes: number,
  formation: FormationName,
  label: string,
): ConfigResult {
  if (n >= SEED_CONFIG_STRIDE) {
    throw new Error(`--n must be < ${SEED_CONFIG_STRIDE} (seed stride) to keep seeds collision-free`);
  }
  const axis: number[] = [];
  const points: number[] = [];
  const samples: ContrastSample[] = [];
  let skipped = 0;
  for (let m = 0; m < n; m++) {
    const measureTeam: 0 | 1 = m % 2 === 0 ? 0 : 1;
    const oppTeam: 0 | 1 = measureTeam === 0 ? 1 : 0;
    const tactics: [TeamTactics, TeamTactics] = [{ ...BASE }, { ...BASE }];
    tactics[measureTeam] = { ...BASE, [lever]: value };
    tactics[oppTeam] = { ...BASE };
    const seed = SEED_BASE + configIndex * SEED_CONFIG_STRIDE + m;
    const s = runContrastMatch(measureTeam, tactics, formation, seed, minutes);
    samples.push(s);
    const axisValue = s[axisKey];
    if (Number.isNaN(axisValue)) skipped++;
    else axis.push(axisValue);
    points.push(pointsFor(s.goalsMeasure, s.goalsOpp));
    process.stderr.write(`    [${label}=${value}] ${m + 1}/${n} seed ${seed}: axis=${Number.isNaN(axisValue) ? 'skipped' : axisValue.toFixed(2)} pts=${pointsFor(s.goalsMeasure, s.goalsOpp)}\n`);
  }
  return { axis, skipped, points, samples };
}
