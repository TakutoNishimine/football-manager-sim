/**
 * Shot-funnel probe (Task Z acceptance metrics).
 *
 * Measures the funnel-shape numbers the event/contest benchmarks don't:
 *   - shots / possession           (target 8–16%, real ~12%)
 *   - passes / possession          (funnel-exit lever; up from V baseline)
 *   - shot-distance histogram       (nonzero 15–20m band, mean distance up from ~9m)
 *   - first-time finishes / team    (> 0.5; new pattern exists)
 *   - goals total / match           (preserve 1.5–3.5)
 *
 * Deterministic (seeded). Same seeds → same numbers. Quick local smoke (small N,
 * short matches) fits the 60s local budget; the authoritative aggregates run in CI.
 *
 * Usage: npx tsx scripts/benchmark/shot-funnel.ts [--matches=8] [--minutes=6] [--seed=1]
 */
import { createWorld, stepPhysics, goalCenter } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import { SIM_DT, PITCH_LENGTH } from '../../src/sim/constants.ts';
import { GK_ROLE } from '../../src/sim/formation.ts';
import { segmentPossessions, type OnBallEvent } from './metrics.ts';

const HALF_L = PITCH_LENGTH / 2;
const BOX_DEPTH = 16.5;
const BOX_HALF_W = 20.16;
// Touch under this counts as a "first-time" (one-touch) shot. The first-time bypass sets
// decisionTimer = FIRST_TIME_DECISION (0.05s); the pressed-shot bail-out is >= 0.1s, so a
// threshold just above 0.05s separates one-touch finishes from settled shots. Hardcoded (not
// imported) so the probe runs against pre-Task-Z checkouts too.
const FIRST_TIME_TOUCH_MAX = 0.05 + 2 * SIM_DT;

function inBox(x: number, y: number, team: 0 | 1): boolean {
  const s = team === 0 ? 1 : -1;
  return s * x > HALF_L - BOX_DEPTH && Math.abs(y) < BOX_HALF_W;
}

interface MatchResult {
  goals: number;
  shots: number;
  passes: number;
  possessions: number;
  passesInPossessions: number;
  firstTimeFinishes: number;
  shotsFromBox: number;
  boxReceptions: number;
  shotDistances: number[];
}

function runMatch(minutes: number, seed: number): MatchResult {
  const world = createWorld(['4-4-2', '4-4-2'], seed);
  const totalSteps = Math.round((minutes * 60) / SIM_DT);

  const onBallSeq: OnBallEvent[] = [];
  const prevPass: [number, number] = [0, 0];
  const prevShot: [number, number] = [0, 0];

  let carryOwner: number | null = null;
  let carryStartX = 0;
  let carryStartY = 0;
  let carryTeam: 0 | 1 = 0;

  const touchStart = new Map<number, number>();
  const shotDistances: number[] = [];
  let firstTimeFinishes = 0;
  let shotsFromBox = 0;
  let boxReceptions = 0;

  for (let step = 0; step < totalSteps; step++) {
    const ownerBefore = world.ball.ownerId;
    const ownerBeforePos = ownerBefore !== null ? { ...world.players[ownerBefore].pos } : null;

    aiStep(world, SIM_DT);
    stepPhysics(world, SIM_DT);

    const ownerAfter = world.ball.ownerId;
    if (ownerAfter !== null && ownerAfter !== ownerBefore) {
      touchStart.set(ownerAfter, world.clock);
      const rp = world.players[ownerAfter];
      if (rp.role !== GK_ROLE && inBox(rp.pos.x, rp.pos.y, rp.team)) boxReceptions++;
    }

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
            const d = Math.hypot(
              ownerBeforePos.x - goalCenter(team).x,
              ownerBeforePos.y - goalCenter(team).y,
            );
            shotDistances.push(d);
            const fromBox = inBox(ownerBeforePos.x, ownerBeforePos.y, team);
            if (fromBox) shotsFromBox++;
            const start = touchStart.get(ownerBefore);
            const touch = start !== undefined ? world.clock - start : Infinity;
            if (touch <= FIRST_TIME_TOUCH_MAX && fromBox) {
              firstTimeFinishes++;
            }
          }
          touchStart.delete(ownerBefore);
        }
      }
    }

    if (ownerAfter !== null) {
      if (ownerAfter !== carryOwner) {
        if (carryOwner !== null) {
          const cd = Math.hypot(world.ball.pos.x - carryStartX, world.ball.pos.y - carryStartY);
          if (cd > 0.5) onBallSeq.push({ team: carryTeam.toString(), type: 'carry' });
        }
        carryOwner = ownerAfter;
        carryStartX = world.ball.pos.x;
        carryStartY = world.ball.pos.y;
        carryTeam = world.players[ownerAfter].team;
      }
    } else if (carryOwner !== null) {
      const cd = Math.hypot(world.ball.pos.x - carryStartX, world.ball.pos.y - carryStartY);
      if (cd > 0.5) onBallSeq.push({ team: carryTeam.toString(), type: 'carry' });
      carryOwner = null;
    }
  }

  const possessions = segmentPossessions(onBallSeq);
  const passesInPossessions = possessions.reduce((s, p) => s + p.passCount, 0);

  return {
    goals: world.score[0] + world.score[1],
    shots: world.stats[0].shots + world.stats[1].shots,
    passes: world.stats[0].passes + world.stats[1].passes,
    possessions: possessions.length,
    passesInPossessions,
    firstTimeFinishes,
    shotsFromBox,
    boxReceptions,
    shotDistances,
  };
}

function parseArgs(argv: string[]) {
  let matches = 8;
  let minutes = 6;
  let seed = 1;
  for (const a of argv) {
    if (a.startsWith('--matches=')) matches = Number(a.slice('--matches='.length));
    else if (a.startsWith('--minutes=')) minutes = Number(a.slice('--minutes='.length));
    else if (a.startsWith('--seed=')) seed = Number(a.slice('--seed='.length));
  }
  return { matches, minutes, seed };
}

function main() {
  const { matches, minutes, seed } = parseArgs(process.argv.slice(2));
  console.log(`\n=== Shot-funnel probe: ${matches} matches × ${minutes} min, seeds ${seed}–${seed + matches - 1} ===\n`);

  const results: MatchResult[] = [];
  for (let i = 0; i < matches; i++) {
    results.push(runMatch(minutes, seed + i));
  }

  const n = results.length;
  const sum = (f: (r: MatchResult) => number) => results.reduce((s, r) => s + f(r), 0);
  const allDist = results.flatMap((r) => r.shotDistances);
  const totalShots = sum((r) => r.shots);
  const totalPoss = sum((r) => r.possessions);
  const totalPasses = sum((r) => r.passesInPossessions);
  const meanDist = allDist.length ? allDist.reduce((a, b) => a + b, 0) / allDist.length : 0;

  const bands = [
    [0, 5],
    [5, 10],
    [10, 15],
    [15, 20],
    [20, 25],
    [25, 40],
  ];
  const hist = bands.map(([lo, hi]) => allDist.filter((d) => d >= lo && d < hi).length);
  const pct = (c: number) => (allDist.length ? ((c / allDist.length) * 100).toFixed(1) : '0.0');

  console.log(`Goals total/match:        ${(sum((r) => r.goals) / n).toFixed(2)}   (preserve 1.5–3.5)`);
  console.log(`Shots/team/match:         ${(totalShots / n / 2).toFixed(2)}   (>= 3.0)`);
  console.log(`Shots / possession:       ${((totalShots / totalPoss) * 100).toFixed(1)}%   (target 8–16%)`);
  console.log(`Passes / possession:      ${(totalPasses / totalPoss).toFixed(2)}`);
  console.log(`First-time finishes/team: ${(sum((r) => r.firstTimeFinishes) / n / 2).toFixed(2)}   (> 0.5)`);
  console.log(`Shots from box/team:      ${(sum((r) => r.shotsFromBox) / n / 2).toFixed(2)}   (diag)`);
  console.log(`Box receptions/team:      ${(sum((r) => r.boxReceptions) / n / 2).toFixed(2)}   (diag)`);
  console.log(`Mean shot distance:       ${meanDist.toFixed(1)} m   (up from ~9m)`);
  console.log(`\nShot-distance histogram (n=${allDist.length}):`);
  bands.forEach(([lo, hi], i) => {
    console.log(`  ${String(lo).padStart(2)}–${String(hi).padStart(2)} m: ${String(hist[i]).padStart(4)}  ${pct(hist[i]).padStart(5)}%`);
  });
}

main();