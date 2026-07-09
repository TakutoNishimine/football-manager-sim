/**
 * Audit core (Task AK) — pure functions shared by audit.ts's serial path
 * (`--workers 1`) and audit-worker.ts's parallel path. No console output, no
 * process-level side effects: keeping this side-effect-free is what makes
 * the two paths produce byte-identical GameRecord data regardless of thread
 * count or completion order.
 */
import type { TacticSheet } from './sheets.ts';
import { runMatch } from './match.ts';

export const SEED_BASE = 100000;
export const SEED_PAIRING_STRIDE = 1000;

export interface GameRecord {
  i: number; // sheet index (A side of the pairing, i <= j)
  j: number; // sheet index (B side of the pairing)
  matchIndex: number;
  seed: number;
  aTeam: 0 | 1; // which world team color sheet i occupied
  goalsI: number;
  goalsJ: number;
}

export interface Pairing {
  pairingIndex: number;
  i: number;
  j: number;
}

export function buildPairings(n: number): Pairing[] {
  const pairings: Pairing[] = [];
  let idx = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      pairings.push({ pairingIndex: idx++, i, j });
    }
  }
  return pairings;
}

export function runPairing(sheets: TacticSheet[], pairing: Pairing, matchCount: number, minutes: number): GameRecord[] {
  const records: GameRecord[] = [];
  const sheetI = sheets[pairing.i];
  const sheetJ = sheets[pairing.j];
  if (matchCount >= SEED_PAIRING_STRIDE) {
    throw new Error(`--matches must be < ${SEED_PAIRING_STRIDE} (seed stride) to keep seeds collision-free`);
  }
  for (let m = 0; m < matchCount; m++) {
    const aTeam: 0 | 1 = m % 2 === 0 ? 0 : 1; // alternate colors so bias cancels
    const seed = SEED_BASE + pairing.pairingIndex * SEED_PAIRING_STRIDE + m;
    const { goalsA, goalsB } = runMatch(sheetI, sheetJ, aTeam, seed, minutes);
    records.push({ i: pairing.i, j: pairing.j, matchIndex: m, seed, aTeam, goalsI: goalsA, goalsJ: goalsB });
  }
  return records;
}
