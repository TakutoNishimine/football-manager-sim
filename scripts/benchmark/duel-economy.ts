/**
 * Duel-economy probe (Task Y). Reports per-team-per-match take-on attempts / success rate,
 * tackle wins (= stats.steals) / losses, interceptions, and goals — the Task Y validation gates:
 *   - take-on attempts 6-16/team/match, success 35-60%
 *   - int >= steals (tackle wins) preserved
 *   - RNG-squirt events = 0 (structural: the squirt is removed)
 *
 * Usage: npx tsx scripts/benchmark/duel-economy.ts [--matches 40] [--minutes 10] [--seed-base 1]
 */
import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import {
  SIM_DT,
  TACKLE_BASE,
  TACKLE_TRIGGER,
  TACKLE_RANGE,
  TACKLE_BEATEN_TIME,
  CARRY_OPEN_SPEED,
  CARRY_OPEN_DIST,
  TAKEON_KNOCK_SPEED,
} from '../../src/sim/constants.ts';
import { setTeamWeights, DEFAULT_WEIGHTS } from '../../src/sim/weights.ts';
import { createCompletionTracker, COMPLETION_FLOOR_PCT } from './completion.ts';

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const matches = argNum('matches', 40);
const minutes = argNum('minutes', 10);
const seedBase = argNum('seed-base', 1);

// weight ノブ(takeOnBase/takeOnSpace)のみ env で上書きできる。物理 constants の env 掃引
// (旧 tune())は Task Y 是正で撤去済み — 出荷値で固定。
const takeOnBase = Number(process.env.TAKEON_BASE ?? DEFAULT_WEIGHTS.takeOnBase);
const takeOnSpace = Number(process.env.TAKEON_SPACE ?? DEFAULT_WEIGHTS.takeOnSpace);
setTeamWeights(0, { takeOnBase, takeOnSpace });
setTeamWeights(1, { takeOnBase, takeOnSpace });
console.log(
  `[config] TACKLE_BASE=${TACKLE_BASE} TACKLE_TRIGGER=${TACKLE_TRIGGER} TACKLE_RANGE=${TACKLE_RANGE} ` +
    `TACKLE_BEATEN_TIME=${TACKLE_BEATEN_TIME} CARRY_OPEN_SPEED=${CARRY_OPEN_SPEED} ` +
    `CARRY_OPEN_DIST=${CARRY_OPEN_DIST} TAKEON_KNOCK_SPEED=${TAKEON_KNOCK_SPEED} ` +
    `takeOnBase=${takeOnBase} takeOnSpace=${takeOnSpace}`,
);

let goals = 0;
let takeOnAtt = 0;
let takeOnWon = 0;
let steals = 0; // tackle wins
let tackleLost = 0;
let interceptions = 0;
let passes = 0;
let carries = 0; // event-bench 定義: 所有スペルで >0.5m 動いたもの(1スペル=1キャリー)
let passesTotal = 0; // canonical completion (Task AO)
let passesCompleted = 0;
let shots = 0;
let possChanges = 0; // 所有チームの切り替わり回数(README ゲート >=25/match)

const t0 = performance.now();
for (let m = 0; m < matches; m++) {
  const w = createWorld(['4-4-2', '4-4-2'], seedBase + m);
  const steps = Math.round((minutes * 60) / SIM_DT);
  const completion = createCompletionTracker();
  // キャリー計数(scripts/benchmark/sim.ts と同じ定義): オーナーが変わるたびに、直前のオーナーが
  // >0.5m 動いていれば1キャリー。所有中の連続保持=1スペル。
  let carryOwner: number | null = null;
  let cx = 0;
  let cy = 0;
  let lastPossTeam: number | null = null;
  for (let i = 0; i < steps; i++) {
    const ownerBefore = w.ball.ownerId;
    aiStep(w, SIM_DT);
    stepPhysics(w, SIM_DT);
    completion.step(w, ownerBefore);
    const oa = w.ball.ownerId;
    if (oa !== null) {
      const t = w.players[oa].team;
      if (lastPossTeam !== null && t !== lastPossTeam) possChanges++;
      lastPossTeam = t;
    }
    if (oa !== carryOwner) {
      if (carryOwner !== null) {
        const d = Math.hypot(w.ball.pos.x - cx, w.ball.pos.y - cy);
        if (d > 0.5) carries++;
      }
      carryOwner = oa;
      cx = w.ball.pos.x;
      cy = w.ball.pos.y;
    }
  }
  for (const s of w.stats) {
    takeOnAtt += s.takeOnAtt;
    takeOnWon += s.takeOnWon;
    steals += s.steals;
    tackleLost += s.tackleLost;
    interceptions += s.interceptions;
    passes += s.passes;
    shots += s.shots;
  }
  if (carryOwner !== null) {
    const d = Math.hypot(w.ball.pos.x - cx, w.ball.pos.y - cy);
    if (d > 0.5) carries++;
  }
  passesTotal += completion.passesTotal;
  passesCompleted += completion.passesCompleted;
  goals += w.score[0] + w.score[1];
}
const secs = (performance.now() - t0) / 1000 / matches;
const sides = matches * 2;
const per = (x: number) => (x / sides).toFixed(2);
const rate = (a: number, b: number) => (b > 0 ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');

console.log(`=== Duel economy: ${matches} matches x ${minutes} min, seeds ${seedBase}-${seedBase + matches - 1} ===`);
console.log(`Goals total/match:        ${(goals / matches).toFixed(2)} (band 1.5-3.5)`);
console.log(`Take-on attempts/tm/match: ${per(takeOnAtt)} (gate 6-16)`);
console.log(`Take-on success rate:      ${rate(takeOnWon, takeOnAtt)} (gate 35-60%)`);
console.log(`Tackle wins (steals)/tm:   ${per(steals)}`);
console.log(`Tackle losses (beaten)/tm: ${per(tackleLost)}`);
console.log(`Tackle win rate:           ${rate(steals, steals + tackleLost)}`);
console.log(`Interceptions/tm:          ${per(interceptions)}`);
console.log(`int >= steals (per match): int ${(interceptions / matches).toFixed(1)} vs steals ${(steals / matches).toFixed(1)} — ${interceptions >= steals ? 'PASS' : 'FAIL'}`);
console.log(`Passes/tm:                 ${per(passes)}`);
console.log(`Shots/tm:                  ${per(shots)} (floor 3.0)`);
console.log(`Poss changes/match:        ${(possChanges / matches).toFixed(1)} (floor 25)`);
const compPct = passesTotal > 0 ? (100 * passesCompleted) / passesTotal : 0;
console.log(`Completion (canonical):    ${compPct.toFixed(1)}% (floor ${COMPLETION_FLOOR_PCT}%) — ${compPct >= COMPLETION_FLOOR_PCT ? 'PASS' : 'FAIL'}`);
console.log(`Carries/tm/match:          ${per(carries)} (gate >=110... real 239)`);
console.log(`Compute:                   ${secs.toFixed(3)} s/match`);
