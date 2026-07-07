/**
 * Aerial-ball probe (Task AA acceptance metrics).
 *
 * Reports what the existing benches don't break out:
 *   - crosses / switches / clearances / punts per team per match (improve: crosses ~8-20,
 *     switches ~3-10, clearances/punts present under pressure)
 *   - lofted vs ground pass completion (canonical tracker definition; a lofted ball is
 *     any pass kicked with vz > 0)
 *   - box occupancy (attacking-third possession frames, tracking-bench definition;
 *     improve: 0.06 -> >= 0.5)
 *   - mean pass length (kick -> resolution distance, event-bench definition;
 *     improve: ~14 -> >= 16 m)
 *   - goals / shots / completion (preserve sanity: goals 1.5-3.5, completion >= 77)
 *
 * Deterministic (seeded). Quick local smoke fits the 60s budget at small N; the
 * authoritative 40-seed aggregates run on the mirror CI.
 *
 * Usage: npx tsx scripts/benchmark/aerial.ts [--matches 8] [--minutes 10] [--seed-base 1]
 */
import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import { SIM_DT, PITCH_LENGTH } from '../../src/sim/constants.ts';
import { GK_ROLE } from '../../src/sim/formation.ts';
import { createCompletionTracker, COMPLETION_FLOOR_PCT } from './completion.ts';
import { inOpponentBox } from './tracking/metrics.ts';

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const matches = argNum('matches', 8);
const minutes = argNum('minutes', 10);
const seedBase = argNum('seed-base', 1);
const HALF_L = PITCH_LENGTH / 2;

let goals = 0;
let shots = 0;
let crosses = 0;
let switches = 0;
let clearances = 0;
let punts = 0;
let passesTotal = 0;
let passesCompleted = 0;
let loftTotal = 0;
let loftCompleted = 0;
let groundTotal = 0;
let groundCompleted = 0;
let passLenSum = 0;
let passLenN = 0;
let boxSamples = 0;
let boxSum = 0;
// クロス後の速いシュート(着地→3s以内のシュート)の粗い計数(eye-test 支援用)
let shotsAfterCross = 0;

const t0 = performance.now();
for (let m = 0; m < matches; m++) {
  const w = createWorld(['4-4-2', '4-4-2'], seedBase + m);
  const steps = Math.round((minutes * 60) / SIM_DT);
  const sampleEvery = Math.round(0.1 / SIM_DT); // 10Hz sampling (tracking-bench cadence)

  let pendingLofted = false;
  let pendingKick: { x: number; y: number } | null = null;
  let lastCrossClock = -Infinity;
  const prevShots: [number, number] = [0, 0];
  const prevCrosses: [number, number] = [0, 0];

  const completion = createCompletionTracker({
    onPassStart: () => {
      pendingLofted = w.ball.vz > 0;
      pendingKick = { x: w.ball.pos.x, y: w.ball.pos.y };
    },
    onPassResolved: (res) => {
      if (res.via === 'reception' && pendingKick) {
        passLenSum += Math.hypot(w.ball.pos.x - pendingKick.x, w.ball.pos.y - pendingKick.y);
        passLenN++;
      }
      if (pendingLofted) {
        loftTotal++;
        if (res.completed) loftCompleted++;
      } else {
        groundTotal++;
        if (res.completed) groundCompleted++;
      }
      pendingKick = null;
    },
  });

  for (let i = 0; i < steps; i++) {
    const ownerBefore = w.ball.ownerId;
    aiStep(w, SIM_DT);
    stepPhysics(w, SIM_DT);
    completion.step(w, ownerBefore);

    for (const team of [0, 1] as const) {
      if (w.stats[team].crosses > prevCrosses[team]) {
        prevCrosses[team] = w.stats[team].crosses;
        lastCrossClock = w.clock;
      }
      if (w.stats[team].shots > prevShots[team]) {
        prevShots[team] = w.stats[team].shots;
        if (w.clock - lastCrossClock < 3.0) shotsAfterCross++;
      }
    }

    if (i % sampleEvery === 0) {
      const ownerId = w.ball.ownerId;
      if (ownerId !== null) {
        const team = w.players[ownerId].team;
        const ballFwdX = team === 0 ? w.ball.pos.x + HALF_L : -w.ball.pos.x + HALF_L;
        if (ballFwdX > (PITCH_LENGTH * 2) / 3) {
          let count = 0;
          for (const p of w.players) {
            if (p.team !== team || p.role === GK_ROLE) continue;
            if (inOpponentBox(p.pos.x, p.pos.y, team)) count++;
          }
          boxSum += count;
          boxSamples++;
        }
      }
    }
  }

  goals += w.score[0] + w.score[1];
  for (const s of w.stats) {
    shots += s.shots;
    crosses += s.crosses;
    switches += s.switches;
    clearances += s.clearances;
    punts += s.punts;
  }
  passesTotal += completion.passesTotal;
  passesCompleted += completion.passesCompleted;
}
const secs = (performance.now() - t0) / 1000 / matches;
const sides = matches * 2;
const per = (x: number) => (x / sides).toFixed(2);
const pct = (a: number, b: number) => (b > 0 ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');

console.log(`=== Aerial probe: ${matches} matches x ${minutes} min, seeds ${seedBase}-${seedBase + matches - 1} ===`);
console.log(`Goals total/match:      ${(goals / matches).toFixed(2)} (band 1.5-3.5)`);
console.log(`Shots/tm/match:         ${per(shots)} (floor 3.0)`);
console.log(`Crosses/tm/match:       ${per(crosses)} (improve ~8-20)`);
console.log(`Switches/tm/match:      ${per(switches)} (improve ~3-10)`);
console.log(`Clearances/tm/match:    ${per(clearances)} (present under pressure)`);
console.log(`Punts/tm/match:         ${per(punts)} (present)`);
console.log(`Shots within 3s of a cross: ${(shotsAfterCross / matches).toFixed(2)} /match (diag)`);
const compPct = passesTotal > 0 ? (100 * passesCompleted) / passesTotal : 0;
console.log(`Completion (canonical): ${compPct.toFixed(1)}% (floor ${COMPLETION_FLOOR_PCT}) — ${compPct >= COMPLETION_FLOOR_PCT ? 'PASS' : 'FAIL'}`);
console.log(`  ground: ${pct(groundCompleted, groundTotal)} (n=${groundTotal})  lofted: ${pct(loftCompleted, loftTotal)} (n=${loftTotal})`);
console.log(`Mean pass length:       ${(passLenN > 0 ? passLenSum / passLenN : 0).toFixed(1)} m (improve >= 16)`);
console.log(`Box occupancy:          ${(boxSamples > 0 ? boxSum / boxSamples : 0).toFixed(2)} (improve >= 0.5, real 1.5-4)`);
console.log(`Compute:                ${secs.toFixed(3)} s/match (<= 2.6 local)`);
