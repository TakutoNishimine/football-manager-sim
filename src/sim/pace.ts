/**
 * ロコモーション経済(Task U): 選手は常に全力スプリントするのではなく、
 * 「意図」に応じて歩く/ジョグ/ラン/スプリントを使い分ける。
 * DOM非依存。world.ts(movePlayers)から呼ばれ、速度の唯一の情報源になる。
 */
import { PLAYER_MAX_SPEED } from './constants';
import type { IntentKind } from './types';

export type Effort = 'walk' | 'jog' | 'run' | 'sprint';

const EFFORT_SPEED: Record<Effort, number> = {
  walk: 1.8,
  jog: 2.5,
  run: 3.7,
  sprint: PLAYER_MAX_SPEED,
};

export function effortSpeed(e: Effort): number {
  return EFFORT_SPEED[e];
}

/** ボールとの距離がこれ未満なら「マーク対象が今にも受けそうで近い」= runへ引き上げる */
export const MARK_BALL_NEAR_RADIUS = 12;
/**
 * コース上のカットポイントがボールに近いと判定する距離。マークより狭い: 「持ち場を
 * シャドーしているだけ」のcutLaneが大半なので、本当に今すぐ塞ぎに行く必要がある
 * (=ボールがまさにそのコースを突こうとしている)場合だけスプリントに上げる
 */
export const CUT_LANE_NEAR_RADIUS = 6;
/** 飛行中のボールにこの距離内なら、受け手/コース上の守備者としてスプリント扱い */
export const BALL_FLIGHT_REACH_RADIUS = 10;
/** 持ち場からこれ以上離れていたら「アウトオブポジション」でエフォートを1段階上げる */
export const OUT_OF_POSITION_DIST = 10;
/**
 * 大きくアウトオブポジション(Task AA): ここまで離れたら2段階上げる(歩き→ラン)。
 * 攻撃の前進で持ち場が20m以上先へ移った選手が歩いて追うと、プレー(ワイドの保持スペルは
 * 2〜4s)に永遠に追いつけず、ボックスに人が立たない(FWが常時20〜30m後方を漂う実測)。
 * 保持チームのみ(world.ts 側でゲート): 守備側の cover まで2段階上げると、ブロックの
 * 回復が速くなりすぎて攻撃の隙が消える(計測: shots 2.0→0.75 に崩壊)。守備の規律ある
 * 歩き(Task U/AC の較正)は従来の1段階エスカレートのまま。
 */
export const FAR_OUT_OF_POSITION_DIST = 22;
/** GK: 自ゴールからこの距離内、またはシュートが飛んでいれば「脅威」でrun/sprintへ */
export const GK_THREAT_RADIUS = 30;

export interface EffortContext {
  /** ボールが飛行中(パス/クリア中)で、かつこの選手がその軌道に絡む位置にいる */
  ballInFlightReach: boolean;
  /** dist(pos, moveTarget) > OUT_OF_POSITION_DIST */
  outOfPosition: boolean;
  /** dist(pos, moveTarget) > FAR_OUT_OF_POSITION_DIST(Task AA: 2段階エスカレート) */
  farOutOfPosition: boolean;
  /** 'mark'専用: マーク対象がボールに近い(=今まさに受けそう)か */
  markBallNear: boolean;
  /** 'cutLane'専用: カットするコース上の点がボールに近い(=今すぐ塞ぐ必要がある)か */
  cutLaneBallNear: boolean;
  /** GK専用: 自ゴールが脅かされている(近距離 or シュート飛翔中) */
  gkThreat: boolean;
  /** GK専用: ボールが相手陣内にある */
  gkBallInOppositionHalf: boolean;
}

function escalate(e: Effort): Effort {
  if (e === 'walk') return 'jog';
  if (e === 'jog') return 'run';
  if (e === 'run') return 'sprint';
  return e;
}

/**
 * 意図から基本エフォートを決め、文脈(コンテキスト脱出条件)で調整する。
 * kind === null は指示なし移動(ユーザーinstruction含む)= jog。
 */
export function intentEffort(kind: IntentKind | null, ctx: EffortContext): Effort {
  if (ctx.ballInFlightReach) return 'sprint';

  let base: Effort;
  if (kind === null) {
    base = 'jog';
  } else if (kind === 'keeper') {
    // GK専用。ボールが脅威なら急いで構え直す、相手陣内ならのんびり、その中間はジョグ
    base = ctx.gkThreat ? 'sprint' : ctx.gkBallInOppositionHalf ? 'walk' : 'jog';
  } else {
    switch (kind) {
      case 'press':
      case 'chase':
      case 'recover': // 抜かれたプレッサーの回復ラン: 全力で戻る(Task W)
      case 'runBehind':
      case 'lateRun':
      case 'overlap':
      case 'underlap':
      case 'giveAndGo':
      case 'takeOn': // 仕掛けのバースト(速度は world.ts 側で TAKEON_BURST_SPEED に拡張)
        base = 'sprint';
        break;
      case 'support':
      case 'decoy':
      case 'carry':
        base = 'jog';
        break;
      case 'mark':
        // マークは相手の動きに追随し続ける必要がある(歩いていては振り切られる)。
        // ボールが近い(=今にも受けそう)ならrun、遠くても最低jogは保つ
        base = ctx.markBallNear ? 'run' : 'jog';
        break;
      case 'cutLane':
        // コース上に立つ守備者: ボールが近く今にも通されそうなら詰める(sprint)。
        // 遠い/まだ間合いのあるシャドーイングは急ぐ必要がない(jog)
        base = ctx.cutLaneBallNear ? 'sprint' : 'jog';
        break;
      case 'hold':
      case 'cover':
        base = 'walk';
        break;
      default:
        base = 'jog';
    }
  }

  if (ctx.farOutOfPosition && base !== 'sprint') base = escalate(escalate(base));
  else if (ctx.outOfPosition && base !== 'sprint') base = escalate(base);
  return base;
}

/**
 * パスコース危険度(laneRiskFromPoints)で守備者の「コースへの到達速度」を見積もるための
 * 基本エフォート。文脈(ボール飛行中の10m以内スプリント)は laneRiskFromPoints 側で
 * 点ごとに上書きするので、ここでは意図から決まる基本ティアだけを返す(Task W)。
 * hold/cover は「持ち場を守るだけ」でコースを積極的に潰しに来ないため engages=false 扱い。
 */
export function laneEngageEffort(kind: IntentKind | null): Effort {
  if (kind === null) return 'jog';
  switch (kind) {
    case 'press':
    case 'chase':
    case 'recover':
    case 'runBehind':
    case 'lateRun':
    case 'overlap':
    case 'underlap':
    case 'giveAndGo':
    case 'takeOn':
      return 'sprint';
    case 'hold':
    case 'cover':
      return 'walk';
    default:
      // support/decoy/carry/mark/cutLane/keeper: run を共有上限とする(Task U の predict と同じ
      // 保守側の近似)。jog だと honest 化しすぎて攻撃が縦に刺しすぎ、シュートが激増した。
      // 注意(既知の非対称): この平坦な run 上限は intentEffort(現実)側の文脈スプリント昇格を
      // 拾わない — 具体的には mark の markBallNear+outOfPosition 昇格(run→escalate→sprint)と
      // cutLane の cutLaneBallNear 昇格(→sprint)。よってコース価格は近接マーカー/コースカッターを
      // 現実よりわずかに低速に見積もる。ボール飛行中の 10m 以内は laneRisk 側で点ごとに sprint へ
      // 上書きされるため主要ケースは補償される。残差は受容(過度な honest 化はシュート激増を招く)。
      return 'run';
  }
}

/** laneRiskFromPoints で「ボールが飛べばスプリントで詰めに来る」対象か(hold/cover は来ない) */
export function laneEngages(kind: IntentKind | null): boolean {
  return kind !== 'hold' && kind !== 'cover';
}
