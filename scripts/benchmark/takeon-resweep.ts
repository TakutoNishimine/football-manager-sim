/**
 * Coupled duel-economy re-sweep (Task AT, Part 1).
 *
 * Task AD's through-ball verb + flatter line displaced take-ons from 6.99 @ 38.1% (Task Y)
 * down to 4.29 @ 32.9% (below the 6-16 @ 35-60% gate). This re-sweeps the two take-on
 * SELECTION weights (takeOnBase / takeOnSpace) and prints the FULL coupled probe set per
 * config so nothing is tuned in isolation (the BACKLOG coupled-dials rule):
 *   - duel economy:  take-on attempts / success, steals, interceptions (int >= steals)
 *   - shot funnel:   shots/team, shots/possession, first-time finishes, completion, poss/min
 *   - goals BOTH windows: canonical (seeds 1-40) and fresh (seeds 4242-4281)
 *   - offsides/team (must stay 1-6 per-90-equivalent)
 *
 * All other weights/constants stay at their shipped values (funnelExitBonus 2.15,
 * shotQualityScale 0.6, SHOT_ERR_SCALE 0.9, RUN_BREAK_DEPTH 4). Take-on weights are
 * AiWeights (runtime-settable), so no recompile / no env override is needed.
 *
 * Deterministic seeds -> CI == local. Meant for the compute mirror:
 *   gh workflow run sim-run.yml -R TakutoNishimine/football-manager-sim --ref task-at \
 *     -f command="npx tsx scripts/benchmark/takeon-resweep.ts --matches 40 --both"
 *
 * Usage: npx tsx scripts/benchmark/takeon-resweep.ts [--matches 40] [--minutes 10]
 *          [--tobase 0.28,0.45,0.65] [--tospace 0.6,1.0,1.4] [--both]
 *   --both also runs the fresh window (seeds 4242+); default is canonical only (faster).
 */
import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import { SIM_DT, PITCH_LENGTH } from '../../src/sim/constants.ts';
import { GK_ROLE } from '../../src/sim/formation.ts';
import { setTeamWeights, DEFAULT_WEIGHTS } from '../../src/sim/weights.ts';
import { segmentPossessions, type OnBallEvent } from './metrics.ts';
import { createCompletionTracker } from './completion.ts';

const HALF_L = PITCH_LENGTH / 2;
const BOX_DEPTH = 16.5;
const BOX_HALF_W = 20.16;
const FIRST_TIME_TOUCH_MAX = 0.05 + 2 * SIM_DT;

function inBox(x: number, y: number, team: 0 | 1): boolean {
  const s = team === 0 ? 1 : -1;
  return s * x > HALF_L - BOX_DEPTH && Math.abs(y) < BOX_HALF_W;
}
function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : def;
}
function argList(name: string, def: number[]): number[] {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1]
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

const matches = argNum('matches', 40);
const minutes = argNum('minutes', 10);
const toBaseGrid = argList('tobase', [DEFAULT_WEIGHTS.takeOnBase, 0.45, 0.65]);
const toSpaceGrid = argList('tospace', [DEFAULT_WEIGHTS.takeOnSpace, 1.0, 1.4]);
const both = process.argv.includes('--both');

interface Row {
  goals: number;
  shotsPerTeam: number;
  shotsPerPoss: number;
  firstTime: number;
  possPerMin: number;
  completion: number;
  toAtt: number;
  toSucc: number;
  steals: number;
  interceptions: number;
  offsides: number;
}

function runWindow(toBase: number, toSpace: number, seedBase: number): Row {
  setTeamWeights(0, { takeOnBase: toBase, takeOnSpace: toSpace });
  setTeamWeights(1, { takeOnBase: toBase, takeOnSpace: toSpace });

  let goals = 0;
  let shots = 0;
  let possessions = 0;
  let firstTime = 0;
  let passesTotal = 0;
  let passesCompleted = 0;
  let toAtt = 0;
  let toWon = 0;
  let steals = 0;
  let interceptions = 0;
  let offsides = 0;

  for (let m = 0; m < matches; m++) {
    const world = createWorld(['4-4-2', '4-4-2'], seedBase + m);
    const totalSteps = Math.round((minutes * 60) / SIM_DT);
    const completion = createCompletionTracker();
    const onBallSeq: OnBallEvent[] = [];
    const prevPass: [number, number] = [0, 0];
    const prevShot: [number, number] = [0, 0];
    const touchStart = new Map<number, number>();
    let carryOwner: number | null = null;
    let cx = 0;
    let cy = 0;
    let carryTeam: 0 | 1 = 0;

    for (let step = 0; step < totalSteps; step++) {
      const ownerBefore = world.ball.ownerId;
      const ownerBeforePos = ownerBefore !== null ? { ...world.players[ownerBefore].pos } : null;
      aiStep(world, SIM_DT);
      stepPhysics(world, SIM_DT);
      completion.step(world, ownerBefore);

      const ownerAfter = world.ball.ownerId;
      if (ownerAfter !== null && ownerAfter !== ownerBefore) touchStart.set(ownerAfter, world.clock);

      for (const team of [0, 1] as const) {
        if (world.stats[team].passes > prevPass[team]) {
          prevPass[team] = world.stats[team].passes;
          onBallSeq.push({ team: team.toString(), type: 'pass' });
          if (ownerBefore !== null) touchStart.delete(ownerBefore);
        }
        if (world.stats[team].shots > prevShot[team]) {
          prevShot[team] = world.stats[team].shots;
          onBallSeq.push({ team: team.toString(), type: 'shot' });
          if (ownerBefore !== null && ownerBeforePos !== null) {
            const shooter = world.players[ownerBefore];
            if (shooter.role !== GK_ROLE) {
              const fromBox = inBox(ownerBeforePos.x, ownerBeforePos.y, team);
              const start = touchStart.get(ownerBefore);
              const touch = start !== undefined ? world.clock - start : Infinity;
              if (touch <= FIRST_TIME_TOUCH_MAX && fromBox) firstTime++;
            }
            touchStart.delete(ownerBefore);
          }
        }
      }

      if (ownerAfter !== null) {
        if (ownerAfter !== carryOwner) {
          if (carryOwner !== null) {
            const cd = Math.hypot(world.ball.pos.x - cx, world.ball.pos.y - cy);
            if (cd > 0.5) onBallSeq.push({ team: carryTeam.toString(), type: 'carry' });
          }
          carryOwner = ownerAfter;
          cx = world.ball.pos.x;
          cy = world.ball.pos.y;
          carryTeam = world.players[ownerAfter].team;
        }
      } else if (carryOwner !== null) {
        const cd = Math.hypot(world.ball.pos.x - cx, world.ball.pos.y - cy);
        if (cd > 0.5) onBallSeq.push({ team: carryTeam.toString(), type: 'carry' });
        carryOwner = null;
      }
    }

    possessions += segmentPossessions(onBallSeq).length;
    shots += world.stats[0].shots + world.stats[1].shots;
    goals += world.score[0] + world.score[1];
    passesTotal += completion.passesTotal;
    passesCompleted += completion.passesCompleted;
    for (const st of world.stats) {
      toAtt += st.takeOnAtt;
      toWon += st.takeOnWon;
      steals += st.steals;
      interceptions += st.interceptions;
      offsides += st.offsides;
    }
  }

  return {
    goals: goals / matches,
    shotsPerTeam: shots / matches / 2,
    shotsPerPoss: (shots / possessions) * 100,
    firstTime: firstTime / matches / 2,
    possPerMin: possessions / matches / minutes,
    completion: passesTotal > 0 ? (100 * passesCompleted) / passesTotal : 0,
    toAtt: toAtt / matches / 2,
    toSucc: toAtt > 0 ? (100 * toWon) / toAtt : 0,
    steals: steals / matches,
    interceptions: interceptions / matches,
    offsides: offsides / matches / 2,
  };
}

console.log(
  `\n=== Take-on coupled re-sweep: ${matches} matches x ${minutes} min ` +
    `(funnel ${DEFAULT_WEIGHTS.funnelExitBonus}, qScale ${DEFAULT_WEIGHTS.shotQualityScale}, shipped constants) ===\n`,
);
console.log(
  '--- gates: toAtt 6-16 | toSucc 35-60% | goals 2.2-2.8 both windows | sh/poss 8-16% | ft>0.5 | comp 78-86 | int>=steal | offsides 1-6/90-eq (~0.11-0.67/10min) ---',
);
console.log(
  ['toBase', 'toSpc', 'window', 'toAtt', 'toSucc', 'goals', 'sh/tm', 'sh/poss', 'ft/tm', 'poss/min', 'comp%', 'steal', 'int', 'offs'].join(' | '),
);

for (const toBase of toBaseGrid) {
  for (const toSpace of toSpaceGrid) {
    const windows: [string, number][] = both
      ? [['canon', 1], ['fresh', 4242]]
      : [['canon', 1]];
    for (const [label, seedBase] of windows) {
      const r = runWindow(toBase, toSpace, seedBase);
      console.log(
        [
          toBase.toFixed(2).padStart(6),
          toSpace.toFixed(2).padStart(5),
          label.padStart(6),
          r.toAtt.toFixed(2).padStart(5),
          (r.toSucc.toFixed(1) + '%').padStart(6),
          r.goals.toFixed(2).padStart(5),
          r.shotsPerTeam.toFixed(2).padStart(5),
          (r.shotsPerPoss.toFixed(1) + '%').padStart(7),
          r.firstTime.toFixed(2).padStart(5),
          r.possPerMin.toFixed(2).padStart(8),
          r.completion.toFixed(1).padStart(5),
          r.steals.toFixed(1).padStart(5),
          r.interceptions.toFixed(1).padStart(5),
          r.offsides.toFixed(2).padStart(4),
        ].join(' | '),
      );
    }
  }
}
