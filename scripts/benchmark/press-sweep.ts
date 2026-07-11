/**
 * Press-geometry sweep probe (Task AF).
 *
 * Runs N seeded matches with in-process overrides of the shared press geometry
 * (src/sim/press.ts setters) and/or asymmetric pressIntensity, and reports the
 * coupled economy the press touches: goals, take-ons, steals/interceptions,
 * completion, possessions/min, shots/possession, offsides, and per-team PPDA
 * (opp passes / own def actions — the league:contrast axis) so the lever's
 * direction is readable from a single asymmetric run.
 *
 * Deterministic seeds -> CI == local. Meant for quick ablations locally (small N)
 * and 40-seed validation on the compute mirror:
 *   gh workflow run sim-run.yml -R TakutoNishimine/football-manager-sim --ref task-af \
 *     -f command="npx tsx scripts/benchmark/press-sweep.ts --matches 40"
 *
 * Usage:
 *   npx tsx scripts/benchmark/press-sweep.ts [--matches 8] [--minutes 6] [--seed-base 1]
 *     [--press0 0.5] [--press1 0.5]           # per-team pressIntensity
 *     [--standoff-base 2.0] [--standoff-press 0.5] [--steer 1.2]
 *     [--cover-base 4] [--cover-gain 8]
 *     [--second-base 6] [--second-gain 16]
 *     [--depth-base 6] [--depth-press 2]
 *     [--fwcap 26]
 */
import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import { SIM_DT } from '../../src/sim/constants.ts';
import { setFwCapAhead } from '../../src/sim/formation.ts';
import { setPressGeometry } from '../../src/sim/press.ts';
import { createCompletionTracker } from './completion.ts';

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : def;
}

const matches = argNum('matches', 8);
const minutes = argNum('minutes', 6);
const seedBase = argNum('seed-base', 1);
const press0 = argNum('press0', 0.5);
const press1 = argNum('press1', 0.5);
{
  const geo = {
    jockeyStandoffBase: argNum('standoff-base', NaN),
    jockeyStandoffPress: argNum('standoff-press', NaN),
    jockeySteerShift: argNum('steer', NaN),
    pressCoverBase: argNum('cover-base', NaN),
    pressCoverGain: argNum('cover-gain', NaN),
    secondPressBase: argNum('second-base', NaN),
    secondPressGain: argNum('second-gain', NaN),
    coverDepthBase: argNum('depth-base', NaN),
    coverDepthPress: argNum('depth-press', NaN),
  };
  const set: Record<string, number> = {};
  for (const [k, v] of Object.entries(geo)) if (Number.isFinite(v)) set[k] = v;
  if (Object.keys(set).length) setPressGeometry(set);
  const fc = argNum('fwcap', NaN);
  if (Number.isFinite(fc)) setFwCapAhead(fc);
}

let goals = 0;
let possChanges = 0;
const tally = {
  toAtt: [0, 0],
  toWon: [0, 0],
  steals: [0, 0],
  ints: [0, 0],
  shots: [0, 0],
  passes: [0, 0],
  offsides: [0, 0],
  tackleLost: [0, 0],
};
let passesTotal = 0;
let passesCompleted = 0;
let possessions = 0;

for (let m = 0; m < matches; m++) {
  const w = createWorld(['4-4-2', '4-4-2'], seedBase + m);
  w.tactics[0] = { ...w.tactics[0], pressIntensity: press0 };
  w.tactics[1] = { ...w.tactics[1], pressIntensity: press1 };
  const steps = Math.round((minutes * 60) / SIM_DT);
  const completion = createCompletionTracker();
  let lastPossTeam: number | null = null;
  for (let i = 0; i < steps; i++) {
    const ownerBefore = w.ball.ownerId;
    aiStep(w, SIM_DT);
    stepPhysics(w, SIM_DT);
    completion.step(w, ownerBefore);
    const ownerId = w.ball.ownerId;
    if (ownerId === null) continue;
    const t = w.players[ownerId].team;
    if (t !== lastPossTeam) {
      if (lastPossTeam !== null) possChanges++;
      possessions++;
      lastPossTeam = t;
    }
  }
  goals += w.score[0] + w.score[1];
  for (const t of [0, 1] as const) {
    tally.toAtt[t] += w.stats[t].takeOnAtt;
    tally.toWon[t] += w.stats[t].takeOnWon;
    tally.steals[t] += w.stats[t].steals;
    tally.ints[t] += w.stats[t].interceptions;
    tally.shots[t] += w.stats[t].shots;
    tally.passes[t] += w.stats[t].passes;
    tally.offsides[t] += w.stats[t].offsides;
    tally.tackleLost[t] += w.stats[t].tackleLost;
  }
  passesTotal += completion.passesTotal;
  passesCompleted += completion.passesCompleted;
}

const per = (x: number) => (x / matches).toFixed(2);
const toAtt = tally.toAtt[0] + tally.toAtt[1];
const toWon = tally.toWon[0] + tally.toWon[1];
const steals = tally.steals[0] + tally.steals[1];
const ints = tally.ints[0] + tally.ints[1];
const shots = tally.shots[0] + tally.shots[1];
// PPDA per team: opponent passes / own defensive actions (contrast-core definition)
const ppda0 = tally.passes[1] / Math.max(1, tally.steals[0] + tally.ints[0]);
const ppda1 = tally.passes[0] / Math.max(1, tally.steals[1] + tally.ints[1]);

console.log(
  `=== Press sweep: ${matches}x${minutes}min seeds ${seedBase}-${seedBase + matches - 1} press=[${press0},${press1}] ===`,
);
console.log(
  `goals/match ${per(goals)} | toAtt/match ${per(toAtt)} @ ${toAtt ? ((100 * toWon) / toAtt).toFixed(1) : '—'}% | ` +
    `steals ${per(steals)} | int ${per(ints)} | shots/match ${per(shots)} | sh/poss ${(shots / Math.max(1, possessions) * 100).toFixed(1)}%`,
);
console.log(
  `completion ${(passesTotal ? (100 * passesCompleted) / passesTotal : 0).toFixed(1)}% | poss/min ${(possessions / (matches * minutes)).toFixed(2)} | ` +
    `possChanges/match ${per(possChanges)} | offsides/team ${per((tally.offsides[0] + tally.offsides[1]) / 2)}`,
);
console.log(`PPDA team0 ${ppda0.toFixed(2)} | PPDA team1 ${ppda1.toFixed(2)} (lower = more aggressive defense)`);
for (const t of [0, 1] as const) {
  console.log(
    `  team${t}: steals ${per(tally.steals[t])} | int ${per(tally.ints[t])} | tackle stabs ${per(
      tally.steals[t] + tally.tackleLost[t],
    )} (lost ${per(tally.tackleLost[t])}) | passes ${per(tally.passes[t])} | toAtt ${per(tally.toAtt[t])}`,
  );
}
