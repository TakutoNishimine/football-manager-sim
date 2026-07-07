/**
 * Reality benchmark: compare our sim to StatsBomb real professional match data.
 *
 * Usage:  npx tsx scripts/benchmark/run.ts
 *
 * Output: comparison table printed to stdout + written to reports/task-o.md
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeRealMetrics } from './real.ts';
import { computeSimMetrics } from './sim.ts';
import type { BenchmarkMetrics } from './metrics.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.resolve(__dirname, '../../reports/task-o.md');

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmt(value: number, decimals = 1): string {
  if (!isFinite(value)) return 'N/A';
  return value.toFixed(decimals);
}

function fmtPct(value: number): string {
  return fmt(value, 1) + '%';
}

function gap(real: number, sim: number): string {
  const diff = sim - real;
  const sign = diff >= 0 ? '+' : '';
  return sign + fmt(diff, 1);
}

function gapPct(real: number, sim: number): string {
  const diff = sim - real;
  const sign = diff >= 0 ? '+' : '';
  return sign + fmt(diff, 1) + '%';
}

// ── Table builder ─────────────────────────────────────────────────────────────

interface Row {
  metric: string;
  real: string;
  sim: string;
  gap: string;
}

function buildRows(real: BenchmarkMetrics, sim: BenchmarkMetrics): Row[] {
  const rows: Row[] = [];

  const r = <K extends keyof BenchmarkMetrics>(section: K) =>
    real[section] as Record<string, number>;
  const s = <K extends keyof BenchmarkMetrics>(section: K) =>
    sim[section] as Record<string, number>;

  // Pass direction
  rows.push({
    metric: '**Pass: forward %**',
    real: fmtPct(real.pass.forwardPct),
    sim: fmtPct(sim.pass.forwardPct),
    gap: gapPct(real.pass.forwardPct, sim.pass.forwardPct),
  });
  rows.push({
    metric: 'Pass: lateral %',
    real: fmtPct(real.pass.lateralPct),
    sim: fmtPct(sim.pass.lateralPct),
    gap: gapPct(real.pass.lateralPct, sim.pass.lateralPct),
  });
  rows.push({
    metric: 'Pass: backward %',
    real: fmtPct(real.pass.backwardPct),
    sim: fmtPct(sim.pass.backwardPct),
    gap: gapPct(real.pass.backwardPct, sim.pass.backwardPct),
  });

  // Pass length
  rows.push({
    metric: '**Pass: mean length (m)**',
    real: fmt(real.pass.meanLengthM),
    sim: fmt(sim.pass.meanLengthM),
    gap: gap(real.pass.meanLengthM, sim.pass.meanLengthM),
  });
  rows.push({
    metric: 'Pass: P25 length (m)',
    real: fmt(real.pass.p25LengthM),
    sim: fmt(sim.pass.p25LengthM),
    gap: gap(real.pass.p25LengthM, sim.pass.p25LengthM),
  });
  rows.push({
    metric: 'Pass: P50 length (m)',
    real: fmt(real.pass.p50LengthM),
    sim: fmt(sim.pass.p50LengthM),
    gap: gap(real.pass.p50LengthM, sim.pass.p50LengthM),
  });
  rows.push({
    metric: 'Pass: P75 length (m)',
    real: fmt(real.pass.p75LengthM),
    sim: fmt(sim.pass.p75LengthM),
    gap: gap(real.pass.p75LengthM, sim.pass.p75LengthM),
  });

  // Pass completion
  rows.push({
    metric: '**Pass completion %**',
    real: fmtPct(real.pass.completionPct),
    sim: fmtPct(sim.pass.completionPct),
    gap: gapPct(real.pass.completionPct, sim.pass.completionPct),
  });

  // Carries
  rows.push({
    metric: '**Carries / team / match**',
    real: fmt(real.carry.carriesPerTeamPerMatch, 0),
    sim: fmt(sim.carry.carriesPerTeamPerMatch, 0),
    gap: gap(real.carry.carriesPerTeamPerMatch, sim.carry.carriesPerTeamPerMatch),
  });
  rows.push({
    metric: 'Carry mean distance (m)',
    real: fmt(real.carry.meanCarryDistM),
    sim: fmt(sim.carry.meanCarryDistM),
    gap: gap(real.carry.meanCarryDistM, sim.carry.meanCarryDistM),
  });

  // Possessions
  rows.push({
    metric: '**Possessions / match**',
    real: fmt(real.possession.possessionsPerMatch, 0),
    sim: fmt(sim.possession.possessionsPerMatch, 0),
    gap: gap(real.possession.possessionsPerMatch, sim.possession.possessionsPerMatch),
  });
  rows.push({
    metric: 'Passes / possession',
    real: fmt(real.possession.meanPassesPerPossession),
    sim: fmt(sim.possession.meanPassesPerPossession),
    gap: gap(real.possession.meanPassesPerPossession, sim.possession.meanPassesPerPossession),
  });

  // Shots
  rows.push({
    metric: '**Shots / team / match**',
    real: fmt(real.shot.shotsPerTeamPerMatch, 1),
    sim: fmt(sim.shot.shotsPerTeamPerMatch, 1),
    gap: gap(real.shot.shotsPerTeamPerMatch, sim.shot.shotsPerTeamPerMatch),
  });

  // Thirds
  rows.push({
    metric: '**On-ball events: def third %**',
    real: fmtPct(real.third.defensivePct),
    sim: fmtPct(sim.third.defensivePct),
    gap: gapPct(real.third.defensivePct, sim.third.defensivePct),
  });
  rows.push({
    metric: 'On-ball events: mid third %',
    real: fmtPct(real.third.middlePct),
    sim: fmtPct(sim.third.middlePct),
    gap: gapPct(real.third.middlePct, sim.third.middlePct),
  });
  rows.push({
    metric: 'On-ball events: att third %',
    real: fmtPct(real.third.attackingPct),
    sim: fmtPct(sim.third.attackingPct),
    gap: gapPct(real.third.attackingPct, sim.third.attackingPct),
  });

  return rows;
}

function renderMarkdownTable(rows: Row[]): string {
  const colWidths = [
    Math.max(...rows.map((r) => r.metric.length), 'Metric'.length),
    Math.max(...rows.map((r) => r.real.length), 'Real (StatsBomb)'.length),
    Math.max(...rows.map((r) => r.sim.length), 'Sim (4-4-2 mirror)'.length),
    Math.max(...rows.map((r) => r.gap.length), 'Gap (sim − real)'.length),
  ];

  const pad = (s: string, w: number) => s.padEnd(w);
  const sep = colWidths.map((w) => '-'.repeat(w));

  const lines: string[] = [];
  lines.push(`| ${pad('Metric', colWidths[0])} | ${pad('Real (StatsBomb)', colWidths[1])} | ${pad('Sim (4-4-2 mirror)', colWidths[2])} | ${pad('Gap (sim − real)', colWidths[3])} |`);
  lines.push(`| ${sep[0]} | ${sep[1]} | ${sep[2]} | ${sep[3]} |`);
  for (const row of rows) {
    lines.push(`| ${pad(row.metric, colWidths[0])} | ${pad(row.real, colWidths[1])} | ${pad(row.sim, colWidths[2])} | ${pad(row.gap, colWidths[3])} |`);
  }
  return lines.join('\n');
}

// ── Biggest gaps analysis ─────────────────────────────────────────────────────

function biggestGapsSection(real: BenchmarkMetrics, sim: BenchmarkMetrics): string {
  type GapEntry = { label: string; realVal: number; simVal: number; absDiff: number; unit: string };
  const entries: GapEntry[] = [
    { label: 'Pass forward %', realVal: real.pass.forwardPct, simVal: sim.pass.forwardPct, absDiff: Math.abs(sim.pass.forwardPct - real.pass.forwardPct), unit: 'pp' },
    { label: 'Pass lateral %', realVal: real.pass.lateralPct, simVal: sim.pass.lateralPct, absDiff: Math.abs(sim.pass.lateralPct - real.pass.lateralPct), unit: 'pp' },
    { label: 'Pass backward %', realVal: real.pass.backwardPct, simVal: sim.pass.backwardPct, absDiff: Math.abs(sim.pass.backwardPct - real.pass.backwardPct), unit: 'pp' },
    { label: 'Pass mean length (m)', realVal: real.pass.meanLengthM, simVal: sim.pass.meanLengthM, absDiff: Math.abs(sim.pass.meanLengthM - real.pass.meanLengthM), unit: 'm' },
    { label: 'Pass completion %', realVal: real.pass.completionPct, simVal: sim.pass.completionPct, absDiff: Math.abs(sim.pass.completionPct - real.pass.completionPct), unit: 'pp' },
    { label: 'Carries / team / match', realVal: real.carry.carriesPerTeamPerMatch, simVal: sim.carry.carriesPerTeamPerMatch, absDiff: Math.abs(sim.carry.carriesPerTeamPerMatch - real.carry.carriesPerTeamPerMatch), unit: '' },
    { label: 'Carry mean distance (m)', realVal: real.carry.meanCarryDistM, simVal: sim.carry.meanCarryDistM, absDiff: Math.abs(sim.carry.meanCarryDistM - real.carry.meanCarryDistM), unit: 'm' },
    { label: 'Possessions / match', realVal: real.possession.possessionsPerMatch, simVal: sim.possession.possessionsPerMatch, absDiff: Math.abs(sim.possession.possessionsPerMatch - real.possession.possessionsPerMatch), unit: '' },
    { label: 'Passes / possession', realVal: real.possession.meanPassesPerPossession, simVal: sim.possession.meanPassesPerPossession, absDiff: Math.abs(sim.possession.meanPassesPerPossession - real.possession.meanPassesPerPossession), unit: '' },
    { label: 'Shots / team / match', realVal: real.shot.shotsPerTeamPerMatch, simVal: sim.shot.shotsPerTeamPerMatch, absDiff: Math.abs(sim.shot.shotsPerTeamPerMatch - real.shot.shotsPerTeamPerMatch), unit: '' },
    { label: 'On-ball def third %', realVal: real.third.defensivePct, simVal: sim.third.defensivePct, absDiff: Math.abs(sim.third.defensivePct - real.third.defensivePct), unit: 'pp' },
    { label: 'On-ball mid third %', realVal: real.third.middlePct, simVal: sim.third.middlePct, absDiff: Math.abs(sim.third.middlePct - real.third.middlePct), unit: 'pp' },
    { label: 'On-ball att third %', realVal: real.third.attackingPct, simVal: sim.third.attackingPct, absDiff: Math.abs(sim.third.attackingPct - real.third.attackingPct), unit: 'pp' },
  ];

  // Normalise by real value for ranking
  const sorted = entries.sort((a, b) => b.absDiff - a.absDiff);
  const top5 = sorted.slice(0, 5);

  const lines: string[] = ['## Biggest gaps\n'];
  for (let i = 0; i < top5.length; i++) {
    const e = top5[i];
    const diff = e.simVal - e.realVal;
    const sign = diff >= 0 ? '+' : '';
    const dir = diff >= 0 ? 'higher' : 'lower';
    lines.push(
      `${i + 1}. **${e.label}**: real=${fmt(e.realVal, 1)}${e.unit}, sim=${fmt(e.simVal, 1)}${e.unit} (${sign}${fmt(diff, 1)}${e.unit} — sim is ${dir})`,
    );
  }
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== Reality Benchmark: Sim vs StatsBomb Real Data ===\n');

  // ── Real side ───────────────────────────────────────────────────────────────
  console.log('[1/2] Computing real-match metrics (StatsBomb open data)…');
  const { metrics: realMetrics, networkOk, matchIds, competitionName, seasonName } = await computeRealMetrics(5);

  // ── Sim side ────────────────────────────────────────────────────────────────
  console.log('\n[2/2] Computing sim metrics (headless 4-4-2 vs 4-4-2)…');
  const simMetrics = computeSimMetrics(10, 10);

  console.log('\n');

  // ── Build report ─────────────────────────────────────────────────────────────
  const now = new Date().toISOString().slice(0, 10);
  const reportLines: string[] = [];

  reportLines.push('# Task O — Reality Benchmark: Sim vs Real Football');
  reportLines.push('');
  reportLines.push(`Generated: ${now}`);
  reportLines.push('');

  if (!networkOk || realMetrics === null) {
    reportLines.push('> **Note:** StatsBomb network fetch failed.  Real-data columns below are **N/A**.  Sim-only results are still valid.');
    reportLines.push('');
  } else {
    reportLines.push(`**Real data source:** StatsBomb Open Data — ${competitionName} ${seasonName}`);
    reportLines.push(`**Matches analysed:** ${matchIds.length} matches (${matchIds.join(', ')})`);
    reportLines.push(`**Filter:** Open play only (\`play_pattern.name === 'Regular Play'\`)`);
    reportLines.push('');
  }

  reportLines.push('**Sim:** 4-4-2 vs 4-4-2 (default tactics, 10 matches × 10 min)');
  reportLines.push('');
  reportLines.push('## Definitions');
  reportLines.push('');
  reportLines.push('- **Pass direction**: forward = |angle| < 60°, backward = |angle| > 120°, lateral = rest (angle in possession team\'s attacking frame).');
  reportLines.push('- **Pass length (m)**: StatsBomb pitch 120 units → ×(105/120) = meters.');
  reportLines.push('- **Carry**: StatsBomb `carry` event / Sim: ball continuously held by same player, distance > 0.5 m.');
  reportLines.push('- **Possession**: consecutive same-team on-ball events (pass or carry) until team changes or shot; shot ends possession.');
  reportLines.push('- **Pitch thirds**: in the possession team\'s attacking direction; three equal thirds of the pitch.');
  reportLines.push('');
  reportLines.push('## Comparison table');
  reportLines.push('');

  if (realMetrics !== null) {
    const rows = buildRows(realMetrics, simMetrics);
    reportLines.push(renderMarkdownTable(rows));
  } else {
    // Sim-only table
    const simOnlyRows = [
      { metric: 'Pass forward %', val: fmtPct(simMetrics.pass.forwardPct) },
      { metric: 'Pass lateral %', val: fmtPct(simMetrics.pass.lateralPct) },
      { metric: 'Pass backward %', val: fmtPct(simMetrics.pass.backwardPct) },
      { metric: 'Pass mean length (m)', val: fmt(simMetrics.pass.meanLengthM) },
      { metric: 'Pass completion %', val: fmtPct(simMetrics.pass.completionPct) },
      { metric: 'Carries / team / match', val: fmt(simMetrics.carry.carriesPerTeamPerMatch, 0) },
      { metric: 'Carry mean distance (m)', val: fmt(simMetrics.carry.meanCarryDistM) },
      { metric: 'Possessions / match', val: fmt(simMetrics.possession.possessionsPerMatch, 0) },
      { metric: 'Passes / possession', val: fmt(simMetrics.possession.meanPassesPerPossession) },
      { metric: 'Shots / team / match', val: fmt(simMetrics.shot.shotsPerTeamPerMatch, 1) },
      { metric: 'On-ball def third %', val: fmtPct(simMetrics.third.defensivePct) },
      { metric: 'On-ball mid third %', val: fmtPct(simMetrics.third.middlePct) },
      { metric: 'On-ball att third %', val: fmtPct(simMetrics.third.attackingPct) },
    ];
    reportLines.push('| Metric | Sim (4-4-2 mirror) |');
    reportLines.push('| --- | --- |');
    for (const r of simOnlyRows) reportLines.push(`| ${r.metric} | ${r.val} |`);
    reportLines.push('');
    reportLines.push('> Real-data columns unavailable due to network error.');
  }

  reportLines.push('');

  if (realMetrics !== null) {
    reportLines.push(biggestGapsSection(realMetrics, simMetrics));
  } else {
    reportLines.push('## Biggest gaps');
    reportLines.push('');
    reportLines.push('Real data unavailable — cannot compute gaps.  See sim-only table above.');
  }

  reportLines.push('');
  reportLines.push('## Notes');
  reportLines.push('');
  reportLines.push('- Sim carry detection fires when the same player holds the ball for > 0.5 m of movement; this means GK possession and short dribbles may be under-counted compared to StatsBomb which logs explicit `carry` events.');
  reportLines.push('- StatsBomb `pass.length` is in the same coordinate unit as the pitch (120 × 80 system), converted to metres with factor 105/120 ≈ 0.875.');
  reportLines.push('- Pass completion in the sim is approximated as: the ball was caught by a player of the same team as the passer (any interception, GK save, or out-of-bounds after the pass counts as incomplete).');
  reportLines.push('- Possession segmentation is identical on both sides: a run of consecutive pass/carry events by the same team; a shot or team change ends the possession.');

  const report = reportLines.join('\n') + '\n';

  // ── Write report ───────────────────────────────────────────────────────────
  const reportsDir = path.dirname(REPORT_PATH);
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(REPORT_PATH, report, 'utf-8');
  console.log(`\nReport written to: ${REPORT_PATH}`);

  // ── Print table to stdout ──────────────────────────────────────────────────
  if (realMetrics !== null) {
    const rows = buildRows(realMetrics, simMetrics);
    console.log('\n--- Comparison Table ---\n');
    console.log(renderMarkdownTable(rows));
    console.log('\n' + biggestGapsSection(realMetrics, simMetrics));
  } else {
    console.log('\nReal data unavailable.  Sim metrics:');
    console.log(`  Pass completion: ${fmtPct(simMetrics.pass.completionPct)}`);
    console.log(`  Pass forward %: ${fmtPct(simMetrics.pass.forwardPct)}`);
    console.log(`  Shots/team/match: ${fmt(simMetrics.shot.shotsPerTeamPerMatch, 1)}`);
    console.log(`  Carries/team/match: ${fmt(simMetrics.carry.carriesPerTeamPerMatch, 0)}`);
    console.log(`  Passes/possession: ${fmt(simMetrics.possession.meanPassesPerPossession)}`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
