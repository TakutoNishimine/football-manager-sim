/**
 * Standard headless regression: N seeded matches, checked against the
 * viable-match bands every sim task must preserve (see README / REALISM-ROADMAP).
 *
 * Usage: npx tsx scripts/regression.ts [--matches 40] [--minutes 10] [--seed-base 1]
 * Exit code 1 if any band fails (CI-friendly).
 */
import { createWorld, stepPhysics } from '../src/sim/world.ts';
import { aiStep } from '../src/sim/ai.ts';
import { SIM_DT } from '../src/sim/constants.ts';
import { createCompletionTracker, COMPLETION_FLOOR_PCT } from './benchmark/completion.ts';

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`--${name} must be a positive number`);
    process.exit(1);
  }
  return v;
}

const matches = argNum('matches', 40);
const minutes = argNum('minutes', 10);
const seedBase = argNum('seed-base', 1);

const GOALS_BAND: [number, number] = [1.5, 3.5];
// Task AO: recalibrated to the canonical (StatsBomb-comparable) completion
// measure — see scripts/benchmark/completion.ts and reports/task-ao.md for
// the paired old (interception-approximation) vs new 40-seed table behind
// this number. The old floor (83) gated the OLD approximation, which read
// ~3pp higher than the canonical measure for the same matches.
const COMPLETION_FLOOR = COMPLETION_FLOOR_PCT; // %
const COMPUTE_MAX = 2.6; // s/match

let totalGoals = 0;
let blue = 0, red = 0, draw = 0;
let interceptions = 0, steals = 0;
let passesTotal = 0, passesCompleted = 0;
const t0 = performance.now();
for (let m = 0; m < matches; m++) {
  const w = createWorld(['4-4-2', '4-4-2'], seedBase + m);
  const steps = Math.round((minutes * 60) / SIM_DT);
  const completion = createCompletionTracker();
  for (let i = 0; i < steps; i++) {
    const ownerBefore = w.ball.ownerId;
    aiStep(w, SIM_DT);
    stepPhysics(w, SIM_DT);
    completion.step(w, ownerBefore);
  }
  totalGoals += w.score[0] + w.score[1];
  if (w.score[0] > w.score[1]) blue++;
  else if (w.score[1] > w.score[0]) red++;
  else draw++;
  interceptions += w.stats[0].interceptions + w.stats[1].interceptions;
  steals += w.stats[0].steals + w.stats[1].steals;
  passesTotal += completion.passesTotal;
  passesCompleted += completion.passesCompleted;
}
const secsPerMatch = (performance.now() - t0) / 1000 / matches;
const goalsPerMatch = totalGoals / matches;
// Canonical measure (Task AO): a pass is completed iff the passing team is
// the next to control the ball (scripts/benchmark/completion.ts) — the same
// definition scripts/benchmark/{sim,contest}.ts use.
const completion = passesTotal > 0 ? 100 * (passesCompleted / passesTotal) : 0;

const goalsPass = goalsPerMatch >= GOALS_BAND[0] && goalsPerMatch <= GOALS_BAND[1];
const completionPass = completion >= COMPLETION_FLOOR;
// The compute budget is calibrated for the local dev machine; CI runners are
// several times slower, so on CI the compute check is informational only.
const onCI = process.env.CI !== undefined;
const computePass = secsPerMatch <= COMPUTE_MAX || onCI;
const computeLabel = secsPerMatch <= COMPUTE_MAX ? 'PASS' : onCI ? 'SLOW (informational on CI)' : 'FAIL';

console.log(`=== Headless regression: ${matches} matches x ${minutes} min, seeds ${seedBase}-${seedBase + matches - 1} ===`);
console.log(`Goals total/match: ${goalsPerMatch.toFixed(3)} (band ${GOALS_BAND[0]}-${GOALS_BAND[1]}) — ${goalsPass ? 'PASS' : 'FAIL'}`);
console.log(`Completion (canonical): ${completion.toFixed(1)}% (floor ${COMPLETION_FLOOR}%) — ${completionPass ? 'PASS' : 'FAIL'}`);
console.log(`Compute: ${secsPerMatch.toFixed(3)} s/match (max ${COMPUTE_MAX}) — ${computeLabel}`);
console.log(`Record: blue ${blue} - red ${red} - draw ${draw}`);
console.log(`Turnovers/match: steals ${(steals / matches).toFixed(1)}, interceptions ${(interceptions / matches).toFixed(1)}`);

if (!(goalsPass && completionPass && computePass)) process.exit(1);
