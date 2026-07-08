/**
 * Pre-offside camping/box baseline (Task AD). Self-contained: computes the
 * offside-position geometry in-script (no src/sim/line.ts dependency), so it
 * runs against main (pre-Task-AD) for the before/after comparison in
 * reports/task-ad.md. Metric definitions match scripts/benchmark/offside-probe.ts.
 *
 * Usage: npx tsx scripts/benchmark/offside-baseline.ts [--matches 40] [--minutes 10] [--seed-base 1]
 */
import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import { SIM_DT, PITCH_LENGTH } from '../../src/sim/constants.ts';
import { GK_ROLE } from '../../src/sim/formation.ts';
import { createCompletionTracker } from './completion.ts';
import { inOpponentBox } from './tracking/metrics.ts';
import type { World } from '../../src/sim/types.ts';

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

/** Second-last defender line (GK included) — same as line.ts offsideLineX. */
function offsideLineX(w: World, defendingTeam: number): number {
  const defSign = defendingTeam === 0 ? 1 : -1;
  let d1 = Infinity;
  let d2 = Infinity;
  for (const q of w.players) {
    if (q.team !== defendingTeam) continue;
    const depth = defSign * q.pos.x;
    if (depth < d1) {
      d2 = d1;
      d1 = depth;
    } else if (depth < d2) {
      d2 = depth;
    }
  }
  return defSign * d2;
}

function isOffsidePosition(w: World, atkTeam: number, pos: { x: number; y: number }): boolean {
  const sign = atkTeam === 0 ? 1 : -1;
  if (sign * pos.x <= 0) return false;
  if (sign * pos.x <= sign * w.ball.pos.x) return false;
  return sign * pos.x > sign * offsideLineX(w, 1 - atkTeam);
}

let goals = 0;
let shots = 0;
let campFrames = 0;
let possFrames = 0;
let campEvents = 0;
let boxSum = 0;
let boxFrames = 0;
let passesTotal = 0;
let passesCompleted = 0;
// 「オフサイドポジションの受け」: リリース時にオフサイドポジションだった選手が、その
// 飛行のボールを収めた回数 — キャンプが攻撃の駅として機能している度合いの直接観測。
let offsideReceptions = 0;
let runnerDeltaSum = 0;
let runnerDeltaN = 0;
let flatSum = 0;
let flatN = 0;

for (let m = 0; m < matches; m++) {
  const w = createWorld(['4-4-2', '4-4-2'], seedBase + m);
  const completion = createCompletionTracker();
  const steps = Math.round((minutes * 60) / SIM_DT);
  const streak = new Map<number, number>();
  let prevInFlight: number | null = null;
  let flagged: number[] = [];
  for (let i = 0; i < steps; i++) {
    const ownerBefore = w.ball.ownerId;
    aiStep(w, SIM_DT);
    stepPhysics(w, SIM_DT);
    completion.step(w, ownerBefore);
    // リリース検出(毎tick): world.ts の snapshotOffside と同じ判定を in-script で再現
    if (w.ballInFlightFrom !== null && prevInFlight === null) {
      const atk = w.ballInFlightFrom;
      flagged = [];
      for (const p of w.players) {
        if (p.team !== atk || p.role === GK_ROLE || p.id === w.ball.lastPasserId) continue;
        if (isOffsidePosition(w, atk, p.pos)) flagged.push(p.id);
      }
    }
    // 受け: フラグされた選手がそのボールを収めた
    if (w.ball.ownerId !== null && ownerBefore === null && flagged.includes(w.ball.ownerId)) {
      offsideReceptions++;
      flagged = [];
    }
    if (w.ballInFlightFrom === null && prevInFlight !== null) {
      // 飛行が誰かに解決された(フラグの寿命は world.ts と同じく飛行中のみ)
      if (!(w.ball.ownerId !== null && flagged.includes(w.ball.ownerId))) flagged = [];
    }
    prevInFlight = w.ballInFlightFrom;
    if (i % 12 !== 0) continue;
    const ownerId = w.ball.ownerId;
    if (ownerId === null) continue;
    const atk = w.players[ownerId].team;
    possFrames++;
    // runBehind ランナーの「マーカー除外ライン」に対する深さ(キャンプの直接観測)。
    // 除外: ランナー自身から2.5m以内の相手(=引きずられた自分のマーカー)。main では
    // ランナーがライン裏に張り付きマーカーごと最終ラインを押し下げる — この delta が正に出る。
    for (const p of w.players) {
      if (p.team !== atk || p.intent?.kind !== 'runBehind') continue;
      // 「ステーションに立っている」= 現在の moveTarget の4m以内(offside-probe.ts と同一定義)。
      if (Math.hypot(p.pos.x - p.moveTarget.x, p.pos.y - p.moveTarget.y) > 4) continue;
      const sign = atk === 0 ? 1 : -1;
      let deepest = -Infinity;
      for (const q of w.players) {
        if (q.team === atk || q.role === GK_ROLE) continue;
        const goalSideOfRunner = sign * q.pos.x > sign * p.pos.x;
        if (goalSideOfRunner && Math.hypot(q.pos.x - p.pos.x, q.pos.y - p.pos.y) < 2.5) continue;
        const prog = sign * q.pos.x;
        if (prog > deepest) deepest = prog;
      }
      if (deepest === -Infinity) continue;
      runnerDeltaSum += sign * p.pos.x - deepest;
      runnerDeltaN++;
    }
    // バックラインの平坦さ: 守備側の最深4人(GK除く)の深さスプレッド
    {
      const def = 1 - atk;
      const dsgn = def === 0 ? 1 : -1;
      const depths: number[] = [];
      for (const q of w.players) {
        if (q.team !== def || q.role === GK_ROLE) continue;
        depths.push(dsgn * q.pos.x);
      }
      depths.sort((x, y) => x - y);
      if (depths.length >= 2) {
        flatSum += depths[1] - depths[0]; // 最深と2番目のギャップ=引きずられたマーカーの孤立度
        flatN++;
      }
    }
    let any = false;
    for (const p of w.players) {
      if (p.team !== atk || p.role === GK_ROLE || p.id === ownerId) continue;
      if (isOffsidePosition(w, atk, p.pos)) {
        any = true;
        const s = (streak.get(p.id) ?? 0) + 0.1;
        streak.set(p.id, s);
        if (Math.abs(s - 1.5) < 0.049) campEvents++;
      } else {
        streak.set(p.id, 0);
      }
    }
    if (any) campFrames++;
    const sign = atk === 0 ? 1 : -1;
    const ballFwd = sign * w.ball.pos.x + HALF_L;
    if (ballFwd > (2 * PITCH_LENGTH) / 3) {
      let inBox = 0;
      for (const p of w.players) {
        if (p.team !== atk || p.role === GK_ROLE) continue;
        if (inOpponentBox(p.pos.x, p.pos.y, atk)) inBox++;
      }
      boxSum += inBox;
      boxFrames++;
    }
  }
  goals += w.score[0] + w.score[1];
  shots += w.stats[0].shots + w.stats[1].shots;
  passesTotal += completion.passesTotal;
  passesCompleted += completion.passesCompleted;
}

const compl = passesTotal > 0 ? (100 * passesCompleted) / passesTotal : 0;
console.log(`=== Offside BASELINE (pre-Task-AD): ${matches} x ${minutes} min, seeds ${seedBase}-${seedBase + matches - 1} ===`);
console.log(`Goals total/match:       ${(goals / matches).toFixed(2)}`);
console.log(`Shots/team/match:        ${(shots / matches / 2).toFixed(2)}`);
console.log(`Completion (canonical):  ${compl.toFixed(1)}%`);
console.log(`Camping frames (strict): ${(campFrames / Math.max(1, possFrames)).toFixed(3)} of possession frames`);
console.log(`Sustained camping >1.5s: ${(campEvents / matches).toFixed(2)} events/match`);
console.log(`Offside-position receptions/match: ${(offsideReceptions / matches).toFixed(2)} (camping as a viable station)`);
console.log(`Box occupancy:           ${(boxSum / Math.max(1, boxFrames)).toFixed(2)}`);
console.log(`Deepest-defender isolation gap (deepest vs 2nd outfielder, defending): ${(flatSum / Math.max(1, flatN)).toFixed(2)} m`);
console.log(`Arrived runBehind depth vs marker-excluded last defender: ${(runnerDeltaSum / Math.max(1, runnerDeltaN)).toFixed(2)} m (n=${runnerDeltaN}; + = camped beyond the line)`);
