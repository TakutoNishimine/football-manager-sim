/**
 * Tracking benchmark v2 — movement-realism metrics with per-minute normalization.
 *
 * Usage: npx tsx scripts/benchmark/tracking/run.ts [--matches=10] [--minutes=10] [--md]
 *
 * Models the loop on scripts/benchmark/sim.ts's runInstrumentedMatch: drive the
 * headless sim (createWorld + aiStep + stepPhysics) and, on top of the same
 * pass/shot/carry event detection already used there, sample a full tracking
 * frame (all player positions + velocities, ball state, score) at 10Hz.
 *
 * Why this exists: the event benchmark (scripts/benchmark/run.ts) compares
 * 10-min sim matches to ~95-min real matches with NO time normalization, and
 * measures zero movement.  See tasks/REALISM-ROADMAP.md.  This is the
 * acceptance test for the locomotion/tempo tasks (U/V/W/X) that follow —
 * it deliberately does NOT fix anything in src/.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createWorld, stepPhysics } from '../../../src/sim/world.ts';
import { aiStep } from '../../../src/sim/ai.ts';
import { SIM_DT } from '../../../src/sim/constants.ts';
import { GK_ROLE } from '../../../src/sim/formation.ts';
import { segmentPossessions, type OnBallEvent } from '../metrics.ts';
import {
  TrackingAggregator,
  meanSd,
  type MeanSd,
  type PerMatchMetrics,
  type TrackedPlayer,
} from './metrics.ts';
import { TARGETS, type TargetSpec } from './targets.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.resolve(__dirname, '../../../reports/tracking-latest.md');

const SAMPLE_EVERY_STEPS = 12; // 12 * SIM_DT(1/120) = 0.1s -> 10Hz
const SWEEP_MATCH_MINUTES = 5;
const SWEEP_MATCH_COUNT = 3;

// ── One instrumented match ───────────────────────────────────────────────────

function runOneMatch(matchMinutes: number, seed: number, lineHeightOverride?: { team: 0 | 1; value: number }): PerMatchMetrics {
  // Deterministic seed so runs are reproducible and comparable across machines/CI.
  const world = createWorld(['4-4-2', '4-4-2'], seed);
  if (lineHeightOverride) world.tactics[lineHeightOverride.team].lineHeight = lineHeightOverride.value;

  const totalSteps = Math.round((matchMinutes * 60) / SIM_DT);
  const agg = new TrackingAggregator(world.formations);

  const onBallSeq: OnBallEvent[] = [];
  const prevPassCounts: [number, number] = [0, 0];
  const prevShotCounts: [number, number] = [0, 0];

  let carryOwner: number | null = null;
  let carryStartX = 0;
  let carryStartY = 0;
  let carryTeam: 0 | 1 = 0;

  const touchStart = new Map<number, number>(); // playerId -> world.clock at possession gain
  const touchDurationsS: number[] = [];

  for (let step = 0; step < totalSteps; step++) {
    const ownerBefore = world.ball.ownerId;

    aiStep(world, SIM_DT);
    stepPhysics(world, SIM_DT);

    const ownerAfter = world.ball.ownerId;

    if (ownerAfter !== null && ownerAfter !== ownerBefore) {
      touchStart.set(ownerAfter, world.clock);
    }

    // ── Pass / shot detection (same stats-delta pattern as sim.ts) ──────────
    for (const team of [0, 1] as const) {
      if (world.stats[team].passes > prevPassCounts[team]) {
        prevPassCounts[team] = world.stats[team].passes;
        onBallSeq.push({ team: team.toString(), type: 'pass' });
        if (ownerBefore !== null) {
          const passer = world.players[ownerBefore];
          if (passer.role !== GK_ROLE) {
            const start = touchStart.get(ownerBefore);
            if (start !== undefined) touchDurationsS.push(world.clock - start);
          }
          touchStart.delete(ownerBefore);
        }
      }
      if (world.stats[team].shots > prevShotCounts[team]) {
        prevShotCounts[team] = world.stats[team].shots;
        onBallSeq.push({ team: team.toString(), type: 'shot' });
        if (ownerBefore !== null) {
          const shooter = world.players[ownerBefore];
          if (shooter.role !== GK_ROLE) {
            const start = touchStart.get(ownerBefore);
            if (start !== undefined) touchDurationsS.push(world.clock - start);
          }
          touchStart.delete(ownerBefore);
        }
      }
    }

    // ── Carry tracking (possession segmentation only) ───────────────────────
    if (ownerAfter !== null) {
      if (ownerAfter !== carryOwner) {
        if (carryOwner !== null) {
          const carryDist = Math.hypot(world.ball.pos.x - carryStartX, world.ball.pos.y - carryStartY);
          if (carryDist > 0.5) onBallSeq.push({ team: carryTeam.toString(), type: 'carry' });
        }
        carryOwner = ownerAfter;
        carryStartX = world.ball.pos.x;
        carryStartY = world.ball.pos.y;
        carryTeam = world.players[ownerAfter].team;
      }
    } else if (carryOwner !== null) {
      const carryDist = Math.hypot(world.ball.pos.x - carryStartX, world.ball.pos.y - carryStartY);
      if (carryDist > 0.5) onBallSeq.push({ team: carryTeam.toString(), type: 'carry' });
      carryOwner = null;
    }

    // ── 10Hz tracking sample ──────────────────────────────────────────────────
    if (step % SAMPLE_EVERY_STEPS === 0) {
      const players: TrackedPlayer[] = world.players.map((p) => ({
        id: p.id,
        team: p.team,
        role: p.role,
        x: p.pos.x,
        y: p.pos.y,
        vx: p.vel.x,
        vy: p.vel.y,
      }));
      const ballOwnerTeam = world.ball.ownerId !== null ? world.players[world.ball.ownerId].team : null;
      agg.ingestFrame(players, ballOwnerTeam, world.ball.pos.x, world.ball.pos.y);
    }
  }

  const possessions = segmentPossessions(onBallSeq);
  const totalPasses = world.stats[0].passes + world.stats[1].passes;
  const totalShots = world.stats[0].shots + world.stats[1].shots;
  const totalGoals = world.score[0] + world.score[1];

  return agg.finalize(
    matchMinutes,
    { possessions: possessions.length, passes: totalPasses, shots: totalShots, goals: totalGoals },
    touchDurationsS,
  );
}

// ── Cross-match aggregation ───────────────────────────────────────────────────

function seriesFor(matches: PerMatchMetrics[], key: string): number[] {
  switch (key) {
    case 'possessionsPerMin':
      return matches.map((m) => m.possessionsPerMin);
    case 'passesPerMin':
      return matches.map((m) => m.passesPerMin);
    case 'shotsPerTeamPerMin':
      return matches.map((m) => m.shotsPerTeamPerMin);
    case 'goalsPerMin':
      return matches.map((m) => m.goalsPerMin);
    case 'standingWalkingPct':
      return matches.map((m) => m.speedBandPctOutfield.standing + m.speedBandPctOutfield.walking);
    case 'joggingPct':
      return matches.map((m) => m.speedBandPctOutfield.jogging);
    case 'runningPct':
      return matches.map((m) => m.speedBandPctOutfield.running);
    case 'sprintingPct':
      return matches.map((m) => m.speedBandPctOutfield.sprinting);
    case 'distance90km':
      return matches.map((m) => m.distance90kmMeanOutfield);
    case 'accelP95':
      return matches.map((m) => m.accelP95);
    case 'blockHeightM':
      return matches.map((m) => m.blockHeightM);
    case 'blockWidthM':
      return matches.map((m) => m.blockWidthM);
    case 'lineHeightM':
      return matches.map((m) => m.lineHeightM);
    case 'dfMfGapM':
      return matches.map((m) => m.dfMfGapM);
    case 'receptionMedianS':
      return matches.map((m) => m.receptionRelease.medianS);
    case 'receptionPctBelow05':
      return matches.map((m) => m.receptionRelease.pctBelow05);
    case 'boxOccupancy':
      return matches.map((m) => m.boxOccupancy);
    case 'reversalsPerPlayerPerMin':
      return matches.map((m) => m.reversalsPerPlayerPerMin);
    default:
      throw new Error(`unknown metric key: ${key}`);
  }
}

// ── Formatting ────────────────────────────────────────────────────────────────

function targetStr(spec: TargetSpec, unit: string): string {
  switch (spec.kind) {
    case 'range':
      return `${spec.low}–${spec.high}${unit}`;
    case 'max':
      return `≤ ${spec.value}${unit}`;
    case 'min':
      return `≥ ${spec.value}${unit}`;
    case 'none':
      return '—';
  }
}

function verdictFor(value: number, spec: TargetSpec): 'PASS' | 'FAIL' | '—' {
  switch (spec.kind) {
    case 'range':
      return value >= spec.low && value <= spec.high ? 'PASS' : 'FAIL';
    case 'max':
      return value <= spec.value ? 'PASS' : 'FAIL';
    case 'min':
      return value >= spec.value ? 'PASS' : 'FAIL';
    case 'none':
      return '—';
  }
}

function decimalsFor(unit: string): number {
  if (unit === '%') return 1;
  if (unit === '') return 2;
  return 2;
}

function simStr(stat: MeanSd, unit: string): string {
  const d = decimalsFor(unit);
  return `${stat.mean.toFixed(d)} ± ${stat.sd.toFixed(d)}${unit}`;
}

interface TableRow {
  label: string;
  target: string;
  sim: string;
  verdict: string;
}

function renderTable(rows: TableRow[]): string {
  const headers = ['Metric', 'Target', 'Sim (mean ± sd)', 'Verdict'];
  const colWidths = [
    Math.max(headers[0].length, ...rows.map((r) => r.label.length)),
    Math.max(headers[1].length, ...rows.map((r) => r.target.length)),
    Math.max(headers[2].length, ...rows.map((r) => r.sim.length)),
    Math.max(headers[3].length, ...rows.map((r) => r.verdict.length)),
  ];
  const pad = (s: string, w: number) => s.padEnd(w);
  const line = (cells: string[]) => `| ${cells.map((c, i) => pad(c, colWidths[i])).join(' | ')} |`;
  const sep = `| ${colWidths.map((w) => '-'.repeat(w)).join(' | ')} |`;
  const lines = [line(headers), sep];
  for (const r of rows) lines.push(line([r.label, r.target, r.sim, r.verdict]));
  return lines.join('\n');
}

function buildMainTable(matches: PerMatchMetrics[]): { rows: TableRow[]; failCount: number; passCount: number } {
  const rows: TableRow[] = [];
  let failCount = 0;
  let passCount = 0;
  for (const t of TARGETS) {
    const series = seriesFor(matches, t.key);
    const stat = meanSd(series);
    const v = verdictFor(stat.mean, t.spec);
    if (v === 'PASS') passCount++;
    if (v === 'FAIL') failCount++;
    rows.push({ label: t.label, target: targetStr(t.spec, t.unit), sim: simStr(stat, t.unit), verdict: v });
  }
  return { rows, failCount, passCount };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { matches: number; minutes: number; md: boolean } {
  let matches = 10;
  let minutes = 10;
  let md = false;
  for (const arg of argv) {
    if (arg === '--md') md = true;
    else if (arg.startsWith('--matches=')) matches = Number(arg.slice('--matches='.length));
    else if (arg.startsWith('--minutes=')) minutes = Number(arg.slice('--minutes='.length));
  }
  return { matches, minutes, md };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { matches: matchCount, minutes: matchMinutes, md } = parseArgs(process.argv.slice(2));
  const start = Date.now();

  console.log('\n=== Tracking Benchmark v2: Movement-Realism Metrics ===\n');
  console.log(`Running ${matchCount} matches x ${matchMinutes} min (default 4-4-2 vs 4-4-2, default tactics)…`);

  const mainMatches: PerMatchMetrics[] = [];
  for (let i = 0; i < matchCount; i++) {
    process.stdout.write(`  Match ${i + 1}/${matchCount}… `);
    const m = runOneMatch(matchMinutes, 1 + i);
    mainMatches.push(m);
    console.log(
      `poss/min=${m.possessionsPerMin.toFixed(2)} sprint%=${m.speedBandPctOutfield.sprinting.toFixed(1)} dist90=${m.distance90kmMeanOutfield.toFixed(1)}km`,
    );
  }

  const { rows, failCount, passCount } = buildMainTable(mainMatches);
  const gkBands = meanSd(mainMatches.map((m) => m.speedBandPctGK.standing + m.speedBandPctGK.walking));

  // ── Line-height monotonicity sweep ─────────────────────────────────────────
  console.log(`\nRunning line-height sweep (${SWEEP_MATCH_COUNT} matches x ${SWEEP_MATCH_MINUTES} min per config)…`);
  const sweepValues = [-1, 0, 1] as const;
  const sweepLineHeights: number[] = [];
  for (const lh of sweepValues) {
    const ms: PerMatchMetrics[] = [];
    for (let i = 0; i < SWEEP_MATCH_COUNT; i++) {
      ms.push(runOneMatch(SWEEP_MATCH_MINUTES, 500 + (lh + 1) * 100 + i, { team: 0, value: lh }));
    }
    const team0LineHeight = meanSd(ms.map((m) => m.lineHeightByTeam[0]));
    sweepLineHeights.push(team0LineHeight.mean);
    console.log(`  lineHeight=${lh.toString().padStart(2)}: team0 line height = ${team0LineHeight.mean.toFixed(2)}m (sd ${team0LineHeight.sd.toFixed(2)})`);
  }
  const monotonic = sweepLineHeights[0] < sweepLineHeights[1] && sweepLineHeights[1] < sweepLineHeights[2];

  const elapsedS = (Date.now() - start) / 1000;

  // ── Print ─────────────────────────────────────────────────────────────────
  console.log('\n--- Tracking Benchmark Table ---\n');
  console.log(renderTable(rows));
  console.log(
    `\nGK speed bands (recorded, not target-checked): standing+walking <2 m/s = ${gkBands.mean.toFixed(1)}% ± ${gkBands.sd.toFixed(1)}%`,
  );
  console.log(`\nVerdicts: ${passCount} PASS, ${failCount} FAIL, ${TARGETS.length - passCount - failCount} recorded-only.`);
  console.log(
    `Line-height monotonicity (team 0, lineHeight -1/0/+1): ${sweepLineHeights.map((v) => v.toFixed(2)).join(' -> ')} — ${monotonic ? 'PASS (monotonic increasing)' : 'FAIL (not monotonic)'}`,
  );
  console.log(`\nTotal runtime: ${elapsedS.toFixed(1)}s`);

  // ── Optional markdown report ──────────────────────────────────────────────
  if (md) {
    const now = new Date().toISOString().slice(0, 10);
    const lines: string[] = [];
    lines.push('# Tracking Benchmark v2 (latest run)');
    lines.push('');
    lines.push(`Generated: ${now}`);
    lines.push(`Sim: 4-4-2 vs 4-4-2, default tactics, ${matchCount} matches x ${matchMinutes} min`);
    lines.push('');
    lines.push(renderTable(rows));
    lines.push('');
    lines.push(
      `GK speed bands (recorded, not target-checked): standing+walking <2 m/s = ${gkBands.mean.toFixed(1)}% ± ${gkBands.sd.toFixed(1)}%`,
    );
    lines.push('');
    lines.push(
      `**Line-height sweep** (team 0, lineHeight -1/0/+1, ${SWEEP_MATCH_COUNT} matches x ${SWEEP_MATCH_MINUTES} min each): ` +
        `${sweepLineHeights.map((v) => v.toFixed(2)).join(' -> ')}m — **${monotonic ? 'PASS' : 'FAIL'}**`,
    );
    lines.push('');
    lines.push(`Verdicts: ${passCount} PASS, ${failCount} FAIL, ${TARGETS.length - passCount - failCount} recorded-only.`);
    lines.push(`Total runtime: ${elapsedS.toFixed(1)}s`);
    lines.push('');
    fs.writeFileSync(REPORT_PATH, lines.join('\n') + '\n', 'utf-8');
    console.log(`\nReport written to: ${REPORT_PATH}`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
