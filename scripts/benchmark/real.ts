/**
 * Compute benchmark metrics from StatsBomb open data.
 *
 * Filter: open play only (play_pattern.name === 'Regular Play').
 * Pitch coords: StatsBomb 120 × 80.  Forward = +x in the possession team's frame.
 */

import {
  fetchEvents,
  selectRepresentativeMatches,
  SB_PITCH_LENGTH,
  type SBEvent,
} from './statsbomb.ts';
import {
  classifyPassDirection,
  classifyThird,
  percentile,
  segmentPossessions,
  type BenchmarkMetrics,
  type OnBallEvent,
  type PassDirection,
} from './metrics.ts';

// StatsBomb pass angle: 0 = right, π/2 = up.
// When the team attacks in +x, this angle IS already in the forward frame.
// (StatsBomb events are already normalised so that the possessing team's goal
//  is always to the right / increasing x, so we can use angle directly.)

function passAngleInAttackingFrame(angle: number): number {
  // StatsBomb angle: 0 = right (+x = forward), π/2 = up, ±π = backward.
  // That matches our convention directly.
  return angle;
}

/** Compute a forward-frame x coordinate from StatsBomb raw x.
 *  StatsBomb: 0 = own goal line, 120 = opp goal line (already in attacking direction).
 */
function sbXFwd(rawX: number): number {
  return rawX; // already 0..120 in attacking direction
}

interface PerMatchAccumulator {
  passCounts: number[];
  passCompletedCounts: number[];
  passLengths: number[];
  passDirections: PassDirection[];
  carryCountsPerTeam: number[];
  carryDistances: number[];
  shotCountsPerTeam: number[];
  thirdEvents: Array<'defensive' | 'middle' | 'attacking'>;
  onBallEvents: OnBallEvent[];
}

function createAcc(): PerMatchAccumulator {
  return {
    passCounts: [],
    passCompletedCounts: [],
    passLengths: [],
    passDirections: [],
    carryCountsPerTeam: [],
    carryDistances: [],
    shotCountsPerTeam: [],
    thirdEvents: [],
    onBallEvents: [],
  };
}

/** Process one match's events and accumulate into global totals. */
function processMatchEvents(events: SBEvent[], acc: PerMatchAccumulator) {
  // Collect team names
  const teams = new Set<string>();
  for (const ev of events) {
    if ((ev as { team?: { name: string } }).team?.name) {
      teams.add((ev as { team: { name: string } }).team.name);
    }
  }

  const teamList = [...teams];
  const passCountByTeam: Record<string, number> = {};
  const passComplByTeam: Record<string, number> = {};
  const carryCountByTeam: Record<string, number> = {};
  const shotCountByTeam: Record<string, number> = {};

  for (const t of teamList) {
    passCountByTeam[t] = 0;
    passComplByTeam[t] = 0;
    carryCountByTeam[t] = 0;
    shotCountByTeam[t] = 0;
  }

  for (const ev of events) {
    const typeName = ev.type.name;
    const patternName = ev.play_pattern.name;
    const teamName = (ev as { team: { name: string } }).team.name;

    // Filter to open play only
    if (patternName !== 'Regular Play') continue;

    if (typeName === 'Pass') {
      const passEv = ev as unknown as { pass: { length: number; angle: number; end_location: [number, number]; outcome?: { name: string } }; location: [number, number] };
      const pass = passEv.pass;
      const completed = !pass.outcome; // absent = complete
      const angle = passAngleInAttackingFrame(pass.angle);
      // StatsBomb length is already in yards? No — it's in their pitch units (0-120 for length).
      // Their pitch 120 units = 105m, so 1 unit ≈ 0.875m.
      const lengthM = pass.length * (105 / 120);

      acc.passLengths.push(lengthM);
      acc.passDirections.push(classifyPassDirection(angle));

      passCountByTeam[teamName] = (passCountByTeam[teamName] ?? 0) + 1;
      if (completed) passComplByTeam[teamName] = (passComplByTeam[teamName] ?? 0) + 1;

      acc.onBallEvents.push({ team: teamName, type: 'pass', passCompleted: completed });

      // Pitch third (use start location x)
      const xFwd = sbXFwd(passEv.location[0]);
      acc.thirdEvents.push(classifyThird(xFwd, SB_PITCH_LENGTH));
    } else if (typeName === 'Carry') {
      const carryEv = ev as unknown as { carry: { end_location: [number, number] }; location: [number, number] };
      const startX = carryEv.location[0];
      const startY = carryEv.location[1];
      const endX = carryEv.carry.end_location[0];
      const endY = carryEv.carry.end_location[1];
      const dist = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2) * (105 / 120);

      carryCountByTeam[teamName] = (carryCountByTeam[teamName] ?? 0) + 1;
      acc.carryDistances.push(dist);
      acc.onBallEvents.push({ team: teamName, type: 'carry' });

      const xFwd = sbXFwd(startX);
      acc.thirdEvents.push(classifyThird(xFwd, SB_PITCH_LENGTH));
    } else if (typeName === 'Shot') {
      const shotEv = ev as unknown as { location: [number, number] };
      shotCountByTeam[teamName] = (shotCountByTeam[teamName] ?? 0) + 1;
      acc.onBallEvents.push({ team: teamName, type: 'shot' });

      const xFwd = sbXFwd(shotEv.location[0]);
      acc.thirdEvents.push(classifyThird(xFwd, SB_PITCH_LENGTH));
    }
  }

  // Aggregate per-team per-match values
  for (const t of teamList) {
    acc.passCounts.push(passCountByTeam[t]);
    acc.passCompletedCounts.push(passComplByTeam[t]);
    acc.carryCountsPerTeam.push(carryCountByTeam[t]);
    acc.shotCountsPerTeam.push(shotCountByTeam[t]);
  }
}

function computeMetrics(acc: PerMatchAccumulator, matchSidesAnalysed: number): BenchmarkMetrics {
  // Pass direction split
  const total = acc.passDirections.length;
  const fwd = acc.passDirections.filter((d) => d === 'forward').length;
  const lat = acc.passDirections.filter((d) => d === 'lateral').length;
  const bck = acc.passDirections.filter((d) => d === 'backward').length;

  // Pass completion
  const totalPasses = acc.passCounts.reduce((s, v) => s + v, 0);
  const totalCompleted = acc.passCompletedCounts.reduce((s, v) => s + v, 0);
  const completionPct = totalPasses > 0 ? (totalCompleted / totalPasses) * 100 : 0;

  // Pass length percentiles
  const sortedLengths = [...acc.passLengths].sort((a, b) => a - b);

  // Carries
  const carriesPerTeamPerMatch =
    matchSidesAnalysed > 0
      ? acc.carryCountsPerTeam.reduce((s, v) => s + v, 0) / matchSidesAnalysed
      : 0;
  const meanCarryDistM =
    acc.carryDistances.length > 0
      ? acc.carryDistances.reduce((s, v) => s + v, 0) / acc.carryDistances.length
      : 0;

  // Shots
  const shotsPerTeamPerMatch =
    matchSidesAnalysed > 0
      ? acc.shotCountsPerTeam.reduce((s, v) => s + v, 0) / matchSidesAnalysed
      : 0;

  // Possessions
  const possessions = segmentPossessions(acc.onBallEvents);
  const possessionsPerMatch = matchSidesAnalysed > 0 ? possessions.length / (matchSidesAnalysed / 2) : 0;
  const passesInPossessions = possessions.map((p) => p.passCount);
  const meanPassesPerPossession =
    passesInPossessions.length > 0
      ? passesInPossessions.reduce((s, v) => s + v, 0) / passesInPossessions.length
      : 0;

  // Third distribution
  const totalThirdEvents = acc.thirdEvents.length;
  const defCount = acc.thirdEvents.filter((t) => t === 'defensive').length;
  const midCount = acc.thirdEvents.filter((t) => t === 'middle').length;
  const attCount = acc.thirdEvents.filter((t) => t === 'attacking').length;

  return {
    pass: {
      totalPasses,
      completionPct,
      forwardPct: total > 0 ? (fwd / total) * 100 : 0,
      lateralPct: total > 0 ? (lat / total) * 100 : 0,
      backwardPct: total > 0 ? (bck / total) * 100 : 0,
      meanLengthM: sortedLengths.length > 0 ? sortedLengths.reduce((s, v) => s + v, 0) / sortedLengths.length : 0,
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
      defensivePct: totalThirdEvents > 0 ? (defCount / totalThirdEvents) * 100 : 0,
      middlePct: totalThirdEvents > 0 ? (midCount / totalThirdEvents) * 100 : 0,
      attackingPct: totalThirdEvents > 0 ? (attCount / totalThirdEvents) * 100 : 0,
    },
    matchSidesAnalysed,
  };
}

export async function computeRealMetrics(matchCount = 5): Promise<{ metrics: BenchmarkMetrics | null; networkOk: boolean; matchIds: number[]; competitionName: string; seasonName: string }> {
  console.log('  Selecting representative matches from StatsBomb open data…');
  const { matches, competitionName, seasonName } = await selectRepresentativeMatches(matchCount);

  if (matches.length === 0) {
    console.error('  [real] No matches fetched — network may be unavailable.');
    return { metrics: null, networkOk: false, matchIds: [], competitionName, seasonName };
  }

  console.log(`  Competition: ${competitionName} ${seasonName}`);
  console.log(`  Matches selected: ${matches.length}`);

  const acc = createAcc();
  const matchIds: number[] = [];
  let fetchedCount = 0;

  for (const match of matches) {
    process.stdout.write(`  Fetching events for match ${match.match_id} (${match.home_team.home_team_name} vs ${match.away_team.away_team_name})… `);
    const events = await fetchEvents(match.match_id);
    if (!events) {
      console.log('FAILED');
      continue;
    }
    console.log(`${events.length} events`);
    processMatchEvents(events, acc);
    matchIds.push(match.match_id);
    fetchedCount++;
  }

  if (fetchedCount === 0) {
    console.error('  [real] Could not fetch any match events — network unavailable.');
    return { metrics: null, networkOk: false, matchIds: [], competitionName, seasonName };
  }

  // matchSides = 2 teams * matches fetched
  const metrics = computeMetrics(acc, fetchedCount * 2);
  return { metrics, networkOk: true, matchIds, competitionName, seasonName };
}
