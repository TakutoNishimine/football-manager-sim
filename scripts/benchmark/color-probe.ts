/**
 * Task AV — color-probe: the pure color / id-order / decision-order channel.
 *
 * Runs identical-sheet matches (both world teams play the SAME sheet, same
 * seed) across all 12 audit sheets and measures the team0-vs-team1 decisive
 * win split. In a fully symmetric match the ONLY thing that can bias the split
 * is color / global id order / per-tick decision order — so this isolates the
 * mechanism the whole task hunts (reports/task-at.md Part 3).
 *
 * The `--order` arm sets src/sim/ai.ts's DECISION_ORDER global (default
 * default alternate = shipped per-tick alternation; team0First = main's historical
 * order; team1First flips it).
 * The FLIP experiment compares the pooled team0 lean between the two arms at
 * the SAME seed lists (seeds derive deterministically from seed-base + sheet +
 * match index, identical across arms). If the lean's sign follows the order,
 * decision order is the mechanism.
 *
 * Worker-pooled (scripts/league/pool.ts). Results aggregate ONLY from the
 * job-index-ordered return array, so stdout is byte-identical across --workers.
 *
 * Usage:
 *   tsx scripts/benchmark/color-probe.ts --matches 170 --seed-base 100000 \
 *       --order alternate|team0First|team1First --workers 4 [--minutes 10] [--sheets a,b] [--md]
 *
 *   --matches N  = matches PER SHEET (total = N × sheets; N < 1000).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHEETS, type TacticSheet } from '../league/sheets.ts';
import { runPool, defaultWorkerCount, parseWorkersArg } from '../league/pool.ts';
import { setDecisionOrder, type DecisionOrder } from '../../src/sim/ai.ts';
import {
  COLOR_SEED_STRIDE,
  runColorJob,
  type ColorJob,
  type ColorResult,
} from './color-core.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COLOR_WORKER_FILE = path.resolve(__dirname, './color-worker.ts');

interface Args {
  matches: number;
  minutes: number;
  seedBase: number;
  order: DecisionOrder;
  workers: number;
  sheetFilter: string[] | null;
  md: boolean;
}

function parseArgs(argv: string[]): Args {
  let matches = 170;
  let minutes = 10;
  let seedBase = 100000;
  let order: DecisionOrder = 'alternate';
  let workers = defaultWorkerCount();
  let sheetFilter: string[] | null = null;
  let md = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--matches') matches = Number(argv[++i]);
    else if (a === '--minutes') minutes = Number(argv[++i]);
    else if (a === '--seed-base') seedBase = Number(argv[++i]);
    else if (a === '--order') {
      const v = argv[++i];
      if (v !== 'alternate' && v !== 'team0First' && v !== 'team1First') throw new Error(`--order must be alternate|team0First|team1First (got ${v})`);
      order = v;
    } else if (a === '--workers') workers = parseWorkersArg(argv[++i]);
    else if (a === '--sheets') sheetFilter = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--md') md = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!Number.isInteger(matches) || matches <= 0 || matches >= COLOR_SEED_STRIDE) {
    throw new Error(`--matches must be a positive integer < ${COLOR_SEED_STRIDE} (got ${matches})`);
  }
  return { matches, minutes, seedBase, order, workers, sheetFilter, md };
}

interface SheetTally {
  name: string;
  w0: number; // team0 decisive wins
  w1: number; // team1 decisive wins
  draws: number;
}

/** z for a team0-vs-team1 split on decisive games (fair coin null): +z = team0 lean. */
function zScore(w0: number, w1: number): number {
  const n = w0 + w1;
  if (n === 0) return 0;
  return (w0 - w1) / Math.sqrt(n);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sheets: TacticSheet[] = args.sheetFilter
    ? SHEETS.filter((s) => args.sheetFilter!.includes(s.name))
    : SHEETS;
  if (!sheets.length) throw new Error('no sheets selected');

  // ジョブ列: (sheetIndex, m)。job-index 順で集計するので --workers 非依存でバイト一致。
  const jobs: ColorJob[] = [];
  for (let si = 0; si < sheets.length; si++) {
    for (let m = 0; m < args.matches; m++) jobs.push({ sheetIndex: si, m });
  }

  const total = jobs.length;
  process.stderr.write(
    `[color-probe] order=${args.order} seedBase=${args.seedBase} sheets=${sheets.length} ` +
      `matches/sheet=${args.matches} total=${total} minutes=${args.minutes} workers=${args.workers}\n`,
  );

  let results: ColorResult[];
  if (args.workers === 1) {
    setDecisionOrder(args.order); // 直列パスも main プロセスで order を設定
    results = jobs.map((j) => runColorJob(sheets, j, args.minutes, args.seedBase));
  } else {
    let done = 0;
    results = await runPool<ColorJob, ColorResult>({
      workerFile: COLOR_WORKER_FILE,
      workerData: { sheets, minutes: args.minutes, seedBase: args.seedBase, order: args.order },
      jobs,
      workers: args.workers,
      onResult: () => {
        done++;
        if (done % 500 === 0 || done === total) process.stderr.write(`  ${done}/${total}\r`);
      },
    });
    process.stderr.write('\n');
  }

  // 集計(job-index 順)
  const tallies: SheetTally[] = sheets.map((s) => ({ name: s.name, w0: 0, w1: 0, draws: 0 }));
  for (let k = 0; k < jobs.length; k++) {
    const { g0, g1 } = results[k];
    const t = tallies[jobs[k].sheetIndex];
    if (g0 > g1) t.w0++;
    else if (g1 > g0) t.w1++;
    else t.draws++;
  }

  let pw0 = 0;
  let pw1 = 0;
  let pdraws = 0;
  for (const t of tallies) {
    pw0 += t.w0;
    pw1 += t.w1;
    pdraws += t.draws;
  }

  const sep = args.md ? ' | ' : '  ';
  const head = args.md ? '| ' : '';
  const tail = args.md ? ' |' : '';
  console.log(`# color-probe order=${args.order} seedBase=${args.seedBase} matches/sheet=${args.matches} minutes=${args.minutes}`);
  console.log(`${head}sheet${sep}team0${sep}team1${sep}draws${sep}z(team0)${tail}`);
  if (args.md) console.log('| --- | --- | --- | --- | --- |');
  for (const t of tallies) {
    console.log(`${head}${t.name}${sep}${t.w0}${sep}${t.w1}${sep}${t.draws}${sep}${zScore(t.w0, t.w1).toFixed(2)}${tail}`);
  }
  const pn = pw0 + pw1;
  console.log(
    `${head}POOLED${sep}${pw0}${sep}${pw1}${sep}${pdraws}${sep}${zScore(pw0, pw1).toFixed(2)}${tail}`,
  );
  // 機械可読サマリ(CIログから拾いやすい1行)
  console.log(
    `SUMMARY order=${args.order} seedBase=${args.seedBase} decisive=${pn} team0=${pw0} team1=${pw1} draws=${pdraws} z=${zScore(pw0, pw1).toFixed(3)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
