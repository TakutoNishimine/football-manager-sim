/**
 * Movement-realism metric definitions for the tracking benchmark (Task T).
 *
 * These are PURE helpers: no sim imports that mutate state, no I/O.  The only
 * src/sim imports are read-only formation classification (classifyRole,
 * GK_ROLE) and pitch dimensions — the same convention scripts/benchmark/sim.ts
 * already uses for its own event metrics.
 *
 * Forward-frame convention (matches scripts/benchmark/metrics.ts and sim.ts):
 * team 0 attacks +x, team 1 attacks -x.  toFwdX() maps world x to "meters from
 * own goal line" in a team's own attacking frame.
 */

import { classifyRole, GK_ROLE, type FormationName } from '../../../src/sim/formation.ts';
import { PITCH_LENGTH, PLAYER_MAX_SPEED, PLAYER_ACCEL } from '../../../src/sim/constants.ts';
import { classifyThird, percentile } from '../metrics.ts';

// ── Basic stats helpers ──────────────────────────────────────────────────────

export function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export interface MeanSd {
  mean: number;
  sd: number;
}

export function meanSd(xs: number[]): MeanSd {
  return { mean: mean(xs), sd: stddev(xs) };
}

// ── Speed bands ───────────────────────────────────────────────────────────────

/**
 * Source: Di Salvo 2007 / Bradley 2009 elite-match speed-zone conventions.
 *   standing  < 0.2 m/s
 *   walking   0.2 - 2 m/s
 *   jogging   2 - 4 m/s
 *   running   4 - 5.5 m/s
 *   sprinting > 5.5 m/s
 */
export type SpeedBand = 'standing' | 'walking' | 'jogging' | 'running' | 'sprinting';
export const SPEED_BANDS: SpeedBand[] = ['standing', 'walking', 'jogging', 'running', 'sprinting'];

export function classifySpeedBand(speed: number): SpeedBand {
  if (speed < 0.2) return 'standing';
  if (speed < 2) return 'walking';
  if (speed < 4) return 'jogging';
  if (speed < 5.5) return 'running';
  return 'sprinting';
}

export type SpeedBandCounts = Record<SpeedBand, number>;
export function emptyBandCounts(): SpeedBandCounts {
  return { standing: 0, walking: 0, jogging: 0, running: 0, sprinting: 0 };
}

// ── Forward-frame / role helpers ──────────────────────────────────────────────

/** World x -> meters from own goal line, in a team's own attacking frame. */
export function toFwdX(x: number, team: 0 | 1): number {
  const half = PITCH_LENGTH / 2;
  return team === 0 ? x + half : -x + half;
}

/** DF line = CB + SB (classifyRole's semantic classification). */
export function isDfLine(name: FormationName, role: number): boolean {
  if (role === GK_ROLE) return false;
  const c = classifyRole(name, role);
  return c.isCB || c.isSB;
}

/** MF line = outfield, non-FW, non-DF-line. */
export function isMfLine(name: FormationName, role: number): boolean {
  if (role === GK_ROLE) return false;
  const c = classifyRole(name, role);
  return !c.isFW && !c.isCB && !c.isSB;
}

/** Angular difference between two headings (radians), returned in degrees, range [0, 180]. */
export function angleDiffDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return (d * 180) / Math.PI;
}

// ── Penalty-area box (hardcoded — no constant exists in src/sim) ─────────────

export const PENALTY_BOX_DEPTH_M = 16.5;
export const PENALTY_BOX_WIDTH_M = 40.32;

/** Is (x, y) inside the *opponent's* penalty box, from `team`'s attacking frame? */
export function inOpponentBox(x: number, y: number, team: 0 | 1): boolean {
  const half = PITCH_LENGTH / 2;
  const halfWidth = PENALTY_BOX_WIDTH_M / 2;
  if (Math.abs(y) > halfWidth) return false;
  if (team === 0) return x > half - PENALTY_BOX_DEPTH_M && x <= half;
  return x < -half + PENALTY_BOX_DEPTH_M && x >= -half;
}

// ── Tracking frame ────────────────────────────────────────────────────────────

export interface TrackedPlayer {
  id: number;
  team: 0 | 1;
  role: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

// ── Per-match aggregate result ────────────────────────────────────────────────

export interface ReceptionReleaseStats {
  medianS: number;
  p25S: number;
  p75S: number;
  pctBelow05: number;
}

export interface PerMatchMetrics {
  minutes: number;
  possessionsPerMin: number;
  passesPerMin: number;
  shotsPerTeamPerMin: number;
  goalsPerMin: number;
  speedBandPctOutfield: SpeedBandCounts; // percentages, sum ~= 100
  speedBandPctGK: SpeedBandCounts;
  distance90kmMeanOutfield: number;
  accelP95: number;
  reversalsPerPlayerPerMin: number;
  blockHeightM: number;
  blockWidthM: number;
  lineHeightM: number; // pooled across both teams
  lineHeightByTeam: [number, number];
  dfMfGapM: number;
  receptionRelease: ReceptionReleaseStats;
  boxOccupancy: number;
}

export interface TempoCounts {
  possessions: number;
  passes: number;
  shots: number;
  goals: number;
}

const REVERSAL_WINDOW_FRAMES = 5; // 0.5s at 10Hz
const REVERSAL_ANGLE_DEG = 120;
const REVERSAL_SPEED_MIN = 2; // m/s

/**
 * Streaming per-match aggregator: ingest one 10Hz tracking frame at a time,
 * finalize() at match end.  Keeps only small running state (no full frame
 * history), so a 10-minute match at 10Hz (6000 frames x 22 players) stays cheap.
 */
export class TrackingAggregator {
  private readonly formations: [FormationName, FormationName];

  private outfieldFrames = 0;
  private gkFrames = 0;
  private speedBandOutfield = emptyBandCounts();
  private speedBandGK = emptyBandCounts();

  private outfieldIds = new Set<number>();
  private allIds = new Set<number>();
  private lastPos = new Map<number, { x: number; y: number }>();
  private distanceByPlayer = new Map<number, number>();
  private lastVel = new Map<number, { x: number; y: number }>();
  private accelSamples: number[] = [];

  // ring buffer of last REVERSAL_WINDOW_FRAMES (speed, heading) per player
  private speedHeadingHistory = new Map<number, { speed: number; heading: number }[]>();
  private reversalCount = new Map<number, number>();
  private lastReversalFrame = new Map<number, number>();
  private frameIndex = 0;

  private blockHeightSamples: number[] = [];
  private blockWidthSamples: number[] = [];
  private lineHeightSamples: number[] = [];
  private lineHeightSamplesByTeam: [number[], number[]] = [[], []];
  private dfMfGapSamples: number[] = [];
  private boxOccupancySamples: number[] = [];

  constructor(formations: [FormationName, FormationName]) {
    this.formations = formations;
  }

  ingestFrame(players: TrackedPlayer[], ballOwnerTeam: 0 | 1 | null, ballX: number, ballY: number): void {
    this.frameIndex++;

    for (const p of players) {
      const isGK = p.role === GK_ROLE;
      const speed = Math.hypot(p.vx, p.vy);
      const band = classifySpeedBand(speed);
      this.allIds.add(p.id);
      if (isGK) {
        this.gkFrames++;
        this.speedBandGK[band]++;
      } else {
        this.outfieldFrames++;
        this.speedBandOutfield[band]++;
        this.outfieldIds.add(p.id);

        const last = this.lastPos.get(p.id);
        if (last) {
          const d = Math.hypot(p.x - last.x, p.y - last.y);
          // Restart teleports (kickoff reset, goal-kick GK reposition, throw-in
          // taker placement) produce frame deltas no legal run can: cap at
          // 1.2 × max sprint distance per 0.1s frame and drop anything above.
          if (d <= PLAYER_MAX_SPEED * 0.1 * 1.2) {
            this.distanceByPlayer.set(p.id, (this.distanceByPlayer.get(p.id) ?? 0) + d);
          }
        }
      }
      this.lastPos.set(p.id, { x: p.x, y: p.y });

      const lastV = this.lastVel.get(p.id);
      if (lastV) {
        const dvx = p.vx - lastV.x;
        const dvy = p.vy - lastV.y;
        // sampleDt is fixed at 0.1s (10Hz sampling of a 1/120s physics tick).
        // Physics clamps steering to PLAYER_ACCEL per second, so any sample
        // above it is a restart teleport / velocity-zeroing artifact — drop it.
        const a = Math.hypot(dvx, dvy) / 0.1;
        if (a <= PLAYER_ACCEL * 1.05) this.accelSamples.push(a);
      }
      this.lastVel.set(p.id, { x: p.vx, y: p.vy });

      if (speed > REVERSAL_SPEED_MIN) {
        const heading = Math.atan2(p.vy, p.vx);
        const hist = this.speedHeadingHistory.get(p.id) ?? [];
        hist.push({ speed, heading });
        if (hist.length > REVERSAL_WINDOW_FRAMES + 1) hist.shift();
        this.speedHeadingHistory.set(p.id, hist);
        if (hist.length === REVERSAL_WINDOW_FRAMES + 1) {
          const prev = hist[0];
          if (prev.speed > REVERSAL_SPEED_MIN) {
            const diff = angleDiffDeg(heading, prev.heading);
            const lastCounted = this.lastReversalFrame.get(p.id) ?? -Infinity;
            if (diff > REVERSAL_ANGLE_DEG && this.frameIndex - lastCounted >= REVERSAL_WINDOW_FRAMES) {
              this.reversalCount.set(p.id, (this.reversalCount.get(p.id) ?? 0) + 1);
              this.lastReversalFrame.set(p.id, this.frameIndex);
            }
          }
        }
      } else {
        // speed dropped below threshold: history no longer represents a continuous fast run
        this.speedHeadingHistory.delete(p.id);
      }
    }

    for (const team of [0, 1] as const) {
      const outfield = players.filter((p) => p.team === team && p.role !== GK_ROLE);
      const name = this.formations[team];

      if (ballOwnerTeam !== null && ballOwnerTeam !== team) {
        // `team` is defending
        const ballFwdX = toFwdX(ballX, team);
        if (outfield.length > 0 && classifyThird(ballFwdX, PITCH_LENGTH) === 'middle') {
          const xs = outfield.map((p) => p.x);
          const ys = outfield.map((p) => p.y);
          this.blockHeightSamples.push(Math.max(...xs) - Math.min(...xs));
          this.blockWidthSamples.push(Math.max(...ys) - Math.min(...ys));
        }

        const dfPlayers = outfield.filter((p) => isDfLine(name, p.role));
        const mfPlayers = outfield.filter((p) => isMfLine(name, p.role));
        if (dfPlayers.length > 0) {
          const lineX = mean(dfPlayers.map((p) => toFwdX(p.x, team)));
          this.lineHeightSamples.push(lineX);
          this.lineHeightSamplesByTeam[team].push(lineX);
        }
        if (dfPlayers.length > 0 && mfPlayers.length > 0) {
          const dfX = mean(dfPlayers.map((p) => toFwdX(p.x, team)));
          const mfX = mean(mfPlayers.map((p) => toFwdX(p.x, team)));
          this.dfMfGapSamples.push(Math.abs(dfX - mfX));
        }
      } else if (ballOwnerTeam === team) {
        // `team` possesses
        const ballFwdX = toFwdX(ballX, team);
        if (classifyThird(ballFwdX, PITCH_LENGTH) === 'attacking') {
          const count = outfield.filter((p) => inOpponentBox(p.x, p.y, team)).length;
          this.boxOccupancySamples.push(count);
        }
      }
    }
  }

  finalize(minutes: number, tempo: TempoCounts, touchDurationsS: number[]): PerMatchMetrics {
    const pct = (counts: SpeedBandCounts, totalFrames: number): SpeedBandCounts => {
      const out = emptyBandCounts();
      if (totalFrames === 0) return out;
      for (const band of SPEED_BANDS) out[band] = (counts[band] / totalFrames) * 100;
      return out;
    };

    const outfieldDistances = Array.from(this.outfieldIds).map((id) => this.distanceByPlayer.get(id) ?? 0);
    const meanDistanceM = mean(outfieldDistances);
    const distance90kmMeanOutfield = minutes > 0 ? (meanDistanceM / 1000) * (90 / minutes) : 0;

    const sortedAccel = [...this.accelSamples].sort((a, b) => a - b);
    const accelP95 = percentile(sortedAccel, 95);

    const reversalsPerPlayer = Array.from(this.allIds).map(
      (id) => (this.reversalCount.get(id) ?? 0) / (minutes > 0 ? minutes : 1),
    );
    const reversalsPerPlayerPerMin = mean(reversalsPerPlayer);

    const sortedTouch = [...touchDurationsS].sort((a, b) => a - b);
    const receptionRelease: ReceptionReleaseStats = {
      medianS: percentile(sortedTouch, 50),
      p25S: percentile(sortedTouch, 25),
      p75S: percentile(sortedTouch, 75),
      pctBelow05:
        touchDurationsS.length > 0
          ? (touchDurationsS.filter((t) => t < 0.5).length / touchDurationsS.length) * 100
          : 0,
    };

    return {
      minutes,
      possessionsPerMin: minutes > 0 ? tempo.possessions / minutes : 0,
      passesPerMin: minutes > 0 ? tempo.passes / minutes : 0,
      shotsPerTeamPerMin: minutes > 0 ? tempo.shots / 2 / minutes : 0,
      goalsPerMin: minutes > 0 ? tempo.goals / minutes : 0,
      speedBandPctOutfield: pct(this.speedBandOutfield, this.outfieldFrames),
      speedBandPctGK: pct(this.speedBandGK, this.gkFrames),
      distance90kmMeanOutfield,
      accelP95,
      reversalsPerPlayerPerMin,
      blockHeightM: mean(this.blockHeightSamples),
      blockWidthM: mean(this.blockWidthSamples),
      lineHeightM: mean(this.lineHeightSamples),
      lineHeightByTeam: [mean(this.lineHeightSamplesByTeam[0]), mean(this.lineHeightSamplesByTeam[1])],
      dfMfGapM: mean(this.dfMfGapSamples),
      receptionRelease,
      boxOccupancy: mean(this.boxOccupancySamples),
    };
  }
}
