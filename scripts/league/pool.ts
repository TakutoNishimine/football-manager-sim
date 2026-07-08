/**
 * Generic worker_threads pool for the league scripts (Task AK).
 *
 * Motivation: `league:audit` runs 780 matches serially (~34 min on one core
 * of a 10-core machine). Match execution is embarrassingly parallel (each
 * match/pairing/config is an independent deterministic simulation with no
 * shared mutable state), so a small worker pool gets a near-linear speedup.
 *
 * tsx + worker_threads: a naive `new Worker('./foo-worker.ts')`, or even
 * `new Worker('./foo-worker.ts', { execArgv: ['--import', 'tsx'] })`, only
 * works by accident. Both rely on Node's CLI-flag-driven loader hook being
 * live inside the worker thread, and whether it is — and whether it also
 * covers the EXTENSIONLESS relative imports `src/sim/*.ts` uses (e.g.
 * `world.ts`'s `from './constants'`) — is Node-version/platform dependent.
 * Verified the hard way: both approaches passed locally on macOS/Node 24
 * but threw `Cannot find module '.../src/sim/constants'` inside the worker
 * on the Linux/Node 22 GitHub Actions runner.
 *
 * The robust fix is tsx's own documented in-PROCESS Node.js API, not CLI
 * flags: every worker's entry point is `worker-bootstrap.mjs`, a plain
 * `.mjs` file (needs no loader to parse itself) that calls tsx's `tsImport`
 * API directly to load the real `.ts` worker module named by the
 * `LEAGUE_WORKER_ENTRY` env var. Because this registers the loader from
 * inside the worker's own bootstrap rather than depending on inherited CLI
 * flags, it's independent of how — or on what Node build — the parent
 * process was started.
 *
 * Determinism contract: `runPool` returns `results` indexed 1:1 with the
 * input `jobs` array, regardless of which worker computed which job or in
 * what order they finished. Callers that need byte-identical, worker-count-
 * independent stdout MUST aggregate/print only from that returned array (in
 * job-index order) — never from `onResult`'s arrival order, which is
 * unspecified and will vary run to run.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_FILE = path.resolve(__dirname, './worker-bootstrap.mjs');

export interface RunPoolOptions<J, R> {
  /** Absolute path to the worker module (a .ts file, loaded via worker-bootstrap.mjs + tsx's tsImport). */
  workerFile: string;
  /** Static data every worker receives once at spawn (shared config/read-only tables). */
  workerData?: unknown;
  /** One job payload per unit of work; `jobs[i]` maps 1:1 to the returned `results[i]`. */
  jobs: J[];
  /** Worker count, clamped to [1, jobs.length]. */
  workers: number;
  /** Called as each result arrives. Arrival order is NOT job order — informational only (e.g. progress logging to stderr). */
  onResult?: (index: number, job: J, result: R) => void;
}

interface WorkerRequest<J> {
  index: number;
  payload: J;
}

type WorkerResponse<R> = { index: number; result: R } | { index: number; error: string };

/**
 * Runs `jobs` across a pool of worker_threads, pull-based: each worker is
 * handed its next job as soon as it finishes the previous one, so faster
 * jobs don't block behind slower ones on other workers.
 */
export function runPool<J, R>(opts: RunPoolOptions<J, R>): Promise<R[]> {
  const { workerFile, workerData, jobs, onResult } = opts;
  const results = new Array<R>(jobs.length);
  if (jobs.length === 0) return Promise.resolve(results);

  const workerCount = Math.max(1, Math.min(opts.workers, jobs.length));
  let nextJob = 0;
  let completed = 0;

  return new Promise((resolve, reject) => {
    const pool: Worker[] = [];
    let settled = false;

    const failAll = (err: unknown) => {
      if (settled) return;
      settled = true;
      for (const w of pool) void w.terminate();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const dispatchNext = (worker: Worker) => {
      if (nextJob >= jobs.length) return;
      const index = nextJob++;
      const req: WorkerRequest<J> = { index, payload: jobs[index] };
      worker.postMessage(req);
    };

    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(BOOTSTRAP_FILE, {
        workerData,
        env: { ...process.env, LEAGUE_WORKER_ENTRY: workerFile },
      });
      pool.push(worker);
      worker.on('message', (msg: WorkerResponse<R>) => {
        if (settled) return;
        if ('error' in msg) {
          failAll(new Error(msg.error));
          return;
        }
        results[msg.index] = msg.result;
        onResult?.(msg.index, jobs[msg.index], msg.result);
        completed++;
        if (completed === jobs.length) {
          settled = true;
          for (const w of pool) void w.terminate();
          resolve(results);
          return;
        }
        dispatchNext(worker);
      });
      worker.on('error', failAll);
      dispatchNext(worker);
    }
  });
}

/** Default pool size: leave 2 cores for the OS/main thread, cap at 8 (diminishing returns beyond that for this workload). */
export function defaultWorkerCount(): number {
  return Math.max(1, Math.min(os.cpus().length - 2, 8));
}

/** Shared `--workers N` CLI validation for all league scripts. */
export function parseWorkersArg(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`--workers must be a positive integer (got ${raw})`);
  }
  return n;
}
