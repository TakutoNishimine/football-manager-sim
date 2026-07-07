import type { Vec } from './vec';
import type { FormationName } from './formation';

export type Team = 0 | 1; // 0 = 青(右に攻める), 1 = 赤(左に攻める)

/** ユーザーがドラッグで出す指示 */
export type Instruction =
  | { kind: 'move'; target: Vec }
  | { kind: 'pass'; receiverId: number };

/** 選手の動きの「意味」。攻撃系はAIが先読みで選び、数秒間やり切る */
export type IntentKind =
  | 'hold' // ポジション維持
  | 'support' // 保持者に近づいてパスコースを作る
  | 'runBehind' // 最終ラインの裏へ抜ける
  | 'lateRun' // 中盤からボックスへのレイトラン(攻撃参加)
  | 'giveAndGo' // ワンツー: パスを出した直後に守備者の裏へ走り、リターンを受ける
  | 'overlap' // ワイドの保持者の外側を追い越して前進
  | 'underlap' // ワイドの保持者の内側ハーフスペースのポケットへ
  | 'decoy' // 守備者を引っ張り出して味方のスペースを作る囮
  | 'press' // ボール保持者へプレス
  | 'mark' // ゾーン内の相手をゴール側でマーク
  | 'cutLane' // パスコース上に立って封鎖
  | 'cover' // 持ち場(ゾーン)を守る
  | 'recover' // 抜かれたプレッサーがゴール側へ戻る回復ラン(Task W)
  | 'carry' // ボールを運ぶ
  | 'chase' // フリーボールの回収
  | 'keeper'; // GK: ボールとゴールを結ぶ線上で構える

/** 守備の役割コミット(Task W: ヒステリシス・スティッキーマーク・先読みミラー用) */
export type DefenseRole = 'press' | 'mark' | 'cover' | 'recover';

export interface Intent {
  kind: IntentKind;
  target: Vec;
  /** world.clockがこの時刻になるまで持続(やり切る) */
  until: number;
  /** 設定時のボール保持チーム。攻守が切り替わったら失効 */
  possTeam: Team | null;
}

export interface Player {
  id: number;
  team: Team;
  number: number;
  /** フォーメーション内の位置(baseAnchorsのindex)。0がDFライン左から */
  role: number;
  pos: Vec;
  vel: Vec;
  /** AIまたはユーザー指示が決めた現在の移動先 */
  moveTarget: Vec;
  instruction: Instruction | null;
  intent: Intent | null;
  decisionTimer: number;
  kickCooldown: number;
  /** このボールを直前にパスしてきた味方のid(アンチピンポン用)。受け取った瞬間に設定 */
  receivedFrom: number | null;
  /** receivedFrom を設定したときの試合時刻。古くなったら無効化する */
  receivedAt: number;
  // ── 守備コミット状態(Task W) ─────────────────────────────────────────
  /** 現在コミットしている守備役割。攻守が切り替わると無効化される */
  defenseRole: DefenseRole | null;
  /** スティッキーマーク: マーク対象の相手id(role != GKのフィールドプレーヤー) */
  markTargetId: number | null;
  /** 現在のマーク/プレス割り当てを設定した試合時刻(≥1.5s の持続判定に使う) */
  markSince: number;
  /** 守備の再判断カデンス(0.15〜0.25s、id由来のジッター)のカウントダウン */
  defenseTimer: number;
}

export interface Ball {
  pos: Vec;
  vel: Vec;
  ownerId: number | null;
  lastTouchTeam: Team;
  /** 直前にパス/クリアを蹴った選手のid。受け手の receivedFrom 設定に使う(アンチピンポン) */
  lastPasserId: number | null;
}

export interface TeamStats {
  shots: number;
  passes: number;
  steals: number;
  interceptions: number;
}

/** チーム戦術パラメータ。攻守の振る舞いを連続値で制御する */
export interface TeamTactics {
  manMark: number; // 0=完全ゾーン 〜 1=完全マンマーク
  pressIntensity: number; // 0=構えて待つ 〜 1=即時奪回(2人目もプレス)
  lineHeight: number; // -1=深く構える 〜 +1=ハイライン
  wideRuns: number; // 0=ワイドのランなし 〜 1=積極的にオーバーラップ/アンダーラップ
}

export interface World {
  players: Player[];
  ball: Ball;
  score: [number, number];
  clock: number; // 試合経過時間(シミュレーション秒)
  /** ゴール直後などの演出用メッセージ */
  message: { text: string; until: number } | null;
  stats: [TeamStats, TeamStats];
  /** パス中(キック後、まだ誰も触っていない)かどうか。インターセプト判定用 */
  ballInFlightFrom: Team | null;
  formations: [FormationName, FormationName];
  tactics: [TeamTactics, TeamTactics];
  /** 直前フレームのボール保持チーム。攻守の切り替わりで守備コミット状態を無効化する(Task W) */
  lastPossTeam: Team | null;
  /** 各守備チームがコミット中のプレッサーのid(ヒステリシス & predict ミラー用, Task W)。index=守備チーム */
  presserId: [number | null, number | null];
  /** 初期シード(表示・デバッグ・レポート用に保持) */
  seed: number;
  /** PRNGの現在の状態(mulberry32) */
  rngState: number;
  /**
   * シュートが飛び始めた試合時刻(Task Z: GK反応ウィンドウ用)。executeShot で設定し、
   * シュートが止まる/収まると null に戻す。GKはこの時刻から GK_REACT_TIME のあいだ構えたまま
   * コースを変えられず、その後だけ予測クロス地点へ寄せる(「GKは限定的」の再機構化)。
   */
  shotInFlightSince: number | null;
}
