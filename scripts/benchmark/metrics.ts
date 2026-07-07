/**
 * Metric definitions shared between the real-data and sim sides.
 *
 * Every metric is defined ONCE here.  Both sides call the same functions so
 * the comparison is apples-to-apples.
 *
 * Forward direction convention (both sides):
 *   - Real (StatsBomb): x increases toward the attacking goal (pitch 120×80).
 *   - Sim: team 0 attacks +x (pitch 105×68).
 *   We always work in the possession team's attacking direction.
 */

// ── Pass direction classification ────────────────────────────────────────────

/**
 * Classify a pass by angle (radians in the possession-team's attacking frame).
 *   forward:  |angle| < 60° (π/3)
 *   backward: |angle| > 120° (2π/3)
 *   lateral:  otherwise
 *
 * StatsBomb angle: 0 = right (+x toward goal), ±π = left.
 * Sim pass angle: computed from direction vector (same convention).
 */
export type PassDirection = 'forward' | 'lateral' | 'backward';

export function classifyPassDirection(angle: number): PassDirection {
  const a = Math.abs(angle);
  if (a < Math.PI / 3) return 'forward';
  if (a > (2 * Math.PI) / 3) return 'backward';
  return 'lateral';
}

// ── Percentile helper ────────────────────────────────────────────────────────

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ── Metric result types ──────────────────────────────────────────────────────

export interface PassMetrics {
  totalPasses: number;
  completionPct: number; // 0-100
  forwardPct: number;
  lateralPct: number;
  backwardPct: number;
  meanLengthM: number;
  p25LengthM: number;
  p50LengthM: number;
  p75LengthM: number;
}

export interface CarryMetrics {
  carriesPerTeamPerMatch: number;
  meanCarryDistM: number;
}

export interface PossessionMetrics {
  possessionsPerMatch: number;
  meanPassesPerPossession: number;
}

export interface ShotMetrics {
  shotsPerTeamPerMatch: number;
}

export interface ThirdMetrics {
  defensivePct: number; // on-ball events in defensive third (0-100)
  middlePct: number;
  attackingPct: number;
}

export interface BenchmarkMetrics {
  pass: PassMetrics;
  carry: CarryMetrics;
  possession: PossessionMetrics;
  shot: ShotMetrics;
  third: ThirdMetrics;
  /** Number of match-sides (team appearances in matches) analysed */
  matchSidesAnalysed: number;
}

// ── Possession segmenter ─────────────────────────────────────────────────────

/**
 * A "possession" is a run of consecutive on-ball events belonging to the same
 * team, ending when possession changes or a non-ball event breaks the sequence.
 *
 * "On-ball events" we count: Pass, Carry.
 * "Turnovers/stoppages" that end a possession:
 *   - The team changes on the next on-ball event.
 *   - The sequence contains no more on-ball events.
 *
 * Note: Shot events are NOT counted as on-ball continuation because they end
 * the possession immediately.  They are counted separately.
 *
 * Returns an array of possession objects, each with the sequence of pass/carry events.
 */
export interface Possession {
  team: string;
  passCount: number;
  carryCount: number;
}

export interface OnBallEvent {
  team: string;
  type: 'pass' | 'carry' | 'shot';
  passCompleted?: boolean;
}

export function segmentPossessions(events: OnBallEvent[]): Possession[] {
  const possessions: Possession[] = [];
  let current: Possession | null = null;

  for (const ev of events) {
    if (ev.type === 'shot') {
      // End current possession on shot
      if (current) {
        possessions.push(current);
        current = null;
      }
      continue;
    }
    if (current === null) {
      current = { team: ev.team, passCount: 0, carryCount: 0 };
    } else if (current.team !== ev.team) {
      possessions.push(current);
      current = { team: ev.team, passCount: 0, carryCount: 0 };
    }
    if (ev.type === 'pass') current.passCount++;
    else current.carryCount++;
  }
  if (current) possessions.push(current);
  return possessions;
}

// ── Pitch-third classification ────────────────────────────────────────────────

/**
 * Classify the ball's x-position into a pitch third, in the possession team's
 * attacking direction.
 *
 * xFwd: x in the possession team's forward frame (0 = own goal line, pitchLength = opp goal line)
 */
export type PitchThird = 'defensive' | 'middle' | 'attacking';

export function classifyThird(xFwd: number, pitchLength: number): PitchThird {
  const third = pitchLength / 3;
  if (xFwd < third) return 'defensive';
  if (xFwd < 2 * third) return 'middle';
  return 'attacking';
}
