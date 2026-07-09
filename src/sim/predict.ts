import {
  BALL_HEAD_HEIGHT,
  COMPACT_BLOCK_RANGE,
  DEFENSE_ZONE_RADIUS,
  GRAVITY,
  PITCH_LENGTH,
  PITCH_WIDTH,
  PLAYER_MAX_SPEED,
  PRESS_LEAD_TIME,
  RECOVER_GOALSIDE_DIST,
} from './constants';
import { classifyRole, dynamicAnchor, GK_ROLE } from './formation';
import { defensiveLineX, isOffsidePosition, markTargetPoint, OFFSIDE_SOFT_MARGIN } from './line';
import { BALL_FLIGHT_REACH_RADIUS, effortSpeed, laneEngageEffort, laneEngages } from './pace';
import type { IntentKind, Player, World } from './types';
import { add, dist, norm, scale, sub, vec, type Vec } from './vec';
import { ballOwner, ballTimeToCover, goalCenter, ownGoalCenter } from './world';

const HALF_L = PITCH_LENGTH / 2;
const HALF_W = PITCH_WIDTH / 2;

function clampToPitch(v: Vec, margin = 2): Vec {
  return vec(
    Math.max(-HALF_L + margin, Math.min(HALF_L - margin, v.x)),
    Math.max(-HALF_W + margin, Math.min(HALF_W - margin, v.y)),
  );
}

/**
 * ai.ts の coverShadowTarget の完全なミラー(invariant: 式を一字一句揃える)。
 * ビルドアップ時の前線プレスの目標点。保持者に圧力をかけつつ最深の出口へのコースを切る。
 * owner = 保持者, defendersTeam = 守備側, oppSign = 攻撃側の攻撃方向。
 */
function coverShadowTarget(
  world: World,
  owner: Player,
  defendersTeam: number,
  oppSign: number,
): Vec {
  const outlets = world.players.filter(
    (q) =>
      q.team !== defendersTeam &&
      q.role !== GK_ROLE &&
      q.id !== owner.id &&
      oppSign * (q.pos.x - owner.pos.x) < -2,
  );
  if (!outlets.length) return { ...owner.pos };
  const outlet = outlets.reduce((a, b) =>
    oppSign * a.pos.x < oppSign * b.pos.x ? a : b,
  );
  const dir = norm(sub(outlet.pos, owner.pos));
  return clampToPitch(add(owner.pos, scale(dir, 0.9)), 1);
}

/**
 * ai.ts の compactBlockTarget の完全なミラー(invariant: 式を一字一句揃える)。
 * 保持者が自ゴールを脅かすとき、空きゾーン守備者をシュートコース(危険地帯)へ寄せる目標点。
 */
function compactBlockTarget(anchor: Vec, ballPos: Vec, ownGoal: Vec): Vec {
  const depthFromGoal = Math.max(7, Math.min(14, dist(ballPos, ownGoal) - 6));
  const laneDir = norm(sub(ballPos, ownGoal));
  const lanePoint = add(ownGoal, scale(laneDir, depthFromGoal));
  const y = lanePoint.y + Math.max(-8, Math.min(8, anchor.y - lanePoint.y));
  return clampToPitch(vec(lanePoint.x, y), 1);
}

/** ai.ts の pressTarget のミラー(invariant)。保持者を速度ぶんリードした迎撃点。 */
function pressTarget(owner: Player): Vec {
  return add(owner.pos, scale(owner.vel, PRESS_LEAD_TIME));
}
/** ai.ts の recoverTarget のミラー(invariant)。抜かれたプレッサーがゴール側へ戻る点。 */
function recoverTarget(owner: Player, ownGoal: Vec): Vec {
  return clampToPitch(add(owner.pos, scale(norm(sub(ownGoal, owner.pos)), RECOVER_GOALSIDE_DIST)), 1);
}
// マーク目標点は line.ts の markTargetPoint を共有(Task AD)。旧・手動ミラーは廃止 —
// decideDefense と同じ実装を import するので、式がズレることは構造的にない。

/** 先読みの時間幅。「この秒数走ったら世界はどうなるか」を評価する */
const REACT_TIME = 1.6;
/** 守備の反応は攻撃より一拍遅れる */
const REACT_FACTOR = 0.8;

export const DEFENDER_REACTION = 0.35; // パスを見てから動き出すまでの反応時間(Task AAで共有: arrivalTime の反応項)
const DEFENDER_REACH = 0.7; // 足を伸ばして触れる距離

/**
 * パスコース危険度の守備者。pos=位置, speed=その意図での基本エフォート速度,
 * engages=ボールが飛べばスプリントで詰めに来るか(hold/cover は false)。
 * Task W: 以前は全守備者を一律 PLAYER_MAX_SPEED で見積もっていたため、実際にはジョグ/歩きで
 * コースに関与しない守備者まで「間に合う」と評価し、パス成功率が96.9%まで膨らんでいた。
 */
export interface LaneDefender {
  pos: Vec;
  speed: number;
  engages: boolean;
}

/**
 * パスコースの危険度(到達時間モデル)の共通実装。
 * 距離ではなく「守備者がボールより先にコース上の点へ着けるか」で判定する。
 * 距離だけのモデルだと長いパスほどリスクを過小評価する(飛行中に守備者が間に合うため)。
 * margin = ボール通過時刻 - 守備者の到達時刻。正なら守備者が先に着く=カットされる。
 *
 * Task W: 守備者ごとの到達速度は「基本エフォート速度」を用い、ボール飛行中カーブアウト
 * (world.ts の ballInFlightReach = 飛行ボールの10m以内でスプリント)をコース上の点ごとに
 * 再現する — engages かつ点まで BALL_FLIGHT_REACH_RADIUS 以内ならスプリント、それ以外は
 * その守備者の実効エフォート速度。これで「持ち場でジョグしている遠い守備者」を幻の
 * インターセプターとして数えなくなる(=先読みが臆病でなくなり、実インターセプトが増える)。
 */
export function laneRiskFromPoints(from: Vec, to: Vec, defenders: LaneDefender[]): number {
  const total = dist(from, to);
  if (total < 0.5) return 0;
  const dir = norm(sub(to, from));
  let worst = -Infinity;
  for (const o of defenders) {
    for (let i = 1; i <= 6; i++) {
      const s = (total * i) / 6;
      const point = add(from, scale(dir, s));
      const dToPoint = dist(o.pos, point);
      const speed =
        o.engages && dToPoint < BALL_FLIGHT_REACH_RADIUS ? PLAYER_MAX_SPEED : o.speed;
      const tBall = ballTimeToCover(total, s);
      const tDef = DEFENDER_REACTION + Math.max(0, dToPoint - DEFENDER_REACH) / speed;
      worst = Math.max(worst, tBall - tDef);
    }
  }
  // margin -0.3s以下なら安全(0)、+0.3s以上なら確実にカット(1)
  return Math.min(1, Math.max(0, (worst + 0.3) / 0.6));
}

/**
 * 静止からの点到達時間の共通モデル(Task AA)。ロフト球の着地レースで、受け手と守備者の
 * 到達時刻を同じ式で見積もるために共有する(ai.ts のクロス採点・predict の着地リスクの両方)。
 * 地上の laneRiskFromPoints の守備者到達式と同じ形(反応 + (距離-リーチ)/速度)。
 */
export function arrivalTime(d: number, speed: number = PLAYER_MAX_SPEED): number {
  return DEFENDER_REACTION + Math.max(0, d - DEFENDER_REACH) / speed;
}

/**
 * ロフトパスのコース危険度(Task AA)。ai.ts と predict.ts が共有する唯一の実装
 * (ballTimeToCover / laneRiskFromPoints と同じ「構築による一致」パターン — 手動ミラー禁止)。
 *
 * 弾道モデル(world.ts の executeLoftedPass と同一): 飛行時間 T = 2*sqrt(2*apex/g)、
 * 水平速度 vh = d/T、z(t) は対称放物線。z > BALL_HEAD_HEIGHT(2.2m)の間は誰も触れない。
 * 脆弱なのは2区間だけで、それぞれ別のモデルで価格付けする:
 *
 *  (a) 蹴り出し窓: 離陸直後の z < 2.2m の低い区間(キッカーから ~2m)。地上パスと同じ
 *      「守備者がボールより先にコース上の点へ着けるか」の margin モデル(ブロックされるクロス)。
 *  (b) 着地レース: 頭上を越えたボールは着地点の争いになる。ボールが降りてくるまでは
 *      誰も触れないので、受け手/守備者の到達時刻を max(到達, T) にクランプした差で測る —
 *      両者とも先着していれば margin 0(=0.5 の意図された50/50)、守備者だけが待ち構えて
 *      いれば 1、受け手だけなら 0。実際の解決(トラップ最近傍・ブロック8%・オープン受け)の
 *      相対到達の代理であり、順序中立な既存レースと同じ向きに単調。
 *
 * receiverArrival = 想定受け手(クロスならボックスの最速の味方)の着地点到達時刻(arrivalTime)。
 * 受け手がいない50/50(クリア/パント)は Infinity を渡す → 着地リスクは「守備者が待ち構えて
 * いるか」だけで決まる。GKを含めるかは呼び出し側の方針(ai.ts はシュート同様 GK を除外する)。
 */
export function loftedLaneRiskFromPoints(
  from: Vec,
  to: Vec,
  apexHeight: number,
  defenders: LaneDefender[],
  receiverArrival: number,
): number {
  const total = dist(from, to);
  if (total < 2) return 1; // 退化(その場への浮かし)は意味がない
  const T = 2 * Math.sqrt((2 * apexHeight) / GRAVITY);
  const vh = total / T;
  const dir = norm(sub(to, from));
  const defArrive = (point: Vec, o: LaneDefender): number => {
    const dToPoint = dist(o.pos, point);
    const speed = o.engages && dToPoint < BALL_FLIGHT_REACH_RADIUS ? PLAYER_MAX_SPEED : o.speed;
    return DEFENDER_REACTION + Math.max(0, dToPoint - DEFENDER_REACH) / speed;
  };

  let worst = -Infinity;
  if (apexHeight <= BALL_HEAD_HEIGHT) {
    // 全行程が頭の高さ以下の低い弾道(消費者は使わないが安全のため): 地上と同じ全区間サンプル
    for (const o of defenders) {
      for (let i = 1; i <= 6; i++) {
        const s = (total * i) / 6;
        const point = add(from, scale(dir, s));
        worst = Math.max(worst, s / vh - defArrive(point, o));
      }
    }
    return Math.min(1, Math.max(0, (worst + 0.3) / 0.6));
  }

  // (a) 蹴り出し窓: z が 2.2m に達するまでの低い離陸区間(対称放物線の小さい方の根)
  const vz0 = (GRAVITY * T) / 2;
  const tUp = (vz0 - Math.sqrt(Math.max(0, vz0 * vz0 - 2 * GRAVITY * BALL_HEAD_HEIGHT))) / GRAVITY;
  const sUp = Math.min(total * 0.45, vh * tUp);
  for (const o of defenders) {
    for (let i = 1; i <= 3; i++) {
      const s = (sUp * i) / 3;
      const point = add(from, scale(dir, s));
      worst = Math.max(worst, s / vh - defArrive(point, o));
    }
  }
  const takeoffRisk = Math.min(1, Math.max(0, (worst + 0.3) / 0.6));

  // (b) 着地レース: 到達を max(・, T) にクランプした受け手 vs 最良守備者の差。
  // 地上レーンより勾配を緩く(±0.6s)、上限を 0.85 に置く: 実際の解決(トラップ最近傍・
  // ブロック8%/tick・跳ねる二次ボール)は近接加重のコンテストであって確定カットではない —
  // 守備者が先着していても、走り込む受け手が初動タッチを取ることは普通にある。
  // 鋭い 0→1 は「守備者がゾーンに立っているだけで誰もクロスを蹴らない」誤較正を生む(計測:
  // 有人ボックスへの全クロスが risk≈0.91 で死んだ)。
  let bestDef = Infinity;
  for (const o of defenders) bestDef = Math.min(bestDef, defArrive(to, o));
  const eRecv = Math.max(receiverArrival, T);
  const eDef = Math.max(bestDef, T);
  const landingRisk = Math.min(0.85, Math.max(0, (eRecv - eDef + 0.6) / 1.2));

  return Math.max(takeoffRisk, landingRisk);
}

function moveToward(from: Vec, to: Vec, maxDist: number): Vec {
  const d = dist(from, to);
  if (d <= maxDist) return { ...to };
  return add(from, scale(norm(sub(to, from)), maxDist));
}

export interface RunUtility {
  /** 走った本人がパスを受けられる価値 */
  self: number;
  /** 守備を動かした結果、味方が受けられるようになる価値(囮の価値はここに出る) */
  team: number;
}

/**
 * 1手先読み: 「moverがtargetへ走ったら、守備はどう反応し、
 * その結果チームの攻撃機会はどうなるか」を採点する。
 *
 * 守備側のルール(ai.tsのdecideDefenseと同じゾーン規則)を我々自身が書いているので、
 * その反応は予測できる — これが囮ラン(自分は受けないが味方を空ける動き)の源泉。
 */
export function predictRunUtility(world: World, mover: Player, target: Vec): RunUtility {
  const owner = ballOwner(world);
  if (!owner) return { self: 0, team: 0 };
  const ballPos = owner.pos;

  // 攻撃側の予測位置: moverだけが走り、他は現在位置のまま
  const movedPos = moveToward(mover.pos, target, PLAYER_MAX_SPEED * REACT_TIME);
  const attackers = world.players.filter((p) => p.team === mover.team);
  const atkPos = new Map<number, Vec>();
  for (const a of attackers) atkPos.set(a.id, a.id === mover.id ? movedPos : a.pos);

  // 守備側の反応予測(decideDefenseのゾーン規則のミラー)。GKはプレス・マークに参加しない
  const allDefenders = world.players.filter((p) => p.team !== mover.team);
  const defenders = allDefenders.filter((p) => p.role !== GK_ROLE);
  const defendersTeam = defenders[0].team;
  // ビルドアップ判定 + 前線プレス(decideDefenseと同一の式)。
  // owner は常に存在(上で early-return 済み)。oppSign = 攻撃側の攻撃方向。
  const oppSign = owner.team === 0 ? 1 : -1;
  const buildupDepth = oppSign * owner.pos.x;
  const buildup = owner.role !== GK_ROLE && buildupDepth < -8;
  let fwPresser: Player | null = null;
  if (buildup) {
    const fws = defenders.filter((d) => classifyRole(world.formations[defendersTeam], d.role).isFW);
    if (fws.length) {
      const nearestFw = fws.reduce((a, b) =>
        dist(a.pos, ballPos) < dist(b.pos, ballPos) ? a : b,
      );
      if (dist(nearestFw.pos, ballPos) < 18) fwPresser = nearestFw;
    }
  }
  const ownGoal = ownGoalCenter(defendersTeam);
  // ai.tsのdecideDefenseと全く同じ式で戦術を反映(ズレると先読みが現実と乖離する)
  const tactics = world.tactics[defendersTeam];
  const zoneRadius = DEFENSE_ZONE_RADIUS * (1 + 2 * tactics.manMark);
  const markOffset = 1.6 + (1.0 - 1.6) * tactics.manMark; // lerp(1.6, 1.0)
  // 共有守備ライン(Task AD): decideDefense と同じ defensiveLineX を同じ引数で呼ぶ。
  // マーク深度クランプ(markTargetPoint)の基準。defSign = 守備チームの攻撃方向。
  const defSign = defendersTeam === 0 ? 1 : -1;
  const ownLineX = defensiveLineX(world, defendersTeam);

  // ── プレッサー: decideDefense がコミットした識別子を読む(Task W ヒステリシスのミラー) ──
  // decideDefense は毎フレーム world.presserId[defendersTeam] に実プレッサーを書く。ここでは
  // それを読むことで、ヒステリシスで固定されたプレッサーと完全に一致させる(nearest 再導出だと
  // 固定を再現できずズレる)。ビルドアップの fwPresser は位置ベースで最優先なので再計算で拾う。
  // フリップ直後で presserId が未設定のフレームだけ nearest にフォールバック(decideDefense と同じ)。
  const nearest = defenders.reduce((x, y) =>
    dist(x.pos, ballPos) < dist(y.pos, ballPos) ? x : y,
  );
  let presser: Player;
  if (fwPresser) {
    presser = fwPresser;
  } else {
    const pid = world.presserId[defendersTeam];
    const committed = pid !== null ? defenders.find((d) => d.id === pid) ?? null : null;
    presser = committed ?? nearest;
  }
  // 挟み込み: プレス強のとき2番目に近い守備者もプレス(decideDefense と同じ再計算)
  let secondPresser: Player | null = null;
  if (tactics.pressIntensity > 0.6) {
    const rest = defenders.filter(
      (d) => d !== presser && !(d.defenseRole === 'recover' && oppSign * (owner.pos.x - d.pos.x) > 0),
    );
    if (rest.length) {
      secondPresser = rest.reduce((x, y) =>
        dist(x.pos, ballPos) < dist(y.pos, ballPos) ? x : y,
      );
    }
  }

  // 各守備者の反応(位置)と、コース危険度用の LaneDefender を組み立てる。
  // reactSpeed = 位置予測の移動上限、laneKind = コース到達速度を決める代表意図(pace.ts と共有)。
  //
  // マークの「割り当て(どの相手に付くか)」は decideDefense のスティッキー版と違い、ここでは
  // 従来どおり movedPos に対するゾーン貪欲マッチで再導出する。理由: predict はフレーム履歴を
  // 持たない1手先読みで、スティッキーは同フレームのフラッピング抑制の時間平滑にすぎず、1.6秒の
  // 先読み地平では「危険な走り込みを拾う」再導出とほぼ一致する。また囮/teamDelta の価値(守備が
  // 走りに反応して空く価値)はこの動的再マークからのみ生まれる。適用する「式」(markTarget/
  // pressTarget/recover/compactBlock)は decideDefense と一字一句ミラーする(invariant)。
  const used = new Set<number>();
  const defPos: Vec[] = [];
  const defLane: LaneDefender[] = [];
  const pushDef = (d: Player, reactTarget: Vec, reactSpeed: number, laneKind: IntentKind | null) => {
    const pos = moveToward(d.pos, reactTarget, reactSpeed * REACT_TIME * REACT_FACTOR);
    defPos.push(pos);
    defLane.push({ pos, speed: effortSpeed(laneEngageEffort(laneKind)), engages: laneEngages(laneKind) });
  };
  for (const d of allDefenders) {
    if (d.role === GK_ROLE) {
      // GKは持ち場(ボールとゴールを結ぶ線上)から動かない前提。反応速度は保護のため sprint 相当。
      pushDef(d, dynamicAnchor(world, d), PLAYER_MAX_SPEED, 'keeper');
    } else if (d === presser) {
      if (d === fwPresser) {
        pushDef(d, coverShadowTarget(world, owner, defendersTeam, oppSign), PLAYER_MAX_SPEED, 'cutLane');
      } else {
        // 迎撃リード点。プレス弱はコンテイン(リード点と自ゴールの間2.5m)。press は sprint。
        const lead = pressTarget(owner);
        const rt =
          tactics.pressIntensity < 0.3
            ? add(lead, scale(norm(sub(ownGoal, lead)), 2.5))
            : lead;
        pushDef(d, rt, PLAYER_MAX_SPEED, 'press');
      }
    } else if (d === secondPresser) {
      pushDef(d, pressTarget(owner), PLAYER_MAX_SPEED, 'press');
    } else if (d.defenseRole === 'recover' && oppSign * (owner.pos.x - d.pos.x) > 0) {
      // 抜かれて回復中の守備者はゴール側へ全力で戻る(decideDefense のミラー)
      pushDef(d, recoverTarget(owner, ownGoal), PLAYER_MAX_SPEED, 'recover');
    } else {
      // マーク/カバー/コンパクトブロック: movedPos に対するゾーン貪欲マッチで最も危険な相手を拾う
      const anchor = dynamicAnchor(world, d);
      let mark: Vec | null = null;
      let markId = -1;
      let bestDanger = -Infinity;
      for (const a of attackers) {
        if (a.id === owner.id || used.has(a.id)) continue;
        const ap = atkPos.get(a.id)!;
        if (dist(ap, anchor) > zoneRadius) continue;
        const danger = -dist(ap, ownGoal);
        if (danger > bestDanger) {
          bestDanger = danger;
          mark = ap;
          markId = a.id;
        }
      }
      if (mark) {
        used.add(markId);
        pushDef(d, markTargetPoint(mark, ownGoal, ballPos, markOffset, ownLineX, defSign), effortSpeed('run'), 'mark');
      } else if (dist(owner.pos, ownGoal) < COMPACT_BLOCK_RANGE) {
        // 空きゾーン守備者はコンパクトブロックへ(cover→compactBlock)。effort は run 上限で近似。
        pushDef(d, compactBlockTarget(anchor, owner.pos, ownGoal), effortSpeed('run'), 'cutLane');
      } else {
        // 持ち場を守る(cover=walk)。cutLane のコース封鎖分岐は ai.ts の既知未ミラー分(task-q)。
        pushDef(d, anchor, effortSpeed('run'), 'cover');
      }
    }
  }

  // 評価: 予測後の世界で、各攻撃者が「コースが通っていてフリーで、前で受けられる」価値
  const goal = goalCenter(mover.team);
  let self = 0;
  let team = 0;
  for (const a of attackers) {
    if (a.id === owner.id || a.role === GK_ROLE) continue;
    const ap = atkPos.get(a.id)!;
    // オフサイド(ソフトルール, Task AD): オフサイドポジションの受け手は価値0。
    // ai.ts のパス採点・world.ts の笛と同じ共有述語(構築による一致)。これにより
    // ライン裏に立つ動きは先読み上も無価値になり、ランはラインとレベルに再調律される。
    if (isOffsidePosition(world, a.team, ap, OFFSIDE_SOFT_MARGIN)) continue;
    let minDef = Infinity;
    for (const dp of defPos) minDef = Math.min(minDef, dist(dp, ap));
    const receivable = (1 - laneRiskFromPoints(ballPos, ap, defLane)) * Math.min(1, minDef / 6);
    const advance = Math.max(0, 1 - dist(ap, goal) / PITCH_LENGTH);
    const value = receivable * (0.6 + advance);
    if (a.id === mover.id) self = value;
    else team += value;
  }
  return { self, team };
}
