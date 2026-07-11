/**
 * GK distribution-personality probe (Task AB, Stage 1).
 *
 * Instruments the new GK hold-before-distribute behaviour so the roadmap's
 * "lull-burst at the GK reset" and the §4 press-farm counter are EVIDENCED,
 * not asserted. Per GK possession spell it records:
 *   - hold duration (seconds the GK held the ball before releasing/losing it)
 *   - release type: short build-up pass vs long punt vs dispossessed (no release)
 *   - §4 box-turnover: an opponent gains control inside the GK's OWN penalty box
 *     within GK_TURNOVER_WINDOW of that GK holding/releasing (the FW cover-shadow
 *     press farming the longer hold). Target ~= 0.
 *
 * Behaviour-only probe (no dial changes). Deterministic seeds -> CI == local.
 * Meant for the compute mirror:
 *   gh workflow run sim-run.yml -R TakutoNishimine/football-manager-sim --ref task-ab \
 *     -f command="npx tsx scripts/benchmark/gk-hold-probe.ts --matches 40 --minutes 10 --both"
 *
 * Usage: npx tsx scripts/benchmark/gk-hold-probe.ts [--matches 40] [--minutes 10]
 *          [--seed-base 1] [--both]
 *   --both also runs the fresh window (seeds 4242+); default canonical only.
 */
import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import { SIM_DT, PITCH_LENGTH } from '../../src/sim/constants.ts';
import { GK_ROLE } from '../../src/sim/formation.ts';

const HALF_L = PITCH_LENGTH / 2;
const BOX_DEPTH = 16.5;
const BOX_HALF_W = 20.16;
// §4 counter windows after a GK spell ends. STRICT = the release itself was farmed
// (an interception of the release resolves in <1s). LOOSE additionally catches the
// receiver being dispossessed right after a clean reception (ordinary build-up loss,
// reported for context).
const GK_TURNOVER_STRICT = 1.0;
const GK_TURNOVER_LOOSE = 2.5;

/** Is (x,y) inside `team`'s OWN penalty box (in front of its own goal)? */
function inOwnBox(x: number, y: number, team: 0 | 1): boolean {
  const s = team === 0 ? 1 : -1; // team0 defends -x goal
  return s * x < -(HALF_L - BOX_DEPTH) && Math.abs(y) < BOX_HALF_W;
}

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : def;
}

const matches = argNum('matches', 40);
const minutes = argNum('minutes', 10);
const seedBase = argNum('seed-base', 1);
const both = process.argv.includes('--both');

interface Row {
  spells: number; // GK possession spells / match
  meanHold: number; // mean seconds held before release/loss
  medianHold: number;
  meanClean: number; // mean hold for spells that STARTED clean (nearest opp > 3.5m at gain)
  cleanPct: number; // % of spells that started clean
  fullHolds: number; // % of spells held >= 2.0s (unpressured full hold)
  quickHolds: number; // % of spells released < 0.5s (pressure-shortened)
  shortPct: number; // % of RELEASES that were short build-up passes
  puntPct: number; // % of RELEASES that were punts
  disposPct: number; // % of spells lost to the opponent WITHOUT a release (dispossessed)
  boxTOStrict: number; // §4 counter (strict, <1.0s): the GK release itself farmed, per match
  boxTOLoose: number; // §4 counter (loose, <2.5s): incl. receiver dispossessed post-reception, per match
}

/** Nearest opponent distance to player p (matches ai.ts pressureOf geometry). */
function nearestOppDist(world: { players: { team: number; pos: { x: number; y: number } }[] }, p: { team: number; pos: { x: number; y: number } }): number {
  let best = Infinity;
  for (const o of world.players) {
    if (o.team === p.team) continue;
    const d = Math.hypot(o.pos.x - p.pos.x, o.pos.y - p.pos.y);
    if (d < best) best = d;
  }
  return best;
}

function runWindow(sb: number): Row {
  const holds: number[] = [];
  const cleanHolds: number[] = [];
  let spells = 0;
  let shortRel = 0;
  let puntRel = 0;
  let dispos = 0;
  let fullHolds = 0;
  let quickHolds = 0;
  let boxTOStrict = 0;
  let boxTOLoose = 0;

  for (let m = 0; m < matches; m++) {
    const world = createWorld(['4-4-2', '4-4-2'], sb + m);
    const totalSteps = Math.round((minutes * 60) / SIM_DT);
    const prevPunts: [number, number] = [0, 0];
    const prevPasses: [number, number] = [0, 0];

    // Active GK spell (a GK currently owns the ball).
    let spellGk: number | null = null;
    let spellTeam: 0 | 1 = 0;
    let spellStart = 0;
    let spellClean = false; // nearest opponent > 3.5m (GK_HOLD_CALM) at gain
    // Recently-held GK context, for the box-turnover window after a release/loss.
    let recentGkTeam: 0 | 1 | null = null;
    let recentGkClock = -Infinity;

    for (let step = 0; step < totalSteps; step++) {
      const ownerBefore = world.ball.ownerId;
      aiStep(world, SIM_DT);
      stepPhysics(world, SIM_DT);
      const ownerAfter = world.ball.ownerId;

      // --- GK spell start: a GK just became the owner ---
      if (ownerAfter !== null && ownerAfter !== ownerBefore) {
        const p = world.players[ownerAfter];
        if (p.role === GK_ROLE) {
          spellGk = p.id;
          spellTeam = p.team;
          spellStart = world.clock;
          spellClean = nearestOppDist(world, p) > 3.5;
        }
      }

      // --- GK spell end: the GK stopped owning the ball this tick ---
      if (spellGk !== null && world.ball.ownerId !== spellGk) {
        const dur = world.clock - spellStart;
        holds.push(dur);
        if (spellClean) cleanHolds.push(dur);
        spells++;
        if (dur >= 2.0) fullHolds++;
        if (dur < 0.5) quickHolds++;
        // Classify how the spell ended: punt / short pass / dispossessed.
        const punted = world.stats[spellTeam].punts > prevPunts[spellTeam];
        const passed = world.stats[spellTeam].passes > prevPasses[spellTeam];
        if (punted) puntRel++;
        else if (passed) shortRel++;
        else dispos++; // lost the ball with no kick = tackled off the GK
        recentGkTeam = spellTeam;
        recentGkClock = world.clock;
        spellGk = null;
      }

      // --- §4 box turnover: opponent gains the ball in the GK's own box, near a hold ---
      if (
        recentGkTeam !== null &&
        ownerAfter !== null &&
        ownerAfter !== ownerBefore &&
        world.players[ownerAfter].team !== recentGkTeam &&
        world.clock - recentGkClock < GK_TURNOVER_LOOSE &&
        inOwnBox(world.ball.pos.x, world.ball.pos.y, recentGkTeam)
      ) {
        if (world.clock - recentGkClock < GK_TURNOVER_STRICT) boxTOStrict++;
        boxTOLoose++;
        recentGkTeam = null; // count once per hold
      }
      // Own team retained the ball outside the window / cleanly: drop the context.
      if (recentGkTeam !== null && world.clock - recentGkClock >= GK_TURNOVER_LOOSE) {
        recentGkTeam = null;
      }

      prevPunts[0] = world.stats[0].punts;
      prevPunts[1] = world.stats[1].punts;
      prevPasses[0] = world.stats[0].passes;
      prevPasses[1] = world.stats[1].passes;
    }
  }

  const sorted = [...holds].sort((a, b) => a - b);
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
  const mean = holds.length > 0 ? holds.reduce((s, x) => s + x, 0) / holds.length : 0;
  const meanClean =
    cleanHolds.length > 0 ? cleanHolds.reduce((s, x) => s + x, 0) / cleanHolds.length : 0;
  const releases = shortRel + puntRel;
  return {
    spells: spells / matches,
    meanHold: mean,
    medianHold: median,
    meanClean,
    cleanPct: spells > 0 ? (100 * cleanHolds.length) / spells : 0,
    fullHolds: spells > 0 ? (100 * fullHolds) / spells : 0,
    quickHolds: spells > 0 ? (100 * quickHolds) / spells : 0,
    shortPct: releases > 0 ? (100 * shortRel) / releases : 0,
    puntPct: releases > 0 ? (100 * puntRel) / releases : 0,
    disposPct: spells > 0 ? (100 * dispos) / spells : 0,
    boxTOStrict: boxTOStrict / matches,
    boxTOLoose: boxTOLoose / matches,
  };
}

console.log(
  `\n=== GK hold/distribution probe: ${matches} matches x ${minutes} min ===\n`,
);
console.log(
  '--- expect: clean-start holds pressure-shortened (meanCln), short% > punt%, boxTO-strict/m ~= 0 ---',
);
console.log(
  ['window', 'spells', 'meanH', 'medH', 'meanCln', 'clean%', 'full%', 'quick%', 'short%', 'punt%', 'dispos%', 'TOstr/m', 'TOloo/m'].join(' | '),
);
const windows: [string, number][] = both ? [['canon', 1], ['fresh', 4242]] : [['canon', seedBase]];
for (const [label, sb] of windows) {
  const r = runWindow(sb);
  console.log(
    [
      label.padStart(6),
      r.spells.toFixed(2).padStart(6),
      r.meanHold.toFixed(2).padStart(5),
      r.medianHold.toFixed(2).padStart(4),
      r.meanClean.toFixed(2).padStart(7),
      (r.cleanPct.toFixed(0) + '%').padStart(6),
      (r.fullHolds.toFixed(0) + '%').padStart(5),
      (r.quickHolds.toFixed(0) + '%').padStart(6),
      (r.shortPct.toFixed(0) + '%').padStart(6),
      (r.puntPct.toFixed(0) + '%').padStart(5),
      (r.disposPct.toFixed(0) + '%').padStart(7),
      r.boxTOStrict.toFixed(2).padStart(7),
      r.boxTOLoose.toFixed(2).padStart(7),
    ].join(' | '),
  );
}
