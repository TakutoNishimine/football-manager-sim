/**
 * Mark-persistence probe (Task W Fix 3 diagnostic).
 *
 * Measures how long a defender holds a single sticky-mark assignment (a "mark
 * spell") and how often those spells end coincident with a ball-ownership change.
 * The Task W spec sets sticky marks to persist ≥ 1.5s; the pre-fix wipe fired on
 * EVERY pass release/reception (possTeam === owner?.team ?? null flips team↔null),
 * so spells were terminated at every pass and re-derived greedily on the same tick.
 *
 * A mark spell = a contiguous run of ticks during which a field player keeps
 * `defenseRole === 'mark'` on the SAME `markTargetId`. A spell "ends" when that
 * tuple changes (to null or to a different target). An ending is counted as
 * "ownership-coincident" if the ball's ownerId changed on the same tick or the
 * immediately preceding tick (a ±1-tick window absorbs the aiStep/physics order).
 *
 * Usage: npx tsx scripts/benchmark/mark-persistence.ts [--matches=4] [--minutes=10] [--seed=1]
 * Deterministic (seeded) — same seeds → same numbers.
 */
import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import { SIM_DT } from '../../src/sim/constants.ts';
import { GK_ROLE } from '../../src/sim/formation.ts';

interface SpellState {
  key: number | null; // markTargetId of the current spell, or null if not marking
  start: number; // world.clock when the current spell began
}

function parseArgs(argv: string[]) {
  let matches = 4;
  let minutes = 10;
  let seed = 1;
  for (const a of argv) {
    if (a.startsWith('--matches=')) matches = Number(a.slice('--matches='.length));
    else if (a.startsWith('--minutes=')) minutes = Number(a.slice('--minutes='.length));
    else if (a.startsWith('--seed=')) seed = Number(a.slice('--seed='.length));
  }
  return { matches, minutes, seed };
}

function runMatch(minutes: number, seed: number, durations: number[], coincident: boolean[]): void {
  const world = createWorld(['4-4-2', '4-4-2'], seed);
  const totalSteps = Math.round((minutes * 60) / SIM_DT);

  const state = new Map<number, SpellState>();
  for (const p of world.players) if (p.role !== GK_ROLE) state.set(p.id, { key: null, start: 0 });

  let prevOwner: number | null = world.ball.ownerId;
  let ownerChangedLastTick = false;

  for (let step = 0; step < totalSteps; step++) {
    aiStep(world, SIM_DT);
    stepPhysics(world, SIM_DT);

    const owner = world.ball.ownerId;
    const ownerChangedThisTick = owner !== prevOwner;
    const ownershipRecent = ownerChangedThisTick || ownerChangedLastTick;

    for (const p of world.players) {
      if (p.role === GK_ROLE) continue;
      const marking = p.defenseRole === 'mark' && p.markTargetId !== null;
      const key = marking ? p.markTargetId : null;
      const prev = state.get(p.id)!;
      if (prev.key !== key) {
        // The previous spell (if any) ends here.
        if (prev.key !== null) {
          durations.push(world.clock - prev.start);
          coincident.push(ownershipRecent);
        }
        // A new spell begins here (only when now marking someone).
        state.set(p.id, { key, start: key !== null ? world.clock : 0 });
      }
    }

    ownerChangedLastTick = ownerChangedThisTick;
    prevOwner = owner;
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function main() {
  const { matches, minutes, seed } = parseArgs(process.argv.slice(2));
  console.log(`\n=== Mark-persistence probe: ${matches} matches × ${minutes} min, seeds ${seed}–${seed + matches - 1} ===\n`);

  const durations: number[] = [];
  const coincident: boolean[] = [];
  for (let i = 0; i < matches; i++) runMatch(minutes, seed + i, durations, coincident);

  const n = durations.length;
  const mean = n ? durations.reduce((a, b) => a + b, 0) / n : 0;
  const med = median(durations);
  const under = durations.filter((d) => d < 1.5).length;
  const coinc = coincident.filter(Boolean).length;

  console.log(`Mark spells (completed):        ${n}`);
  console.log(`Median spell duration:          ${med.toFixed(2)}s   (target ≥ ~1.2s)`);
  console.log(`Mean spell duration:            ${mean.toFixed(2)}s`);
  console.log(`Spells ending < 1.5s:           ${under} (${n ? ((100 * under) / n).toFixed(1) : '0.0'}%)`);
  console.log(`Ownership-change-coincident end: ${coinc} (${n ? ((100 * coinc) / n).toFixed(1) : '0.0'}%)`);
}

main();
