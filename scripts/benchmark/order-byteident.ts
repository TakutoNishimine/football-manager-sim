/**
 * Task AV — byte-identity proof for the team0First guard arm vs main.
 *
 * Runs a set of fixed-seed 10-min matches and prints, per seed, a highly
 * sensitive fingerprint: final score, final stats, final rngState, and a
 * per-step position/velocity/ball checksum. Any behavioral divergence
 * changes at least one field.
 *
 * --order (default team0First = main's historical order) selects the arm.
 * When run against main's ai.ts (which has no setDecisionOrder), the flag is
 * skipped gracefully — main IS team0First, so the comparison stays valid.
 *
 * Proof procedure (local, < 60 s):
 *   1) tsx scripts/benchmark/order-byteident.ts > /tmp/av.txt        (task-av, team0First arm)
 *   2) git show main:src/sim/ai.ts > /tmp/main-ai.ts && cp src/sim/ai.ts /tmp/av-ai.ts \
 *        && cp /tmp/main-ai.ts src/sim/ai.ts \
 *        && tsx scripts/benchmark/order-byteident.ts > /tmp/main.txt \
 *        && cp /tmp/av-ai.ts src/sim/ai.ts
 *   3) diff /tmp/av.txt /tmp/main.txt   (MUST be empty)
 *
 * Usage: tsx scripts/benchmark/order-byteident.ts [--seeds 1-12] [--minutes 10]
 *            [--order team0First|team1First|alternate]
 */
import { createWorld, stepPhysics } from '../../src/sim/world.ts';
import * as ai from '../../src/sim/ai.ts';
import { SIM_DT } from '../../src/sim/constants.ts';

const { aiStep } = ai;

function parseSeeds(spec: string): number[] {
  const m = spec.match(/^(\d+)-(\d+)$/);
  if (m) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    const out: number[] = [];
    for (let s = lo; s <= hi; s++) out.push(s);
    return out;
  }
  return spec.split(',').map((x) => Number(x.trim()));
}

function main(): void {
  const argv = process.argv.slice(2);
  let seeds = parseSeeds('1-12');
  let minutes = 10;
  let order = 'team0First';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seeds') seeds = parseSeeds(argv[++i]);
    else if (argv[i] === '--minutes') minutes = Number(argv[++i]);
    else if (argv[i] === '--order') order = argv[++i];
  }
  // main の ai.ts には setDecisionOrder が無い(= 常に team0First)。存在チェックで両対応にし、
  // 出力ヘッダは order を含めない(main と diff するため)。
  const setOrder = (ai as { setDecisionOrder?: (o: string) => void }).setDecisionOrder;
  if (setOrder) setOrder(order);
  else if (order !== 'team0First') throw new Error('this ai.ts has no setDecisionOrder (main?) — only team0First is valid');
  const totalSteps = Math.round((minutes * 60) / SIM_DT);

  console.log(`# order-byteident seeds=${seeds[0]}..${seeds[seeds.length - 1]} minutes=${minutes}`);
  for (const seed of seeds) {
    const world = createWorld(['4-4-2', '4-4-2'], seed);
    // 全stepで位置・速度・ボール状態を畳み込む(発散に鋭敏なチェックサム)。
    let checksum = 0;
    for (let step = 0; step < totalSteps; step++) {
      aiStep(world, SIM_DT);
      stepPhysics(world, SIM_DT);
      for (const p of world.players) {
        checksum += p.pos.x + p.pos.y * 7 + p.vel.x * 13 + p.vel.y * 17;
      }
      const b = world.ball;
      checksum +=
        b.pos.x * 23 + b.pos.y * 29 + b.vel.x * 31 + b.vel.y * 37 + b.z * 41 + (b.ownerId ?? -1) * 43;
    }
    // rngState は RNG ストリーム全体の整数フィンガープリント: 描画回数や順序が1回でも
    // 変われば必ず変わる。score/stats と併せてバイト一致を厳密に判定する。
    console.log(
      `seed=${seed} score=${world.score[0]}-${world.score[1]} rng=${world.rngState} ` +
        `chk=${checksum.toFixed(6)} s0=${JSON.stringify(world.stats[0])} s1=${JSON.stringify(world.stats[1])}`,
    );
  }
}

main();
