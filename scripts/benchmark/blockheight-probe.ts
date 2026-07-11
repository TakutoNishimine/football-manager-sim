/**
 * Block-height probe (Task AT, Part 2).
 *
 * Task AD shipped block height 43.21 m (+1.2 over the 30-42 band). AD's diagnosis: not the
 * controller shape (Stage 1 read 39.32, DF-MF gap and monotonicity both improved) but a
 * Stage-2 state-distribution effect — hotter attack leaves more possessions sampled while the
 * block is still stretched in transition (just after a turnover, before it compacts).
 *
 * This probe reports the block-height number TWO ways on identical matches so the PM can see
 * the sampling-definition effect directly:
 *   (a) ALL defending mid-third frames   — the tracking-bench definition (the 43.21 number)
 *   (b) EXCLUDING hot-transition frames  — frames within TRANSITION_S of the last possession
 *       change dropped (the block hasn't settled yet)
 * It also reports the DF-MF gap and line height (must not regress) and supports LINE_DROP_MAX /
 * LINE_STEP_MAX overrides (--drop / --step) to test the controller lever's effect on the spread.
 * Goals / completion / offsides are co-reported per config (block-lever changes are
 * goals-coupled) and --tobase/--tospace set the Part-1 take-on operating point.
 *
 * block height = max(x)-min(x) of a team's outfielders while it defends and the ball is in the
 * mid third — the front-to-back SPREAD of the block (matches tracking/metrics.ts exactly).
 *
 * Deterministic seeds. Usage:
 *   npx tsx scripts/benchmark/blockheight-probe.ts [--matches 40] [--minutes 10]
 *     [--seed-base 1] [--transition 1.5] [--drop 6] [--step 5] [--tobase B] [--tospace S]
 */
import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import { SIM_DT, PITCH_LENGTH } from '../../src/sim/constants.ts';
import { GK_ROLE, setFwCapAhead, FW_CAP_AHEAD } from '../../src/sim/formation.ts';
import { setLineDropMax, setLineStepMax, LINE_DROP_MAX, LINE_STEP_MAX } from '../../src/sim/line.ts';
import { setTeamWeights } from '../../src/sim/weights.ts';
import { toFwdX, isDfLine, isMfLine } from './tracking/metrics.ts';
import { classifyThird } from './metrics.ts';
import { createCompletionTracker } from './completion.ts';

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : def;
}

const matches = argNum('matches', 40);
const minutes = argNum('minutes', 10);
const seedBase = argNum('seed-base', 1);
const transitionS = argNum('transition', 1.5);
{
  const d = argNum('drop', NaN);
  if (Number.isFinite(d)) setLineDropMax(d);
  const s = argNum('step', NaN);
  if (Number.isFinite(s)) setLineStepMax(s);
  // Task AF: ブロック上端の主要レバー(守備時FWの対DFライン深度キャップ)の dose-response 用
  const fc = argNum('fwcap', NaN);
  if (Number.isFinite(fc)) setFwCapAhead(fc);
  // Part-1 の仕掛け動作点でブロック掃引を回すための重み上書き(既定は出荷値)
  const tb = argNum('tobase', NaN);
  const ts = argNum('tospace', NaN);
  const w: { takeOnBase?: number; takeOnSpace?: number } = {};
  if (Number.isFinite(tb)) w.takeOnBase = tb;
  if (Number.isFinite(ts)) w.takeOnSpace = ts;
  if (Object.keys(w).length) {
    setTeamWeights(0, w);
    setTeamWeights(1, w);
  }
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

// per-match block-height samples (mean per match, then aggregate — matches the tracking bench's
// per-match then across-match aggregation for a comparable sd)
const bhAllPerMatch: number[] = [];
const bhSettledPerMatch: number[] = [];
const dfMfPerMatch: number[] = [];
const lineHeightPerMatch: number[] = [];
let framesAll = 0;
let framesSettled = 0;
let goals = 0;
let offsides = 0;
let passesTotal = 0;
let passesCompleted = 0;

for (let m = 0; m < matches; m++) {
  const w = createWorld(['4-4-2', '4-4-2'], seedBase + m);
  const steps = Math.round((minutes * 60) / SIM_DT);
  const completion = createCompletionTracker();
  const bhAll: number[] = [];
  const bhSettled: number[] = [];
  const dfMf: number[] = [];
  const lineH: number[] = [];
  let lastPossTeam: number | null = null;
  let lastChangeClock = -Infinity;
  for (let i = 0; i < steps; i++) {
    const ownerBefore = w.ball.ownerId;
    aiStep(w, SIM_DT);
    stepPhysics(w, SIM_DT);
    completion.step(w, ownerBefore);
    const ownerId = w.ball.ownerId;
    if (ownerId === null) continue;
    const atk = w.players[ownerId].team;
    if (atk !== lastPossTeam) {
      // possession CHANGE (turnover or first possession) — the block is in transition
      if (lastPossTeam !== null) lastChangeClock = w.clock;
      lastPossTeam = atk;
    }
    if (i % 12 !== 0) continue; // 10 Hz sampling (as the offside probe)
    const def = (1 - atk) as 0 | 1;
    const ballFwd = toFwdX(w.ball.pos.x, def);
    if (classifyThird(ballFwd, PITCH_LENGTH) !== 'middle') continue;
    const outfield = w.players.filter((p) => p.team === def && p.role !== GK_ROLE);
    if (outfield.length === 0) continue;
    const xs = outfield.map((p) => p.pos.x);
    const spread = Math.max(...xs) - Math.min(...xs);
    bhAll.push(spread);
    framesAll++;
    const settled = w.clock - lastChangeClock >= transitionS;
    if (settled) {
      bhSettled.push(spread);
      framesSettled++;
    }
    // DF-MF gap + line height (regression guard), by forward-x
    const name = w.formations[def];
    const dfX = outfield.filter((p) => isDfLine(name, p.role)).map((p) => toFwdX(p.pos.x, def));
    const mfX = outfield.filter((p) => isMfLine(name, p.role)).map((p) => toFwdX(p.pos.x, def));
    if (dfX.length > 0) lineH.push(mean(dfX));
    if (dfX.length > 0 && mfX.length > 0) dfMf.push(mean(mfX) - mean(dfX));
  }
  if (bhAll.length) bhAllPerMatch.push(mean(bhAll));
  if (bhSettled.length) bhSettledPerMatch.push(mean(bhSettled));
  if (dfMf.length) dfMfPerMatch.push(mean(dfMf));
  if (lineH.length) lineHeightPerMatch.push(mean(lineH));
  goals += w.score[0] + w.score[1];
  offsides += w.stats[0].offsides + w.stats[1].offsides;
  passesTotal += completion.passesTotal;
  passesCompleted += completion.passesCompleted;
}

console.log(
  `=== Block-height probe: ${matches} matches x ${minutes} min, seeds ${seedBase}-${seedBase + matches - 1}, ` +
    `LINE_DROP_MAX=${LINE_DROP_MAX} LINE_STEP_MAX=${LINE_STEP_MAX} FW_CAP_AHEAD=${FW_CAP_AHEAD}, transition-exclude=${transitionS}s ===`,
);
console.log(
  `Block height (ALL mid-third defending frames): ${mean(bhAllPerMatch).toFixed(2)} ± ${sd(bhAllPerMatch).toFixed(2)} m ` +
    `(band 30-42; n_frames=${framesAll}) — the tracking-bench definition`,
);
console.log(
  `Block height (EXCLUDING <${transitionS}s post-turnover transition frames): ${mean(bhSettledPerMatch).toFixed(2)} ± ${sd(bhSettledPerMatch).toFixed(2)} m ` +
    `(n_frames=${framesSettled}, ${((100 * framesSettled) / Math.max(1, framesAll)).toFixed(1)}% of frames kept)`,
);
console.log(`DF-MF gap: ${mean(dfMfPerMatch).toFixed(2)} m (guard <=15, AD 14.58)`);
console.log(`Line height (own attacking half depth): ${mean(lineHeightPerMatch).toFixed(2)} m`);
console.log(`Goals total/match: ${(goals / matches).toFixed(2)} (target 2.2-2.8)`);
console.log(`Offsides/team/match: ${(offsides / matches / 2).toFixed(2)}`);
console.log(
  `Completion (canonical): ${(passesTotal > 0 ? (100 * passesCompleted) / passesTotal : 0).toFixed(1)}% (band 78-86)`,
);
