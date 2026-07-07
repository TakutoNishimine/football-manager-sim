/**
 * Compute benchmark metrics from the headless sim.
 *
 * Instruments the sim to emit the same events as the StatsBomb real-data side,
 * using identical metric definitions.  Works entirely outside src/ — we hook
 * into executePass / executeShot by monkey-patching world.ts exports at runtime
 * via a lightweight event bus passed into the sim loop.
 *
 * Forward direction: team 0 attacks +x; team 1 attacks -x.
 * For every on-ball event we convert to the possession team's forward frame.
 */

import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import { aiStep } from '../../src/sim/ai.ts';
import { SIM_DT, PITCH_LENGTH } from '../../src/sim/constants.ts';
import { len } from '../../src/sim/vec.ts';
import {
  classifyPassDirection,
  classifyThird,
  percentile,
  segmentPossessions,
  type BenchmarkMetrics,
  type OnBallEvent,
  type PassDirection,
} from './metrics.ts';
import { createCompletionTracker, type PassResolution } from './completion.ts';

// ── Event collection ─────────────────────────────────────────────────────────

interface SimPassEvent {
  team: 0 | 1;
  angleRad: number; // in attacking-forward frame (forward = 0)
  lengthM: number;
  completed: boolean;
  xFwdStart: number; // 0 = own goal line, PITCH_LENGTH = opp goal line
  kickX: number; // world x at kick time
  kickY: number; // world y at kick time
}

interface SimCarryEvent {
  team: 0 | 1;
  distM: number;
  xFwdStart: number;
}

interface SimShotEvent {
  team: 0 | 1;
  xFwdStart: number;
}

interface SimEventLog {
  passes: SimPassEvent[];
  carries: SimCarryEvent[];
  shots: SimShotEvent[];
  onBallSeq: OnBallEvent[]; // ordered sequence for possession segmentation
}

// ── Instrumented sim runner ───────────────────────────────────────────────────

/**
 * Convert a direction vector to angle-in-attacking-frame.
 * Team 0 attacks +x: angle = atan2(dy, dx).
 * Team 1 attacks -x: flip x, angle = atan2(dy, -dx).
 */
function dirToAngle(dx: number, dy: number, team: 0 | 1): number {
  if (team === 0) return Math.atan2(dy, dx);
  return Math.atan2(dy, -dx); // mirror x for team 1
}

/** Convert raw world x to forward-frame x (0 = own goal line). */
function toFwdX(x: number, team: 0 | 1): number {
  const half = PITCH_LENGTH / 2;
  if (team === 0) return x + half; // team 0 own goal at -half
  return -x + half; // team 1 own goal at +half
}

/**
 * Run one match and return instrumented event log.
 *
 * Pass completion is decided by the canonical tracker in
 * scripts/benchmark/completion.ts (Task AO — one definition, shared with
 * contest.ts and regression.ts); this function only attaches the extra
 * per-pass detail (angle/length/pitch position) this benchmark reports.
 */
function runInstrumentedMatch(matchMinutes: number, seed: number): SimEventLog {
  const log: SimEventLog = { passes: [], carries: [], shots: [], onBallSeq: [] };

  const world = createWorld(['4-4-2', '4-4-2'], seed);
  const totalSteps = Math.round((matchMinutes * 60) / SIM_DT);

  // Track carry state (ball owner + start position)
  let carryOwner: number | null = null;
  let carryStartX = 0;
  let carryStartY = 0;
  let carryTeam: 0 | 1 = 0;

  // Previous stats for detecting new shot events (for log.shots / onBallSeq;
  // the completion tracker below does its own independent shot detection to
  // decide pass outcomes).
  let prevShotCounts: [number, number] = [0, 0];

  // Detail (angle/length/position) for the currently in-flight pass, keyed
  // to the completion tracker's start/resolve events. `ballBefore` is
  // updated once per tick below and read by the onPassStart closure.
  let ballBefore = { ...world.ball };
  let pendingDetail: { angleRad: number; xFwdStart: number; kickX: number; kickY: number } | null = null;

  const completion = createCompletionTracker({
    // The tracker only fires onPassStart for kicks above its own minimum
    // speed threshold, so `vel` here is always safe to normalize.
    onPassStart: (team) => {
      const vel = world.ball.vel;
      const spd = len(vel);
      pendingDetail = {
        angleRad: dirToAngle(vel.x / spd, vel.y / spd, team),
        xFwdStart: toFwdX(ballBefore.pos.x, team),
        kickX: ballBefore.pos.x,
        kickY: ballBefore.pos.y,
      };
    },
    onPassResolved: (res: PassResolution) => {
      if (!pendingDetail) return;
      const detail = pendingDetail;
      pendingDetail = null;
      // A shot-terminated pass never had its catch point measured (matches
      // the original: length stays 0 in that case).
      const lengthM =
        res.via === 'reception'
          ? Math.sqrt((world.ball.pos.x - detail.kickX) ** 2 + (world.ball.pos.y - detail.kickY) ** 2)
          : 0;
      log.passes.push({
        team: res.team,
        angleRad: detail.angleRad,
        lengthM,
        completed: res.completed,
        xFwdStart: detail.xFwdStart,
        kickX: detail.kickX,
        kickY: detail.kickY,
      });
      log.onBallSeq.push({ team: res.team.toString(), type: 'pass', passCompleted: res.completed });
    },
  });

  for (let step = 0; step < totalSteps; step++) {
    // Snapshot before step
    ballBefore = { ...world.ball };
    const ownerBefore = ballBefore.ownerId;

    aiStep(world, SIM_DT);
    stepPhysics(world, SIM_DT);

    const ownerAfter = world.ball.ownerId;

    // ── Detect new shot (logged BEFORE completion.step so ordering within
    // onBallSeq matches the original: shot entry, then any pass-incomplete
    // entry it triggers) ───────────────────────────────────────────────────
    for (const team of [0, 1] as const) {
      if (world.stats[team].shots > prevShotCounts[team]) {
        prevShotCounts[team] = world.stats[team].shots;
        const xFwd = toFwdX(ballBefore.pos.x, team);
        log.shots.push({ team, xFwdStart: xFwd });
        log.onBallSeq.push({ team: team.toString(), type: 'shot' });
      }
    }

    // ── Canonical pass completion (start/shot/reception state machine) ──────
    completion.step(world, ownerBefore);

    // ── Carry tracking ───────────────────────────────────────────────────────
    if (ownerAfter !== null) {
      if (ownerAfter !== carryOwner) {
        // New owner started — if the previous owner was carrying for a while, record it
        if (carryOwner !== null) {
          const p = world.players[carryOwner];
          const curX = world.ball.pos.x;
          const curY = world.ball.pos.y;
          const carryDist = Math.sqrt((curX - carryStartX) ** 2 + (curY - carryStartY) ** 2);
          if (carryDist > 0.5) { // only record meaningful carries
            log.carries.push({
              team: carryTeam,
              distM: carryDist,
              xFwdStart: toFwdX(carryStartX, carryTeam),
            });
            log.onBallSeq.push({ team: carryTeam.toString(), type: 'carry' });
          }
        }
        carryOwner = ownerAfter;
        carryStartX = world.ball.pos.x;
        carryStartY = world.ball.pos.y;
        carryTeam = world.players[ownerAfter].team;
      }
    } else {
      // Ball is free — close any ongoing carry
      if (carryOwner !== null) {
        const curX = world.ball.pos.x;
        const curY = world.ball.pos.y;
        const carryDist = Math.sqrt((curX - carryStartX) ** 2 + (curY - carryStartY) ** 2);
        if (carryDist > 0.5) {
          log.carries.push({
            team: carryTeam,
            distM: carryDist,
            xFwdStart: toFwdX(carryStartX, carryTeam),
          });
          log.onBallSeq.push({ team: carryTeam.toString(), type: 'carry' });
        }
        carryOwner = null;
      }
    }
  }

  return log;
}

// ── Aggregate across matches ──────────────────────────────────────────────────

export function computeSimMetrics(matchCount = 10, matchMinutes = 10, baseSeed = 1): BenchmarkMetrics {
  const allPasses: SimPassEvent[] = [];
  const allCarries: SimCarryEvent[] = [];
  const allShots: SimShotEvent[] = [];
  const allOnBall: OnBallEvent[] = [];

  let totalMatchSides = 0;

  console.log(`  Running ${matchCount} headless sim matches (${matchMinutes} min each)…`);

  for (let i = 0; i < matchCount; i++) {
    process.stdout.write(`  Match ${i + 1}/${matchCount}… `);
    const log = runInstrumentedMatch(matchMinutes, baseSeed + i);
    allPasses.push(...log.passes);
    allCarries.push(...log.carries);
    allShots.push(...log.shots);
    allOnBall.push(...log.onBallSeq);
    totalMatchSides += 2; // 2 teams per match
    console.log(`passes=${log.passes.length} carries=${log.carries.length} shots=${log.shots.length}`);
  }

  // ── Pass metrics ──────────────────────────────────────────────────────────
  const passDirections: PassDirection[] = allPasses.map((p) => classifyPassDirection(p.angleRad));
  const passLengths = allPasses.map((p) => p.lengthM);
  const sortedLengths = [...passLengths].sort((a, b) => a - b);
  const totalPasses = allPasses.length;
  const completedPasses = allPasses.filter((p) => p.completed).length;
  const fwd = passDirections.filter((d) => d === 'forward').length;
  const lat = passDirections.filter((d) => d === 'lateral').length;
  const bck = passDirections.filter((d) => d === 'backward').length;

  // ── Carry metrics ─────────────────────────────────────────────────────────
  const carriesPerTeamPerMatch = totalMatchSides > 0 ? allCarries.length / totalMatchSides : 0;
  const meanCarryDistM =
    allCarries.length > 0
      ? allCarries.reduce((s, c) => s + c.distM, 0) / allCarries.length
      : 0;

  // ── Shots ─────────────────────────────────────────────────────────────────
  const shotsPerTeamPerMatch = totalMatchSides > 0 ? allShots.length / totalMatchSides : 0;

  // ── Possessions ───────────────────────────────────────────────────────────
  const possessions = segmentPossessions(allOnBall);
  const possessionsPerMatch = (matchCount > 0) ? possessions.length / matchCount : 0;
  const passesInPossessions = possessions.map((p) => p.passCount);
  const meanPassesPerPossession =
    passesInPossessions.length > 0
      ? passesInPossessions.reduce((s, v) => s + v, 0) / passesInPossessions.length
      : 0;

  // ── Pitch thirds ─────────────────────────────────────────────────────────
  const thirdEventsPass = allPasses.map((p) => classifyThird(p.xFwdStart, PITCH_LENGTH));
  const thirdEventsCarry = allCarries.map((c) => classifyThird(c.xFwdStart, PITCH_LENGTH));
  const thirdEventsShot = allShots.map((s) => classifyThird(s.xFwdStart, PITCH_LENGTH));
  const allThirds = [...thirdEventsPass, ...thirdEventsCarry, ...thirdEventsShot];
  const totalThird = allThirds.length;
  const defCount = allThirds.filter((t) => t === 'defensive').length;
  const midCount = allThirds.filter((t) => t === 'middle').length;
  const attCount = allThirds.filter((t) => t === 'attacking').length;

  return {
    pass: {
      totalPasses,
      completionPct: totalPasses > 0 ? (completedPasses / totalPasses) * 100 : 0,
      forwardPct: totalPasses > 0 ? (fwd / totalPasses) * 100 : 0,
      lateralPct: totalPasses > 0 ? (lat / totalPasses) * 100 : 0,
      backwardPct: totalPasses > 0 ? (bck / totalPasses) * 100 : 0,
      meanLengthM:
        sortedLengths.length > 0 ? sortedLengths.reduce((s, v) => s + v, 0) / sortedLengths.length : 0,
      p25LengthM: percentile(sortedLengths, 25),
      p50LengthM: percentile(sortedLengths, 50),
      p75LengthM: percentile(sortedLengths, 75),
    },
    carry: {
      carriesPerTeamPerMatch,
      meanCarryDistM,
    },
    possession: {
      possessionsPerMatch,
      meanPassesPerPossession,
    },
    shot: {
      shotsPerTeamPerMatch,
    },
    third: {
      defensivePct: totalThird > 0 ? (defCount / totalThird) * 100 : 0,
      middlePct: totalThird > 0 ? (midCount / totalThird) * 100 : 0,
      attackingPct: totalThird > 0 ? (attCount / totalThird) * 100 : 0,
    },
    matchSidesAnalysed: totalMatchSides,
  };
}
