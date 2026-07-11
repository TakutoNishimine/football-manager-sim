/**
 * Worker entry for audit.ts's `--workers > 1` path (Task AK).
 *
 * Receives the sheet pool + match/minute config once via `workerData`, then
 * one pairing per message. Runs it through the exact same `runPairing()`
 * used by the serial path, so results are bit-identical regardless of which
 * thread (or whether any worker at all) produced them.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { runPairing, type GameRecord, type Pairing } from './audit-core.ts';
import type { TacticSheet } from './sheets.ts';

interface AuditWorkerData {
  sheets: TacticSheet[];
  matchCount: number;
  minutes: number;
  seedBase: number;
}

interface WorkerRequest {
  index: number;
  payload: Pairing;
}

if (!parentPort) throw new Error('audit-worker.ts must be run as a worker_threads Worker');

const { sheets, matchCount, minutes, seedBase } = workerData as AuditWorkerData;

parentPort.on('message', (msg: WorkerRequest) => {
  try {
    const records: GameRecord[] = runPairing(sheets, msg.payload, matchCount, minutes, seedBase);
    parentPort!.postMessage({ index: msg.index, result: records });
  } catch (err) {
    parentPort!.postMessage({ index: msg.index, error: err instanceof Error ? err.message : String(err) });
  }
});
