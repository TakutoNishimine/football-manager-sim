/**
 * Worker entry for contrast.ts's `--workers > 1` path (Task AK).
 *
 * One "config" (a single lever value's N-match run, e.g. "manMark=1") is the
 * unit of work — there are 10 of them per full run (4 levers x lo/hi + the
 * pressIntensity dead-zone probe's lo/hi). Each is itself N serial matches,
 * so this is coarse enough to keep worker overhead negligible.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { runConfig, type ConfigJob, type ConfigResult } from './contrast-core.ts';
import type { FormationName } from '../../src/sim/formation.ts';

interface ContrastWorkerData {
  n: number;
  minutes: number;
  formation: FormationName;
}

interface WorkerRequest {
  index: number;
  payload: ConfigJob;
}

if (!parentPort) throw new Error('contrast-worker.ts must be run as a worker_threads Worker');

const { n, minutes, formation } = workerData as ContrastWorkerData;

parentPort.on('message', (msg: WorkerRequest) => {
  try {
    const { lever, value, axisKey, configIndex, label } = msg.payload;
    const result: ConfigResult = runConfig(lever, value, axisKey, configIndex, n, minutes, formation, label);
    parentPort!.postMessage({ index: msg.index, result });
  } catch (err) {
    parentPort!.postMessage({ index: msg.index, error: err instanceof Error ? err.message : String(err) });
  }
});
