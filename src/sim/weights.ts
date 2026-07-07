import type { Team } from './types';

/**
 * AIの採点重み。チームごとに持ち、ヘッドレス自己対戦による最適化の対象。
 * 重みを変えるとチームの「性格」が変わる(例: passProgressを上げると縦に速いチームになる)。
 */
export interface AiWeights {
  // ボール保持者の行動選択
  shootBase: number; // ゴールに近いほどシュート
  shootSafety: number; // シュートコースが通っているほどシュート
  shotQualityScale: number; // シュートの「質」ゲートの効き(0=ゲートなし, 1=フル)。角度の悪い遠/横からの投機的シュートを抑える
  passSafety: number; // カットされにくいパスを好む
  passProgress: number; // 前進するパスを好む
  passVertical: number; // 縦・ライン間を割るパス(相手を1人以上越える前進)への追加加点
  passOpenness: number; // フリーな受け手を好む
  passPressureRelief: number; // 囲まれている時ほどパスを選ぶ
  pingPongPenalty: number; // 直前の出し手へすぐ返すパスの減点(前進の選択肢があるときほど強い)
  lateralPassPenalty: number; // 真横(攻撃方向に対し±60〜120°)へ流すパスの減点(前進の選択肢があるとき強い)
  runReceiverBonus: number; // 攻撃参加のラン中の味方(前進方向)を受け手として優先する加点
  giveAndGoReceiverBonus: number; // ワンツーで裏へ走る味方(giveAndGo意図)を受け手として優先する加点
  passBackwardInRange: number; // シュートレンジ内での後ろ向き/横向きパスの減点(囲まれている時は緩和)
  funnelExitBonus: number; // ファイナルサードで好機がない時、後方の安全な出口へ「循環して出る」ことへの加点(Task Z)
  dribbleBase: number; // ドリブル継続の基準点
  dribbleCalm: number; // プレッシャーがない時のドリブル選好
  takeOnBase: number; // 仕掛け(テイクオン)の基準点。前方に抜ける相手が1人・背後にスペースがある時のみ候補になる(Task Y)
  takeOnSpace: number; // 抜いた先(相手の背後)が開いているほど仕掛けを選好する加点(Task Y)
  crossBase: number; // クロスの基準点。ワイドのファイナルサードで、着地を襲える味方がいる時のみ候補(Task AA)
  crossBodies: number; // 着地を襲える味方(ボックスの人数)1人あたりの加点(Task AA)
  switchBase: number; // 40〜70mロフトのサイドチェンジの基準点。ボールサイド過密時のみ候補(Task AA)
  carrySpaceAhead: number; // ゴール方向の前方コーンが空いているほどキャリーを選好
  carryOpenGrass: number; // 前が大きく空いていて低圧の時、運ぶことへの追加加点(反射的な横パスに勝たせる)
  reflexivePassPenalty: number; // 前が空いて低圧なのに前進しない短い/横の「反射的な」リリースの減点
  holdBase: number; // 保持者のhold(その場で待つ)基準点。低圧・選択肢が乏しい時にのみ効く(Task V)
  holdRunWait: number; // 味方が攻撃参加のラン中(裏抜け/レイトラン等)なら hold を加点(ランの発展を待つ)(Task V)

  // オフボールの意図選択
  offSelf: number; // 自分がパスを受けられる価値
  offTeamDelta: number; // 味方を空ける価値(囮の源泉)
  offProgress: number; // ゴールへ近づく動きの選好
  offDisciplineSupport: number; // サポート時の持ち場への規律
  offDisciplineOther: number; // その他の意図の持ち場への規律
  supportPressuredBonus: number; // 保持者が囲まれている時のサポート加点
  runBehindBonus: number; // 最終ライン突破の加点
  lateRunBonus: number; // 中盤のボックスへのレイトラン加点
  postRunBonus: number; // ボールがワイドのファイナルサードにあるときのニア/ファーポストへのラン加点(Task AA)
  wideRunBonus: number; // オーバーラップ/アンダーラップの加点(wideRunsでスケール)
  holdBonus: number; // ポジション維持の基準加点
}

export const DEFAULT_WEIGHTS: AiWeights = {
  shootBase: 2.2,
  shootSafety: 0.9,
  shotQualityScale: 0.6,
  passSafety: 1.3,
  passProgress: 1.85,
  passVertical: 1.45,
  passOpenness: 0.6,
  passPressureRelief: 0.5,
  pingPongPenalty: 1.2,
  lateralPassPenalty: 0.7,
  runReceiverBonus: 0.25,
  giveAndGoReceiverBonus: 0.8,
  passBackwardInRange: 3.0,
  funnelExitBonus: 2.15,
  dribbleBase: 0.55,
  dribbleCalm: 0.5,
  takeOnBase: 0.28,
  takeOnSpace: 0.6,
  crossBase: 2.2,
  crossBodies: 0.5,
  switchBase: 0.9,
  carrySpaceAhead: 0.7,
  carryOpenGrass: 0.3,
  reflexivePassPenalty: 0.15,
  holdBase: 0.25,
  holdRunWait: 0.6,
  offSelf: 1.2,
  offTeamDelta: 1.5,
  offProgress: 0.5,
  offDisciplineSupport: 0.05,
  offDisciplineOther: 0.025,
  supportPressuredBonus: 0.35,
  runBehindBonus: 0.45,
  lateRunBonus: 0.5,
  postRunBonus: 1.4,
  wideRunBonus: 0.7,
  holdBonus: 0.1,
};

/** チームごとの採点重み。自己対戦最適化は片方に候補・片方に基準を入れて比較する */
export const TEAM_WEIGHTS: [AiWeights, AiWeights] = [
  { ...DEFAULT_WEIGHTS },
  { ...DEFAULT_WEIGHTS },
];

export function setTeamWeights(team: Team, w: Partial<AiWeights>): void {
  Object.assign(TEAM_WEIGHTS[team], w);
}

export function resetWeights(): void {
  Object.assign(TEAM_WEIGHTS[0], DEFAULT_WEIGHTS);
  Object.assign(TEAM_WEIGHTS[1], DEFAULT_WEIGHTS);
}
