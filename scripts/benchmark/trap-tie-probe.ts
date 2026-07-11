/**
 * Trap-argmin tie probe (Task AT, Part 3 — the color-bias channel hunt).
 *
 * world.ts's trap loop ("トラップ判定") selects the nearest eligible player by a strict
 * `d < bestD` scan over GLOBAL id order — an exact floating-point distance tie between
 * candidates from OPPOSITE teams is won by team 0 (lower ids scan first). The AD review
 * called this channel "exact-tie-only, measure-zero in continuous play"; this probe verifies
 * that claim empirically via the behavior-neutral trapTieDebug counters that world.ts
 * increments in the ACTUAL resolving scan (only when a trap resolves, so the numbers are the
 * real channel exposure, not an approximation).
 *
 * Usage: npx tsx scripts/benchmark/trap-tie-probe.ts [--matches 40] [--minutes 10] [--seed-base 1]
 */
import { createWorld, stepPhysics, trapTieDebug } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import { SIM_DT } from '../../src/sim/constants.ts';

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const matches = argNum('matches', 40);
const minutes = argNum('minutes', 10);
const seedBase = argNum('seed-base', 1);

for (let m = 0; m < matches; m++) {
  const w = createWorld(['4-4-2', '4-4-2'], seedBase + m);
  const steps = Math.round((minutes * 60) / SIM_DT);
  for (let i = 0; i < steps; i++) {
    aiStep(w, SIM_DT);
    stepPhysics(w, SIM_DT);
  }
}

const t = trapTieDebug;
console.log(
  `=== Trap-argmin tie probe: ${matches} matches x ${minutes} min, seeds ${seedBase}-${seedBase + matches - 1} ===`,
);
console.log(`Trap resolutions:                       ${t.resolutions}`);
console.log(`  contested (other team also in radius): ${t.contested}`);
console.log(`  exact cross-team ties (diff === 0):    ${t.exactTies}  <- the id-order channel`);
console.log(`  cross-team ties within 1e-9:           ${t.ties1e9}`);
console.log(`  cross-team near-ties within 1mm:       ${t.ties1mm}`);
console.log(
  `  contested resolutions won by team0:    ${t.wonByTeam0} of ${t.contested} (${t.contested > 0 ? ((100 * t.wonByTeam0) / t.contested).toFixed(1) : '0'}%)`,
);
console.log(
  t.exactTies === 0
    ? 'VERDICT: zero exact ties in the actual resolving scans — the trap argmin id-order channel is empirically refuted at this N.'
    : `VERDICT: ${t.exactTies} exact ties observed — the channel is real; order-neutral resolution needed.`,
);
