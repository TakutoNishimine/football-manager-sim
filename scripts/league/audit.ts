/**
 * League meta-audit harness (Task AH) — quantify tactic dominance across a
 * curated sheet pool before the manager-vs-manager league exists.
 *
 * Round-robins every unordered pair of sheets, INCLUDING self-pairings
 * (mirror matches are the calibration set that exposes pure color/side bias).
 * Per pairing, N seeded matches, half with sheet A on team 0 and half on
 * team 1, so color bias cancels in the ranking. Seeds are fully deterministic
 * (derived from pairingIndex + matchIndex), so the same command always
 * reproduces the same matrix.
 *
 * This is the durable deliverable, not any one run's numbers — re-run after
 * every future sim change (see tasks/REALISM-ROADMAP.md Task AH, and
 * anything Task U merges).
 *
 * Parallelism (Task AK): pairings run across a node:worker_threads pool
 * (scripts/league/pool.ts). `--workers 1` is the original serial path
 * (also the reference implementation for the determinism gate below).
 * Match/pairing logic lives in audit-core.ts / audit-worker.ts so both
 * paths call the exact same pure functions. Pairing results are collected
 * into `pairingResults[pairingIndex]` (preallocated, order-independent of
 * completion order) and only flattened/aggregated/printed AFTER every
 * pairing is done — this is what keeps stdout byte-identical across
 * `--workers` values (progress lines with wall-clock go to stderr only,
 * and worker count itself is never printed to stdout).
 *
 * Usage:
 *   npx tsx scripts/league/audit.ts [--matches 10] [--minutes 10] [--sheets a,b,c] [--quick] [--md] [--workers N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHEETS, type TacticSheet } from './sheets.ts';
import { buildPairings, runPairing, SEED_BASE, type GameRecord, type Pairing } from './audit-core.ts';
import { runPool, defaultWorkerCount, parseWorkersArg } from './pool.ts';
import { runMatch } from './match.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.resolve(__dirname, '../../reports/league-audit-latest.md');
const AUDIT_WORKER_FILE = path.resolve(__dirname, './audit-worker.ts');

// Gate thresholds, taken verbatim from tasks/task-ah-league-audit.md.
const DOMINANCE_MAX_PTS = 1.95; // > 65% of max (3 pts)
const TRAP_MIN_PTS = 0.65; // flag sheets scoring below this as trap options

// ── CLI ───────────────────────────────────────────────────────────────────────

interface Args {
  matches: number;
  minutes: number;
  md: boolean;
  sheetFilter: string[] | null;
  workers: number;
  seedBase: number;
}

function parseArgs(argv: string[]): Args {
  let matches = 10;
  let minutes = 10;
  let md = false;
  let quick = false;
  let sheetFilter: string[] | null = null;
  let workers = defaultWorkerCount();
  let seedBase = SEED_BASE;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--md') md = true;
    else if (arg === '--quick') quick = true;
    else if (arg === '--matches') matches = Number(argv[++i]);
    else if (arg === '--minutes') minutes = Number(argv[++i]);
    else if (arg === '--sheets') sheetFilter = argv[++i].split(',').map((s) => s.trim());
    else if (arg === '--workers') workers = parseWorkersArg(argv[++i]);
    else if (arg === '--seed-base') seedBase = Number(argv[++i]);
    else throw new Error(`unknown arg: ${arg}`);
  }
  if (quick) matches = 4;
  // Guard the seed/record math against garbage: a non-positive or NaN match
  // count leaves allRecords empty and the determinism spot-check's non-null
  // assertion (`allRecords.find(...)!`) then crashes instead of reporting usage.
  if (!Number.isFinite(matches) || !Number.isInteger(matches) || matches <= 0) {
    throw new Error(`--matches must be a positive integer (got ${matches}); usage: [--matches N] [--minutes M] [--sheets a,b,c] [--quick] [--md] [--workers N] [--seed-base B]`);
  }
  // seed-base must be a non-negative integer (Task AT color A/B tooling). Default SEED_BASE
  // (100000) is byte-identical to the historical audit — only an explicit flag changes seeds.
  if (!Number.isFinite(seedBase) || !Number.isInteger(seedBase) || seedBase < 0) {
    throw new Error(`--seed-base must be a non-negative integer (got ${seedBase})`);
  }
  return { matches, minutes, md, sheetFilter, workers, seedBase };
}

// ── Points / stats helpers ───────────────────────────────────────────────────

function pointsFor(own: number, opp: number): number {
  if (own > opp) return 3;
  if (own === opp) return 1;
  return 0;
}

interface RankRow {
  idx: number;
  name: string;
  matches: number;
  meanPoints: number;
  meanGoalDiff: number;
}

function buildRanking(sheets: TacticSheet[], records: GameRecord[]): RankRow[] {
  const rows: RankRow[] = sheets.map((s, idx) => ({ idx, name: s.name, matches: 0, meanPoints: 0, meanGoalDiff: 0 }));
  const pointSums = new Array(sheets.length).fill(0);
  const gdSums = new Array(sheets.length).fill(0);
  const counts = new Array(sheets.length).fill(0);

  for (const r of records) {
    if (r.i === r.j) continue; // ranking excludes mirror matches (see mirror calibration instead)
    pointSums[r.i] += pointsFor(r.goalsI, r.goalsJ);
    gdSums[r.i] += r.goalsI - r.goalsJ;
    counts[r.i]++;
    pointSums[r.j] += pointsFor(r.goalsJ, r.goalsI);
    gdSums[r.j] += r.goalsJ - r.goalsI;
    counts[r.j]++;
  }

  for (const row of rows) {
    row.matches = counts[row.idx];
    row.meanPoints = row.matches > 0 ? pointSums[row.idx] / row.matches : 0;
    row.meanGoalDiff = row.matches > 0 ? gdSums[row.idx] / row.matches : 0;
  }
  rows.sort((a, b) => b.meanPoints - a.meanPoints);
  return rows;
}

interface MatrixCell {
  meanPoints: number;
  meanGoalsFor: number;
  meanGoalsAgainst: number;
  matches: number;
}

/** matrix[r][c] = sheet r's record against sheet c (r's own perspective). */
function buildMatrix(sheets: TacticSheet[], records: GameRecord[]): MatrixCell[][] {
  const n = sheets.length;
  const matrix: MatrixCell[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => ({ meanPoints: 0, meanGoalsFor: 0, meanGoalsAgainst: 0, matches: 0 })));
  const grouped = new Map<string, GameRecord[]>();
  for (const r of records) {
    const key = `${r.i}:${r.j}`;
    const arr = grouped.get(key) ?? [];
    arr.push(r);
    grouped.set(key, arr);
  }
  for (const [key, recs] of grouped) {
    const [i, j] = key.split(':').map(Number);
    const cellIJ = matrix[i][j];
    cellIJ.matches = recs.length;
    cellIJ.meanPoints = recs.reduce((s, r) => s + pointsFor(r.goalsI, r.goalsJ), 0) / recs.length;
    cellIJ.meanGoalsFor = recs.reduce((s, r) => s + r.goalsI, 0) / recs.length;
    cellIJ.meanGoalsAgainst = recs.reduce((s, r) => s + r.goalsJ, 0) / recs.length;
    if (i !== j) {
      const cellJI = matrix[j][i];
      cellJI.matches = recs.length;
      cellJI.meanPoints = recs.reduce((s, r) => s + pointsFor(r.goalsJ, r.goalsI), 0) / recs.length;
      cellJI.meanGoalsFor = recs.reduce((s, r) => s + r.goalsJ, 0) / recs.length;
      cellJI.meanGoalsAgainst = recs.reduce((s, r) => s + r.goalsI, 0) / recs.length;
    }
  }
  return matrix;
}

// ── Binomial calibration checks ──────────────────────────────────────────────

interface BinomialCheck {
  wins0: number;
  wins1: number;
  draws: number;
  n: number; // decisive games (wins0 + wins1)
  sigma: number;
  deviation: number;
  toleranceSigma: number;
  pass: boolean;
}

function binomialCheck(wins0: number, wins1: number, draws: number, toleranceSigma = 2): BinomialCheck {
  const n = wins0 + wins1;
  const sigma = 0.5 * Math.sqrt(n); // sd of count of team-0 wins under p=0.5
  const deviation = Math.abs(wins0 - n / 2);
  const pass = n === 0 ? true : deviation <= toleranceSigma * sigma;
  return { wins0, wins1, draws, n, sigma, deviation, toleranceSigma, pass };
}

function colorSplit(records: GameRecord[]): { wins0: number; wins1: number; draws: number } {
  let wins0 = 0;
  let wins1 = 0;
  let draws = 0;
  for (const r of records) {
    const goals0 = r.aTeam === 0 ? r.goalsI : r.goalsJ;
    const goals1 = r.aTeam === 0 ? r.goalsJ : r.goalsI;
    if (goals0 > goals1) wins0++;
    else if (goals1 > goals0) wins1++;
    else draws++;
  }
  return { wins0, wins1, draws };
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtPts(v: number): string {
  return v.toFixed(2);
}

function renderRankingTable(rows: RankRow[]): string {
  const header = ['#', 'Sheet', 'Pts/match', 'GD/match', 'Matches'];
  const lines = [header.join(' | '), header.map(() => '---').join(' | ')];
  rows.forEach((r, i) => {
    lines.push([String(i + 1), r.name, fmtPts(r.meanPoints), (r.meanGoalDiff >= 0 ? '+' : '') + r.meanGoalDiff.toFixed(2), String(r.matches)].join(' | '));
  });
  return lines.join('\n');
}

function renderMatrix(sheets: TacticSheet[], matrix: MatrixCell[][], kind: 'points' | 'goals'): string {
  const names = sheets.map((s) => s.name);
  const header = ['vs', ...names];
  const lines = [header.join(' | '), header.map(() => '---').join(' | ')];
  for (let r = 0; r < names.length; r++) {
    const row = [names[r]];
    for (let c = 0; c < names.length; c++) {
      const cell = matrix[r][c];
      if (kind === 'points') row.push(fmtPts(cell.meanPoints));
      else row.push(`${cell.meanGoalsFor.toFixed(1)}-${cell.meanGoalsAgainst.toFixed(1)}`);
    }
    lines.push(row.join(' | '));
  }
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { matches: matchCount, minutes, md, sheetFilter, workers, seedBase } = parseArgs(process.argv.slice(2));
  const sheets = sheetFilter ? SHEETS.filter((s) => sheetFilter.includes(s.name)) : SHEETS;
  if (sheetFilter && sheets.length !== sheetFilter.length) {
    const found = new Set(sheets.map((s) => s.name));
    const missing = sheetFilter.filter((n) => !found.has(n));
    throw new Error(`unknown sheet name(s): ${missing.join(', ')}`);
  }

  const pairings = buildPairings(sheets.length);
  const start = Date.now();

  console.log('\n=== League Meta-Audit (Task AH) ===\n');
  console.log(`Sheets: ${sheets.length} (${sheets.map((s) => s.name).join(', ')})`);
  console.log(`Pairings: ${pairings.length} (incl. self-pairings) x ${matchCount} matches x ${minutes} min`);
  console.log(`Seed base: ${seedBase}\n`);

  // Worker count is deliberately NOT printed to stdout: the determinism gate
  // requires `--workers 1` and `--workers N` to produce byte-identical
  // stdout, so anything that varies with `workers` stays on stderr.
  console.error(`Workers: ${workers} (pairings: ${pairings.length})`);

  const pairingResults: GameRecord[][] = new Array(pairings.length);
  const reportProgress = (pairing: Pairing, records: GameRecord[]) => {
    const sheetI = sheets[pairing.i].name;
    const sheetJ = sheets[pairing.j].name;
    const goalsISum = records.reduce((s, r) => s + r.goalsI, 0);
    const goalsJSum = records.reduce((s, r) => s + r.goalsJ, 0);
    const elapsedS = (Date.now() - start) / 1000;
    // Progress + wall-clock go to stderr so stdout stays byte-identical between
    // two identical runs (deterministic-report contract). With workers > 1,
    // pairings complete out of order, so these lines are no longer strictly
    // sequential — informational only, never part of the determinism gate.
    console.error(
      `[${pairing.pairingIndex + 1}/${pairings.length}] ${sheetI} vs ${sheetJ}: ${goalsISum}-${goalsJSum} over ${matchCount} matches (${elapsedS.toFixed(0)}s elapsed)`,
    );
  };

  if (workers === 1) {
    for (const pairing of pairings) {
      const records = runPairing(sheets, pairing, matchCount, minutes, seedBase);
      pairingResults[pairing.pairingIndex] = records;
      reportProgress(pairing, records);
    }
  } else {
    await runPool<Pairing, GameRecord[]>({
      workerFile: AUDIT_WORKER_FILE,
      workerData: { sheets, matchCount, minutes, seedBase },
      jobs: pairings,
      workers,
      onResult: (_index, pairing, records) => {
        pairingResults[pairing.pairingIndex] = records;
        reportProgress(pairing, records);
      },
    });
  }

  // Aggregate in fixed pairingIndex order — this (not completion order) is
  // what makes stdout byte-identical across `--workers` values.
  const allRecords: GameRecord[] = pairingResults.flat();

  const elapsedS = (Date.now() - start) / 1000;

  // Determinism spot-check: re-run pairing 0 / match 0 and compare.
  const detCheckPairing = pairings[0];
  const detOriginal = allRecords.find((r) => r.i === detCheckPairing.i && r.j === detCheckPairing.j && r.matchIndex === 0)!;
  const detRerun = runMatch(sheets[detCheckPairing.i], sheets[detCheckPairing.j], detOriginal.aTeam, detOriginal.seed, minutes);
  const detPass = detRerun.goalsA === detOriginal.goalsI && detRerun.goalsB === detOriginal.goalsJ;

  const ranking = buildRanking(sheets, allRecords);
  const matrix = buildMatrix(sheets, allRecords);

  // ── Gate 1: dominance ──────────────────────────────────────────────────────
  const dominant = ranking.filter((r) => r.meanPoints > DOMINANCE_MAX_PTS);
  const traps = ranking.filter((r) => r.matches > 0 && r.meanPoints < TRAP_MIN_PTS);
  const dominanceGatePass = dominant.length === 0;

  // ── Gate 2: mirror calibration (pooled) ───────────────────────────────────
  // Running one 2σ test per self-pairing means 12 independent tests ⇒ ~46%
  // chance at least one fires by luck (this flagged default-343 pre-U; a
  // 30-match rerun refuted it). Pool ALL mirror matches into ONE color-split
  // test — that pooled test is the gate. Per-sheet rows stay as informational
  // output only, at a looser 3σ threshold so a single noisy sheet doesn't read
  // as a failure.
  const mirrorRecords = allRecords.filter((r) => r.i === r.j);
  const mirrorPooled = colorSplit(mirrorRecords);
  const mirrorCheck = binomialCheck(mirrorPooled.wins0, mirrorPooled.wins1, mirrorPooled.draws);
  const mirrorGatePass = mirrorCheck.pass;

  const mirrorChecks: { name: string; check: BinomialCheck }[] = [];
  for (let i = 0; i < sheets.length; i++) {
    const selfRecords = allRecords.filter((r) => r.i === i && r.j === i);
    const { wins0, wins1, draws } = colorSplit(selfRecords);
    mirrorChecks.push({ name: sheets[i].name, check: binomialCheck(wins0, wins1, draws, 3) });
  }

  // ── Gate 3: color neutrality (pooled across ALL matches) ──────────────────
  const pooledSplit = colorSplit(allRecords);
  const colorCheck = binomialCheck(pooledSplit.wins0, pooledSplit.wins1, pooledSplit.draws);

  // ── Print ─────────────────────────────────────────────────────────────────
  console.log('\n--- Expected-points-vs-field ranking ---\n');
  console.log(renderRankingTable(ranking));

  console.log('\n--- Pairwise matrix: expected points (row vs column) ---\n');
  console.log(renderMatrix(sheets, matrix, 'points'));

  console.log('\n--- Pairwise matrix: mean goals for-against (row vs column) ---\n');
  console.log(renderMatrix(sheets, matrix, 'goals'));

  console.log('\n--- Gate checks ---\n');
  console.log(
    `Dominance gate (no sheet > ${DOMINANCE_MAX_PTS} pts/match; trap flag < ${TRAP_MIN_PTS} pts/match): ${dominanceGatePass ? 'PASS' : 'FAIL'}`,
  );
  if (dominant.length > 0) console.log(`  DOMINANT: ${dominant.map((r) => `${r.name} (${fmtPts(r.meanPoints)})`).join(', ')}`);
  if (traps.length > 0) console.log(`  TRAP: ${traps.map((r) => `${r.name} (${fmtPts(r.meanPoints)})`).join(', ')}`);

  console.log(
    `\nMirror calibration (POOLED self-pairing win split within ±2σ of 50/50): team0=${mirrorCheck.wins0} team1=${mirrorCheck.wins1} draws=${mirrorCheck.draws} (n=${mirrorCheck.n}, sigma=${mirrorCheck.sigma.toFixed(2)}, deviation=${mirrorCheck.deviation.toFixed(2)}) — ${mirrorGatePass ? 'PASS' : 'FAIL'}`,
  );
  console.log('  per-sheet split (informational only, 3σ):');
  for (const m of mirrorChecks) {
    console.log(
      `    ${m.name}: team0=${m.check.wins0} team1=${m.check.wins1} draws=${m.check.draws} (n=${m.check.n}, sigma=${m.check.sigma.toFixed(2)}, deviation=${m.check.deviation.toFixed(2)}) — ${m.check.pass ? 'PASS' : 'FAIL'}`,
    );
  }

  console.log(
    `\nColor neutrality (pooled team0 vs team1 win rate within ±2σ of 50/50): team0=${colorCheck.wins0} team1=${colorCheck.wins1} draws=${colorCheck.draws} (n=${colorCheck.n}, sigma=${colorCheck.sigma.toFixed(2)}, deviation=${colorCheck.deviation.toFixed(2)}) — ${colorCheck.pass ? 'PASS' : 'FAIL'}`,
  );

  console.log(
    `\nDeterminism spot-check (pairing ${detCheckPairing.i}:${detCheckPairing.j}, match 0, seed ${detOriginal.seed}): original=${detOriginal.goalsI}-${detOriginal.goalsJ} rerun=${detRerun.goalsA}-${detRerun.goalsB} — ${detPass ? 'PASS' : 'FAIL'}`,
  );

  console.error(`\nTotal runtime: ${elapsedS.toFixed(1)}s (${allRecords.length} matches, ${workers} workers)`);

  // ── Optional markdown report ──────────────────────────────────────────────
  if (md) {
    const now = new Date().toISOString().slice(0, 10);
    const lines: string[] = [];
    lines.push('# League Meta-Audit (latest run)');
    lines.push('');
    lines.push(`Generated: ${now}`);
    lines.push(`Sheets: ${sheets.length} (${sheets.map((s) => s.name).join(', ')})`);
    lines.push(`Pairings: ${pairings.length} (incl. self-pairings) x ${matchCount} matches x ${minutes} min`);
    lines.push(`Seed base: ${seedBase}`);
    lines.push('');
    lines.push('## Expected-points-vs-field ranking');
    lines.push('');
    lines.push(renderRankingTable(ranking));
    lines.push('');
    lines.push('## Pairwise matrix: expected points (row vs column)');
    lines.push('');
    lines.push(renderMatrix(sheets, matrix, 'points'));
    lines.push('');
    lines.push('## Pairwise matrix: mean goals for-against (row vs column)');
    lines.push('');
    lines.push(renderMatrix(sheets, matrix, 'goals'));
    lines.push('');
    lines.push('## Gate checks');
    lines.push('');
    lines.push(
      `- **Dominance gate** (no sheet > ${DOMINANCE_MAX_PTS} pts/match; trap flag < ${TRAP_MIN_PTS} pts/match): **${dominanceGatePass ? 'PASS' : 'FAIL'}**`,
    );
    if (dominant.length > 0) lines.push(`  - DOMINANT: ${dominant.map((r) => `${r.name} (${fmtPts(r.meanPoints)})`).join(', ')}`);
    if (traps.length > 0) lines.push(`  - TRAP: ${traps.map((r) => `${r.name} (${fmtPts(r.meanPoints)})`).join(', ')}`);
    lines.push(
      `- **Mirror calibration** (POOLED self-pairing win split within ±2σ of 50/50): team0=${mirrorCheck.wins0} team1=${mirrorCheck.wins1} draws=${mirrorCheck.draws} (n=${mirrorCheck.n}, σ=${mirrorCheck.sigma.toFixed(2)}, deviation=${mirrorCheck.deviation.toFixed(2)}) — **${mirrorGatePass ? 'PASS' : 'FAIL'}**`,
    );
    lines.push('  - per-sheet split (informational only, 3σ):');
    for (const m of mirrorChecks) {
      lines.push(
        `    - ${m.name}: team0=${m.check.wins0} team1=${m.check.wins1} draws=${m.check.draws} (n=${m.check.n}, σ=${m.check.sigma.toFixed(2)}, deviation=${m.check.deviation.toFixed(2)}) — ${m.check.pass ? 'PASS' : 'FAIL'}`,
      );
    }
    lines.push(
      `- **Color neutrality** (pooled team0 vs team1 win rate within ±2σ of 50/50): team0=${colorCheck.wins0} team1=${colorCheck.wins1} draws=${colorCheck.draws} (n=${colorCheck.n}, σ=${colorCheck.sigma.toFixed(2)}, deviation=${colorCheck.deviation.toFixed(2)}) — **${colorCheck.pass ? 'PASS' : 'FAIL'}**`,
    );
    lines.push(
      `- **Determinism spot-check** (pairing ${detCheckPairing.i}:${detCheckPairing.j}, match 0, seed ${detOriginal.seed}): original=${detOriginal.goalsI}-${detOriginal.goalsJ} rerun=${detRerun.goalsA}-${detRerun.goalsB} — **${detPass ? 'PASS' : 'FAIL'}**`,
    );
    lines.push('');
    lines.push(`Total runtime: ${elapsedS.toFixed(1)}s (${allRecords.length} matches)`);
    lines.push('');
    // The public compute mirror excludes reports/ — create it so --md works there.
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, lines.join('\n') + '\n', 'utf-8');
    console.log(`\nReport written to: ${REPORT_PATH}`);
  }
}

main().catch((err) => {
  // Print the message only, not the full Error object — util.inspect'ing an
  // Error (the old `console.error('Fatal error:', err)`) dumps a 6-line
  // stack trace for what is usually just a bad CLI arg (Task AK polish #5).
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
