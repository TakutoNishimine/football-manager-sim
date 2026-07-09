/**
 * Canonical pass-completion metric — StatsBomb-comparable.
 *
 * ONE definition, used by every script that reports completion (see
 * tasks/task-ao-completion-metric.md). Before this, `contest.ts` and
 * `regression.ts` each re-derived their own version and the readings
 * silently diverged (~79-80% vs ~83-87%) as the sim was tuned over many
 * tasks — gates referencing "floor 83" or "band 85-92" meant different
 * things depending on which script you read.
 *
 * Definition: a pass is COMPLETE iff the passing team is the next team to
 * gain control of the ball (a trap, an "open receiver" auto-control, or a
 * GK catch — anything that assigns `ball.ownerId`). It is INCOMPLETE if the
 * passing team shoots before any reception resolves the pass (the phase
 * ends), or if the opposing team gains control first (an interception). A
 * pass still in flight when the match clock runs out is dropped from both
 * totals — there is no real-world "event" to log for it, matching how
 * `scripts/benchmark/sim.ts` always handled it.
 *
 * This mirrors the real-data definition used in `scripts/benchmark/real.ts`
 * (StatsBomb: `completed = !pass.outcome`, i.e. absent outcome = complete).
 *
 * Known deviation (~+0.9pp, pre-existing, shared with the old sim.ts measure):
 * a pass BLOCKED/deflected mid-flight (world.ts probabilistic block — no
 * ownerId assigned) that the passing team then recovers counts COMPLETE here,
 * while StatsBomb logs blocked passes Incomplete regardless of recovery. The
 * sim-vs-real gap column therefore reads ~1pp friendlier than strict StatsBomb
 * semantics. Measured at ~1.6 such passes/match (review of task-ao).
 */
import type { World } from '../../src/sim/world.ts';
import { len } from '../../src/sim/vec.ts';

/** Below this, `executePass`'s resulting kick is degenerate (near-zero-distance
 * target) and StatsBomb would have no corresponding event to log — exclude it
 * from both totals, same as the original event-benchmark behavior. */
const MIN_PASS_SPEED = 0.1;

export interface PassResolution {
  team: 0 | 1;
  completed: boolean;
  /** What ended the pass: a reception (by either team), or the passing team shooting first. */
  via: 'reception' | 'shot';
}

export interface CompletionTrackerHooks {
  /** A pass was just kicked; its outcome is not known yet. */
  onPassStart?: (team: 0 | 1) => void;
  /** The pending pass's fate was just decided (shot or reception). */
  onPassResolved?: (res: PassResolution) => void;
}

export interface CompletionTracker {
  /**
   * Call once per sim tick, immediately after `aiStep` + `stepPhysics`, with
   * the ball owner from BEFORE that tick's stepping.
   */
  step(world: World, ownerBefore: number | null): void;
  readonly passesTotal: number;
  readonly passesCompleted: number;
  readonly completionPct: number;
}

export function createCompletionTracker(hooks: CompletionTrackerHooks = {}): CompletionTracker {
  let pendingTeam: 0 | 1 | null = null;
  let passesTotal = 0;
  let passesCompleted = 0;
  const prevPassCounts: [number, number] = [0, 0];
  const prevShotCounts: [number, number] = [0, 0];

  function resolve(team: 0 | 1, completed: boolean, via: 'reception' | 'shot'): void {
    // Counted at RESOLUTION, not at kick — a pass still in flight when the
    // match clock runs out must be dropped from both totals (there is no
    // real-world "event" to log for it), not counted as an attempt with no
    // possible completion.
    passesTotal++;
    if (completed) passesCompleted++;
    hooks.onPassResolved?.({ team, completed, via });
    pendingTeam = null;
  }

  return {
    get passesTotal() {
      return passesTotal;
    },
    get passesCompleted() {
      return passesCompleted;
    },
    get completionPct() {
      return passesTotal > 0 ? (passesCompleted / passesTotal) * 100 : 0;
    },
    step(world, ownerBefore) {
      const ownerAfter = world.ball.ownerId;

      // New pass kicked — becomes the (only) pending pass. Degenerate
      // near-zero-speed kicks (MIN_PASS_SPEED) are excluded entirely.
      // (passesTotal is incremented on resolution, not here — see resolve().)
      for (const team of [0, 1] as const) {
        if (world.stats[team].passes > prevPassCounts[team]) {
          prevPassCounts[team] = world.stats[team].passes;
          if (len(world.ball.vel) > MIN_PASS_SPEED) {
            pendingTeam = team;
            hooks.onPassStart?.(team);
          }
        }
      }

      // A shot ends any pending pass as incomplete (the phase is over).
      for (const team of [0, 1] as const) {
        if (world.stats[team].shots > prevShotCounts[team]) {
          prevShotCounts[team] = world.stats[team].shots;
          if (pendingTeam !== null) resolve(pendingTeam, false, 'shot');
        }
      }

      // Reception resolves the pending pass: complete iff the same team
      // gains control next; any other team's control is an interception.
      if (pendingTeam !== null && ownerAfter !== null && ownerBefore !== ownerAfter) {
        const receiver = world.players[ownerAfter];
        resolve(pendingTeam, receiver.team === pendingTeam, 'reception');
      }
    },
  };
}

/**
 * Gate floor + informal display band for pass completion, recalibrated for
 * the canonical measure in Task AO (2026-07-07). The old approximation
 * (`1 - interceptions/passes`) gated at floor 83 with the sim reading
 * 82.8-83.5% on two 40-seed windows (already failing). The canonical measure
 * on the SAME windows reads 79.7% (seeds 1-40) and 80.5% (seeds 101-140) —
 * a stable ~3pp gap from the approximation, and just under real (84.8%,
 * scripts/benchmark/real.ts). See reports/task-ao.md for the full paired
 * table.
 *
 * Floor 75 leaves ~5pp of margin below the observed ~80% so ordinary sim
 * tuning doesn't flip this gate red the way the un-recalibrated floor 83
 * did; it still catches an actual regression (e.g. defense suddenly winning
 * most duels). The band is informational only (contest.ts), not gated.
 */
// PM calibration (task-ao review): canonical measure reads 79.7-80.5% across two
// 40-seed windows (±0.5pp aggregate noise). Floor 77 leaves ~2.7pp real margin;
// the [78,86] band below is surfaced as a WARN in regression.ts so drift toward
// the floor is visible in CI logs before it gates.
export const COMPLETION_FLOOR_PCT = 77;
export const COMPLETION_BAND_PCT: [number, number] = [78, 86];
