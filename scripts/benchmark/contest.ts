/**
 * Contest-economy regression (Task W acceptance gate §5).
 *
 * 40 matches × 10 min, seeds 1–40 (default 4-4-2 vs 4-4-2, default tactics).
 * Reports the metrics Task W is graded on:
 *   - goals total / match            (band 1.5–3.5)
 *   - steals & interceptions / match (interceptions ≥ steals)
 *   - pass completion %              (canonical measure, see completion.ts — Task AO recalibrated band/floor)
 *   - shots / team / match           (≥ 3.5)
 *   - possessions / match            (≥ 65)
 *   - compute s/match                (≤ 2.6)
 *
 * Pass completion uses the SAME canonical tracker (scripts/benchmark/completion.ts)
 * as scripts/benchmark/sim.ts's event benchmark — this reading is directly
 * comparable to it (Task AO unified the two; they used to silently diverge).
 * Possession segmentation reads world.stats/score directly for the rest.
 * Deterministic (seeded) — same seeds → same numbers.
 *
 * Usage: npx tsx scripts/benchmark/contest.ts [--matches=40] [--minutes=10] [--seed=1]
 */
import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import { SIM_DT } from '../../src/sim/constants.ts';
import { segmentPossessions, type OnBallEvent } from './metrics.ts';
import { createCompletionTracker, COMPLETION_FLOOR_PCT, COMPLETION_BAND_PCT } from './completion.ts';

interface MatchResult {
  goals: number;
  steals: number;
  interceptions: number;
  shots: number; // both teams
  passesTotal: number;
  passesCompleted: number;
  possessions: number;
  computeS: number;
}

function runMatch(minutes: number, seed: number): MatchResult {
  const world = createWorld(['4-4-2', '4-4-2'], seed);
  const totalSteps = Math.round((minutes * 60) / SIM_DT);

  const onBallSeq: OnBallEvent[] = [];
  const prevShotCounts: [number, number] = [0, 0];

  // Canonical pass-completion tracking (scripts/benchmark/completion.ts) —
  // the SAME state machine scripts/benchmark/sim.ts uses for the event
  // benchmark, so this reading is directly comparable to it.
  const completion = createCompletionTracker({
    onPassStart: (team) => onBallSeq.push({ team: team.toString(), type: 'pass' }),
  });

  let carryOwner: number | null = null;
  let carryStartX = 0;
  let carryStartY = 0;
  let carryTeam: 0 | 1 = 0;

  const t0 = process.hrtime.bigint();
  for (let step = 0; step < totalSteps; step++) {
    const ballBefore = { ...world.ball };
    const ownerBefore = ballBefore.ownerId;

    aiStep(world, SIM_DT);
    stepPhysics(world, SIM_DT);

    const ownerAfter = world.ball.ownerId;

    // Canonical pass completion (pushes 'pass' onto onBallSeq via onPassStart).
    completion.step(world, ownerBefore);

    // new shot -> possession-sequence log (completion.step already resolved
    // any pending pass as incomplete when the shot-count ticked up)
    for (const team of [0, 1] as const) {
      if (world.stats[team].shots > prevShotCounts[team]) {
        prevShotCounts[team] = world.stats[team].shots;
        onBallSeq.push({ team: team.toString(), type: 'shot' });
      }
    }

    // carry tracking (possession segmentation)
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
  const computeS = Number(process.hrtime.bigint() - t0) / 1e9;

  return {
    goals: world.score[0] + world.score[1],
    steals: world.stats[0].steals + world.stats[1].steals,
    interceptions: world.stats[0].interceptions + world.stats[1].interceptions,
    shots: world.stats[0].shots + world.stats[1].shots,
    passesTotal: completion.passesTotal,
    passesCompleted: completion.passesCompleted,
    possessions: segmentPossessions(onBallSeq).length,
    computeS,
  };
}

function parseArgs(argv: string[]) {
  let matches = 40;
  let minutes = 10;
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
  console.log(`\n=== Contest-economy regression: ${matches} matches × ${minutes} min, seeds ${seed}–${seed + matches - 1} ===\n`);

  const results: MatchResult[] = [];
  for (let i = 0; i < matches; i++) {
    const r = runMatch(minutes, seed + i);
    results.push(r);
    process.stdout.write(
      `  seed ${seed + i}: goals=${r.goals} steals=${r.steals} int=${r.interceptions} shots=${r.shots} poss=${r.possessions} ${r.computeS.toFixed(2)}s\n`,
    );
  }

  const n = results.length;
  const sum = (f: (r: MatchResult) => number) => results.reduce((s, r) => s + f(r), 0);
  const goalsPerMatch = sum((r) => r.goals) / n;
  const stealsPerMatch = sum((r) => r.steals) / n;
  const intPerMatch = sum((r) => r.interceptions) / n;
  const shotsPerTeam = sum((r) => r.shots) / n / 2;
  const possPerMatch = sum((r) => r.possessions) / n;
  const passTotal = sum((r) => r.passesTotal);
  const passComp = sum((r) => r.passesCompleted);
  const completionPct = passTotal > 0 ? (passComp / passTotal) * 100 : 0;
  const computePerMatch = sum((r) => r.computeS) / n;

  const gate = (ok: boolean) => (ok ? 'PASS' : 'FAIL');
  console.log('\n--- Aggregate (Task W §5 gates) ---');
  console.log(`Goals total/match:     ${goalsPerMatch.toFixed(2)}   (band 1.5–3.5)          ${gate(goalsPerMatch >= 1.5 && goalsPerMatch <= 3.5)}`);
  console.log(`Steals/match:          ${stealsPerMatch.toFixed(1)}`);
  console.log(`Interceptions/match:   ${intPerMatch.toFixed(1)}   (int ≥ steals)          ${gate(intPerMatch >= stealsPerMatch)}`);
  console.log(`Pass completion:       ${completionPct.toFixed(1)}%  (canonical measure; band ${COMPLETION_BAND_PCT[0]}–${COMPLETION_BAND_PCT[1]}, floor ${COMPLETION_FLOOR_PCT})  ${gate(completionPct >= COMPLETION_FLOOR_PCT)}`);
  console.log(`Shots/team/match:      ${shotsPerTeam.toFixed(2)}   (≥ 3.5)                 ${gate(shotsPerTeam >= 3.5)}`);
  console.log(`Possessions/match:     ${possPerMatch.toFixed(1)}   (≥ 65)                  ${gate(possPerMatch >= 65)}`);
  console.log(`Compute:               ${computePerMatch.toFixed(3)} s/match (≤ 2.6)         ${gate(computePerMatch <= 2.6)}`);
}

main();
