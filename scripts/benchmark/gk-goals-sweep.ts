/**
 * Goals operating-point sweep + diagnosis (Task AQ).
 *
 * Task AA shifted the canonical-window goals from ~3.17 (Y) to 1.525 — the floor of the
 * 1.5-3.5 band. This script (a) diagnoses where the goals went and (b) sweeps the
 * EXPECTATION-side levers (goals-per-shot), NOT the volume side, per the AQ spec:
 *   - GK_REACT_TIME       (constants.ts, settable): the designated goals knob — longer =
 *                          keeper reacts later = more well-placed shots beat it.
 *   - GK_AERIAL_SWEEP_MARGIN (constants.ts, settable): airborne-ball sweep caution — larger =
 *                          keeper claims fewer crosses = more contested box chances survive.
 *   - shotQualityScale    (weights.ts): continuous shot-quality gate strength.
 * Diagnosis ablation flags disable the AA aerial verbs to attribute the volume/quality loss:
 *   - --crossbase / --switchbase grids (0 turns the verb off).
 *
 * Every config prints one row: goals, shots/team, shots/possession, conversion (goals per
 * total shot), completion, first-time finishes, and the aerial-verb counts — so the goals
 * gate, the volume preserve gate (shots/poss 8-16%), and the "aerial verbs stay alive" gate
 * are all co-measured in one deterministic mirror run.
 *
 * Meant for the compute mirror (deterministic seeds -> CI == local on same Node major):
 *   gh workflow run sim-run.yml -R TakutoNishimine/football-manager-sim --ref task-aq \
 *     -f command="npx tsx scripts/benchmark/gk-goals-sweep.ts --matches 40 --minutes 10 \
 *       --react 0.25,0.28,0.31,0.34"
 *
 * Usage: npx tsx scripts/benchmark/gk-goals-sweep.ts [--matches 40] [--minutes 10]
 *          [--seed-base 1] [--react 0.25,...] [--sweepmargin 2,...] [--scale 0.6,...]
 *          [--crossbase 2.2,...] [--switchbase 0.9,...] [--funnel 2.15,...]
 */
import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import {
  SIM_DT,
  PITCH_LENGTH,
  setGkReactTime,
  setGkAerialSweepMargin,
  setShotErrScale,
} from '../../src/sim/constants.ts';
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
  return Number.isFinite(v) ? v : def;
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
const reactGrid = argList('react', [0.25]);
const marginGrid = argList('sweepmargin', [2]);
const errScaleGrid = argList('errscale', [1]);
const scaleGrid = argList('scale', [DEFAULT_WEIGHTS.shotQualityScale]);
const crossGrid = argList('crossbase', [DEFAULT_WEIGHTS.crossBase]);
const switchGrid = argList('switchbase', [DEFAULT_WEIGHTS.switchBase]);
const funnelGrid = argList('funnel', [DEFAULT_WEIGHTS.funnelExitBonus]);

interface Row {
  react: number;
  margin: number;
  errScale: number;
  scale: number;
  crossBase: number;
  switchBase: number;
  funnel: number;
  goals: number;
  shotsPerTeam: number;
  shotsPerPoss: number;
  conversion: number;
  firstTime: number;
  completion: number;
  crosses: number;
  switches: number;
  clearances: number;
  punts: number;
}

function runConfig(
  react: number,
  margin: number,
  errScale: number,
  scale: number,
  crossBase: number,
  switchBase: number,
  funnel: number,
): Row {
  setGkReactTime(react);
  setGkAerialSweepMargin(margin);
  setShotErrScale(errScale);
  const w = { shotQualityScale: scale, crossBase, switchBase, funnelExitBonus: funnel };
  setTeamWeights(0, w);
  setTeamWeights(1, w);

  let goals = 0;
  let shots = 0;
  let possessions = 0;
  let firstTime = 0;
  let passesTotal = 0;
  let passesCompleted = 0;
  let crosses = 0;
  let switches = 0;
  let clearances = 0;
  let punts = 0;

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
    shots += world.stats[0].shots + world.stats[1].shots;
    goals += world.score[0] + world.score[1];
    passesTotal += completion.passesTotal;
    passesCompleted += completion.passesCompleted;
    for (const st of world.stats) {
      crosses += st.crosses;
      switches += st.switches;
      clearances += st.clearances;
      punts += st.punts;
    }
  }

  const totalShots = shots;
  return {
    react,
    margin,
    errScale,
    scale,
    crossBase,
    switchBase,
    funnel,
    goals: goals / matches,
    shotsPerTeam: shots / matches / 2,
    shotsPerPoss: (shots / possessions) * 100,
    conversion: totalShots > 0 ? (100 * goals) / totalShots : 0,
    firstTime: firstTime / matches / 2,
    completion: passesTotal > 0 ? (100 * passesCompleted) / passesTotal : 0,
    crosses: crosses / matches / 2,
    switches: switches / matches / 2,
    clearances: clearances / matches / 2,
    punts: punts / matches / 2,
  };
}

console.log(
  `\n=== Goals operating-point sweep: ${matches} matches x ${minutes} min, seeds ${seedBase}-${seedBase + matches - 1} ===\n`,
);
console.log(
  ['react', 'swpM', 'eScl', 'qScl', 'xBase', 'swBse', 'funnl', 'goals', 'sh/tm', 'sh/pos', 'conv%', 'ft/tm', 'comp%', 'cross', 'switc', 'clear', 'punt'].join(' | '),
);
console.log(
  '--- gates: goals 2.2-2.8 | sh/poss 8-16% | comp 78-86 | crosses>=~0.8 | switches 3-10 | ft>0.5 ---',
);
for (const react of reactGrid) {
  for (const margin of marginGrid) {
    for (const errScale of errScaleGrid) {
      for (const scale of scaleGrid) {
        for (const crossBase of crossGrid) {
          for (const switchBase of switchGrid) {
            for (const funnel of funnelGrid) {
              const r = runConfig(react, margin, errScale, scale, crossBase, switchBase, funnel);
              console.log(
                [
                  r.react.toFixed(2).padStart(5),
                  r.margin.toFixed(1).padStart(4),
                  r.errScale.toFixed(2).padStart(4),
                  r.scale.toFixed(2).padStart(4),
                  r.crossBase.toFixed(1).padStart(5),
                  r.switchBase.toFixed(1).padStart(5),
                  r.funnel.toFixed(2).padStart(5),
                  r.goals.toFixed(2).padStart(5),
                  r.shotsPerTeam.toFixed(2).padStart(5),
                  (r.shotsPerPoss.toFixed(1) + '%').padStart(6),
                  (r.conversion.toFixed(1) + '%').padStart(5),
                  r.firstTime.toFixed(2).padStart(5),
                  r.completion.toFixed(1).padStart(5),
                  r.crosses.toFixed(2).padStart(5),
                  r.switches.toFixed(2).padStart(5),
                  r.clearances.toFixed(2).padStart(5),
                  r.punts.toFixed(2).padStart(4),
                ].join(' | '),
              );
            }
          }
        }
      }
    }
  }
}
console.log(`\n(completion floor ${COMPLETION_FLOOR_PCT}%; conv% = goals per total shot)`);
