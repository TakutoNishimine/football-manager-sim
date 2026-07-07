/**
 * 自己対戦評価モジュール。
 * 候補重み vs 基準重みで複数試合を実行し、適応度を返す。
 */
import { createWorld, stepPhysics } from '../src/sim/world';
import { aiStep } from '../src/sim/ai';
import { setTeamWeights, resetWeights, type AiWeights } from '../src/sim/weights';
import { SIM_DT } from '../src/sim/constants';

/** 1試合分のシミュレーションを実行し、スコアとシュート数を返す */
function runMatch(minutesDuration: number, seed?: number): { score: [number, number]; shots: [number, number] } {
  const world = createWorld(undefined, seed);
  const totalSteps = Math.round((minutesDuration * 60) / SIM_DT);
  for (let i = 0; i < totalSteps; i++) {
    aiStep(world, SIM_DT);
    stepPhysics(world, SIM_DT);
  }
  return {
    score: [world.score[0], world.score[1]],
    shots: [world.stats[0].shots, world.stats[1].shots],
  };
}

/**
 * 候補重みと基準重みを対戦させて適応度を返す。
 * 適応度 = 平均得失点差 + 0.1 × 平均シュート数差
 *
 * 公平性のため:
 *   - 前半(ceil(n/2)試合): 候補=チーム0、基準=チーム1
 *   - 後半(残り試合):     候補=チーム1、基準=チーム0
 * 両サイドを入れ替えることでフィールド側・攻撃方向のバイアスを除去する。
 */
export function evaluate(
  candidate: AiWeights,
  base: AiWeights,
  numMatches: number,
  minutesDuration: number,
  baseSeed?: number,
): number {
  let totalGoalDiff = 0;
  let totalShotDiff = 0;
  const half = Math.ceil(numMatches / 2);
  const rest = numMatches - half;
  let matchIndex = 0;

  // 候補をチーム0として実行
  for (let i = 0; i < half; i++) {
    setTeamWeights(0, candidate);
    setTeamWeights(1, base);
    const { score, shots } = runMatch(minutesDuration, baseSeed === undefined ? undefined : baseSeed + matchIndex++);
    totalGoalDiff += score[0] - score[1];
    totalShotDiff += shots[0] - shots[1];
  }

  // 候補をチーム1として実行(符号を反転して候補視点に揃える)
  for (let i = 0; i < rest; i++) {
    setTeamWeights(0, base);
    setTeamWeights(1, candidate);
    const { score, shots } = runMatch(minutesDuration, baseSeed === undefined ? undefined : baseSeed + matchIndex++);
    totalGoalDiff += score[1] - score[0];
    totalShotDiff += shots[1] - shots[0];
  }

  resetWeights();

  return totalGoalDiff / numMatches + 0.1 * (totalShotDiff / numMatches);
}
