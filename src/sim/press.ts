/**
 * プレス・カバーの共有ジオメトリ(Task AF)。
 *
 * このモジュールは ai.ts(decideDefense)と predict.ts(守備反応ミラー)が共有する唯一の実装
 * (line.ts / ballTimeToCover / loftedLaneRiskFromPoints と同じ「構築による一致」パターン)。
 * プレスの式を呼び出し側にコピーしてはならない(ミラー invariant)。
 *
 * 二人組のプレス(Task AF):
 *  1. 1人目(プレッサー)はジョッキー: 保持者の ~1.5-2m 手前・中央側に立ち、外(タッチライン)へ
 *     追い出す。タックルレンジへのコミット(リード点へ詰め切る)は「カバーが近くにいる」ときだけ。
 *  2. 2人目はカバー点へ: 保持者の「最も可能性の高い逃げレーン」上、4-6m ゴール側
 *     (旧実装の owner.pos 尾行 = 1人目と同一点へ2人が重なる = レーンが開く、を廃止)。
 *
 * pressIntensity レバーはこのジオメトリの連続パラメータ(不感帯なし・閾値なし):
 *  - コミット許可のカバー半径(強いほど薄いカバーでも突っ込む)
 *  - 2人目を引き抜く距離(強いほど遠くからでも2人目を投入=トラップの積極性)
 *  - ジョッキーの間合いとカバー点の深さ(強いほど密着・タイト)
 * 旧実装の <0.3 コンテイン / >0.6 挟み込みのハード閾値は全て置換(Task AJ の不感帯の解消)。
 */
import { PITCH_LENGTH, PITCH_WIDTH, PRESS_LEAD_TIME, RECOVER_GOALSIDE_DIST } from './constants';
import type { Player } from './types';
import { add, dist, norm, scale, sub, vec, type Vec } from './vec';

const HALF_L = PITCH_LENGTH / 2;
const HALF_W = PITCH_WIDTH / 2;

function clampToPitch(v: Vec, margin = 1): Vec {
  return vec(
    Math.max(-HALF_L + margin, Math.min(HALF_L - margin, v.x)),
    Math.max(-HALF_W + margin, Math.min(HALF_W - margin, v.y)),
  );
}

// ── 較正値(掃引用 setter 付き。line.ts と同型の in-process 上書き) ──────────
/** ジョッキーの間合い(m): standOff = BASE − PRESS×pressIntensity(強いほど密着)。
 * 既定(0.5)で仕様の ~2m。press=0 は 3m のコンテイン(タックルレンジ 2.2m の外=本当に構えて
 * 待つ)、press=1 は 1m の密着 — タックル機構(レンジ 2.2m)への滞在時間がレバーで連続に変わる。 */
export let JOCKEY_STANDOFF_BASE = 3.0;
export let JOCKEY_STANDOFF_PRESS = 2.0;
/** ジョッキーの中央側シフト(m)。プレッサーが中央側から寄せる=保持者の開くレーンは外側になる */
export let JOCKEY_STEER_SHIFT = 1.2;
/** コミット許可のカバー半径(m): coverDist = BASE + GAIN×pressIntensity。
 * 既定(0.5)で仕様の ~8m。press=0 はほぼコンテイン、press=1 はほぼ常時コミット。 */
export let PRESS_COVER_BASE = 4;
export let PRESS_COVER_GAIN = 8;
/** 2人目のプレッサーを投入する距離(m): range = BASE + GAIN×pressIntensity。
 * 旧 >0.6 閾値の置換 = レバーの主要な連続コントロール(PPDA の勾配源)。 */
export let SECOND_PRESS_BASE = 6;
export let SECOND_PRESS_GAIN = 16;
/** 2人目のカバー点の深さ(m): depth = BASE − PRESS×pressIntensity(仕様の 4-6m ゴール側) */
export let COVER_DEPTH_BASE = 6;
export let COVER_DEPTH_PRESS = 2;
/** ビルドアップ時に前線(FW)がプレッサーとして出て行く距離(m): range = BASE + GAIN×press。
 * 既定(0.5)で従来の 18m と一致(既定経済は不変)。press=0 の FW は構えて眺め(6m)、press=1 は
 * 30m 先の CB まで狩りに出る — PPDA(相手のビルドアップのパス数)を握る主要な連続軸。 */
export let FW_PRESS_BASE = 6;
export let FW_PRESS_GAIN = 24;
/** 守備側の「飛行中のボールへの即時反応」半径(m): radius = BASE + GAIN×press。
 * 既定(0.5)で従来の BALL_FLIGHT_REACH_RADIUS(10m)と一致(既定経済は不変)。
 * press=0 の守備は持ち場を保って飛行ボールに飛びつかない(3m)、press=1 は 17m 先から
 * 全てのパスを狩りに出る(ゲーゲンプレスの即時奪回)。インターセプト経済=PPDA の主要軸。
 * 自チームのパス(受け手のラン)には適用しない(world.ts 側でゲート)。 */
export let FLIGHT_REACH_BASE = 3;
export let FLIGHT_REACH_GAIN = 14;
export function setPressGeometry(v: Partial<{
  jockeyStandoffBase: number;
  jockeyStandoffPress: number;
  jockeySteerShift: number;
  pressCoverBase: number;
  pressCoverGain: number;
  secondPressBase: number;
  secondPressGain: number;
  coverDepthBase: number;
  coverDepthPress: number;
  fwPressBase: number;
  fwPressGain: number;
  flightReachBase: number;
  flightReachGain: number;
  tacklePressBase: number;
  tacklePressGain: number;
  pressAggroBase: number;
  pressAggroGain: number;
}>): void {
  if (v.jockeyStandoffBase !== undefined) JOCKEY_STANDOFF_BASE = v.jockeyStandoffBase;
  if (v.jockeyStandoffPress !== undefined) JOCKEY_STANDOFF_PRESS = v.jockeyStandoffPress;
  if (v.jockeySteerShift !== undefined) JOCKEY_STEER_SHIFT = v.jockeySteerShift;
  if (v.pressCoverBase !== undefined) PRESS_COVER_BASE = v.pressCoverBase;
  if (v.pressCoverGain !== undefined) PRESS_COVER_GAIN = v.pressCoverGain;
  if (v.secondPressBase !== undefined) SECOND_PRESS_BASE = v.secondPressBase;
  if (v.secondPressGain !== undefined) SECOND_PRESS_GAIN = v.secondPressGain;
  if (v.coverDepthBase !== undefined) COVER_DEPTH_BASE = v.coverDepthBase;
  if (v.coverDepthPress !== undefined) COVER_DEPTH_PRESS = v.coverDepthPress;
  if (v.fwPressBase !== undefined) FW_PRESS_BASE = v.fwPressBase;
  if (v.fwPressGain !== undefined) FW_PRESS_GAIN = v.fwPressGain;
  if (v.flightReachBase !== undefined) FLIGHT_REACH_BASE = v.flightReachBase;
  if (v.flightReachGain !== undefined) FLIGHT_REACH_GAIN = v.flightReachGain;
  if (v.tacklePressBase !== undefined) TACKLE_PRESS_BASE = v.tacklePressBase;
  if (v.tacklePressGain !== undefined) TACKLE_PRESS_GAIN = v.tacklePressGain;
  if (v.pressAggroBase !== undefined) PRESS_AGGRO_BASE = v.pressAggroBase;
  if (v.pressAggroGain !== undefined) PRESS_AGGRO_GAIN = v.pressAggroGain;
}

/** タックル踏み込み率(/s)に掛けるプレス係数。既定 0.5 で 1.0(従来と一致)。
 * world.ts の resolveTackles(物理)が使う — predict はタックルを模さないのでミラー対象外
 * (Task Y と同じ前例)。 */
export function tacklePressScale(pressIntensity: number): number {
  return TACKLE_PRESS_BASE + TACKLE_PRESS_GAIN * pressIntensity;
}

/** タックル踏み込み率のプレス係数: scale = BASE + GAIN×press。既定(0.5)で 1.0(従来の
 * TACKLE_TRIGGER 8/s と一致 = 既定経済は不変)。press=0 は 0.2×(構えて遅らせ、足を出さない)、
 * press=1 は 1.8×(即時奪回の圧)。奪取(steals)= PPDA 分母のもう一つの主要軸。
 * 成功率・結果ジオメトリ(Task Y)は不変 — 変わるのは踏み込みの頻度だけ。 */
export let TACKLE_PRESS_BASE = 0.2;
export let TACKLE_PRESS_GAIN = 1.6;

/** 守備の「コース狩り」係数: BASE + GAIN×press。既定(0.5)で 1.0(従来と一致)。
 * マークのボール寄りシェード(markTargetPoint の shade)と、空きゾーン守備者のコース封鎖
 * (cutLane)の受諾半径の両方に掛かる。press=0 は純粋にゴール側で構えてコースを狩らない
 * (0.4×)、press=1 はコース上に強く出る(1.6×)。ints=PPDA 分母の第3軸。 */
export let PRESS_AGGRO_BASE = 0.4;
export let PRESS_AGGRO_GAIN = 1.2;

/** コース狩り係数(マークシェードと cutLane 受諾半径に掛ける)。既定 0.5 で 1.0。 */
export function pressAggroScale(pressIntensity: number): number {
  return PRESS_AGGRO_BASE + PRESS_AGGRO_GAIN * pressIntensity;
}

/**
 * 守備側の飛行ボール即時反応半径(m)。連続関数(不感帯なし)。既定 0.5 で従来の 10m と一致。
 * 現実(world.ts のエフォート昇格)と価格付け(laneRiskFromPoints のスプリント・カーブアウト、
 * ai.ts のパス採点 + predict.ts の先読みの両方)が同じ値を共有する(ミラー invariant)。
 */
export function flightReachRadius(pressIntensity: number): number {
  return FLIGHT_REACH_BASE + FLIGHT_REACH_GAIN * pressIntensity;
}

/**
 * ビルドアップ時に最寄りのFWが前線プレッサーとして出て行く距離(m)。連続関数(不感帯なし)。
 * 旧実装の固定 18m の置換(既定 0.5 で 18m と一致 = 既定経済は不変)。
 */
export function fwPressRange(pressIntensity: number): number {
  return FW_PRESS_BASE + FW_PRESS_GAIN * pressIntensity;
}

/**
 * プレスの目標点(Task W)。保持者の現在位置ではなく速度ぶんリードした迎撃点を狙う。
 * (旧 ai.ts/predict.ts の手動ミラー2実装を Task AF で共有化)
 */
export function pressTarget(owner: Player): Vec {
  return add(owner.pos, scale(owner.vel, PRESS_LEAD_TIME));
}

/**
 * 抜かれたプレッサーの回復ラン目標(Task W)。保持者→自ゴール線上、保持者から
 * RECOVER_GOALSIDE_DIST ゴール側の点へ全力で戻る。(Task AF で共有化)
 */
export function recoverTarget(owner: Player, ownGoal: Vec): Vec {
  return clampToPitch(add(owner.pos, scale(norm(sub(ownGoal, owner.pos)), RECOVER_GOALSIDE_DIST)), 1);
}

/**
 * コミット許可のカバー判定(Task AF)。プレッサー以外の味方守備者(GK除く=呼び出し側のリスト)が
 * 保持者から coverDist 以内、かつ「置き去りではない」(保持者より 2m 超は攻撃側に取り残されて
 * いない)位置にいれば true = プレッサーはタックルレンジへコミットしてよい。
 * oppSign = 攻撃側の攻撃方向(守備側の自ゴールは +oppSign 側)。位置の純関数(履歴なし)なので
 * decideDefense と predict の先読みが同じtickで必ず同じ判定を見る。
 */
export function hasPressCover(
  defenders: readonly Player[],
  presser: Player,
  owner: Player,
  oppSign: number,
  pressIntensity: number,
): boolean {
  const coverDist = PRESS_COVER_BASE + PRESS_COVER_GAIN * pressIntensity;
  for (const d of defenders) {
    if (d === presser) continue;
    if (oppSign * (d.pos.x - owner.pos.x) < -2) continue; // 攻撃側に置き去りの選手はカバーでない
    if (dist(d.pos, owner.pos) < coverDist) return true;
  }
  return false;
}

/**
 * ジョッキー(ステア)点(Task AF)。カバーが無いプレッサーはリード点へ突っ込まず、保持者の
 * standOff 手前(自ゴール側)・中央側に JOCKEY_STEER_SHIFT ずれた点で構える — 中央のレーンを
 * 身体で塞ぎ、保持者を外(タッチライン)へ追い出す。Math.sign(owner.pos.y) はy=0で0(左右対称、
 * Task AR のミラー対称性を保つ)。
 */
export function jockeyTarget(owner: Player, ownGoal: Vec, pressIntensity: number): Vec {
  const lead = pressTarget(owner);
  const standOff = JOCKEY_STANDOFF_BASE - JOCKEY_STANDOFF_PRESS * pressIntensity;
  const base = add(lead, scale(norm(sub(ownGoal, lead)), standOff));
  base.y -= Math.sign(owner.pos.y) * JOCKEY_STEER_SHIFT; // 中央側へ半身ずらす → 外へ誘導
  return clampToPitch(base, 1);
}

/**
 * 2人目のプレッサーを投入するボールからの距離(m)。連続関数(不感帯なし)。
 * 旧実装のハード閾値(pressIntensity > 0.6 のときだけ・距離無制限)の置換。
 */
export function secondPressRange(pressIntensity: number): number {
  return SECOND_PRESS_BASE + SECOND_PRESS_GAIN * pressIntensity;
}

/**
 * 2人目のカバー点(Task AF): 保持者の「最も可能性の高い逃げレーン」上、4-6m ゴール側。
 * レーン方向 = ゴール側(+oppSign x) + ジョッキーが誘導する外側(タッチライン側) +
 * 保持者の実横速度(逃げの先取り)。旧実装(owner.pos = 1人目と同一点)の置換。
 * y=0 の保持者は steer 成分が0で左右対称(Task AR)。
 */
export function pressCoverTarget(owner: Player, oppSign: number, pressIntensity: number): Vec {
  const steerY = Math.sign(owner.pos.y); // ジョッキーが追い出すタッチライン側
  const lane = norm(vec(oppSign * 2, steerY * 1 + owner.vel.y * 0.25));
  const depth = COVER_DEPTH_BASE - COVER_DEPTH_PRESS * pressIntensity;
  return clampToPitch(add(owner.pos, scale(lane, depth)), 1);
}
