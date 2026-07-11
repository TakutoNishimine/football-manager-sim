/**
 * Worker entry for color-probe.ts's `--workers > 1` path (Task AV).
 *
 * Receives the sheet pool + config + decision-order ONCE via workerData, sets
 * the DECISION_ORDER global for this worker's whole lifetime, then runs one
 * identical-sheet match per message through the same runColorJob() the serial
 * path uses (byte-identical results regardless of thread count — pool.ts /
 * audit-worker.ts precedent).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { setDecisionOrder, type DecisionOrder } from '../../src/sim/ai.ts';
import { runColorJob, type ColorJob, type ColorResult } from './color-core.ts';
import type { TacticSheet } from '../league/sheets.ts';

interface ColorWorkerData {
  sheets: TacticSheet[];
  minutes: number;
  seedBase: number;
  order: DecisionOrder;
}

interface WorkerRequest {
  index: number;
  payload: ColorJob;
}

if (!parentPort) throw new Error('color-worker.ts must be run as a worker_threads Worker');

const { sheets, minutes, seedBase, order } = workerData as ColorWorkerData;
setDecisionOrder(order); // 1ワーカー=1アーム。プロセス寿命の間 order は不変。

parentPort.on('message', (msg: WorkerRequest) => {
  try {
    const result: ColorResult = runColorJob(sheets, msg.payload, minutes, seedBase);
    parentPort!.postMessage({ index: msg.index, result });
  } catch (err) {
    parentPort!.postMessage({ index: msg.index, error: err instanceof Error ? err.message : String(err) });
  }
});
