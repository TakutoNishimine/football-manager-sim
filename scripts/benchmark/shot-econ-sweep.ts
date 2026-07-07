/**
 * Shot-economy dose-response sweep (Task Y remediation, Fix 1).
 *
 * After reverting GK_REACT_TIME to Z's 0.25, the duel economy leaves shot volume too high
 * (shots/possession ~25% vs the 8-16% preserve gate). This sweeps the two designated attack-side
 * levers IN-PROCESS (deterministic; no env physics overrides) and prints one row per config so the
 * operating point — and its ±0.05 sensitivity on funnelExitBonus (BACKLOG flags it sensitive) — is
 * evidenced, not asserted:
 *   - funnelExitBonus  (weights.ts): final-third recycle appetite; dominant shots/possession dial
 *   - shotQualityScale (weights.ts): continuous shot-quality gate strength (suppress far/wide junk)
 *
 * Both are AiWeights (runtime-settable via setTeamWeights), so no recompile / no env is needed —
 * this is why tune() could be stripped from constants.ts. GK_REACT_TIME is fixed at its 0.25 ship
 * value here (not a sweep axis).
 *
 * Meant for the compute mirror (deterministic seeds → CI == local on same Node major):
 *   gh workflow run sim-run.yml -R TakutoNishimine/football-manager-sim --ref task-y \
 *     -f command="npx tsx scripts/benchmark/shot-econ-sweep.ts --matches 40 --minutes 10"
 *
 * Also reports the duel gates (take-on attempts/success, int vs steals) per config: the recycle
 * weights move WHERE duels happen, so the take-on success gate (35-60%) must be co-verified with
 * the shot economy, not assumed orthogonal (measured on identical mechanics: funnel 2.0/qScale 0.5
 * -> 39.6% take-on success but funnel 2.2/qScale 0.6 -> 33.8%). Optional take-on selectivity axes
 * (--tobase/--tospace) sweep takeOnBase/takeOnSpace for the same reason.
 *
 * Usage: npx tsx scripts/benchmark/shot-econ-sweep.ts [--matches 40] [--minutes 10] [--seed-base 1]
 *          [--funnel 1.15,1.6,2.0,...] [--scale 0.5,0.7] [--tobase 0.28] [--tospace 0.6]
 */
import { createWorld, stepPhysics, goalCenter } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import { SIM_DT, PITCH_LENGTH } from '../../src/sim/constants.ts';
import { GK_ROLE } from '../../src/sim/formation.ts';
import { setTeamWeights, DEFAULT_WEIGHTS } from '../../src/sim/weights.ts';
import { segmentPossessions, type OnBallEvent } from './metrics.ts';
import { createCompletionTracker, COMPLETION_FLOOR_PCT } from './completion.ts';

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
const seedBase = argNum('seed-base', 1);
// Operating point 1.6 plus ±0.05 sensitivity (1.55/1.65), plus a coarse dose-response spread.
const funnelGrid = argList('funnel', [1.15, 1.55, 1.6, 1.65, 2.0, 2.4, 2.8]);
const scaleGrid = argList('scale', [DEFAULT_WEIGHTS.shotQualityScale]);
const toBaseGrid = argList('tobase', [DEFAULT_WEIGHTS.takeOnBase]);
const toSpaceGrid = argList('tospace', [DEFAULT_WEIGHTS.takeOnSpace]);

interface Row {
  funnel: number;
  scale: number;
  toBase: number;
  toSpace: number;
  goals: number;
  shotsPerTeam: number;
  shotsPerPoss: number;
  passesPerPoss: number;
  firstTime: number;
  possPerMatch: number;
  possPerMin: number;
  completion: number;
  toAtt: number;
  toSucc: number;
  steals: number;
  interceptions: number;
}

function runConfig(funnel: number, scale: number, toBase: number, toSpace: number): Row {
  const w = { funnelExitBonus: funnel, shotQualityScale: scale, takeOnBase: toBase, takeOnSpace: toSpace };
  setTeamWeights(0, w);
  setTeamWeights(1, w);

  let goals = 0;
  let shots = 0;
  let possessions = 0;
  let passesInPoss = 0;
  let firstTime = 0;
  let passesTotal = 0;
  let passesCompleted = 0;
  let toAtt = 0;
  let toWon = 0;
  let steals = 0;
  let interceptions = 0;

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

    const poss = segmentPossessions(onBallSeq);
    possessions += poss.length;
    passesInPoss += poss.reduce((s, p) => s + p.passCount, 0);
    shots += world.stats[0].shots + world.stats[1].shots;
    goals += world.score[0] + world.score[1];
    passesTotal += completion.passesTotal;
    passesCompleted += completion.passesCompleted;
    for (const st of world.stats) {
      toAtt += st.takeOnAtt;
      toWon += st.takeOnWon;
      steals += st.steals;
      interceptions += st.interceptions;
    }
  }

  return {
    funnel,
    scale,
    toBase,
    toSpace,
    goals: goals / matches,
    shotsPerTeam: shots / matches / 2,
    shotsPerPoss: (shots / possessions) * 100,
    passesPerPoss: passesInPoss / possessions,
    firstTime: firstTime / matches / 2,
    possPerMatch: possessions / matches,
    possPerMin: possessions / matches / minutes,
    completion: passesTotal > 0 ? (100 * passesCompleted) / passesTotal : 0,
    toAtt: toAtt / matches / 2,
    toSucc: toAtt > 0 ? (100 * toWon) / toAtt : 0,
    steals: steals / matches,
    interceptions: interceptions / matches,
  };
}

console.log(
  `\n=== Shot-economy sweep: ${matches} matches x ${minutes} min, seeds ${seedBase}-${seedBase + matches - 1} (GK_REACT_TIME fixed 0.25) ===\n`,
);
console.log(
  ['funnel', 'qScale', 'toBase', 'toSpc', 'goals', 'sh/tm', 'sh/poss', 'pa/poss', 'ft/tm', 'poss/min', 'comp%', 'toAtt', 'toSucc', 'steal', 'int'].join(' | '),
);
console.log(
  '--- gates: goals 1.5-3.5 | sh/poss 8-16% | ft/tm >0.5 | comp 78-86 | poss/min <=7.27 | toAtt 6-16 | toSucc 35-60% | int>=steal ---',
);
for (const scale of scaleGrid) {
  for (const funnel of funnelGrid) {
    for (const toBase of toBaseGrid) {
      for (const toSpace of toSpaceGrid) {
        const r = runConfig(funnel, scale, toBase, toSpace);
        console.log(
          [
            r.funnel.toFixed(2).padStart(6),
            r.scale.toFixed(2).padStart(6),
            r.toBase.toFixed(2).padStart(6),
            r.toSpace.toFixed(2).padStart(5),
            r.goals.toFixed(2).padStart(5),
            r.shotsPerTeam.toFixed(2).padStart(5),
            (r.shotsPerPoss.toFixed(1) + '%').padStart(7),
            r.passesPerPoss.toFixed(2).padStart(7),
            r.firstTime.toFixed(2).padStart(5),
            r.possPerMin.toFixed(2).padStart(8),
            r.completion.toFixed(1).padStart(5),
            r.toAtt.toFixed(2).padStart(5),
            (r.toSucc.toFixed(1) + '%').padStart(6),
            r.steals.toFixed(1).padStart(5),
            r.interceptions.toFixed(1).padStart(5),
          ].join(' | '),
        );
      }
    }
  }
}
console.log(`\n(completion floor ${COMPLETION_FLOOR_PCT}%)`);
