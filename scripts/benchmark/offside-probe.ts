/**
 * Offside + defensive-line probe (Task AD acceptance metrics).
 *
 * Reports what the existing benches don't break out:
 *   - offsides called / team / match      (improve: 1-6, real ~2-3; >6 = runs not retiming)
 *   - behind-the-line camping             (fraction of possession frames with >=1 attacker in
 *     offside position, strict geometry; plus sustained (>1.5s) camping events per match —
 *     "eliminated" means the sustained events collapse vs the pre-offside baseline)
 *   - box occupancy                        (tracking-bench definition; improve: 0.12 -> >= 0.3)
 *   - line responsiveness eye test         (defending-team line depth split by game state:
 *     unpressured carrier (drop expected) vs pressed carrier (step expected))
 *   - goals / shots / completion           (preserve: goals 2.2-2.8, completion 78-86)
 *
 * Deterministic (seeded). Quick local smoke at small N; authoritative 40-seed on mirror CI.
 *
 * Usage:
 *   npx tsx scripts/benchmark/offside-probe.ts [--matches 40] [--minutes 10] [--seed-base 1]
 *       [--soft <m>] [--hold <m>]     # margin overrides (in-process setters)
 *   npx tsx scripts/benchmark/offside-probe.ts --sweep   # grid over (soft, hold) margins
 */
import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import { setShotErrScale, SHOT_ERR_SCALE } from '../../src/sim/constants.ts';
import { aiStep } from '../../src/sim/ai.ts';
import { SIM_DT, PITCH_LENGTH } from '../../src/sim/constants.ts';
import { GK_ROLE } from '../../src/sim/formation.ts';
import {
  defensiveLineX,
  isOffsidePosition,
  setOffsideSoftMargin,
  setRunHoldMargin,
  setRunThroughGate,
  setRunBreakDepth,
  OFFSIDE_SOFT_MARGIN,
  RUN_HOLD_MARGIN,
  RUN_THROUGH_GATE,
} from '../../src/sim/line.ts';
import { createCompletionTracker } from './completion.ts';
import { inOpponentBox } from './tracking/metrics.ts';

const HALF_L = PITCH_LENGTH / 2;

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : def;
}

const matches = argNum('matches', 40);
const minutes = argNum('minutes', 10);
const seedBase = argNum('seed-base', 1);
const sweep = process.argv.includes('--sweep');
// 期待値側ノブの上書き(Task AQ の setter を再掃引するため。既定は出荷値のまま)
{
  const se = argNum('shot-err', NaN);
  if (Number.isFinite(se)) setShotErrScale(se);
  const tg = argNum('tb-gate', NaN);
  if (Number.isFinite(tg)) setRunThroughGate(tg);
  const bd = argNum('break-depth', NaN);
  if (Number.isFinite(bd)) setRunBreakDepth(bd);
}

interface Agg {
  offsides: number;
  goals: number;
  shots: number;
  campFrames: number;
  possFrames: number;
  campEvents: number; // >1.5s sustained offside-position streaks (any attacker)
  boxSum: number;
  boxFrames: number;
  passesTotal: number;
  passesCompleted: number;
  // line responsiveness (defending team's controller depth from own goal, by game state)
  dropDepthSum: number;
  dropN: number;
  stepDepthSum: number;
  stepN: number;
  // camping observable comparable to scripts/benchmark/offside-baseline.ts (main):
  // arrived runBehind runners' depth vs the marker-excluded last outfield defender
  runnerDeltaSum: number;
  runnerDeltaN: number;
  // back-line flatness: depth spread (max-min) of the 4 deepest outfield defenders while defending
  flatSum: number;
  flatN: number;
}

function runConfig(soft: number, hold: number): Agg {
  setOffsideSoftMargin(soft);
  setRunHoldMargin(hold);
  const a: Agg = {
    offsides: 0, goals: 0, shots: 0,
    campFrames: 0, possFrames: 0, campEvents: 0,
    boxSum: 0, boxFrames: 0,
    passesTotal: 0, passesCompleted: 0,
    dropDepthSum: 0, dropN: 0, stepDepthSum: 0, stepN: 0,
    runnerDeltaSum: 0, runnerDeltaN: 0,
    flatSum: 0, flatN: 0,
  };
  for (let m = 0; m < matches; m++) {
    const w = createWorld(['4-4-2', '4-4-2'], seedBase + m);
    const completion = createCompletionTracker();
    const steps = Math.round((minutes * 60) / SIM_DT);
    // per-player camping streak clocks (seconds in offside position, contiguous)
    const streak = new Map<number, number>();
    for (let i = 0; i < steps; i++) {
      const ownerBefore = w.ball.ownerId;
      aiStep(w, SIM_DT);
      stepPhysics(w, SIM_DT);
      completion.step(w, ownerBefore);
      if (i % 12 !== 0) continue; // 10Hz sampling
      const ownerId = w.ball.ownerId;
      if (ownerId === null) continue;
      const atk = w.players[ownerId].team;
      const def = (1 - atk) as 0 | 1;
      a.possFrames++;
      // 到着済み runBehind ランナーの「マーカー除外ライン」に対する深さ(キャンプの直接観測、
      // offside-baseline.ts と同一定義)。main では +3〜4m(ライン裏のキャンプ)、
      // Task AD 後は ≈0(ラインとレベルのホールド)になるはず。
      // 「ステーションに立っている」= 現在の moveTarget(main: ライン裏のキャンプ地点、
      // Task AD: オンサイドのホールド点)の4m以内。除外はランナーの「ゴール側」2.5m以内の
      // 相手のみ = 引きずられたマーカー。レベルに立つ味方側マーカー(Task AD のクランプ)は
      // 除外しない — main +3.7(マーカーごとライン裏)vs AD ≈0(ラインとレベル)が出る。
      for (const p of w.players) {
        if (p.team !== atk || p.intent?.kind !== 'runBehind') continue;
        if (Math.hypot(p.pos.x - p.moveTarget.x, p.pos.y - p.moveTarget.y) > 4) continue;
        const sgn = atk === 0 ? 1 : -1;
        let deepest = -Infinity;
        for (const q of w.players) {
          if (q.team === atk || q.role === GK_ROLE) continue;
          const goalSideOfRunner = sgn * q.pos.x > sgn * p.pos.x;
          if (goalSideOfRunner && Math.hypot(q.pos.x - p.pos.x, q.pos.y - p.pos.y) < 2.5) continue;
          const prog = sgn * q.pos.x;
          if (prog > deepest) deepest = prog;
        }
        if (deepest === -Infinity) continue;
        a.runnerDeltaSum += sgn * p.pos.x - deepest;
        a.runnerDeltaN++;
      }
      // バックラインの平坦さ: 守備側の最深4人(GK除く)の深さスプレッド。main では
      // キャンパーに引きずられたマーカーが1人だけ深く残り、スプレッドが大きい。
      {
        const dsgn = def === 0 ? 1 : -1;
        const depths: number[] = [];
        for (const q of w.players) {
          if (q.team !== def || q.role === GK_ROLE) continue;
          depths.push(dsgn * q.pos.x);
        }
        depths.sort((x, y) => x - y);
        if (depths.length >= 2) {
          a.flatSum += depths[1] - depths[0]; // 最深と2番目のギャップ=引きずられたマーカーの孤立度
          a.flatN++;
        }
      }
      // camping: any attacker (not the owner) in strict offside position
      let any = false;
      for (const p of w.players) {
        if (p.team !== atk || p.role === GK_ROLE || p.id === ownerId) continue;
        if (isOffsidePosition(w, atk, p.pos)) {
          any = true;
          const s = (streak.get(p.id) ?? 0) + 0.1;
          streak.set(p.id, s);
          if (Math.abs(s - 1.5) < 0.049) a.campEvents++; // crossed the 1.5s threshold
        } else {
          streak.set(p.id, 0);
        }
      }
      if (any) a.campFrames++;
      // box occupancy (tracking-bench definition: attacking-third possession frames)
      const sign = atk === 0 ? 1 : -1;
      const ballFwd = sign * w.ball.pos.x + HALF_L;
      if (ballFwd > (2 * PITCH_LENGTH) / 3) {
        let inBox = 0;
        for (const p of w.players) {
          if (p.team !== atk || p.role === GK_ROLE) continue;
          if (inOpponentBox(p.pos.x, p.pos.y, atk)) inBox++;
        }
        a.boxSum += inBox;
        a.boxFrames++;
      }
      // line responsiveness eye test: defending team's controller depth by state
      const owner = w.players[ownerId];
      let dMin = Infinity;
      for (const q of w.players) {
        if (q.team !== def || q.role === GK_ROLE) continue;
        const d = Math.hypot(q.pos.x - owner.pos.x, q.pos.y - owner.pos.y);
        if (d < dMin) dMin = d;
      }
      const defSign = def === 0 ? 1 : -1;
      const depth = defSign * defensiveLineX(w, def) + HALF_L; // m from own goal
      const advancing = -defSign * owner.vel.x > 1; // carrier moving at the line
      if (dMin > 8 && advancing) {
        a.dropDepthSum += depth;
        a.dropN++;
      } else if (dMin < 2.5) {
        a.stepDepthSum += depth;
        a.stepN++;
      }
    }
    a.offsides += w.stats[0].offsides + w.stats[1].offsides;
    a.goals += w.score[0] + w.score[1];
    a.shots += w.stats[0].shots + w.stats[1].shots;
    a.passesTotal += completion.passesTotal;
    a.passesCompleted += completion.passesCompleted;
  }
  return a;
}

function report(label: string, a: Agg): void {
  const compl = a.passesTotal > 0 ? (100 * a.passesCompleted) / a.passesTotal : 0;
  console.log(`--- ${label} ---`);
  console.log(`Offsides/team/match:     ${(a.offsides / matches / 2).toFixed(2)} (improve 1-6, real ~2-3)`);
  console.log(`Goals total/match:       ${(a.goals / matches).toFixed(2)} (target 2.2-2.8)`);
  console.log(`Shots/team/match:        ${(a.shots / matches / 2).toFixed(2)}`);
  console.log(`Completion (canonical):  ${compl.toFixed(1)}% (band 78-86)`);
  console.log(`Camping frames (strict): ${(a.campFrames / Math.max(1, a.possFrames)).toFixed(3)} of possession frames`);
  console.log(`Sustained camping >1.5s: ${(a.campEvents / matches).toFixed(2)} events/match`);
  console.log(`Box occupancy:           ${(a.boxSum / Math.max(1, a.boxFrames)).toFixed(2)} (improve >= 0.3)`);
  console.log(
    `Line depth (own goal, m): drop-state ${(a.dropDepthSum / Math.max(1, a.dropN)).toFixed(1)} (n=${a.dropN})` +
      ` vs step-state ${(a.stepDepthSum / Math.max(1, a.stepN)).toFixed(1)} (n=${a.stepN}) — drop < step expected`,
  );
  console.log(
    `Arrived runBehind depth vs marker-excluded last defender: ` +
      `${(a.runnerDeltaSum / Math.max(1, a.runnerDeltaN)).toFixed(2)} m (n=${a.runnerDeltaN}; baseline main ≈ +3.6 = camping)`,
  );
  console.log(
    `Deepest-defender isolation gap (deepest vs 2nd outfielder, defending): ` +
      `${(a.flatSum / Math.max(1, a.flatN)).toFixed(2)} m — smaller = no dragged marker, back line moves as one`,
  );
}

console.log(`=== Offside probe: ${matches} matches x ${minutes} min, seeds ${seedBase}-${seedBase + matches - 1}, SHOT_ERR_SCALE=${SHOT_ERR_SCALE}, TB_GATE=${RUN_THROUGH_GATE} ===`);
if (sweep) {
  for (const soft of [0.8, 1.2, 1.8]) {
    for (const hold of [0.2, -0.4, -0.8]) {
      report(`soft=${soft} hold=${hold}`, runConfig(soft, hold));
    }
  }
} else {
  const soft = argNum('soft', OFFSIDE_SOFT_MARGIN);
  const hold = argNum('hold', RUN_HOLD_MARGIN);
  report(`soft=${soft} hold=${hold} (shipped defaults)`, runConfig(soft, hold));
}
