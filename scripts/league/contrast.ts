/**
 * Tactic-lever contrast (Task AJ) — dead-lever detection.
 *
 * A tactic slider whose extremes don't measurably change anything is a placebo
 * and must not be shown to managers (REALISM-ROADMAP.md T6). For each of the
 * four TeamTactics scalars this runs extreme-vs-default comparisons on a fixed
 * formation (4-4-2) and measures the axis the lever is *supposed* to move:
 *
 *   lineHeight     → own defensive-line height while defending (meters)
 *   pressIntensity → PPDA proxy = opponent passes / (own steals + interceptions)
 *   wideRuns       → mean |y| of own on-ball events in the attacking third (m)
 *   manMark        → mean distance of own outfield defenders to nearest opponent
 *                    while defending (meters; lower = tighter marking). Reported
 *                    both for ALL outfield players and for the DF-line only
 *                    (Task AK #3 — the all-outfield mean dilutes the signal).
 *
 * Verdict: LIVE if the two extremes separate by > 2σ (pooled sample sd) on the
 * designated axis, else DEAD. Separately reports each extreme's expected points
 * vs the default sheet — a lever can be LIVE but strictly harmful (a balance
 * note, not DEAD). Also probes pressIntensity's suspected 0.3-vs-0.6 dead zone.
 *
 * The lever is applied to the "measure team" only; the opponent always plays the
 * default sheet. Colors alternate across matches so side bias cancels from both
 * the axis and the points. Seeds are fully deterministic → same command twice
 * diffs byte-identical on stdout (progress goes to stderr).
 *
 * Parallelism (Task AK): the 10 configs (4 levers x lo/hi + the press-probe's
 * lo/hi) run across a node:worker_threads pool (scripts/league/pool.ts).
 * `--workers 1` is the original serial path. Match/config logic lives in
 * contrast-core.ts / contrast-worker.ts so both paths call the exact same
 * pure functions; results are collected into `results[configIndex]` and only
 * aggregated/printed after every config is done, keeping stdout
 * byte-identical across `--workers` values.
 *
 * SCRIPT-ONLY, READ-ONLY on src/: no src/ file is modified. This reports what
 * HEAD does; fixing dead levers is future src/ work (Task AG).
 *
 * Usage:
 *   npx tsx scripts/league/contrast.ts [--n 20] [--minutes 10] [--formation 4-4-2] [--workers N]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORMATION_NAMES, type FormationName } from '../../src/sim/formation.ts';
import type { TeamTactics } from '../../src/sim/types.ts';
import { mean, stddev } from '../benchmark/tracking/metrics.ts';
import { BASE, runConfig, type AxisKey, type ConfigJob, type ConfigResult } from './contrast-core.ts';
import { runPool, defaultWorkerCount, parseWorkersArg } from './pool.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRAST_WORKER_FILE = path.resolve(__dirname, './contrast-worker.ts');

// ── CLI ───────────────────────────────────────────────────────────────────────

interface Args {
  n: number;
  minutes: number;
  formation: FormationName;
  workers: number;
}

function parseArgs(argv: string[]): Args {
  let n = 20;
  let minutes = 10;
  let formation: FormationName = '4-4-2';
  let workers = defaultWorkerCount();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--n') n = Number(argv[++i]);
    else if (arg === '--minutes') minutes = Number(argv[++i]);
    else if (arg === '--formation') formation = argv[++i] as FormationName;
    else if (arg === '--workers') workers = parseWorkersArg(argv[++i]);
    else throw new Error(`unknown arg: ${arg}`);
  }
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--n must be a positive integer (got ${n})`);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`--minutes must be a positive number (got ${minutes})`);
  if (!FORMATION_NAMES.includes(formation)) throw new Error(`--formation must be one of ${FORMATION_NAMES.join(', ')}`);
  return { n, minutes, formation, workers };
}

// ── Separation test ────────────────────────────────────────────────────────────

interface Separation {
  meanLo: number;
  sdLo: number;
  meanHi: number;
  sdHi: number;
  pooledSd: number;
  sigmas: number; // effect size: |meanHi - meanLo| / pooledSd (vs single-match noise)
  signif: number; // significance: |meanHi - meanLo| / SE_diff (is the mean shift real)
  live: boolean; // headline verdict: effect size > 2σ (the task's ">2σ" criterion)
}

/**
 * Two separate questions, both reported:
 *  - `sigmas` (EFFECT SIZE, pooled sample sd): is the shift big *relative to
 *    the match-to-match noise a manager would see*? This is the headline
 *    LIVE/DEAD test (> 2σ = the task's criterion) — a lever that only shifts
 *    the axis by a fraction of match variance is a placebo to a human watcher.
 *  - `signif` (SIGNIFICANCE, standard error of the difference): is the mean
 *    shift *real at all* at this N? A lever can be DEAD (noise-dominated) yet
 *    have a statistically real shift — that nuance matters for later balancing.
 */
function separation(lo: number[], hi: number[]): Separation {
  const meanLo = mean(lo);
  const meanHi = mean(hi);
  const sdLo = stddev(lo);
  const sdHi = stddev(hi);
  const pooledSd = Math.sqrt((sdLo * sdLo + sdHi * sdHi) / 2);
  const diff = Math.abs(meanHi - meanLo);
  const sigmas = pooledSd > 0 ? diff / pooledSd : Infinity;
  const seDiff = Math.sqrt(sdLo * sdLo / lo.length + sdHi * sdHi / hi.length);
  const signif = seDiff > 0 ? diff / seDiff : Infinity;
  return { meanLo, sdLo, meanHi, sdHi, pooledSd, sigmas, signif, live: sigmas > 2 };
}

function fmtSig(x: number): string {
  return x === Infinity ? '∞' : x.toFixed(2);
}

/** Task AK #2: note skipped (0-defensive-action) matches inline, only when nonzero. */
function skipNote(skipped: number, n: number): string {
  return skipped > 0 ? ` [skipped ${skipped}/${n}: 0 defensive actions]` : '';
}

// ── Lever definitions ──────────────────────────────────────────────────────────

interface LeverSpec {
  lever: keyof TeamTactics;
  axisKey: AxisKey;
  axisLabel: string;
  axisUnit: string;
  lo: number;
  hi: number;
  direction: string; // human note: what "higher axis" should mean
  /** Task AK #3: manMark also reports a DF-line-only marking-distance axis alongside the all-outfield one. */
  secondaryAxisKey?: AxisKey;
  secondaryAxisLabel?: string;
}

const LEVERS: LeverSpec[] = [
  { lever: 'lineHeight', axisKey: 'lineHeightM', axisLabel: 'DF-line height', axisUnit: 'm', lo: -1, hi: 1, direction: 'higher lineHeight → higher line' },
  { lever: 'pressIntensity', axisKey: 'ppda', axisLabel: 'PPDA (opp passes / def actions)', axisUnit: '', lo: 0, hi: 1, direction: 'higher press → LOWER PPDA' },
  { lever: 'wideRuns', axisKey: 'wingYM', axisLabel: 'attacking-third on-ball |y|', axisUnit: 'm', lo: 0, hi: 1, direction: 'higher wideRuns → higher |y|' },
  {
    lever: 'manMark',
    axisKey: 'markDistM',
    axisLabel: 'defender→nearest-opp distance (ALL outfield)',
    axisUnit: 'm',
    lo: 0,
    hi: 1,
    direction: 'higher manMark → LOWER distance',
    secondaryAxisKey: 'markDistDfM',
    secondaryAxisLabel: 'defender→nearest-opp distance (DF-LINE ONLY)',
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

function fmtPts(pts: number[]): string {
  return `${mean(pts).toFixed(2)} pts/match (sd ${stddev(pts).toFixed(2)})`;
}

async function main() {
  const { n, minutes, formation, workers } = parseArgs(process.argv.slice(2));
  const start = Date.now();

  console.log('\n=== Tactic-Lever Contrast (Task AJ) ===\n');
  console.log(`Formation: ${formation} (both teams). Lever on measure team, opponent = default BASE.`);
  console.log(`N=${n} matches per config x ${minutes} min, colors alternate. Default sheet = ${JSON.stringify(BASE)}\n`);

  // ── Build all 10 config jobs upfront (4 levers x lo/hi + press-probe lo/hi) ──
  // so they can run across the worker pool. configIndex assignment matches the
  // original serial ordering exactly (seed formula depends on it).
  const jobs: ConfigJob[] = [];
  let configIndex = 0;
  for (const spec of LEVERS) {
    jobs.push({ configIndex: configIndex++, lever: spec.lever, value: spec.lo, axisKey: spec.axisKey, label: spec.lever });
    jobs.push({ configIndex: configIndex++, lever: spec.lever, value: spec.hi, axisKey: spec.axisKey, label: spec.lever });
  }
  const pressSpec = LEVERS.find((l) => l.lever === 'pressIntensity')!;
  const probeLoIndex = configIndex++;
  jobs.push({ configIndex: probeLoIndex, lever: 'pressIntensity', value: 0.3, axisKey: pressSpec.axisKey, label: 'press-probe' });
  const probeHiIndex = configIndex++;
  jobs.push({ configIndex: probeHiIndex, lever: 'pressIntensity', value: 0.6, axisKey: pressSpec.axisKey, label: 'press-probe' });

  // Worker count is deliberately NOT printed to stdout (determinism gate).
  console.error(`Workers: ${workers} (configs: ${jobs.length})`);

  const results: ConfigResult[] = new Array(jobs.length);
  if (workers === 1) {
    for (const job of jobs) {
      process.stderr.write(`\n[config ${job.configIndex}] ${job.label}=${job.value}…\n`);
      results[job.configIndex] = runConfig(job.lever, job.value, job.axisKey, job.configIndex, n, minutes, formation, job.label);
    }
  } else {
    await runPool<ConfigJob, ConfigResult>({
      workerFile: CONTRAST_WORKER_FILE,
      workerData: { n, minutes, formation },
      jobs,
      workers,
      onResult: (_index, job, result) => {
        results[job.configIndex] = result;
      },
    });
  }

  // ── Reassemble per-lever verdicts from results[], indexed by configIndex ────
  let idx = 0;
  const verdicts: { spec: LeverSpec; sep: Separation; loPts: number[]; hiPts: number[]; loRes: ConfigResult; hiRes: ConfigResult; secondarySep?: Separation }[] = [];
  for (const spec of LEVERS) {
    const loRes = results[idx++];
    const hiRes = results[idx++];
    const sep = separation(loRes.axis, hiRes.axis);
    let secondarySep: Separation | undefined;
    if (spec.secondaryAxisKey) {
      const key = spec.secondaryAxisKey;
      secondarySep = separation(
        loRes.samples.map((s) => s[key]),
        hiRes.samples.map((s) => s[key]),
      );
    }
    verdicts.push({ spec, sep, loPts: loRes.points, hiPts: hiRes.points, loRes, hiRes, secondarySep });
  }
  const probeLo = results[probeLoIndex];
  const probeHi = results[probeHiIndex];
  const probeSep = separation(probeLo.axis, probeHi.axis);

  const elapsedS = (Date.now() - start) / 1000;

  // ── Print (stdout = deterministic report) ───────────────────────────────────
  console.log('--- Lever verdicts (LIVE if extremes separate > 2σ on designated axis) ---\n');
  for (const { spec, sep, loPts, hiPts, loRes, hiRes, secondarySep } of verdicts) {
    const unit = spec.axisUnit;
    console.log(`${spec.lever}  [${spec.direction}]`);
    console.log(`  axis = ${spec.axisLabel}`);
    console.log(`    ${spec.lever}=${spec.lo}: ${sep.meanLo.toFixed(2)}${unit} (sd ${sep.sdLo.toFixed(2)}, n=${loRes.axis.length}${skipNote(loRes.skipped, loPts.length)})   → ${fmtPts(loPts)} vs default`);
    console.log(`    ${spec.lever}=${spec.hi}: ${sep.meanHi.toFixed(2)}${unit} (sd ${sep.sdHi.toFixed(2)}, n=${hiRes.axis.length}${skipNote(hiRes.skipped, hiPts.length)})   → ${fmtPts(hiPts)} vs default`);
    console.log(`    effect size = ${fmtSig(sep.sigmas)}σ (pooled sd ${sep.pooledSd.toFixed(2)}) → ${sep.live ? 'LIVE' : 'DEAD'}   [mean shift significance ${fmtSig(sep.signif)}σ via SE]`);
    // Task AK #1: possChangesPerMin was computed but never surfaced — pressIntensity
    // is the lever it's diagnostic for (more/less active turnover economy).
    if (spec.lever === 'pressIntensity') {
      const loPcm = mean(loRes.samples.map((s) => s.possChangesPerMin));
      const hiPcm = mean(hiRes.samples.map((s) => s.possChangesPerMin));
      console.log(`    possChangesPerMin: ${spec.lever}=${spec.lo} → ${loPcm.toFixed(2)}/min   ${spec.lever}=${spec.hi} → ${hiPcm.toFixed(2)}/min`);
    }
    if (secondarySep && spec.secondaryAxisLabel) {
      console.log(`  secondary axis = ${spec.secondaryAxisLabel}`);
      console.log(`    ${spec.lever}=${spec.lo}: ${secondarySep.meanLo.toFixed(2)}m (sd ${secondarySep.sdLo.toFixed(2)})`);
      console.log(`    ${spec.lever}=${spec.hi}: ${secondarySep.meanHi.toFixed(2)}m (sd ${secondarySep.sdHi.toFixed(2)})`);
      console.log(
        `    effect size = ${fmtSig(secondarySep.sigmas)}σ (pooled sd ${secondarySep.pooledSd.toFixed(2)}) → ${secondarySep.live ? 'LIVE' : 'DEAD'}   [mean shift significance ${fmtSig(secondarySep.signif)}σ via SE]`,
      );
    }
    console.log('');
  }

  console.log('--- pressIntensity 0.3-vs-0.6 dead-zone probe (axis = PPDA) ---\n');
  console.log(`    pressIntensity=0.3: ${probeSep.meanLo.toFixed(2)} (sd ${probeSep.sdLo.toFixed(2)}, n=${probeLo.axis.length}${skipNote(probeLo.skipped, probeLo.points.length)})   → ${fmtPts(probeLo.points)} vs default`);
  console.log(`    pressIntensity=0.6: ${probeSep.meanHi.toFixed(2)} (sd ${probeSep.sdHi.toFixed(2)}, n=${probeHi.axis.length}${skipNote(probeHi.skipped, probeHi.points.length)})   → ${fmtPts(probeHi.points)} vs default`);
  console.log(`    effect size = ${fmtSig(probeSep.sigmas)}σ (pooled sd ${probeSep.pooledSd.toFixed(2)}) → ${probeSep.live ? 'LIVE (range acts)' : 'DEAD ZONE (range inert)'}   [mean shift significance ${fmtSig(probeSep.signif)}σ via SE]`);

  console.log('\n--- Summary (headline verdict = effect size > 2σ vs match noise) ---\n');
  for (const { spec, sep, secondarySep } of verdicts) {
    console.log(`  ${spec.lever.padEnd(16)} ${sep.live ? 'LIVE' : 'DEAD'} (effect ${fmtSig(sep.sigmas)}σ, shift significance ${fmtSig(sep.signif)}σ)`);
    if (secondarySep) {
      console.log(`  ${(spec.lever + ' (DF-line)').padEnd(16)} ${secondarySep.live ? 'LIVE' : 'DEAD'} (effect ${fmtSig(secondarySep.sigmas)}σ, shift significance ${fmtSig(secondarySep.signif)}σ)`);
    }
  }
  console.log(`  pressIntensity 0.3-0.6 ${probeSep.live ? 'LIVE' : 'DEAD ZONE'} (effect ${fmtSig(probeSep.sigmas)}σ, shift significance ${fmtSig(probeSep.signif)}σ)`);

  process.stderr.write(`\nTotal runtime: ${elapsedS.toFixed(1)}s\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
