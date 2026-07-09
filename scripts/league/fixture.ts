/**
 * League fixture (Task AJ) — one fixture = K seeded sims, not one match.
 *
 * A single sim mostly ranks luck (match-to-match variance needs ~50+ sims to
 * resolve a 0.5-goal edge — REALISM-ROADMAP.md T6). A league "fixture" between
 * two tactic sheets is therefore an aggregate: run K deterministic matches
 * (alternating colors so side bias cancels — same seed scheme as audit.ts) and
 * present expected points + a score distribution + a single *representative*
 * seed whose score sits closest to the median outcome, so it can later be
 * replayed in the UI as "the" match of this fixture.
 *
 * This is a REPORT, not a gate: it always exits 0.
 *
 * Determinism: all result output goes to stdout; wall-clock/progress goes to
 * stderr. So `npm run league:fixture -- ... > a; npm run league:fixture -- ... > b`
 * always diffs byte-identical (validation 1) — true regardless of `--workers`
 * (Task AK): each of the K matches is an independent job on the pool
 * (scripts/league/pool.ts, worker unit = one match), results are collected
 * into `results[m]` (index = match index) and only aggregated/printed after
 * every match is done.
 *
 * Usage:
 *   npx tsx scripts/league/fixture.ts --a <sheet> --b <sheet> [--k 40] [--minutes 10] [--seed-base N] [--workers N]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mean, stddev } from '../benchmark/tracking/metrics.ts';
import { runMatch } from './match.ts';
import { SHEETS, type TacticSheet } from './sheets.ts';
import { runPool, defaultWorkerCount, parseWorkersArg } from './pool.ts';
import type { FixtureJob } from './fixture-worker.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_WORKER_FILE = path.resolve(__dirname, './fixture-worker.ts');

const DEFAULT_SEED_BASE = 200000;

// ── CLI ───────────────────────────────────────────────────────────────────────

interface Args {
  a: string;
  b: string;
  k: number;
  minutes: number;
  seedBase: number;
  workers: number;
}

function parseArgs(argv: string[]): Args {
  let a: string | null = null;
  let b: string | null = null;
  let k = 40;
  let minutes = 10;
  let seedBase = DEFAULT_SEED_BASE;
  let workers = defaultWorkerCount();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--a') a = argv[++i];
    else if (arg === '--b') b = argv[++i];
    else if (arg === '--k') k = Number(argv[++i]);
    else if (arg === '--minutes') minutes = Number(argv[++i]);
    else if (arg === '--seed-base') seedBase = Number(argv[++i]);
    else if (arg === '--workers') workers = parseWorkersArg(argv[++i]);
    else throw new Error(`unknown arg: ${arg}`);
  }
  if (!a || !b) throw new Error('usage: --a <sheet> --b <sheet> [--k 40] [--minutes 10] [--seed-base N] [--workers N]');
  if (!Number.isInteger(k) || k <= 0) throw new Error(`--k must be a positive integer (got ${k})`);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`--minutes must be a positive number (got ${minutes})`);
  if (!Number.isFinite(seedBase)) throw new Error(`--seed-base must be a number (got ${seedBase})`);
  return { a, b, k, minutes, seedBase, workers };
}

function lookupSheet(name: string): TacticSheet {
  const s = SHEETS.find((x) => x.name === name);
  if (!s) throw new Error(`unknown sheet name: ${name} (available: ${SHEETS.map((x) => x.name).join(', ')})`);
  return s;
}

// ── Points / stats helpers ───────────────────────────────────────────────────

function pointsFor(own: number, opp: number): number {
  if (own > opp) return 3;
  if (own === opp) return 1;
  return 0;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface MatchResult {
  seed: number;
  aTeam: 0 | 1;
  goalsA: number;
  goalsB: number;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { a, b, k, minutes, seedBase, workers } = parseArgs(process.argv.slice(2));
  const sheetA = lookupSheet(a);
  const sheetB = lookupSheet(b);
  const start = Date.now();

  // Worker count is deliberately NOT printed to stdout (determinism gate).
  console.error(`Workers: ${workers} (matches: ${k})`);

  const jobs: FixtureJob[] = Array.from({ length: k }, (_, m) => ({
    aTeam: (m % 2 === 0 ? 0 : 1) as 0 | 1, // alternate colors so side bias cancels
    seed: seedBase + m,
  }));

  const results: MatchResult[] = new Array(k);
  const reportProgress = (m: number, job: FixtureJob, goals: { goalsA: number; goalsB: number }) => {
    process.stderr.write(`  [${m + 1}/${k}] seed ${job.seed}: ${sheetA.name} ${goals.goalsA}-${goals.goalsB} ${sheetB.name}\n`);
  };

  if (workers === 1) {
    for (let m = 0; m < k; m++) {
      const goals = runMatch(sheetA, sheetB, jobs[m].aTeam, jobs[m].seed, minutes);
      results[m] = { seed: jobs[m].seed, aTeam: jobs[m].aTeam, ...goals };
      reportProgress(m, jobs[m], goals);
    }
  } else {
    const goalsByIndex = await runPool<FixtureJob, { goalsA: number; goalsB: number }>({
      workerFile: FIXTURE_WORKER_FILE,
      workerData: { sheetA, sheetB, minutes },
      jobs,
      workers,
      onResult: (m, job, goals) => reportProgress(m, job, goals),
    });
    for (let m = 0; m < k; m++) {
      results[m] = { seed: jobs[m].seed, aTeam: jobs[m].aTeam, ...goalsByIndex[m] };
    }
  }

  // ── Points / W-D-L per sheet ────────────────────────────────────────────────
  const ptsA = results.map((r) => pointsFor(r.goalsA, r.goalsB));
  const ptsB = results.map((r) => pointsFor(r.goalsB, r.goalsA));
  let winA = 0;
  let draws = 0;
  let winB = 0;
  for (const r of results) {
    if (r.goalsA > r.goalsB) winA++;
    else if (r.goalsB > r.goalsA) winB++;
    else draws++;
  }

  const meanPtsA = mean(ptsA);
  const meanPtsB = mean(ptsB);
  // ±2σ = 95% interval on the *estimate* of expected points → 2 × SE of the mean.
  const seA = stddev(ptsA) / Math.sqrt(k);
  const seB = stddev(ptsB) / Math.sqrt(k);

  const meanGoalsA = mean(results.map((r) => r.goalsA));
  const meanGoalsB = mean(results.map((r) => r.goalsB));

  // ── Score distribution (from sheet A's perspective) ─────────────────────────
  const scoreCounts = new Map<string, number>();
  for (const r of results) {
    const key = `${r.goalsA}-${r.goalsB}`;
    scoreCounts.set(key, (scoreCounts.get(key) ?? 0) + 1);
  }
  const sortedScores = [...scoreCounts.entries()].sort((x, y) => {
    if (y[1] !== x[1]) return y[1] - x[1]; // frequency desc
    return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0; // then score string asc (stable)
  });

  // ── Representative seed: closest to the median (goalsA, goalsB) ──────────────
  const medA = median(results.map((r) => r.goalsA));
  const medB = median(results.map((r) => r.goalsB));
  let rep = results[0];
  let bestDist = Infinity;
  for (const r of results) {
    const d = Math.abs(r.goalsA - medA) + Math.abs(r.goalsB - medB);
    if (d < bestDist || (d === bestDist && r.seed < rep.seed)) {
      bestDist = d;
      rep = r;
    }
  }

  const elapsedS = (Date.now() - start) / 1000;

  // ── Print (stdout = deterministic report) ───────────────────────────────────
  console.log('\n=== League Fixture (Task AJ) ===\n');
  console.log(`${sheetA.name} (${sheetA.formation}) vs ${sheetB.name} (${sheetB.formation})`);
  console.log(`K=${k} matches x ${minutes} min, alternating colors, seed-base ${seedBase}\n`);

  console.log('--- Expected points (95% CI = ±2 SE of the mean) ---\n');
  console.log(`${sheetA.name}: ${meanPtsA.toFixed(3)} pts/match  (±${(2 * seA).toFixed(3)})  W-D-L ${winA}-${draws}-${winB}  goals ${meanGoalsA.toFixed(2)}`);
  console.log(`${sheetB.name}: ${meanPtsB.toFixed(3)} pts/match  (±${(2 * seB).toFixed(3)})  W-D-L ${winB}-${draws}-${winA}  goals ${meanGoalsB.toFixed(2)}`);

  console.log('\n--- Score distribution (A-B, most frequent first) ---\n');
  const maxCount = Math.max(...sortedScores.map(([, c]) => c));
  const barWidth = 40;
  for (const [score, count] of sortedScores) {
    const bars = '×'.repeat(Math.max(1, Math.round((count / maxCount) * barWidth)));
    console.log(`${score.padStart(7)}  ${String(count).padStart(3)}  ${bars}`);
  }

  console.log('\n--- Representative match (closest to median outcome) ---\n');
  console.log(`Median outcome: ${medA}-${medB}`);
  console.log(`Representative: ${sheetA.name} ${rep.goalsA}-${rep.goalsB} ${sheetB.name}  (sheet A on team ${rep.aTeam})`);
  console.log(`Replay with: --seed ${rep.seed}`);

  process.stderr.write(`\nTotal runtime: ${elapsedS.toFixed(1)}s (${k} matches)\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
