/**
 * Match inspector — replay a seeded match headless and dump a player's
 * internal state (or an all-players table / event log) over a time window.
 *
 * Turns an owner eye-test report ("seed 42, around 3:15, blue #7 moved
 * impossibly") into diagnosable evidence: since a match is a pure function
 * of (formations, seed, tactics), this replays EXACTLY that match and
 * prints what the AI actually decided at that moment.
 *
 * Usage:
 *   npx tsx scripts/debug/inspect-match.ts --seed 42 --from 3:00 --to 3:30 \
 *     --team 0 --number 7 --interval 0.5 [--events] \
 *     [--home 4-4-2] [--away 4-4-2] \
 *     [--tactics0 manMark,press,line,wide] [--tactics1 manMark,press,line,wide]
 *
 * Output is plain, deterministic text (no wall-clock, no randomness beyond
 * the given seed) — safe to diff two runs or two seeds against each other.
 */
import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import { SIM_DT } from '../../src/sim/constants.ts';
import { FORMATION_NAMES, type FormationName } from '../../src/sim/formation.ts';
import { dist, len } from '../../src/sim/vec.ts';
import type { Player, Team, TeamStats, World } from '../../src/sim/types.ts';

// ── CLI parsing ──────────────────────────────────────────────────────────────

interface Args {
  seed: number;
  home: FormationName;
  away: FormationName;
  fromSec: number;
  toSec: number;
  team?: Team;
  number?: number;
  interval: number;
  events: boolean;
  tactics0?: [number, number, number, number];
  tactics1?: [number, number, number, number];
}

const MAX_WINDOW_SEC = 120;

function isFormationName(v: string): v is FormationName {
  return (FORMATION_NAMES as readonly string[]).includes(v);
}

/** Accepts "m:ss" (e.g. "3:15", "3:15.5") or a plain number of seconds ("195"). */
function parseTime(raw: string, flag: string): number {
  if (raw.includes(':')) {
    const [mStr, sStr] = raw.split(':');
    const m = Number(mStr);
    const s = Number(sStr);
    if (!Number.isFinite(m) || !Number.isFinite(s)) {
      throw new Error(`${flag}: cannot parse time "${raw}" (expected m:ss or seconds)`);
    }
    return m * 60 + s;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${flag}: cannot parse time "${raw}" (expected m:ss or seconds)`);
  }
  return n;
}

function parseTacticsArg(raw: string, flag: string): [number, number, number, number] {
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`${flag}: expected 4 comma-separated numbers "manMark,press,line,wide", got "${raw}"`);
  }
  return parts as [number, number, number, number];
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === 'events') {
      flags.add(key);
      continue;
    }
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`--${key} requires a value`);
    }
    map.set(key, next);
    i++;
  }

  if (!map.has('seed')) throw new Error('--seed is required');
  if (!map.has('from') || !map.has('to')) throw new Error('--from and --to are required (whole-match dumps are too noisy)');

  const seed = Number(map.get('seed'));
  if (!Number.isFinite(seed)) throw new Error(`--seed: not a number "${map.get('seed')}"`);

  const homeRaw = map.get('home') ?? '4-4-2';
  const awayRaw = map.get('away') ?? '4-4-2';
  if (!isFormationName(homeRaw)) throw new Error(`--home: unknown formation "${homeRaw}" (one of ${FORMATION_NAMES.join(', ')})`);
  if (!isFormationName(awayRaw)) throw new Error(`--away: unknown formation "${awayRaw}" (one of ${FORMATION_NAMES.join(', ')})`);

  const fromSec = parseTime(map.get('from')!, '--from');
  const toSec = parseTime(map.get('to')!, '--to');
  if (toSec <= fromSec) throw new Error(`--to (${toSec}s) must be after --from (${fromSec}s)`);
  if (toSec - fromSec > MAX_WINDOW_SEC) {
    throw new Error(`window ${(toSec - fromSec).toFixed(1)}s exceeds max ${MAX_WINDOW_SEC}s — narrow --from/--to`);
  }

  let team: Team | undefined;
  if (map.has('team')) {
    const t = Number(map.get('team'));
    if (t !== 0 && t !== 1) throw new Error(`--team: must be 0 or 1, got "${map.get('team')}"`);
    team = t;
  }

  let number: number | undefined;
  if (map.has('number')) {
    const n = Number(map.get('number'));
    if (!Number.isFinite(n)) throw new Error(`--number: not a number "${map.get('number')}"`);
    number = n;
  }

  if ((team !== undefined) !== (number !== undefined)) {
    throw new Error('--team and --number must be given together (both, or neither for the all-players table)');
  }

  const interval = map.has('interval') ? Number(map.get('interval')) : 0.5;
  if (!Number.isFinite(interval) || interval <= 0) throw new Error(`--interval: must be a positive number, got "${map.get('interval')}"`);

  const tactics0 = map.has('tactics0') ? parseTacticsArg(map.get('tactics0')!, '--tactics0') : undefined;
  const tactics1 = map.has('tactics1') ? parseTacticsArg(map.get('tactics1')!, '--tactics1') : undefined;

  return {
    seed,
    home: homeRaw,
    away: awayRaw,
    fromSec,
    toSec,
    team,
    number,
    interval,
    events: flags.has('events'),
    tactics0,
    tactics1,
  };
}

// ── Formatting helpers ───────────────────────────────────────────────────────

/** m:ss.ss — sub-second precision (the UI HUD only shows whole seconds; this tool needs more). */
function fmtClock(t: number): string {
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

function fmtVec(v: { x: number; y: number }): string {
  return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)})`;
}

function fmtIntent(p: Player): string {
  if (!p.intent) return 'none';
  const i = p.intent;
  return `${i.kind}→${fmtVec(i.target)} until=${fmtClock(i.until)} possTeam=${i.possTeam === null ? 'null' : i.possTeam}`;
}

function teamLabel(t: Team): string {
  return t === 0 ? 'blue(0)' : 'red(1)';
}

function nearestOpponentDist(world: World, p: Player): number {
  let best = Infinity;
  for (const o of world.players) {
    if (o.team === p.team) continue;
    const d = dist(p.pos, o.pos);
    if (d < best) best = d;
  }
  return best;
}

// ── Event detection (stats-delta + ownership transitions, same technique as
//    scripts/benchmark/sim.ts's instrumented runner) ─────────────────────────

interface EventLine {
  clock: number;
  text: string;
}

function statsSnapshot(world: World): [TeamStats, TeamStats] {
  return [{ ...world.stats[0] }, { ...world.stats[1] }];
}

/** Compares a stats snapshot to the live world and appends any new event lines. */
function detectEvents(world: World, prev: [TeamStats, TeamStats], events: EventLine[]): void {
  for (const team of [0, 1] as Team[]) {
    const a = prev[team];
    const b = world.stats[team];
    if (b.passes > a.passes) events.push({ clock: world.clock, text: `${teamLabel(team)} pass completed (passes ${a.passes}→${b.passes})` });
    if (b.shots > a.shots) events.push({ clock: world.clock, text: `${teamLabel(team)} shot (shots ${a.shots}→${b.shots})` });
    if (b.steals > a.steals) events.push({ clock: world.clock, text: `${teamLabel(team)} tackle/steal (steals ${a.steals}→${b.steals})` });
    if (b.interceptions > a.interceptions) events.push({ clock: world.clock, text: `${teamLabel(team)} interception (interceptions ${a.interceptions}→${b.interceptions})` });
    if (b.tackleLost > a.tackleLost) events.push({ clock: world.clock, text: `${teamLabel(team)} beaten by tackle (tackleLost ${a.tackleLost}→${b.tackleLost})` });
    if (b.crosses > a.crosses) events.push({ clock: world.clock, text: `${teamLabel(team)} cross (crosses ${a.crosses}→${b.crosses})` });
    if (b.switches > a.switches) events.push({ clock: world.clock, text: `${teamLabel(team)} switch of play (switches ${a.switches}→${b.switches})` });
    if (b.clearances > a.clearances) events.push({ clock: world.clock, text: `${teamLabel(team)} clearance (clearances ${a.clearances}→${b.clearances})` });
    if (b.punts > a.punts) events.push({ clock: world.clock, text: `${teamLabel(team)} GK punt (punts ${a.punts}→${b.punts})` });
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    console.error('\nUsage: npx tsx scripts/debug/inspect-match.ts --seed 42 --from 3:00 --to 3:30 [--team 0] [--number 7] [--interval 0.5] [--events] [--home 4-4-2] [--away 4-4-2] [--tactics0 m,p,l,w] [--tactics1 m,p,l,w]');
    process.exit(1);
  }

  const world = createWorld([args.home, args.away], args.seed);

  // Apply tactics overrides (defaults already match createWorld's own
  // defaults, which are identical to the UI's slider defaults — manMark=0,
  // pressIntensity=0.5, lineHeight=0, wideRuns=0.5 — see src/main.ts).
  const [d0m, d0p, d0l, d0w] = args.tactics0 ?? [world.tactics[0].manMark, world.tactics[0].pressIntensity, world.tactics[0].lineHeight, world.tactics[0].wideRuns];
  const [d1m, d1p, d1l, d1w] = args.tactics1 ?? [world.tactics[1].manMark, world.tactics[1].pressIntensity, world.tactics[1].lineHeight, world.tactics[1].wideRuns];
  world.tactics[0] = { manMark: d0m, pressIntensity: d0p, lineHeight: d0l, wideRuns: d0w };
  world.tactics[1] = { manMark: d1m, pressIntensity: d1p, lineHeight: d1l, wideRuns: d1w };

  console.log('=== Match inspector ===');
  console.log(`seed=${args.seed} home=${args.home} away=${args.away}`);
  console.log(
    `tactics blue(0): manMark=${world.tactics[0].manMark} press=${world.tactics[0].pressIntensity} line=${world.tactics[0].lineHeight} wide=${world.tactics[0].wideRuns}` +
      (args.tactics0 ? ' (overridden via --tactics0)' : ' (default — matches UI slider defaults)'),
  );
  console.log(
    `tactics red(1): manMark=${world.tactics[1].manMark} press=${world.tactics[1].pressIntensity} line=${world.tactics[1].lineHeight} wide=${world.tactics[1].wideRuns}` +
      (args.tactics1 ? ' (overridden via --tactics1)' : ' (default — matches UI slider defaults)'),
  );
  console.log(
    'CAVEAT: this replay matches the UI byte-for-byte only if no tactics slider was moved mid-match in the UI run. ' +
      'If the owner touched a slider during the match, use --tactics0/--tactics1 to approximate the value at the moment of interest.',
  );
  console.log(`window: ${fmtClock(args.fromSec)} .. ${fmtClock(args.toSec)} (interval=${args.interval}s)`);
  if (args.team !== undefined) {
    console.log(`focus: ${teamLabel(args.team)} #${args.number}`);
  } else {
    console.log('focus: none — printing compact all-players table at each sample');
  }
  console.log('');

  const focusPlayer = (): Player | undefined =>
    args.team === undefined
      ? undefined
      : world.players.find((p) => p.team === args.team && p.number === args.number);

  if (args.team !== undefined && !focusPlayer()) {
    console.error(`Error: no player with team=${args.team} number=${args.number} in formations [${args.home}, ${args.away}]`);
    process.exit(1);
  }

  const events: EventLine[] = [];

  // Step to --from. Events before the window are not printed but are still
  // simulated faithfully (the whole point is deterministic replay).
  let prevStats = statsSnapshot(world);
  while (world.clock < args.fromSec) {
    aiStep(world, SIM_DT);
    stepPhysics(world, SIM_DT);
    if (args.events) {
      detectEvents(world, prevStats, events);
      prevStats = statsSnapshot(world);
    }
  }

  // Sample at --interval steps from --from to --to.
  let nextSample = args.fromSec;
  while (world.clock <= args.toSec) {
    while (world.clock >= nextSample && nextSample <= args.toSec + 1e-9) {
      printSample(world, args);
      nextSample += args.interval;
    }
    if (world.clock >= args.toSec) break;
    aiStep(world, SIM_DT);
    stepPhysics(world, SIM_DT);
    if (args.events) {
      detectEvents(world, prevStats, events);
      prevStats = statsSnapshot(world);
    }
  }

  if (args.events) {
    console.log('');
    console.log(`=== Events in [${fmtClock(args.fromSec)}, ${fmtClock(args.toSec)}] ===`);
    const inWindow = events.filter((e) => e.clock >= args.fromSec && e.clock <= args.toSec);
    if (inWindow.length === 0) {
      console.log('(none)');
    } else {
      for (const e of inWindow) {
        console.log(`${fmtClock(e.clock)}  ${e.text}`);
      }
    }
    console.log('');
    console.log('Note: offside events are not printed — the sim does not yet track offsides (pending Task AD).');
  }
}

function printSample(world: World, args: Args): void {
  const ball = world.ball;
  const ballLine = `ball pos=${fmtVec(ball.pos)} vel=${fmtVec(ball.vel)} z=${ball.z.toFixed(2)} owner=${ball.ownerId === null ? 'none' : `#${world.players[ball.ownerId].number}(${teamLabel(world.players[ball.ownerId].team)})`}`;

  if (args.team !== undefined) {
    const p = world.players.find((pl) => pl.team === args.team && pl.number === args.number)!;
    const speed = len(p.vel);
    const nearOpp = nearestOpponentDist(world, p);
    const hasBall = world.ball.ownerId === p.id;
    console.log(`t=${fmtClock(world.clock)}`);
    console.log(`  pos=${fmtVec(p.pos)} vel=${fmtVec(p.vel)} speed=${speed.toFixed(2)}m/s`);
    console.log(`  intent=${fmtIntent(p)}`);
    console.log(`  moveTarget=${fmtVec(p.moveTarget)}`);
    console.log(`  nearestOpponentDist=${nearOpp.toFixed(2)}m hasBall=${hasBall}`);
    console.log(`  ${ballLine}`);
  } else {
    console.log(`t=${fmtClock(world.clock)}  ${ballLine}`);
    for (const p of world.players) {
      const intentKind = p.intent ? p.intent.kind : 'none';
      console.log(`  ${teamLabel(p.team)} #${p.number}: pos=${fmtVec(p.pos)} intent=${intentKind}`);
    }
  }
}

main();
