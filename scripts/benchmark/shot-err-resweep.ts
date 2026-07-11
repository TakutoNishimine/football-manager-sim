/**
 * SHOT_ERR_SCALE coupled dose-response sweep (Task AB, Stage 2).
 *
 * The attack economy drifted below band (goals ~2.05 pooled over four windows, fresh
 * shots/poss 7.1% vs the 8% floor — AV final table) and the pre-declared re-center
 * trigger fired. Per the coupled-dials protocol (BACKLOG; worked pattern:
 * takeon-resweep.ts), every candidate config reports the FULL coupled probe set
 * measured together, per window:
 *   - goals BOTH windows (canonical seeds 1-40, fresh 4242-4281; tie-break windows
 *     8000-8039 / 9000-9039 via --seed-bases)
 *   - shot funnel: shots/team, shots/possession, first-time finishes, poss/min
 *   - completion (canonical tracker)
 *   - duel economy: take-on attempts/success, steals, interceptions (int >= steals)
 *   - offsides/team
 *   - aerial verbs: crosses / switches / clearances / punts (crosses >= 0.8 floor;
 *     punts move with the Stage-1 GK personality — report the new level)
 *
 * Primary dial: SHOT_ERR_SCALE (setShotErrScale; history in constants.ts — AQ 0.5,
 * AD 0.9). Secondary (only if the primary cannot land both windows): funnelExitBonus /
 * shotQualityScale via --funnel/--scale.
 *
 * Deterministic seeds -> CI == local. Meant for the compute mirror:
 *   gh workflow run sim-run.yml -R TakutoNishimine/football-manager-sim --ref task-ab \
 *     -f command="npx tsx scripts/benchmark/shot-err-resweep.ts --matches 40 --both \
 *       --errscale 0.7,0.8,0.9"
 *
 * Usage: npx tsx scripts/benchmark/shot-err-resweep.ts [--matches 40] [--minutes 10]
 *          [--errscale 0.9,...] [--funnel 2.15,...] [--scale 0.6,...] [--both]
 *          [--seed-bases 8000,9000]  (extra windows, labeled by their base)
 */
import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import { SIM_DT, PITCH_LENGTH, setShotErrScale } from '../../src/sim/constants.ts';
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
const errGrid = argList('errscale', [0.9]);
const funnelGrid = argList('funnel', [DEFAULT_WEIGHTS.funnelExitBonus]);
const scaleGrid = argList('scale', [DEFAULT_WEIGHTS.shotQualityScale]);
const extraBases = argList('seed-bases', []);
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
  crosses: number;
  switches: number;
  clearances: number;
  punts: number;
}

function runWindow(err: number, funnel: number, scale: number, seedBase: number): Row {
  setShotErrScale(err);
  setTeamWeights(0, { funnelExitBonus: funnel, shotQualityScale: scale });
  setTeamWeights(1, { funnelExitBonus: funnel, shotQualityScale: scale });

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
      crosses += st.crosses;
      switches += st.switches;
      clearances += st.clearances;
      punts += st.punts;
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
    crosses: crosses / matches / 2,
    switches: switches / matches / 2,
    clearances: clearances / matches / 2,
    punts: punts / matches / 2,
  };
}

console.log(
  `\n=== SHOT_ERR_SCALE coupled re-sweep: ${matches} matches x ${minutes} min ` +
    `(defaults: funnel ${DEFAULT_WEIGHTS.funnelExitBonus}, qScale ${DEFAULT_WEIGHTS.shotQualityScale}) ===\n`,
);
console.log(
  '--- gates: goals 2.2-2.8 both windows | sh/poss 8-16% | ft>0.5 | comp 78-86 | toAtt 6-16 | toSucc 35-60% | int>=steal | offs ~0.11-0.67/10min | crosses>=0.8 | switches 3-10 | poss/min<=7.27 ---',
);
console.log(
  ['eScl', 'funnl', 'qScl', 'window', 'goals', 'sh/tm', 'sh/poss', 'ft/tm', 'poss/min', 'comp%', 'toAtt', 'toSucc', 'steal', 'int', 'offs', 'cross', 'switc', 'clear', 'punt'].join(' | '),
);

const windows: [string, number][] = [['canon', 1]];
if (both) windows.push(['fresh', 4242]);
for (const b of extraBases) windows.push([`w${b}`, b]);

for (const err of errGrid) {
  for (const funnel of funnelGrid) {
    for (const scale of scaleGrid) {
      for (const [label, sb] of windows) {
        const r = runWindow(err, funnel, scale, sb);
        console.log(
          [
            err.toFixed(2).padStart(4),
            funnel.toFixed(2).padStart(5),
            scale.toFixed(2).padStart(4),
            label.padStart(6),
            r.goals.toFixed(2).padStart(5),
            r.shotsPerTeam.toFixed(2).padStart(5),
            (r.shotsPerPoss.toFixed(1) + '%').padStart(7),
            r.firstTime.toFixed(2).padStart(5),
            r.possPerMin.toFixed(2).padStart(8),
            r.completion.toFixed(1).padStart(5),
            r.toAtt.toFixed(2).padStart(5),
            (r.toSucc.toFixed(1) + '%').padStart(6),
            r.steals.toFixed(1).padStart(5),
            r.interceptions.toFixed(1).padStart(5),
            r.offsides.toFixed(2).padStart(4),
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
