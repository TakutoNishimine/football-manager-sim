/**
 * Worker entry for fixture.ts's `--workers > 1` path (Task AK).
 *
 * One match is the unit of work: sheetA/sheetB and `minutes` are static
 * (sent once via workerData), each job payload is just `{ aTeam, seed }`.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { runMatch } from './match.ts';
import type { TacticSheet } from './sheets.ts';

interface FixtureWorkerData {
  sheetA: TacticSheet;
  sheetB: TacticSheet;
  minutes: number;
}

export interface FixtureJob {
  aTeam: 0 | 1;
  seed: number;
}

interface WorkerRequest {
  index: number;
  payload: FixtureJob;
}

if (!parentPort) throw new Error('fixture-worker.ts must be run as a worker_threads Worker');

const { sheetA, sheetB, minutes } = workerData as FixtureWorkerData;

parentPort.on('message', (msg: WorkerRequest) => {
  try {
    const result = runMatch(sheetA, sheetB, msg.payload.aTeam, msg.payload.seed, minutes);
    parentPort!.postMessage({ index: msg.index, result });
  } catch (err) {
    parentPort!.postMessage({ index: msg.index, error: err instanceof Error ? err.message : String(err) });
  }
});
