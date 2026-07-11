/**
 * Mirror-symmetry probe (Task AR) — durable color-fairness regression tool.
 *
 * The pitch is symmetric: team 0 attacks +x, team 1 attacks −x, and y carries
 * no team meaning. So the whole simulation must be EQUIVARIANT under the
 * team-swap reflection R:
 *
 *   R = point-reflection (x,y) → (−x,−y)
 *       + velocity negation
 *       + team relabel 0↔1
 *       + within-line role reversal (role i in a formation line ↔ role count-1-i,
 *         i.e. its left↔right mirror; GK maps to itself)
 *       + swap every per-team world array (formations, tactics, score, stats,
 *         presserId, switchReadyAt) and relabel every team-valued scalar.
 *
 * Why role reversal is part of R: `baseAnchors` lays a formation out with the
 * SAME y for both teams (kickoffPos negates only x). A raw point reflection
 * therefore flips a defender's anchor to −y, which the un-reversed role does not
 * reproduce; reversing the role within its line restores the exact mirror. With
 * role reversal, `dynamicAnchor`, `classifyRole` (FW/SB/CB depend on line-x and
 * |y|, both preserved) and the `perp` (90° rotation) constructions are all
 * equivariant by construction — so ANY residual mismatch is a genuine
 * direction-sign bug, not a layout artifact.
 *
 * The transform preserves player ids and array order (R relabels each player in
 * place), so the RNG stream stays aligned: per aiStep tick only the single ball
 * owner executes (consuming rand for kick noise), and that owner is the same id
 * in both worlds. Kick-noise is a rotation (executePass/executeLoftedPass) or a
 * magnitude (shot power) — both commute with negation — so a symmetric sim
 * produces byte-mirrored ball velocities and an identical post-step rngState.
 *
 * DECISION-ORDER PHASE (Task AV): aiStep's per-tick alternation makes the step
 * a PHASED map S_f (f = which team index decides first, derived from clock+seed).
 * The phase bit is team-indexed world state, so R must map it like every other
 * per-team field: R sends "team f decides first" to "team 1-f decides first"
 * (the same PHYSICAL players first -- ids are preserved). The sound equivariance
 * is therefore  R(S_f(W)) == S_{1-f}(R(W)),  and the probe steps the mirrored
 * world under setMirrorPhaseFlip(true) (a probe-only diagnostic guard in ai.ts
 * that XORs 1 into the alternation phase). Run 29140984144 measured what happens
 * without the flip: 4,744/57,600 non-mirroring ticks, all of them the defending
 * GK's release-reaction timing (intent.until off by exactly one SIM_DT) -- the
 * cross-team read the alternation exists to symmetrize, observed from both
 * sides. --order team0First runs the probe on the fixed guard path instead
 * (main's historical id order, phase-free): there the OLD id-aligned invariant
 * R(S(W)) == S(R(W)) must still hold with zero violations, isolating the
 * transform extension to the phase semantics alone.
 *
 * Two checks:
 *   CHECK A — decision equivariance over states sampled from seeded matches
 *     (incl. asymmetric-formation matchups, the pool where the 3.32σ color bias
 *     lived). Force the owner to re-decide (decisionTimer=0) so every sample
 *     exercises a fresh decideOwner/execute. Assert R(aiStep(W)) == aiStep(R(W))
 *     field-for-field (rngState included). The only relaxation: a SHOT's aim uses
 *     a signed rand coin when the GK is centered (symmetric-in-expectation, not a
 *     color bias) — for shot ticks the ball velocity is compared by magnitude and
 *     x-direction only. Every aerial verb (cross/switch/clearance/punt) flows
 *     through executeLoftedPass and IS asserted byte-exact.
 *   CHECK C — physics equivariance over constructed airborne states: pure
 *     ballistic flight/bounce/settle, crossbar goal vs goal-kick, and boundary
 *     restart side. Rand-free, asserted byte-exact (goal ticks assert the
 *     score-swap only, since resetForKickoff draws a fresh kickoff coin).
 *
 * Usage:
 *   npx tsx scripts/benchmark/symmetry-probe.ts [--matches 24] [--minutes 3]
 *        [--stride 3] [--max-report 20] [--seed-base 5000]
 *        [--order alternate|team0First]   # default alternate (shipped path)
 */
import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import { aiStep, setDecisionOrder, setMirrorPhaseFlip, type DecisionOrder } from '../../src/sim/ai.ts';
import { SIM_DT } from '../../src/sim/constants.ts';
import { baseAnchors, type FormationName } from '../../src/sim/formation.ts';
import type { Team, World } from '../../src/sim/types.ts';

// ── CLI ────────────────────────────────────────────────────────────────────
function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : def;
}
const MATCHES = argNum('matches', 16);
const MINUTES = argNum('minutes', 2);
const STRIDE = Math.max(1, Math.round(argNum('stride', 4)));
const MAX_REPORT = Math.round(argNum('max-report', 20));
const SEED_BASE = Math.round(argNum('seed-base', 5000));
function argStr(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}
// --order: 'alternate' (shipped default; mirrored world steps phase-flipped) or
// 'team0First' (fixed guard path = main's id order; the OLD id-aligned invariant, no flip needed).
const ORDER = argStr('order', 'alternate') as DecisionOrder;
if (ORDER !== 'alternate' && ORDER !== 'team0First') throw new Error(`--order must be alternate|team0First (got ${ORDER})`);
setDecisionOrder(ORDER);
/** Step the MIRRORED world one aiStep under the R-mapped phase (S_{1-f}); no-op phase-wise for fixed orders. */
function aiStepMirrored(w: World, dt: number): void {
  setMirrorPhaseFlip(true);
  try {
    aiStep(w, dt);
  } finally {
    setMirrorPhaseFlip(false);
  }
}

const FLOAT_TOL = 1e-9;

// Asymmetric-heavy matchup pool (the color-bias pool). Each entry is the pair of
// formation names given to team 0 / team 1.
const MATCHUPS: [FormationName, FormationName][] = [
  ['4-4-2', '4-3-3'],
  ['4-3-3', '4-2-3-1'],
  ['4-2-3-1', '3-5-2'],
  ['3-5-2', '3-4-3'],
  ['3-4-3', '5-3-2'],
  ['5-3-2', '4-4-2'],
  ['4-4-2', '4-2-3-1'],
  ['4-3-3', '3-4-3'],
  ['4-2-3-1', '5-3-2'],
  ['3-5-2', '4-4-2'],
  ['3-4-3', '4-3-3'],
  ['5-3-2', '3-5-2'],
];

// ── Reflection R ─────────────────────────────────────────────────────────────

/** role → its within-line mirror (same anchor x, negated anchor y). Cached. */
const mirrorRoleCache = new Map<FormationName, number[]>();
function mirrorRoleMap(name: FormationName): number[] {
  const cached = mirrorRoleCache.get(name);
  if (cached) return cached;
  const a = baseAnchors(name);
  const map = a.map((av, _i) => {
    for (let j = 0; j < a.length; j++) {
      if (Math.abs(a[j].x - av.x) < 1e-9 && Math.abs(a[j].y + av.y) < 1e-9) return j;
    }
    throw new Error(`no mirror role for ${name} role ${_i}`);
  });
  mirrorRoleCache.set(name, map);
  return map;
}

// NON-mutating negation returning a fresh vec. Must not mutate: aiStep aliases
// moveTarget and intent.target to the SAME vec object, and structuredClone
// preserves that aliasing — an in-place neg would negate the shared vec twice
// (a no-op). Reassigning fresh objects negates each field exactly once from its
// original value regardless of aliasing.
function negd(v: { x: number; y: number }): { x: number; y: number } {
  return { x: -v.x, y: -v.y };
}
function swap<T>(a: [T, T]): [T, T] {
  return [a[1], a[0]];
}
function flipTeam(t: Team | null): Team | null {
  return t === null ? null : ((1 - t) as Team);
}

/** Apply R in place. Preserves player ids and array order (RNG-aligned). */
function reflect(w: World): void {
  const oldFormations: [FormationName, FormationName] = [w.formations[0], w.formations[1]];
  for (const p of w.players) {
    const mr = mirrorRoleMap(oldFormations[p.team]);
    p.pos = negd(p.pos);
    p.vel = negd(p.vel);
    p.moveTarget = negd(p.moveTarget);
    if (p.intent) {
      p.intent.target = negd(p.intent.target);
      p.intent.possTeam = flipTeam(p.intent.possTeam);
    }
    if (p.instruction && p.instruction.kind === 'move') p.instruction.target = negd(p.instruction.target);
    p.role = mr[p.role];
    p.number = p.role + 1;
    p.team = (1 - p.team) as Team;
    // ids (id, markTargetId, receivedFrom) unchanged: same physical players.
  }
  w.ball.pos = negd(w.ball.pos);
  w.ball.vel = negd(w.ball.vel);
  w.ball.lastTouchTeam = (1 - w.ball.lastTouchTeam) as Team;
  // ball.z, ball.vz, ball.ownerId, ball.lastPasserId unchanged.
  w.formations = swap(oldFormations);
  w.tactics = swap(w.tactics);
  w.score = swap(w.score);
  w.stats = swap(w.stats);
  w.presserId = swap(w.presserId);
  w.switchReadyAt = swap(w.switchReadyAt);
  w.ballInFlightFrom = flipTeam(w.ballInFlightFrom);
  w.lastPossTeam = flipTeam(w.lastPossTeam);
  // rngState, seed, clock, shotInFlightSince, takeOnRunnerId, takeOnDeadline: unchanged.
}

function cloneWorld(w: World): World {
  return structuredClone(w);
}

// ── Deep reflect-compare ──────────────────────────────────────────────────────

interface Diff {
  path: string;
  a: unknown; // value from reflect(stepA)
  b: unknown; // value from stepB
}

function almostEq(a: number, b: number): boolean {
  if (a === b) return true;
  return Math.abs(a - b) <= FLOAT_TOL * (1 + Math.abs(a) + Math.abs(b));
}

function deepDiff(a: unknown, b: unknown, path: string, out: Diff[], skip: (p: string) => boolean): void {
  if (skip(path)) return;
  if (out.length > 5000) return; // safety cap
  if (typeof a === 'number' && typeof b === 'number') {
    if (!almostEq(a, b)) out.push({ path, a, b });
    return;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (a !== b) out.push({ path, a, b });
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    const la = Array.isArray(a) ? a.length : -1;
    const lb = Array.isArray(b) ? b.length : -1;
    if (la !== lb) {
      out.push({ path: `${path}.length`, a: la, b: lb });
      return;
    }
    for (let i = 0; i < la; i++) deepDiff((a as unknown[])[i], (b as unknown[])[i], `${path}[${i}]`, out, skip);
    return;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) deepDiff(ao[k], bo[k], path ? `${path}.${k}` : k, out, skip);
}

// ── CHECK A: decision equivariance over sampled states ────────────────────────

interface CheckAResult {
  samples: number;
  fails: number;
  verbCounts: Record<string, number>;
  reports: string[];
  // CHECK B: full-step (aiStep + stepPhysics) equivariance on the same samples.
  bSamples: number;
  bFails: number;
  bReports: string[];
}

function fmt(v: unknown): string {
  if (typeof v === 'number') return v.toFixed(6);
  return JSON.stringify(v);
}

/** Which action the owner executed this aiStep, inferred from the ball delta. */
function classifyOwnerAction(before: World, after: World): string {
  if (before.ball.ownerId === null) return before.ball.ownerId === after.ball.ownerId ? 'none(free)' : 'trap';
  if (after.shotInFlightSince === after.clock && before.shotInFlightSince !== after.clock) return 'shot';
  // a loft raises vz from 0
  if (after.ball.vz > 1e-6 && Math.abs(before.ball.vz) < 1e-6) return 'loft';
  if (after.ball.ownerId === null && before.ball.ownerId !== null) {
    // ball released this tick without a loft/shot ⇒ ground pass or take-on knock
    return after.ballInFlightFrom !== null ? 'pass' : 'takeOnKnock';
  }
  return 'hold/carry';
}

function checkA(): CheckAResult {
  const res: CheckAResult = { samples: 0, fails: 0, verbCounts: {}, reports: [], bSamples: 0, bFails: 0, bReports: [] };
  const steps = Math.round((MINUTES * 60) / SIM_DT);
  for (let m = 0; m < MATCHES; m++) {
    const matchup = MATCHUPS[m % MATCHUPS.length];
    const world = createWorld(matchup, SEED_BASE + m);
    for (let i = 0; i < steps; i++) {
      aiStep(world, SIM_DT);
      stepPhysics(world, SIM_DT);
      if (i % STRIDE !== 0) continue;

      // Sample this state. Force the owner to re-decide so every sample exercises
      // a fresh decideOwner/execute (broad verb coverage).
      const sample = cloneWorld(world);
      if (sample.ball.ownerId !== null) sample.players[sample.ball.ownerId].decisionTimer = 0;

      const A = cloneWorld(sample);
      const B = cloneWorld(sample);
      reflect(B);

      const beforeA = cloneWorld(A);
      const beforeB = cloneWorld(B);
      aiStep(A, SIM_DT);
      aiStepMirrored(B, SIM_DT); // B = R(A): R写像後のフェーズ S_{1-f} で進める(Task AV)

      const action = classifyOwnerAction(beforeA, A);
      const actionB = classifyOwnerAction(beforeB, B);
      res.verbCounts[action] = (res.verbCounts[action] ?? 0) + 1;
      res.samples++;

      // A SHOT's aim uses a signed rand coin when the GK is centered (or the
      // center-aim branch) — symmetric-in-expectation, not a color bias — and it
      // cascades into the same-tick defensive chase (a now-loose ball). Exclude
      // shot ticks from the bit-exact assertion; validate them by the relaxed
      // check (both worlds shoot, toward the correct goal, same power) and skip
      // CHECK B for the tick (the cascade would false-positive).
      const shotFired = action === 'shot';
      if (shotFired || actionB === 'shot') {
        const diffs: Diff[] = [];
        if (action !== actionB) {
          diffs.push({ path: 'owner.action(shot)', a: action, b: actionB });
        } else {
          const va = negd(A.ball.vel); // reflect(A).ball.vel
          const vb = B.ball.vel;
          if (!almostEq(Math.hypot(va.x, va.y), Math.hypot(vb.x, vb.y))) diffs.push({ path: 'ball.speed(shot)', a: Math.hypot(va.x, va.y), b: Math.hypot(vb.x, vb.y) });
          if (Math.sign(va.x) !== Math.sign(vb.x)) diffs.push({ path: 'ball.vel.x.sign(shot)', a: va.x, b: vb.x });
        }
        if (diffs.length > 0) {
          res.fails++;
          if (res.reports.length < MAX_REPORT) {
            res.reports.push(
              `[A] match ${m} tick ${i} action=${action}/${actionB} (shot)\n` +
                diffs.map((d) => `    ${d.path}: reflect(A)=${fmt(d.a)} vs B=${fmt(d.b)}`).join('\n'),
            );
          }
        }
        continue;
      }

      const AR = cloneWorld(A);
      reflect(AR);
      const skip = (p: string): boolean => p === 'message';
      const diffs: Diff[] = [];
      deepDiff(AR, B, '', diffs, skip);

      if (diffs.length > 0) {
        res.fails++;
        if (res.reports.length < MAX_REPORT) {
          const maxAbs = Math.max(...diffs.filter((d) => typeof d.a === 'number').map((d) => Math.abs((d.a as number) - (d.b as number))));
          const kinds = new Set<string>();
          for (const d of diffs) {
            const mm = d.path.match(/^players\[(\d+)\]/);
            if (mm) kinds.add(`${mm[1]}:${A.players[Number(mm[1])].intent?.kind ?? A.players[Number(mm[1])].defenseRole ?? '?'}`);
          }
          const head = `[A] match ${m} (${matchup[0]} vs ${matchup[1]}) tick ${i} action=${action} ownerId=${sample.ball.ownerId} maxAbs=${maxAbs.toExponential(2)} kinds=${[...kinds].slice(0, 6).join(',')}`;
          const body = diffs.slice(0, 8).map((d) => `    ${d.path}: reflect(A)=${fmt(d.a)} vs B=${fmt(d.b)}`).join('\n');
          res.reports.push(`${head}\n${body}${diffs.length > 8 ? `\n    …(+${diffs.length - 8} more fields)` : ''}`);
        }
      }

      // ── CHECK B: continue the SAME tick through stepPhysics ────────────────
      // Player integration, ballistic flight, block/trap/GK-sweep contests. With
      // the id-aligned reflection the RNG stream stays aligned, so a symmetric
      // sim mirrors exactly EXCEPT the signed-rand paths (shot aim coin, block
      // deflection jitter, kickoff coin) — detected via a stepPhysics rand draw
      // or a score change, under which ball.pos/ball.vel are compared by
      // magnitude/ownership rather than exact vector.
      const scoreBeforeA: [number, number] = [A.score[0], A.score[1]];
      const rngBeforePhysA = A.rngState;
      stepPhysics(A, SIM_DT);
      stepPhysics(B, SIM_DT);
      res.bSamples++;
      const scoredThisTick = A.score[0] !== scoreBeforeA[0] || A.score[1] !== scoreBeforeA[1];
      if (scoredThisTick) continue; // goal ⇒ kickoff coin resets asymmetrically; skip
      const physicsDrewRand = A.rngState !== rngBeforePhysA;
      const AR2 = cloneWorld(A);
      reflect(AR2);
      const skipB = (p: string): boolean =>
        p === 'message' || (physicsDrewRand && (p === 'ball.vel' || p.startsWith('ball.vel.') || p === 'ball.pos' || p.startsWith('ball.pos.')));
      const bdiffs: Diff[] = [];
      deepDiff(AR2, B, '', bdiffs, skipB);
      if (physicsDrewRand) {
        // still assert the ball ended up mirrored in magnitude and ownership
        const sa = Math.hypot(AR2.ball.vel.x, AR2.ball.vel.y);
        const sb = Math.hypot(B.ball.vel.x, B.ball.vel.y);
        if (!almostEq(sa, sb)) bdiffs.push({ path: 'ball.speed(rand)', a: sa, b: sb });
      }
      if (bdiffs.length > 0) {
        res.bFails++;
        if (res.bReports.length < MAX_REPORT) {
          const maxAbs = Math.max(...bdiffs.filter((d) => typeof d.a === 'number').map((d) => Math.abs((d.a as number) - (d.b as number))));
          const head = `[B] match ${m} (${matchup[0]} vs ${matchup[1]}) tick ${i} action=${action} drewRand=${physicsDrewRand} maxAbs=${maxAbs.toExponential(2)}`;
          const body = bdiffs.slice(0, 8).map((d) => `    ${d.path}: reflect(A)=${fmt(d.a)} vs B=${fmt(d.b)}`).join('\n');
          res.bReports.push(`${head}\n${body}${bdiffs.length > 8 ? `\n    …(+${bdiffs.length - 8} more fields)` : ''}`);
        }
      }
    }
  }
  return res;
}

// ── CHECK C: physics equivariance over constructed airborne states ────────────

interface CheckCResult {
  cases: number;
  fails: number;
  reports: string[];
}

/** Build a minimal world then place all players far from a given point. */
function bareWorld(seed: number): World {
  const w = createWorld(['4-4-2', '4-4-2'], seed);
  return w;
}

/** Park every player at a harmless spot so nobody blocks/traps/chases the ball. */
function parkPlayersAway(w: World): void {
  // Two neutral clusters, both > 15 m from the ball path, mirror-symmetric so the
  // parking itself does not break equivariance.
  for (const p of w.players) {
    const sign = p.team === 0 ? -1 : 1;
    p.pos = { x: sign * 40, y: p.role * 0.3 * (p.team === 0 ? 1 : -1) };
    p.vel = { x: 0, y: 0 };
    p.moveTarget = { ...p.pos };
    p.intent = null;
    p.instruction = null;
    p.kickCooldown = 1e9; // never touch the ball during this test
  }
}

function checkCComparingTicks(name: string, build: () => World, ticks: number, res: CheckCResult): void {
  res.cases++;
  const W = build();
  const B = cloneWorld(W);
  reflect(B);
  for (let t = 0; t < ticks; t++) {
    stepPhysics(W, SIM_DT);
    stepPhysics(B, SIM_DT);
    const AR = cloneWorld(W);
    reflect(AR);
    const diffs: Diff[] = [];
    deepDiff(AR, B, '', diffs, (p) => p === 'message');
    if (diffs.length > 0) {
      res.fails++;
      res.reports.push(
        `[C] ${name} tick ${t}:\n` +
          diffs.slice(0, 6).map((d) => `    ${d.path}: reflect(W)=${fmt(d.a)} vs B=${fmt(d.b)}`).join('\n'),
      );
      return;
    }
  }
}

function checkCScore(name: string, build: () => World, res: CheckCResult): void {
  res.cases++;
  const W = build();
  const B = cloneWorld(W);
  reflect(B);
  // Step until a goal or 120 ticks.
  let scoredW: Team | null = null;
  let scoredB: Team | null = null;
  const s0W: [number, number] = [W.score[0], W.score[1]];
  const s0B: [number, number] = [B.score[0], B.score[1]];
  for (let t = 0; t < 120; t++) {
    stepPhysics(W, SIM_DT);
    if (scoredW === null) {
      if (W.score[0] > s0W[0]) scoredW = 0;
      else if (W.score[1] > s0W[1]) scoredW = 1;
    }
    stepPhysics(B, SIM_DT);
    if (scoredB === null) {
      if (B.score[0] > s0B[0]) scoredB = 0;
      else if (B.score[1] > s0B[1]) scoredB = 1;
    }
  }
  // Under R, team t scoring in W must correspond to team (1-t) scoring in B.
  const expected = scoredW === null ? null : flipTeam(scoredW);
  if (scoredW === null || scoredB !== expected) {
    res.fails++;
    res.reports.push(`[C] ${name}: scoredW=${scoredW} scoredB=${scoredB} expected(B)=${expected}`);
  }
}

function checkC(): CheckCResult {
  const res: CheckCResult = { cases: 0, fails: 0, reports: [] };

  // 1. Pure ballistic flight/bounce/settle over midfield, nobody near.
  checkCComparingTicks(
    'ballistic-flight',
    () => {
      const w = bareWorld(11);
      parkPlayersAway(w);
      w.ball = {
        pos: { x: -20, y: 8 },
        vel: { x: 9, y: -2.5 },
        z: 0.5,
        vz: 12,
        ownerId: null,
        lastTouchTeam: 0,
        lastPasserId: null,
      };
      w.ballInFlightFrom = 0;
      return w;
    },
    90,
    res,
  );

  // 2. Diagonal loft the other way (guards against a single-orientation pass).
  checkCComparingTicks(
    'ballistic-flight-2',
    () => {
      const w = bareWorld(12);
      parkPlayersAway(w);
      w.ball = {
        pos: { x: 15, y: -18 },
        vel: { x: -6, y: 7 },
        z: 1.2,
        vz: 9,
        ownerId: null,
        lastTouchTeam: 1,
        lastPasserId: null,
      };
      w.ballInFlightFrom = 1;
      return w;
    },
    90,
    res,
  );

  // 3. Low ball crossing the +x goal line under the bar ⇒ team 0 goal.
  checkCScore('goal-under-bar', () => {
    const w = bareWorld(13);
    parkPlayersAway(w);
    w.ball = {
      pos: { x: 51.5, y: 1 },
      vel: { x: 14, y: 0 },
      z: 1.0,
      vz: 0,
      ownerId: null,
      lastTouchTeam: 0,
      lastPasserId: null,
    };
    w.ballInFlightFrom = null;
    return w;
  }, res);

  // 4. High ball over the +x goal line ABOVE the bar ⇒ NOT a goal (goal-kick).
  checkCComparingTicks(
    'over-bar-no-goal',
    () => {
      const w = bareWorld(14);
      parkPlayersAway(w);
      // Place two restart-eligible players symmetrically near each goal so the
      // goal-kick / restart assignment is itself mirror-symmetric.
      w.players[1].pos = { x: 48, y: 0 };
      w.players[1].kickCooldown = 0;
      w.players[12].pos = { x: -48, y: 0 };
      w.players[12].kickCooldown = 0;
      w.ball = {
        pos: { x: 52, y: 0.5 },
        vel: { x: 12, y: 0 },
        z: 3.2, // above CROSSBAR_HEIGHT (2.44)
        vz: 1,
        ownerId: null,
        lastTouchTeam: 1, // team 1 last touched ⇒ team 0 goal-kick
        lastPasserId: null,
      };
      w.ballInFlightFrom = null;
      return w;
    },
    6,
    res,
  );

  // 5. Ball rolling out over a side touchline ⇒ throw-in, restart side mirrors.
  checkCComparingTicks(
    'touchline-restart',
    () => {
      const w = bareWorld(15);
      parkPlayersAway(w);
      w.players[3].pos = { x: 10, y: 30 };
      w.players[3].kickCooldown = 0;
      w.players[14].pos = { x: -10, y: -30 };
      w.players[14].kickCooldown = 0;
      w.ball = {
        pos: { x: 8, y: 33 },
        vel: { x: 1, y: 6 },
        z: 0,
        vz: 0,
        ownerId: null,
        lastTouchTeam: 0,
        lastPasserId: null,
      };
      w.ballInFlightFrom = null;
      return w;
    },
    6,
    res,
  );

  return res;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const t0 = Date.now();
  console.log('=== Mirror-symmetry probe (Task AR) ===');
  console.log(
    `CHECK A: ${MATCHES} matches x ${MINUTES} min, sample every ${STRIDE} ticks, seeds ${SEED_BASE}..${SEED_BASE + MATCHES - 1}, order=${ORDER}`,
  );
  const a = checkA();
  console.log(
    `\nCHECK A (decision equivariance): ${a.samples} sampled ticks, ${a.fails} non-mirroring — ${a.fails === 0 ? 'PASS' : 'FAIL'}`,
  );
  const verbs = Object.entries(a.verbCounts)
    .sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  console.log(`  owner-action coverage: ${verbs}`);
  for (const r of a.reports) console.log(r);

  console.log(
    `\nCHECK B (full-step incl. physics): ${a.bSamples} sampled ticks, ${a.bFails} non-mirroring — ${a.bFails === 0 ? 'PASS' : 'FAIL'}`,
  );
  for (const r of a.bReports) console.log(r);

  const c = checkC();
  console.log(
    `\nCHECK C (physics equivariance): ${c.cases} constructed cases, ${c.fails} non-mirroring — ${c.fails === 0 ? 'PASS' : 'FAIL'}`,
  );
  for (const r of c.reports) console.log(r);

  const pass = a.fails === 0 && a.bFails === 0 && c.fails === 0;
  console.log(`\nRuntime: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`\nOVERALL: ${pass ? 'PASS — sim is color-symmetric on the sampled set' : 'FAIL — asymmetry found (see above)'}`);
  process.exit(pass ? 0 : 1);
}

main();
