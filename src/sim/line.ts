/**
 * 守備ラインの共有コントローラ + オフサイド判定(Task AD)。
 *
 * このモジュールは ai.ts / predict.ts / world.ts / formation.ts が共有する唯一の実装
 * (「構築による一致」— ballTimeToCover / loftedLaneRiskFromPoints と同じパターン)。
 * ラインやオフサイドの式を呼び出し側にコピーしてはならない(ミラー invariant)。
 *
 * 1. defensiveLineX: チームごとの守備ライン基準x(コントローラ)。DFアンカー・中盤圧縮・
 *    FWキャップ(formation.ts dynamicAnchor)とマーク深度クランプ(ai.ts/predict.ts)の
 *    共通の深さ基準。ゲーム状態の純関数(履歴なし)なので、decideDefense と predict の
 *    先読みが同じtickで必ず同じ値を見る。
 * 2. isOffsidePosition: オフサイドポジション判定(後方から2人目の守備者・ボール・敵陣)。
 *    ai.ts のパス採点(ソフトルール)、predict.ts の受け値、world.ts のリリース時
 *    スナップショット(実際の笛)が全て同じ述語を使う。
 *
 * 注意(循環import): formation.ts ⇄ line.ts は関数宣言のみの参照なので ESM 的に安全。
 * ここのトップレベルで formation.ts の値を評価しないこと。
 */
import { MARK_BALL_SHADE, PITCH_LENGTH } from './constants';
import { baseAnchors, GK_ROLE, type FormationName } from './formation';
import type { Team, World } from './types';
import { add, dist, norm, scale, sub, type Vec } from './vec';

const HALF_L = PITCH_LENGTH / 2;

// ── ラインコントローラの較正値 ─────────────────────────────────────────────
/** DFラインの基本撤退量(m)。Task AC の -7 を継承(ブロック全体の基準深さ) */
export const DF_RETREAT = -7;
/** ボールx追従の係数(dynamicAnchor の全体スライドと同値) */
const LINE_SLIDE = 0.25;
/** lineHeight スライダーのゲイン(m)。従来のアンカー式と同値 = レバーの生存・単調性を保つ */
const LINE_HEIGHT_GAIN = 7;
/** 保持者が無圧で前を向いているときのライン後退(ドロップ)の最大量(m)。
 * Task AT 掃引用 setter あり(ブロックの前後スプレッド=block height の調律)。 */
export let LINE_DROP_MAX = 6;
export function setLineDropMax(v: number): void {
  LINE_DROP_MAX = v;
}
/** 保持者が圧を受けている/ボールが後方へ動いているときの押し上げ(ステップ)の最大量(m)。
 * Task AT 掃引用 setter あり。 */
export let LINE_STEP_MAX = 5;
export function setLineStepMax(v: number): void {
  LINE_STEP_MAX = v;
}
/** 保持者への圧力: 最寄りの自チーム守備者がこの距離以下なら「圧を受けている」(=1) */
const LINE_PRESSED_DIST = 3;
/** 最寄りの自チーム守備者がこの距離以上なら「完全に無圧」(=1) */
const LINE_FREE_DIST = 9;
/** ラインは自ゴールからこの深さより手前(浅く)には下がらない(GKと重ならない) */
const LINE_MIN_DEPTH = 8;
/** runBehind のブレイク目標: オフサイドラインのこの距離裏(m)。旧 lineX+6 の深さを継承。
 * 掃引用 setter あり(浅いほど受け点への守備の寄せが速く、スルーパスの決定力が下がる)。 */
// Task AD 較正 4(旧6): 浅いブレイクほど受け点への守備の寄せが速く、スルーパスの決定力が
// 下がり(40シード: −0.15 goals, run 29047197249)、際どいレースが増えてオフサイドも増える。
export let RUN_BREAK_DEPTH = 4;
export function setRunBreakDepth(v: number): void {
  RUN_BREAK_DEPTH = v;
}
/**
 * AI側(パス採点・先読み)のオフサイド許容マージン(m)。攻撃側は「ラインとほぼレベル」を
 * オンサイドとみなしてプレーする(肩勝負)が、笛(world.ts のスナップショット)は厳密な
 * ジオメトリで判定する。この非対称が現実のオフサイド(際どいランの誤差)を生む —
 * 両者を同一にすると AI は反則になるパスを構造的に一切選ばず、オフサイドが0件になる。
 */
export let OFFSIDE_SOFT_MARGIN = 1.2;
/** 掃引用の in-process 上書き(SHOT_ERR_SCALE と同型。env 上書きは存在しない) */
export function setOffsideSoftMargin(v: number): void {
  OFFSIDE_SOFT_MARGIN = v;
}
/**
 * runBehind のホールド狙い(m)。正=ラインの手前(オンサイド側)、負=ラインの先(肩勝負で
 * ギャンブル)。ランナーは clampOnsideX でこの狙いに毎tick追従するが、身体の慣性と
 * ラインの呼吸(ドロップ/ステップ)で実位置は散る — その散りが「際どいオフサイド」になる。
 */
export let RUN_HOLD_MARGIN = -0.4;
export function setRunHoldMargin(v: number): void {
  RUN_HOLD_MARGIN = v;
}
/**
 * runBehind ランナーへのスルーパスの laneRisk ハードゲート(通常パスは 0.7)。
 * laneRisk は受け手のヘッドスタート(リリースでブレイクするランナーがラインの守備者と
 * 競うレース)を織り込まないため、ライン裏へのボールは構造的に高リスク評価になる —
 * 0.7 のままだとスルーパスという動詞が消え、緩めるほど得点が過熱する(goals の主要ダイヤル)。
 */
export let RUN_THROUGH_GATE = 0.8;
export function setRunThroughGate(v: number): void {
  RUN_THROUGH_GATE = v;
}
/**
 * オフサイドの「プレー関与」半径(m)。リリース時にフラグされた選手が、飛行中のボールに
 * この距離まで寄った(=ボールにチャレンジした)瞬間に笛を吹く。実際の副審はタッチを
 * 待たず「明らかにそのボールを追っている」時点で旗を上げる — タッチのみを待つと、
 * 守備者が先に触れて笛が消えるケースが大半になり、オフサイドが事実上発生しなくなる。
 */
export const OFFSIDE_ENGAGE_RADIUS = 2.5;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** フォーメーションのDFライン正規化深さ(GKを除く最小 anchor x)。純関数なのでキャッシュ */
const dfAXCache = new Map<FormationName, number>();
function dfLineAnchorX(name: FormationName): number {
  const cached = dfAXCache.get(name);
  if (cached !== undefined) return cached;
  const anchors = baseAnchors(name);
  let dfAX = Infinity;
  for (let i = 0; i < anchors.length; i++) {
    if (i !== GK_ROLE && anchors[i].x < dfAX) dfAX = anchors[i].x;
  }
  dfAXCache.set(name, dfAX);
  return dfAX;
}

/**
 * チーム `team` の守備ライン基準x(ワールド座標)。毎tickゲーム状態から計算する:
 *  - 基本: DFアンカーの撤退位置(Task AC と同じ式 = バイアス0なら従来と一致)
 *  - ドロップ: 保持者(相手)が無圧で前を向いている → 最大 LINE_DROP_MAX 後退(裏のスペースを守る)
 *  - ステップ: 保持者が圧を受けている / ボールが後方へ動いている(バックパス・クリア) →
 *    最大 LINE_STEP_MAX 前進(ブロックを圧縮し裏のリスクを取る)
 * lineHeight スライダーは基本項に線形に入る(LIVE・単調)。
 * ゲーム状態の純関数・O(players)。predict の先読みと decideDefense が同じ値を共有する。
 */
export function defensiveLineX(world: World, team: Team): number {
  const sign = team === 0 ? 1 : -1; // このチームの攻撃方向(自ゴールは -sign*HALF_L)
  const dfAX = dfLineAnchorX(world.formations[team]);
  let x =
    sign * dfAX * HALF_L * 0.78 +
    world.ball.pos.x * LINE_SLIDE +
    sign * world.tactics[team].lineHeight * LINE_HEIGHT_GAIN +
    sign * DF_RETREAT;

  // ── ゲーム状態バイアス(攻撃方向のメートル。正=押し上げ、負=ドロップ) ──
  const ball = world.ball;
  const owner = ball.ownerId === null ? null : world.players[ball.ownerId];
  let bias = 0;
  if (owner !== null && owner.team !== team) {
    // 保持者への圧力: 自チームの最寄りフィールドプレーヤーの距離
    let dMin = Infinity;
    for (const q of world.players) {
      if (q.team !== team || q.role === GK_ROLE) continue;
      const d = dist(q.pos, owner.pos);
      if (d < dMin) dMin = d;
    }
    const unpressured = clamp01((dMin - LINE_PRESSED_DIST) / (LINE_FREE_DIST - LINE_PRESSED_DIST));
    // 前向き度: 保持者の速度の自ゴール方向成分(静止=0.5、前進2m/s以上≈1、後退≈0)
    const facingFwd = clamp01(0.5 + (-sign * owner.vel.x) / 4);
    // ボールの後退度: ボールが自ゴールから遠ざかる速度(バックパス/クリアの飛行も拾う)
    const retreating = clamp01((sign * ball.vel.x) / 6);
    bias -= LINE_DROP_MAX * unpressured * facingFwd;
    bias += LINE_STEP_MAX * Math.max(1 - unpressured, retreating);
  } else if (owner === null) {
    // フリーボール/飛行中: ボールが自ゴールから遠ざかっていれば押し上げ(バックパス・クリア)
    const retreating = clamp01((sign * ball.vel.x) / 6);
    bias += LINE_STEP_MAX * retreating;
  }
  x += sign * bias;

  // 深さクランプ: 自ゴールから LINE_MIN_DEPTH 〜 ハーフライン
  const depth = Math.max(LINE_MIN_DEPTH, Math.min(HALF_L, sign * x + HALF_L));
  return sign * (depth - HALF_L);
}

/**
 * マーク目標点(ゴール側 + ボール寄りシェード + ライン深度クランプ)。
 * ai.ts(decideDefense)と predict.ts(守備反応ミラー)が共有する唯一の実装(Task AD で
 * 旧・手動ミラー2実装を統合)。lineX = defensiveLineX(world, 守備チーム)、
 * defSign = 守備チームの攻撃方向。マーカーはラインより深く(自ゴール側に)は下がらない —
 * ライン裏に立つ相手には「ライン上でレーンに立つ」ことで応じ、背走はライン全体で行う。
 */
export function markTargetPoint(
  markPos: Vec,
  ownGoal: Vec,
  ballPos: Vec,
  markOffset: number,
  lineX: number,
  defSign: number,
): Vec {
  const goalSide = add(markPos, scale(norm(sub(ownGoal, markPos)), markOffset));
  const shade = scale(norm(sub(ballPos, markPos)), MARK_BALL_SHADE);
  const t = add(goalSide, shade);
  // 厳密なライン・クランプ: マーカーはラインより深く(自ゴール側に)は下がらない。
  // 「解除」の2案は両方 40シードで REJECTED(strict 3.25 → 全体解除 3.70, run 28919523601 /
  // 破られたマーカー個人のみ解除でも 3.70, run 28919983285): オフサイドラインは実際の
  // 選手位置から導かれるため、誰か1人でも深く下がればラインそのものが下がり、合法な
  // ブレイクの開始点が深くなって過熱する。ライン裏のレースはチェイス・プレッサー
  // (interceptInfo の最速到達者)と GK スイープが担う — マーカーはラインを保つ。
  t.x = defSign * Math.max(defSign * t.x, defSign * lineX);
  return t;
}

/**
 * オフサイドラインのx(ワールド座標): 守備チーム(GK含む全員)の「後方から2人目」の深さ。
 * 実際の選手位置から導く(コントローラの目標値ではない)— ランナーが見るのはこのライン。
 */
export function offsideLineX(world: World, defendingTeam: Team): number {
  const defSign = defendingTeam === 0 ? 1 : -1; // 守備チームの攻撃方向(自ゴールは -defSign 側)
  // 自ゴール方向の深さ deepest = 最小の defSign*x。1位と2位を1パスで取る
  let d1 = Infinity; // 最深
  let d2 = Infinity; // 2番目
  for (const q of world.players) {
    if (q.team !== defendingTeam) continue;
    const depth = defSign * q.pos.x;
    if (depth < d1) {
      d2 = d1;
      d1 = depth;
    } else if (depth < d2) {
      d2 = depth;
    }
  }
  return defSign * d2;
}

/**
 * オフサイドポジション判定(共有述語)。攻撃チーム atkTeam の選手が位置 pos にいるとき、
 * (a) 敵陣にいて (b) ボールより前(相手ゴール側)で (c) 後方から2人目の守備者より
 * margin 以上前 なら true。「ラインと同レベルはオンサイド」(厳密な超過のみオフサイド)。
 * margin = 0(既定)が笛のジオメトリ(world.ts のリリース時スナップショット)。
 * ai.ts のパス採点と predict.ts の受け値は OFFSIDE_SOFT_MARGIN で緩く判定する
 * (際どいレベル勝負はプレーする)— この差が現実的なオフサイド発生源になる。
 */
export function isOffsidePosition(world: World, atkTeam: Team, pos: Vec, margin = 0): boolean {
  const sign = atkTeam === 0 ? 1 : -1; // 攻撃方向
  if (sign * pos.x <= 0) return false; // 自陣ではオフサイドにならない
  if (sign * pos.x <= sign * world.ball.pos.x) return false; // ボールより後ろはオンサイド
  const defTeam = (1 - atkTeam) as Team;
  const lineX = offsideLineX(world, defTeam);
  return sign * pos.x > sign * lineX + margin; // ラインを margin 超えていたらオフサイド
}

/**
 * runBehind のオンサイド・ホールド点(Task AD): 目標 target の深さをオフサイドラインの
 * 手前(margin m オンサイド)とボール位置のいずれか深い方までにクランプする。
 * ランナーはリリース(自チームのパス飛行)までここで待ち、リリースで target へブレイクする。
 * margin は小さく保つ(肩勝負): ラインの押し上げに身体の慣性が追いつかない瞬間が
 * 「際どいオフサイド」の現実的な発生源になる(笛は厳密ジオメトリ、AIは SOFT_MARGIN)。
 */
export function clampOnsideX(
  world: World,
  atkTeam: Team,
  targetX: number,
  margin = RUN_HOLD_MARGIN,
): number {
  const sign = atkTeam === 0 ? 1 : -1;
  const defTeam = (1 - atkTeam) as Team;
  const lineDepth = sign * offsideLineX(world, defTeam) - margin;
  // ボールより後ろは常にオンサイド: ライン超えでもボール(保持者)と同深度までは立てる
  const ballDepth = sign * world.ball.pos.x;
  const maxDepth = Math.max(lineDepth, ballDepth);
  return sign * Math.min(sign * targetX, maxDepth);
}
