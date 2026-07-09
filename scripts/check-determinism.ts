/**
 * 決定性チェック: 同じシードなら試合結果(スコア・スタッツ・位置チェックサム)が
 * バイト一致することを検証する。異なるシードなら結果が分岐することも確認する(健全性チェック)。
 *
 * 使い方: npx tsx scripts/check-determinism.ts
 */
import { createWorld, stepPhysics } from '../src/sim/world';
import { aiStep } from '../src/sim/ai';
import { SIM_DT } from '../src/sim/constants';
import type { TeamStats } from '../src/sim/types';

const MATCH_MINUTES = 10;
const TOTAL_STEPS = Math.round((MATCH_MINUTES * 60) / SIM_DT);
const SAMPLE_INTERVAL = 1000;

interface MatchResult {
  score: [number, number];
  stats: [TeamStats, TeamStats];
  checksum: number;
}

/** 決定論的な10分ヘッドレス試合を実行し、スコア・スタッツ・位置チェックサムを返す */
function runMatch(seed: number): MatchResult {
  const world = createWorld(['4-4-2', '4-4-2'], seed);
  let checksum = 0;
  for (let step = 0; step < TOTAL_STEPS; step++) {
    aiStep(world, SIM_DT);
    stepPhysics(world, SIM_DT);
    if (step % SAMPLE_INTERVAL === 0) {
      for (const p of world.players) checksum += p.pos.x + p.pos.y;
    }
  }
  return {
    score: [...world.score],
    stats: [{ ...world.stats[0] }, { ...world.stats[1] }],
    checksum,
  };
}

function statsEqual(a: [TeamStats, TeamStats], b: [TeamStats, TeamStats]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function main(): void {
  let failed = false;
  console.log('=== Determinism check ===\n');

  // 1) 同じシードを2回実行 → 完全一致すること
  const SEED = 42;
  console.log(`[1/2] Running seed=${SEED} twice…`);
  const r1 = runMatch(SEED);
  const r2 = runMatch(SEED);
  console.log(`  run1: score=${JSON.stringify(r1.score)} stats=${JSON.stringify(r1.stats)} checksum=${r1.checksum}`);
  console.log(`  run2: score=${JSON.stringify(r2.score)} stats=${JSON.stringify(r2.stats)} checksum=${r2.checksum}`);

  const scoreMatch = r1.score[0] === r2.score[0] && r1.score[1] === r2.score[1];
  const statsMatch = statsEqual(r1.stats, r2.stats);
  const checksumMatch = r1.checksum === r2.checksum;

  if (scoreMatch && statsMatch && checksumMatch) {
    console.log('  PASS: identical score, stats, and position checksum\n');
  } else {
    console.error(
      `  FAIL: same seed diverged (score match=${scoreMatch}, stats match=${statsMatch}, checksum match=${checksumMatch})\n`,
    );
    failed = true;
  }

  // 2) 異なるシード → チェックサムが分岐すること(シードが実際に効いているかの健全性チェック)
  console.log('[2/2] Running seed=1 and seed=2…');
  const s1 = runMatch(1);
  const s2 = runMatch(2);
  console.log(`  seed=1: score=${JSON.stringify(s1.score)} checksum=${s1.checksum}`);
  console.log(`  seed=2: score=${JSON.stringify(s2.score)} checksum=${s2.checksum}`);

  if (s1.checksum !== s2.checksum) {
    console.log('  PASS: different seeds diverge\n');
  } else {
    console.error('  FAIL: different seeds produced the same checksum (suspicious)\n');
    failed = true;
  }

  if (failed) {
    console.error('=== Determinism check FAILED ===');
    process.exit(1);
  }
  console.log('=== Determinism check PASSED ===');
}

main();
