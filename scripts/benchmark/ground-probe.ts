/**
 * Ground-physics byte-identity probe (Task AA).
 *
 * Hashes the EXACT float64 bits of the ball position/velocity and every player
 * position on every physics tick of N seeded matches, and prints one hash per
 * seed. Purpose: prove that adding the z-axis ball branch left all grounded
 * trajectories byte-identical — run this at the pre-AA commit to record the
 * baseline hashes, then at the physics-only AA commit; the hashes must match
 * digit-for-digit (any single-bit FP divergence changes the hash).
 *
 * Note: this identity only holds while no lofted kick fires (the AA consumers
 * intentionally change decisions). Once consumers are wired, the probe remains
 * useful as a plain determinism fingerprint of a build.
 *
 * Usage: npx tsx scripts/benchmark/ground-probe.ts [--matches 4] [--minutes 10] [--seed-base 1]
 */
import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import { SIM_DT } from '../../src/sim/constants.ts';

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const matches = argNum('matches', 4);
const minutes = argNum('minutes', 10);
const seedBase = argNum('seed-base', 1);

// FNV-1a over the raw float64 bits (two uint32 words per number).
const buf = new DataView(new ArrayBuffer(8));
function mix(h: number, x: number): number {
  buf.setFloat64(0, x);
  for (const w of [buf.getUint32(0), buf.getUint32(4)]) {
    h ^= w & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (w >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (w >>> 16) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= w >>> 24;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

console.log(`=== Ground probe: ${matches} matches x ${minutes} min, seeds ${seedBase}-${seedBase + matches - 1} ===`);
for (let m = 0; m < matches; m++) {
  const w = createWorld(['4-4-2', '4-4-2'], seedBase + m);
  const steps = Math.round((minutes * 60) / SIM_DT);
  let h = 0x811c9dc5;
  for (let i = 0; i < steps; i++) {
    aiStep(w, SIM_DT);
    stepPhysics(w, SIM_DT);
    h = mix(h, w.ball.pos.x);
    h = mix(h, w.ball.pos.y);
    h = mix(h, w.ball.vel.x);
    h = mix(h, w.ball.vel.y);
    for (const p of w.players) {
      h = mix(h, p.pos.x);
      h = mix(h, p.pos.y);
    }
  }
  console.log(
    `seed ${seedBase + m}: hash ${h.toString(16).padStart(8, '0')} score ${w.score[0]}-${w.score[1]} rng ${w.rngState >>> 0}`,
  );
}
