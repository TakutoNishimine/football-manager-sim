import {
  AI_DECISION_INTERVAL,
  BALL_DAMPING,
  BALL_HEAD_HEIGHT,
  GRAVITY,
  LOFT_BOUNCE_FRICTION,
  LOFT_RESTITUTION,
  LOFT_SETTLE_VZ,
  CARRY_RELEASE_PRESSURE,
  CLEARANCE_APEX,
  CLEARANCE_DIST,
  CLEARANCE_GOAL_DIST,
  CLEARANCE_PRESSURE,
  COMPACT_BLOCK_RANGE,
  CROSS_APEX,
  CROSS_MIN_WIDE_Y,
  CROSS_ZONE_DEPTH,
  PUNT_APEX,
  PUNT_DIST,
  SWITCH_APEX,
  SWITCH_COOLDOWN,
  SWITCH_MAX_DIST,
  SWITCH_MIN_DIST,
  SWITCH_OVERLOAD_RADIUS,
  DEFENSE_DECIDE_MAX,
  DEFENSE_DECIDE_MIN,
  DEFENSE_ZONE_RADIUS,
  GK_AERIAL_SWEEP_MARGIN,
  GK_REACT_TIME,
  GOAL_WIDTH,
  HOLD_DURATION,
  HOLD_MAX_PRESSURE,
  MARK_REASSIGN_MARGIN,
  MARK_STICKY_TIME,
  OWNER_DECIDE_MAX,
  OWNER_DECIDE_MIN,
  PITCH_LENGTH,
  PITCH_WIDTH,
  PLAYER_ACCEL,
  PLAYER_MAX_SPEED,
  PRESS_BEATEN_DIST,
  PRESS_HYSTERESIS_MARGIN,
  PRESS_LEAD_TIME,
  RECOVER_GOALSIDE_DIST,
  SETTLE_BAILOUT_PRESSURE,
  SHOT_MAX_RANGE,
  SHOT_QUALITY_DIST_FLOOR,
  SHOT_RANGE,
  TAKEON_KNOCK_PAST,
  TAKEON_OPEN_BEHIND,
  TAKEON_RANGE,
} from './constants';
import { classifyRole, dynamicAnchor, GK_ROLE } from './formation';
import {
  clampOnsideX,
  defensiveLineX,
  isOffsidePosition,
  markTargetPoint,
  OFFSIDE_SOFT_MARGIN,
  offsideLineX,
  RUN_BREAK_DEPTH,
  RUN_THROUGH_GATE,
} from './line';
import { effortSpeed, laneEngageEffort, laneEngages } from './pace';
import {
  arrivalTime,
  DEFENDER_REACTION,
  laneRiskFromPoints,
  loftedLaneRiskFromPoints,
  predictRunUtility,
  type LaneDefender,
} from './predict';
import { TEAM_WEIGHTS } from './weights';
import type { IntentKind, Player, World } from './types';
import {
  ballOwner,
  executeLoftedPass,
  executePass,
  executeShot,
  executeTakeOn,
  goalCenter,
  loftFlightTime,
  opponents,
  ownGoalCenter,
  passFlightTime,
  predictGoalLineCrossing,
  teammates,
} from './world';
import { add, dist, dot, len, norm, scale, sub, vec, type Vec } from './vec';

const HALF_L = PITCH_LENGTH / 2;
const HALF_W = PITCH_WIDTH / 2;

/**
 * パスコースの危険度 0(安全)〜1(ほぼカットされる)。可視化にも使う。
 * シュートの評価ではGKを除外すること(GKは定義上常にシュートコース上にいるため、
 * 含めると全シュートのリスクが1になりAIが一切シュートしなくなる。GKはセーブ物理で対抗する)
 */
export function laneRisk(
  world: World,
  from: Vec,
  to: Vec,
  attackingTeam: number,
  excludeGK = false,
  conservative = false,
): number {
  const defenders: LaneDefender[] = [];
  for (const opp of world.players) {
    if (opp.team === attackingTeam) continue;
    if (excludeGK && opp.role === GK_ROLE) continue;
    // conservative: 全守備者を PLAYER_MAX_SPEED で見積もる(Task U以前の挙動)。
    // シュートの被ブロック判定に使う: ブロックする身体はすでにコース上に立っており「コースへ
    // 走って間に合うか」という到達時間の honest モデル(=速いシュートは遠くから届かない)は
    // シュートには不適切。honest 化は §6 の狙いどおり「パス」成功率にだけ効かせ、シュート本数の
    // ファネル(Task Q/Z の領域)は既存の較正を保つ。
    defenders.push(
      conservative
        ? { pos: opp.pos, speed: PLAYER_MAX_SPEED, engages: true }
        : laneDefenderOf(opp),
    );
  }
  return laneRiskFromPoints(from, to, defenders);
}

/**
 * 守備者を laneRiskFromPoints 用の LaneDefender に変換する(Task W)。
 * speed = 意図から決まる基本エフォート速度、engages = ボール飛行時に詰めに来るか。
 * GKは持ち場から動かない前提だが、コース上にいれば脅威なので engages=false・walk扱いにせず
 * 実効ゼロ移動でも現在位置での到達だけ評価させる(=speedは使われても近接時のみ)。
 */
function laneDefenderOf(opp: Player): LaneDefender {
  const kind = opp.intent?.kind ?? null;
  return { pos: opp.pos, speed: effortSpeed(laneEngageEffort(kind)), engages: laneEngages(kind) };
}

function nearestOpponentDist(world: World, p: Player): number {
  return Math.min(...opponents(world, p.team).map((o) => dist(o.pos, p.pos)));
}

/**
 * ロフトパスのコース危険度(Task AA)。共有実装 loftedLaneRiskFromPoints(predict.ts)を
 * ai の守備者ビュー(laneDefenderOf: 意図由来のエフォート速度+engage)で呼ぶ。
 * GKは除外する: シュートの laneRisk と同じ理由で、GKは定義上ゴール前に常駐するため
 * 含めるとゴール前への全クロスが risk≈1 になり誰もクロスしなくなる。GKには既存の
 * 物理(リーチ1.5m・確定ブロック・スイープ)で対抗させる。
 */
function loftedRisk(
  world: World,
  owner: Player,
  target: Vec,
  apexHeight: number,
  receiverArrival: number,
): number {
  const defenders: LaneDefender[] = [];
  for (const opp of world.players) {
    if (opp.team === owner.team || opp.role === GK_ROLE) continue;
    defenders.push(laneDefenderOf(opp));
  }
  return loftedLaneRiskFromPoints(owner.pos, target, apexHeight, defenders, receiverArrival);
}

/**
 * クロス実行時のボックスラン発火(Task AA)。狙い点に最も早く着ける味方は「着地点そのもの」を
 * 襲い(ボールへのアタック — これが無いと着地点の半径8mに誰もおらず、GKが「明確に最初」の
 * 条件でクロスを回収してしまう)、もう1人はファーポスト(こぼれ球/折り返し)へ走る。
 * 既存のラン意図機構を再利用する(runBehind = スプリント・到着では失効しない・
 * 味方のパスを跨いで持続)。人がいないクロスはターンオーバーなので、蹴ると同時に人を走らせる。
 */
function triggerCrossRuns(world: World, crosser: Player, aim: Vec): void {
  const atkSign = crosser.team === 0 ? 1 : -1;
  const goal = goalCenter(crosser.team);
  const ySide = crosser.pos.y >= 0 ? 1 : -1;
  const farPost = clampToPitch(vec(goal.x - atkSign * 9, -ySide * 5), 1.5);
  const runners = teammates(world, crosser)
    .filter(
      (t) =>
        t.role !== GK_ROLE &&
        !t.instruction &&
        // オフサイドポジションからのボックスランは反則の受けにしかならない(Task AD)
        !isOffsidePosition(world, crosser.team, t.pos, OFFSIDE_SOFT_MARGIN),
    )
    .sort((a, b) => dist(a.pos, aim) - dist(b.pos, aim))
    .slice(0, 2);
  if (!runners.length) return;
  // 最も早く着ける方が着地点へ、もう1人はファーポストのこぼれ球へ
  const targets = [{ ...aim }, farPost];
  runners.forEach((t, i) => {
    const target = targets[i];
    t.intent = { kind: 'runBehind', target, until: world.clock + 2.6, possTeam: crosser.team };
    t.moveTarget = target;
  });
}

/** 圧力 0(フリー)〜1(密着)。最寄り相手まで4mで頭打ち(ai.ts:176 の従来式を一元化) */
function pressureOf(world: World, p: Player): number {
  return Math.min(1, Math.max(0, 1 - nearestOpponentDist(world, p) / 4));
}

/** 保持者の再判断カデンス(Task V): 圧力連動 lerp(圧力0で0.6s → 圧力1で0.15s)。 */
function ownerDecisionInterval(pressure: number): number {
  return OWNER_DECIDE_MAX + (OWNER_DECIDE_MIN - OWNER_DECIDE_MAX) * pressure;
}

/**
 * hold/整えのシールド目標点(Task V): その場に立ち、最寄り相手からわずかに身体をずらして
 * ボールを守る。moveTarget=自位置ならその場で構える。相手が近ければ少しだけ相手と逆へ。
 */
function shieldTarget(world: World, owner: Player): Vec {
  let nearest: Player | null = null;
  let best = Infinity;
  for (const o of opponents(world, owner.team)) {
    const d = dist(o.pos, owner.pos);
    if (d < best) {
      best = d;
      nearest = o;
    }
  }
  if (!nearest || best > 6) return { ...owner.pos }; // 相手が遠ければその場で構える
  const away = norm(sub(owner.pos, nearest.pos));
  return clampToPitch(add(owner.pos, scale(away, 0.5)), 1);
}

/**
 * ファーストタッチの整え中の移動目標(Task V)。意思決定は遅らせるが、ボール前進は必要な分だけ
 * 生かす。前方に十分な空間があり無圧なら、勢いを活かして前へ運ぶ(=攻撃がファイナルサードに
 * 届き shots/goals を保つ。立ち止まるだけだと shots が floor を割る)。前が詰まっている/相手が
 * 寄っているなら身体で守る(=steals・完成度を守る。ゴール側の相手コーンに突っ込まない)。
 * 相手が steal レンジに寄れば aiStep 側の割り込みで即断するので、整えのフル時間は安全局面だけ。
 */
function settleTarget(world: World, owner: Player): Vec {
  const pressure = pressureOf(world, owner);
  if (pressure >= 0.5) return shieldTarget(world, owner); // 寄られている: 身体で守る
  // 無圧: 勢いを活かして前へ運ぶ(近い相手からは逃げるベクトルを混ぜてコーンを避ける)。
  // 前進を殺すと攻撃がファイナルサードに届かず shots が floor を割るため、運びは必要。
  const toGoal = norm(sub(goalCenter(owner.team), owner.pos));
  let escape = vec(0, 0);
  for (const opp of opponents(world, owner.team)) {
    const d = dist(opp.pos, owner.pos);
    if (d < 6) escape = add(escape, scale(norm(sub(owner.pos, opp.pos)), (6 - d) / 6));
  }
  const dir = norm(add(toGoal, scale(escape, 1.0)));
  return clampToPitch(add(owner.pos, scale(dir, 4)), 1);
}

/**
 * ゴール方向の「前方コーン」の空き具合(m)。
 * 保持者の前(攻撃方向)に広がる扇形に最も近い相手(GK除く)までの距離を返す。
 * 大きいほど運び込める空間が前に開いている。相手がいなければ上限(=40m相当)。
 */
function forwardSpaceAhead(world: World, owner: Player): number {
  const sign = owner.team === 0 ? 1 : -1;
  let best = Infinity;
  for (const o of opponents(world, owner.team)) {
    if (o.role === GK_ROLE) continue;
    const dx = (o.pos.x - owner.pos.x) * sign; // 攻撃方向の前方距離
    if (dx <= 0) continue; // 前方のみ
    const dy = Math.abs(o.pos.y - owner.pos.y);
    if (dy > dx + 6) continue; // 約45度+オフセットの前方コーン
    best = Math.min(best, dist(o.pos, owner.pos));
  }
  return best === Infinity ? 40 : best;
}

/**
 * このパスが「ライン間を割る/相手を越える」度合い。出し手と受け手の間(攻撃方向)に
 * いて、かつパスコースの近く(横方向8m以内)に立つ相手フィールドプレーヤーの人数を数える。
 * 1人以上越えるパスは縦に刺さる前進パス。横パスは0になる。
 */
function lineBreakCount(world: World, owner: Player, target: Vec): number {
  const sign = owner.team === 0 ? 1 : -1;
  let count = 0;
  for (const o of opponents(world, owner.team)) {
    if (o.role === GK_ROLE) continue;
    const aheadOfOwner = sign * (o.pos.x - owner.pos.x) > 0.5; // 出し手より前
    const behindTarget = sign * (target.x - o.pos.x) > -1; // 受け手の手前まで(=越える)
    if (!aheadOfOwner || !behindTarget) continue;
    // パスの進行ラインからの横ずれ(おおまかに守備ブロックの幅)
    const dy = Math.abs(o.pos.y - (owner.pos.y + (target.y - owner.pos.y) * 0.5));
    if (dy < 12) count++;
  }
  return count;
}

/**
 * パスの目標点: 受け手の現在位置ではなく、ボールの飛行時間ぶん走りをリードした点。
 * 裏へ走る選手にはその走り込む先(=マークの外)へ出る — スルーパスの実装。
 * runBehind のランナー(Task AD)はオフサイドラインとレベルでオンサイドに待機している
 * (clampOnsideX)ので速度リードが効かない — 代わりに intent.target(ライン裏のブレイク
 * 目標)へ出す。リリースでランナーがブレイクして走り込む(オフサイドは受け手のリリース時
 * 現在位置で判定されるため、この形が合法なスルーパスになる)。
 */
function passTarget(world: World, owner: Player, t: Player): Vec {
  if (
    t.intent !== null &&
    t.intent.kind === 'runBehind' &&
    t.intent.possTeam === owner.team &&
    t.intent.until > world.clock
  ) {
    return clampToPitch(t.intent.target, 1);
  }
  const T = Math.min(1.6, passFlightTime(dist(owner.pos, t.pos)));
  return clampToPitch(add(t.pos, scale(t.vel, T)), 1);
}

/**
 * 転がるボール(指数減衰)に追いつける最早の地点と所要時間。
 * ボールの現在位置ではなく軌道の先を取ることで、パスのインターセプト/受けが可能になる。
 * 浮き球(Task AA)は world.ts と同じ弾道(重力+バウンド・飛行中は水平減衰なし)を先読みし、
 * 頭上(z >= BALL_HEAD_HEIGHT)にある間は「届かない」— つまり追跡者は着地点へのレースになる。
 * 接地球(z=0, vz=0)は従来と同一の式・同一の地平(3.0s)を通る(バイト同一)。
 * predictミラー不要: これは owner無し(フリーボール)の局面でのみ使われ、predict は
 * owner無しで early-return する(Task Y の前例と同じ)。
 */
function interceptInfo(world: World, p: Player): { point: Vec; time: number } {
  let pos = { ...world.ball.pos };
  let vel = { ...world.ball.vel };
  let z = world.ball.z;
  let vz = world.ball.vz;
  const step = 0.1;
  const horizon = z > 0 || vz !== 0 ? 4.5 : 3.0; // 浮き球は飛行が長い(パント〜3.1s+バウンド)
  for (let t = step; t <= horizon; t += step) {
    pos = add(pos, scale(vel, step));
    if (z > 0 || vz !== 0) {
      z += vz * step;
      vz -= GRAVITY * step;
      if (z <= 0) {
        z = 0;
        vz = Math.max(0, -vz) * LOFT_RESTITUTION;
        vel = scale(vel, LOFT_BOUNCE_FRICTION);
        if (vz < LOFT_SETTLE_VZ) vz = 0;
      }
    } else {
      vel = scale(vel, Math.exp(-BALL_DAMPING * step));
    }
    if (z < BALL_HEAD_HEIGHT && dist(p.pos, pos) <= reachDist(t)) return { point: pos, time: t };
  }
  // 追いつけない場合は転がって止まる先へ(時間は大きい値)
  return { point: pos, time: 10 + dist(p.pos, pos) / PLAYER_MAX_SPEED };
}

/**
 * 静止から加速度 PLAYER_ACCEL で立ち上がる選手が時間 t で到達できる距離(Task W)。
 * 従来は PLAYER_MAX_SPEED*t の等速前提で早期到達を過大評価していた(PLAYER_ACCEL 14→6 で悪化)。
 * t < 到達時間 なら 0.5*a*t^2、以降は v_max*t - v_max^2/(2a)(加速に費やした距離ぶん差し引く)。
 */
function reachDist(t: number): number {
  const tAccel = PLAYER_MAX_SPEED / PLAYER_ACCEL;
  if (t <= tAccel) return 0.5 * PLAYER_ACCEL * t * t;
  return PLAYER_MAX_SPEED * t - (PLAYER_MAX_SPEED * PLAYER_MAX_SPEED) / (2 * PLAYER_ACCEL);
}

interface TakeOnCand {
  defender: Player;
  openBehind: number;
}

/**
 * 仕掛け(テイクオン)のゲート(Task Y)。攻撃方向の前方 TAKEON_RANGE 内に「抜ける対象」が
 * ちょうど1人だけいて、その背後(押し出す先)に別の相手がいない(=カバーされていない)局面のみ候補。
 * openBehind = 押し出す先の最寄りの別守備者までの距離(スコアの空きスペース項に使う)。GKは対象外。
 */
function takeOnCandidate(world: World, owner: Player): TakeOnCand | null {
  const goal0 = goalCenter(owner.team);
  const toGoalDir = norm(sub(goal0, owner.pos));
  const perp0 = vec(-toGoalDir.y, toGoalDir.x);
  const opps = opponents(world, owner.team).filter((o) => o.role !== GK_ROLE);
  // 「抜く対象」= ゴール方向の前方コーン内(進路上)の相手。前方 TAKEON_RANGE 内かつ owner→goal 線から
  // 横に3m以内(=本当に「目の前で進路を塞ぐ」相手)。横に外れた相手は仕掛けの対象ではない。
  const near = opps.filter((o) => {
    const rel = sub(o.pos, owner.pos);
    const fwd = dot(rel, toGoalDir); // 前方成分(攻撃方向)
    const lat = Math.abs(dot(rel, perp0)); // 横成分
    return fwd > 0.5 && fwd < TAKEON_RANGE && lat < 3;
  });
  if (near.length !== 1) return null; // 進路上にちょうど1人でないと仕掛けない(密集は仕掛けの局面ではない)
  const defender = near[0];
  // 押し出す先(相手の TAKEON_KNOCK_PAST 先)に別の相手=カバーがいれば仕掛けない。
  // 同時に「最終ラインを丸ごと越える仕掛け」は不可: 押し出す先よりゴール側にフィールド守備者が
  // 1人も残らない(=抜けたら GK と1対1)なら仕掛けない。現実の仕掛けはウィングが SB を剥がす・
  // 中盤で1枚外す局面であり、無人の守備を突き抜ける安直な得点経路にはしない(goals 帯域の保護)。
  const beyond = add(owner.pos, scale(toGoalDir, dist(owner.pos, defender.pos) + TAKEON_KNOCK_PAST));
  const sign = owner.team === 0 ? 1 : -1;
  let openBehind = Infinity;
  let coverGoalSide = 0;
  for (const o of opps) {
    if (o.id === defender.id) continue;
    openBehind = Math.min(openBehind, dist(o.pos, beyond));
    if (sign * (o.pos.x - beyond.x) > 0) coverGoalSide++;
  }
  if (openBehind < TAKEON_OPEN_BEHIND) return null; // 背後がカバーされている
  if (coverGoalSide === 0) return null; // 最終ライン越えの仕掛けは不可(GKと1対1の安直経路)
  return { defender, openBehind };
}

/** ボール保持者の意思決定: シュート / パス / ドリブル / 仕掛け を点数で比較 */
function decideOwner(world: World, owner: Player): void {
  // ユーザーのパス指示が最優先
  if (owner.instruction?.kind === 'pass') {
    const receiver = world.players[owner.instruction.receiverId];
    owner.instruction = null;
    // オフサイド(ソフトルール, Task AT): オフサイドポジションの指示受け手には出さない
    // — 指示をクリアして通常の意思決定に委ねる(笛で止まるパスをユーザー指示でも切る)。
    if (!isOffsidePosition(world, owner.team, receiver.pos, OFFSIDE_SOFT_MARGIN)) {
      executePass(world, owner, passTarget(world, owner, receiver));
      return;
    }
  }

  // キックオフのバックパス誘導(Task AT, オーナー eye-test): キックオフ直後の短い窓の間、
  // 中央スポットの持ち手の最初の意思決定を後方/横の最寄り味方(サポートのMF)への短いパスに
  // 誘導する。実際のキックオフはほぼ必ず一旦後ろへ下げて保持を確立する(新機構ではなく状態フラグ)。
  if (
    world.kickoffCarrierId === owner.id &&
    world.clock < world.kickoffPassUntil &&
    owner.role !== GK_ROLE
  ) {
    world.kickoffCarrierId = null; // 1回だけ発火
    const sign = owner.team === 0 ? 1 : -1;
    let back: Player | null = null;
    let bestD = Infinity;
    for (const t of teammates(world, owner)) {
      if (t.role === GK_ROLE) continue;
      if (sign * t.pos.x > sign * owner.pos.x + 1) continue; // 前方の味方は対象外(後ろ/横のみ)
      const d = dist(owner.pos, t.pos);
      if (d < bestD) {
        bestD = d;
        back = t;
      }
    }
    if (back) {
      executePass(world, owner, passTarget(world, owner, back));
      return;
    }
  }

  const W = TEAM_WEIGHTS[owner.team];
  const goal = goalCenter(owner.team);
  const distGoal = dist(owner.pos, goal);
  const pressure = pressureOf(world, owner);
  const attackDepth = owner.team === 0 ? owner.pos.x : -owner.pos.x; // +HALF_L=敵ゴール際
  const ownGoalD = dist(owner.pos, ownGoalCenter(owner.team));

  // GK: ドリブルで持ち上がらない。最良のパス、なければパント(Task AA)
  if (owner.role === GK_ROLE) {
    let best: Player | null = null;
    let bestPassScore = -Infinity;
    for (const t of teammates(world, owner)) {
      if (t.role === GK_ROLE) continue;
      // オフサイド(ソフトルール, Task AD): オフサイドポジションの受け手は無効
      if (isOffsidePosition(world, owner.team, t.pos, OFFSIDE_SOFT_MARGIN)) continue;
      const target = passTarget(world, owner, t);
      const d = dist(owner.pos, target);
      if (d < 6 || d > 45) continue;
      const risk = laneRisk(world, owner.pos, target, owner.team);
      if (risk > 0.7) continue;
      const openness = Math.min(1, nearestOpponentDist(world, t) / 6);
      const score = (1 - risk) * 1.2 + openness * 0.8 - d / 60;
      if (score > bestPassScore) {
        bestPassScore = score;
        best = t;
      }
    }
    // パントのゲートは「GK自身への直接圧力」のみ(Task AA)。計測: GKのショート採点は
    // ほぼ常に ~1.85(プレスが1枚では出口3-4人を全て消せない)なので、スコア棒での
    // ゲートは構造的に死ぬ。一方 GK受球の~15%は相手が2m級まで迫っており(p10=0.8m)、
    // 足元にプレッサーがいる状態でショートを刺すのは非現実的 — そこは蹴り出す。
    if (best && pressure < 0.5) {
      executePass(world, owner, passTarget(world, owner, best));
    } else {
      // 安全なパスがない、または詰められている → パント(Task AA): 圧力の逃し弁。
      // 最前線の味方のサイドへ55〜70mの高いボールを送り、着地は素のレースで争う
      // (フルのGK配球パーソナリティは Task AB — ここは圧力時の脱出だけ)。
      // オフサイド(ソフトルール, Task AT): オフサイドポジションの最前線の味方は狙わない
      // (パントの着地をオフサイドの受け手に向けると笛で止まる)。全員オフサイドの稀な場合は
      // 従来どおり最前線へ蹴る(圧力の逃し弁を殺さない)。
      const outfield = teammates(world, owner).filter((t) => t.role !== GK_ROLE);
      const puntCands = outfield.filter(
        (t) => !isOffsidePosition(world, owner.team, t.pos, OFFSIDE_SOFT_MARGIN),
      );
      const fw = (puntCands.length > 0 ? puntCands : outfield).reduce((a, b) =>
        dist(a.pos, goal) < dist(b.pos, goal) ? a : b,
      );
      const atkSign = owner.team === 0 ? 1 : -1;
      const target = clampToPitch(vec(owner.pos.x + atkSign * PUNT_DIST, fw.pos.y * 0.6), 3);
      executeLoftedPass(world, owner, target, PUNT_APEX, 'punt');
    }
    return;
  }

  // シュート / ドリブル(=運ぶ)。
  // ドリブルの基準点に「前方の空きスペース」項を加える: ゴール方向の前方コーンが
  // 大きく開いていてプレッシャーが低いほど、横/後ろの安全なパスより運ぶことを選好する。
  // これがないと受けた瞬間に必ず近場へパスしてしまい、空いた前へ運び込めない。
  const spaceAhead = forwardSpaceAhead(world, owner);
  // 10m以上開いていれば「前が空いている」とみなし、最大で頭打ち(約24m)。
  // 閾値を高めにして、半端な空きで運んで奪われる(=パス成功率低下・攻守交代過多)のを避ける。
  // シュートレンジ内ではキャリー選好を抑える(ボックス内では運ばずシュート/崩しを優先)。
  const spaceTerm =
    Math.min(1, Math.max(0, (spaceAhead - 10) / 14)) * (distGoal < SHOT_RANGE ? 0.3 : 1);
  // 「前に芝が広がっている」局面: 前方コーンが十分に開いていて(>=13m)、プレッシャーが低い。
  // この時だけ、反射的な横/短いパスより「運ぶ」を選好させる(現実の選手は前のスペースに突っ込む)。
  // シュートレンジ内では崩し/シュートを優先するので発動しない。
  const openGrassAhead =
    spaceAhead >= 16 && pressure < 0.25 && distGoal > SHOT_RANGE
      ? Math.min(1, (spaceAhead - 16) / 12) * (1 - pressure / 0.25)
      : 0;
  // シュートコースのふさがり具合(GK除く)。ソフト上限 SHOT_MAX_RANGE まで評価する(壁ではない)。
  const shotLaneRisk =
    distGoal < SHOT_MAX_RANGE ? laneRisk(world, owner.pos, goal, owner.team, true, true) : 0;
  // シュートの「質」(Task Z): 距離クオリティ × 正面度、SHOT_MAX_RANGE まで連続。
  // shotProximity は「主戦レンジ(SHOT_RANGE)」の急峻な近接項で shootBase を駆動する(従来どおり
  // 20m で 0)。shotDistQ は SHOT_QUALITY_DIST_FLOOR 以内で満点・SHOT_MAX_RANGE で 0 の連続関数で、
  // 質ゲートに使う。これで SHOT_RANGE の「壁」を撤廃: 遠目・横・密集の低質シュートは連続的に抑え、
  // オープンで正面ならまれに 20〜26m(SHOT_MAX_RANGE)も撃てる。ロングの薄い裾は shootSafety 項が担う。
  const shotProximity = Math.max(0, 1 - distGoal / SHOT_RANGE); // 20m で 0: 近接シュートの appetite
  const shotAngleQ = Math.max(0, Math.min(1, 1 - Math.abs(owner.pos.y - goal.y) / 22));
  const shotDistQ = Math.max(
    0,
    Math.min(1, (SHOT_MAX_RANGE - distGoal) / (SHOT_MAX_RANGE - SHOT_QUALITY_DIST_FLOOR)),
  );
  const shotQuality = shotDistQ * shotAngleQ; // 0(遠/横)〜1(至近/正面)、SHOT_MAX_RANGE まで連続

  let bestAction: 'shoot' | 'dribble' | 'hold' | 'takeOn' | 'cross' | 'switch' | Player = 'dribble';
  let bestScore =
    W.dribbleBase +
    (1 - pressure) * W.dribbleCalm +
    spaceTerm * (1 - pressure) * W.carrySpaceAhead +
    openGrassAhead * W.carryOpenGrass; // 前が大きく空いている時の運ぶ加点
  if (distGoal < SHOT_MAX_RANGE) {
    const laneClear = 1 - shotLaneRisk;
    // base 近接項は「角度」だけでゲート(Task Z): 浅い角度の至近ジャンクシュートは抑えつつ、正面の
    // 至近フィニッシュは appetite を保つ(=ファーストタッチ・フィニッシュを潰さない)。距離でゲート
    // すると近接シュート全体が沈んでシュートが遠目に偏りフィニッシュが消えるため、base は角度のみ。
    // shootSafety(コースの通り)項は距離込みの質でフルゲート: 遠い/横/密集を連続的に抑え、オープン
    // 正面ならまれに 20〜26m のロングも撃てる薄い裾を作る(SHOT_RANGE の壁を撤廃)。ロングシュートは
    // shotProximity=0 なので shootSafety 項だけが担う。shootBase は下げない(方針§4)— 掛けるのは質ゲートのみ。
    const angleGate = 1 - W.shotQualityScale * (1 - shotAngleQ);
    const qGate = 1 - W.shotQualityScale * (1 - shotQuality);
    const score =
      shotProximity * shotProximity * shotProximity * W.shootBase * angleGate +
      laneClear * W.shootSafety * qGate;
    if (score > bestScore) {
      bestScore = score;
      bestAction = 'shoot';
    }
  }

  // 仕掛け(テイクオン, Task Y): 前方に抜ける相手が1人・その背後が空いている局面のみ候補。
  // 抜いた先の空きスペースが大きいほど選好。dribble/shoot/pass/hold と同じ土俵で採点する。
  const takeOn = takeOnCandidate(world, owner);
  if (takeOn) {
    const spaceQ = Math.min(1, takeOn.openBehind / 10);
    const takeOnScore = W.takeOnBase + spaceQ * W.takeOnSpace;
    if (takeOnScore > bestScore) {
      bestScore = takeOnScore;
      bestAction = 'takeOn';
    }
  }

  // ── クロス(Task AA): ワイドのファイナルサードからニア/ファー/カットバックへ ──────────
  // 「人がいないクロスはターンオーバー」: 着地を襲える味方(共有 arrivalTime で飛行時間+0.4s
  // 以内に着地点へ届く)が1人もいない狙い点は候補にしない。リスクは共有のロフト・レーン関数
  // (loftedLaneRiskFromPoints)で価格付けする。選ばれたら実行時にボックスラン(ニア/ファー)を
  // 発火させる(triggerCrossRuns)。
  let crossAim: Vec | null = null;
  if (
    attackDepth > HALF_L - CROSS_ZONE_DEPTH &&
    Math.abs(owner.pos.y) > CROSS_MIN_WIDE_Y &&
    distGoal > 11
  ) {
    const atkSign = owner.team === 0 ? 1 : -1;
    const ySide = owner.pos.y >= 0 ? 1 : -1;
    // 狙い点はGKの即応半径の外側(「コリドー・オブ・アンサートンティ」= GKと最終ラインの間)。
    // ゴールに近すぎる着地はトラフィックが無い限りキーパーのボールになる。
    const aims = [
      vec(goal.x - atkSign * 7.5, ySide * (GOAL_WIDTH / 2 + 1.5)), // ニアポスト
      vec(goal.x - atkSign * 9, -ySide * (GOAL_WIDTH / 2 + 2.5)), // ファーポスト
      vec(goal.x - atkSign * 12, ySide * 3), // カットバックゾーン(PKスポット付近)
    ];
    const T = loftFlightTime(CROSS_APEX);
    for (const aimRaw of aims) {
      const aim = clampToPitch(aimRaw, 1.5);
      const d = dist(owner.pos, aim);
      if (d < 12 || d > 40) continue; // 近すぎるなら地上の崩し、遠すぎるなら運ぶ/循環
      // 着地を襲える味方: 到達が着地+1.2s 以内(着地後もボールは頭の高さ以下で ~1s 以上
      // 弾んで残るので、僅かに遅れて入るランナーもファーストバウンドを争える)。
      // bestArrival は全味方の最小到達(=実際に競る最速の味方)で、着地レースの受け手側。
      let bodies = 0;
      let bestArrival = Infinity;
      for (const t of teammates(world, owner)) {
        if (t.role === GK_ROLE) continue;
        // オフサイドポジションの味方はクロスの的に数えない(Task AD: 受けたら笛)
        if (isOffsidePosition(world, owner.team, t.pos, OFFSIDE_SOFT_MARGIN)) continue;
        // 勢いのクレジット: すでに狙い点へ向かって走っている味方(接近速度 > 2m/s)は
        // 反応遅延(DEFENDER_REACTION)を免除する — クロスはランナーの走路に合わせて蹴る。
        const toAim = norm(sub(aim, t.pos));
        const closing = t.vel.x * toAim.x + t.vel.y * toAim.y;
        const at = arrivalTime(dist(t.pos, aim)) - (closing > 2 ? DEFENDER_REACTION : 0);
        if (at < bestArrival) bestArrival = at;
        if (at <= T + 1.2) {
          bodies++;
        }
      }
      if (bodies === 0) continue; // 人がいないクロスは蹴らない
      const risk = loftedRisk(world, owner, aim, CROSS_APEX, bestArrival);
      const score = (1 - risk) * (W.crossBase + Math.min(2, bodies) * W.crossBodies);
      if (score > bestScore) {
        bestScore = score;
        bestAction = 'cross';
        crossAim = aim;
      }
    }
    // 注: 人がいない場合に保持者側から最前線の味方をポストへ「徴発」する案は計測の結果
    // REJECTED — 最前線2人(=FW)の意図経済を毎再判断で上書きし、裏抜け/サポートの供給が
    // 絶たれて shots が 2.25→0.42 に崩壊した(6×6min ablation)。人を送るのはオフボール側:
    // chooseOffBallIntent のポストラン候補(ボールがワイドのファイナルサードにあるとき発生)が
    // 採点の土俵で自分からボックスへ走り、bodies が立ってからここのクロス採点が成立する。
  }

  // ファネル・エグジット(Task Z Req3 / task-q が挙げて未実装だったレバー)の発動条件。
  // ファイナルサードで(a)前方の明確な選択肢がなく(b)好機(=質の高いシュート)がない局面。このとき
  // 後方の安全な出口への「循環して出る」パスを、単なる減点緩和ではなく積極的な加点にする(下のパス
  // ループで付与)。狙い: passes/possession↑、無理な低質シュートの funnel を断ち、循環して入り直す
  // ことでより良い好機を作る。「好機の無さ」は shotLaneRisk(コースの塞がり)と 1-shotQuality(遠い/
  // 横=低質)の大きい方で測る。これがシュート本数の主要な制御レバー(dominant): 高いほど低質局面を
  // 循環に回し shots/possession を実データ(~12%)へ寄せる。
  const inFinalThird = distGoal < SHOT_RANGE + 14;
  const shotBlocked = Math.max(shotLaneRisk, 1 - shotQuality); // 0(好機あり)〜1(好機なし)

  // アンチピンポン: 直前にこのボールを出してきた味方(=すぐ返す相手)を特定。
  // 受け取りから時間が経っていれば(2s)もう「返し」ではないので無効化する。
  const justReceivedFrom =
    owner.receivedFrom !== null && world.clock - owner.receivedAt < 2.0 ? owner.receivedFrom : null;
  // 前進の選択肢(=明確に前へ運べる味方)が他にあるか。あるなら横の安全な戻しを抑える。
  // これがあるとき限定でピンポン減点を強める(プレッシャー下の正当な循環は残す)。
  let forwardOptionExists = false;
  for (const t of teammates(world, owner)) {
    if (t.role === GK_ROLE || t.id === justReceivedFrom) continue;
    // オフサイドポジションの味方は「前進の選択肢」に数えない(Task AD)
    if (isOffsidePosition(world, owner.team, t.pos, OFFSIDE_SOFT_MARGIN)) continue;
    const fwd = (dist(owner.pos, goal) - dist(t.pos, goal)) / 12;
    if (fwd <= 0.25) continue;
    const target = passTarget(world, owner, t);
    const d = dist(owner.pos, target);
    if (d < 3 || d > 32) continue;
    if (laneRisk(world, owner.pos, target, owner.team) > 0.6) continue;
    forwardOptionExists = true;
    break;
  }

  // パス
  let bestReceiver: Player | null = null;
  let bestPassRisk = 0; // bestAction が Player のとき、そのパスの laneRisk(Task AA クリア判定用)
  for (const t of teammates(world, owner)) {
    const isGKReceiver = t.role === GK_ROLE;
    // オフサイド(ソフトルール, Task AD): リリース時(=今)オフサイドポジションの受け手は
    // 無効なターゲット。world.ts の笛(実ルール)と同じ共有述語なので、AIは「反則になる
    // パス」を構造的に選ばない。ラインとレベルに待機する runBehind ランナーは合法。
    if (!isGKReceiver && isOffsidePosition(world, owner.team, t.pos, OFFSIDE_SOFT_MARGIN)) continue;
    // runBehind ランナーへのスルーパス(Task AD): passTarget は intent.target(ライン裏)を返す
    const isRunBehindReceiver =
      !isGKReceiver &&
      t.intent !== null &&
      t.intent.kind === 'runBehind' &&
      t.intent.possTeam === owner.team &&
      t.intent.until > world.clock;
    const target = passTarget(world, owner, t);
    const d = dist(owner.pos, target);
    // GKへの戻しは「逃げ場」なので飛距離レンジを広めに許す(通常パスは3〜32m)
    if (d < 3 || d > (isGKReceiver ? 40 : 45)) continue;
    const risk = laneRisk(world, owner.pos, target, owner.team);
    // ほぼ確実にカットされるパスは選ばない。スルーパスだけゲートを緩める(Task AD):
    // laneRisk はコース上の点への守備者到達だけを見て「受け手のヘッドスタート(リリースで
    // ブレイクするランナーがラインの守備者と競り勝つレース)」を評価しない — ライン裏への
    // ボールは構造的に risk≈0.7 超になり、ゲートが硬いままだとスルーパスという動詞自体が
    // 消える。スコア側の (1-risk)*passSafety が高リスクの対価は引き続き払う。
    if (risk > (isRunBehindReceiver ? RUN_THROUGH_GATE : 0.7)) continue;
    let progress = (dist(owner.pos, goal) - dist(t.pos, goal)) / 12; // 前進するパスを好む
    // GKへのバックパス: 前進ペナルティはプレッシャーに応じて緩和する(逃げ場として選べるように)。
    // プレッシャーが無いときは緩和しない=GK経由のポゼッションが増えすぎないようにする
    if (isGKReceiver) {
      // ownDepth: 攻撃方向の進み具合(負=自陣、正=敵陣)
      const ownDepth = owner.team === 0 ? owner.pos.x : -owner.pos.x;
      // GKビルドアップは「自陣でのボール循環」。敵陣側では戻さない
      if (ownDepth > 0) continue;
      // 自陣深く(ペナルティエリア付近)では、プレッシャーが無くても落ち着いて循環できる。
      // それより前ではプレッシャー時の逃げ場としてのみ戻す。
      const calmBuildup = ownDepth < -22;
      if (!calmBuildup && pressure < 0.25) continue;
      // 前進ペナルティ(負値)を緩和。循環時は中立、プレッシャー時は逃げ場として僅かに加点
      progress = progress * (1 - pressure) * (calmBuildup ? 0 : 1) + 0.5 * pressure;
    }
    // ビルドアップの出口としてのバック(SB/CB)。自陣でのボール循環では、後ろ向きの
    // バックへの戻し/サイドチェンジを正当な選択肢として残す。Task-Fの後ろ向き減点は
    // シュートレンジ内(=敵ゴール近く)のみに効くので自陣には及ばないが、passProgressを
    // 上げた結果バックが永久に選ばれなくなるのを防ぐ: 自陣に近いほど後退ペナルティを緩和する。
    const ownAttackDepth = owner.team === 0 ? owner.pos.x : -owner.pos.x; // 負=自陣
    let backOutlet = false;
    if (!isGKReceiver) {
      const rc = classifyRole(world.formations[t.team], t.role);
      backOutlet = (rc.isSB || rc.isCB) && ownAttackDepth < 10;
    }
    if (backOutlet && progress < 0) {
      // 自陣(深いほど)では後退の進行ペナルティを最大ほぼ無効化(=安心して戻せる)。
      // ハーフライン付近では僅かに残す。switch/recycleの土台。
      const relief = Math.min(1, Math.max(0, (-ownAttackDepth + 5) / 35));
      progress *= 1 - 0.9 * relief;
    }
    const openness = Math.min(1, nearestOpponentDist(world, t) / 6);
    let score =
      (1 - risk) * W.passSafety +
      progress * W.passProgress +
      openness * W.passOpenness +
      pressure * W.passPressureRelief;
    // 縦・ライン間を割るパス(相手を1人以上越えて前へ刺す)に追加加点。
    // 横パス(誰も越えない)は0。これが「サイドの安全な循環」より「縦に刺す」を選ばせる中核。
    // GKへの戻しは対象外。前進していること(progress>0)を条件にして後ろ向きのパスは加点しない。
    let broken = 0;
    if (!isGKReceiver && progress > 0) {
      broken = lineBreakCount(world, owner, target);
      if (broken > 0) score += Math.min(2, broken) * W.passVertical;
    }
    // 横循環の抑制: ボールの進む向きが「横(攻撃方向に対して概ね真横)」のパスを減点する。
    // ベンチ指標は実際のパス角度(前方=|angle|<60°)で判定するので、進行距離(progress)ではなく
    // 出し手→受け手のベクトルの向きで「横さ(lateralness)」を測り、横パスを直接抑える。
    // これが「中盤のサイドへの安全な横パス連鎖(=試合が中盤で停滞する)」を最も直接的に減らす。
    // 自陣でのビルドアップ(バック/GKへの戻し・サイドチェンジ)は正当なので、距離で足切りした上で
    // backOutlet/GKは対象外にし、前進の選択肢があるときに強く効かせる。
    if (!isGKReceiver && !backOutlet) {
      const sign = owner.team === 0 ? 1 : -1;
      const fdx = sign * (target.x - owner.pos.x); // 攻撃方向の前進成分
      const sdy = Math.abs(target.y - owner.pos.y); // 横成分
      const ang = Math.atan2(sdy, fdx); // 0=真っ直ぐ前, π/2=真横, >π/2=後ろ
      // lateralness: 横(±60°〜120°)に近いほど1。前進パス・後退パスでは0。
      const DEG = Math.PI / 180;
      let lateralness = 0;
      if (ang > 60 * DEG && ang < 120 * DEG) {
        // 60°→120°の帯の中で、真横(90°)に近いほど強く減点
        lateralness = 1 - Math.abs(ang - 90 * DEG) / (30 * DEG);
      }
      if (lateralness > 0) {
        // 前進の選択肢があるときは強く、無いときは弱く。ライン越え(broken>0)は前進パスなので
        // ここには来ない。ファイナルサード(ゴール前)では崩しの横パスを残すため減点を弱める。
        const gate = forwardOptionExists ? 1 : 0.35;
        // ファイナルサード(ゴール前)では横の循環(崩しの横パス・サイドチェンジ)を
        // 罰しない。これがないと攻撃側がボックスへ縦に殺到してシュート/得点が過剰になる。
        // ゴールから遠いほど(中盤〜自陣寄り)横循環を強く抑える。
        const finalThird = distGoal < SHOT_RANGE + 14 ? 0.4 : 1;
        score -= lateralness * W.lateralPassPenalty * gate * finalThird * (1 - 0.5 * pressure);
      }
    }
    // アンチピンポン: 直前の出し手へすぐ返すパスを減点。前進の選択肢があるときは強く、
    // 無い(循環せざるを得ない)ときは弱く効かせ、A→B→A→B の往復を断つ。
    if (!isGKReceiver && t.id === justReceivedFrom) {
      score -= W.pingPongPenalty * (1 - pressure) * (forwardOptionExists ? 1 : 0.3);
    }
    // 攻撃参加のラン(レイトラン/オーバーラップ/アンダーラップ/裏抜け)で前へ走っている味方は
    // 「崩しの受け手」として早めに使う。守備が戻る前に走り込む選手へ通せるよう、
    // 前進パス(progress>0)に限って加点する(後ろ向きの受け手は対象外)。
    // これがないと、走り込んだ中盤が一瞬空いても保持者がシュート/前線パスを優先して使われない。
    // runBehind を含める(Task AD): 旧実装ではランナーがライン裏にキャンプして受け値を
    // 自力で稼いだが、再調律後はラインとレベルで待つ=スルーパス(intent.target への出し)を
    // パサー側が選ばないと裏抜けの経済が成立しない。
    if (
      !isGKReceiver &&
      progress > 0 &&
      t.intent &&
      (t.intent.kind === 'lateRun' ||
        t.intent.kind === 'overlap' ||
        t.intent.kind === 'underlap' ||
        t.intent.kind === 'runBehind')
    ) {
      // runBehind は半分の重み(Task AD 較正): フル重みだとスルーパスが仕掛け(takeOn)や
      // 崩しの他動詞を締め出し、goals が帯域上限を超え take-on が床を割った(40シード計測)。
      score += W.runReceiverBonus * (t.intent.kind === 'runBehind' ? 0.5 : 1);
    }
    // ワンツーで裏へ走る味方(giveAndGo意図)は最優先で使う。守備の裏に走り込む選手へ
    // スルーパス(passTargetのリード)で通すと一気にラインを越える。
    if (!isGKReceiver && t.intent && t.intent.kind === 'giveAndGo') {
      score += W.giveAndGoReceiverBonus;
    }
    // シュートレンジ内では後ろ向き・横向きパスを大幅に減点し、シュート/ドリブル/前進パスを優先。
    // ただし「無理に撃つ/突っ込む価値がない」局面では循環(後退・横)を許す。これが Task Q の本数
    // 削減の肝: レンジ内へ入った攻撃が必ず1本のシュート(funnel)で終わるのを断つ。減点の緩和は
    //  (a) 囲まれている時(pressure高)
    //  (b) シュートコースがふさがっている時(shotLaneRisk高)
    //  (c) そもそもシュートの質が低い時(1-shotQuality 高 = 遠い/横) ← clear lane でも遠目は循環へ
    // で効かせる。質が高い(至近・正面)ほど (1-shotQuality) は小さく、減点は残って前進/シュートを
    // 優先する。前進パス(progress>0.15)は backwardness=0 なので影響なし=Task Pの前進志向は保つ。
    // GKへの戻しは別ロジックで対象外。
    if (!isGKReceiver && distGoal < SHOT_RANGE) {
      // backwardness: 後退の度合い。progressが小さい(横〜後ろ)ほど大きい。
      // progress>=0.15(およそ1.8m以上前進)なら0。
      const backwardness = Math.max(0, 0.15 - progress);
      const relax = Math.max(pressure, shotLaneRisk, 1 - shotQuality);
      score -= backwardness * W.passBackwardInRange * (1 - relax);
    }
    // 反射的リリースの抑制(Task N): 前に芝が大きく開いていて低圧の時(openGrassAhead)、
    // ライン間を割らず・連携の受け手でもなく・前進量も小さい「横/短い置きパス」を減点する。
    // 狙いは「受けた瞬間に空いた前へ運ばず近場へ流す」反射的リリースだけを抑えること。
    // ライン越えの縦パス(broken>0)・ワンツー・攻撃参加ランへのパスは対象外なので、
    // 真に良い前進パスは引き続きキャリーに勝つ。
    const isCombinationReceiver =
      t.intent !== null &&
      (t.intent.kind === 'giveAndGo' ||
        t.intent.kind === 'lateRun' ||
        t.intent.kind === 'overlap' ||
        t.intent.kind === 'underlap');
    if (
      !isGKReceiver &&
      openGrassAhead > 0 &&
      broken === 0 &&
      !isCombinationReceiver &&
      progress < 0.4 // 約4.8m未満の前進(=明確な前進パスではない)
    ) {
      score -= openGrassAhead * W.reflexivePassPenalty;
    }
    // ファネル・エグジット(Task Z Req3): ファイナルサードで前方の選択肢がなく好機もない(shotBlocked高)
    // とき、後方の安全な出口(ボールサイドのバック/ピボット)への「循環して出る」パスに積極的な加点を
    // 与える。減点緩和(上の passBackwardInRange)ではなく明示的なボーナスなので、無理な低質シュート
    // より「一度出て入り直す」を選べる。ファイナルサード限定なので中盤停滞(rejected lever #1)にはならない。
    if (!isGKReceiver && inFinalThird && !forwardOptionExists && shotBlocked > 0.5) {
      const exitSign = owner.team === 0 ? 1 : -1;
      const behindBall = exitSign * (target.x - owner.pos.x) < -1; // 明確に後方=循環の出口
      if (behindBall) {
        const rc = classifyRole(world.formations[t.team], t.role);
        const isOutlet = rc.isSB || rc.isCB || !rc.isFW; // バック/中盤(FW以外)= 出口になれる
        const ballSide = t.pos.y * owner.pos.y >= 0 ? 1 : 0.6; // ボールサイドを優遇
        if (isOutlet) score += W.funnelExitBonus * shotBlocked * openness * ballSide;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestAction = t;
      bestReceiver = t;
      bestPassRisk = risk;
    }
  }

  // ── サイドチェンジ(Task AA): ボールサイドが過密で「前進の選択肢が無い」とき、
  // 逆サイドの開いたワイドへ40〜70mの対角ロフト。逆サイドのSB/ウィンガーのアンカーは
  // ボールが逆に開くほどタック解除される(formation.ts の farFactor)ので、ボールが渡れば
  // 受け手は幅を取り直す。リスクは共有のロフト・レーン関数。
  // 2つのゲート(計測に基づく):
  //  - 深いファイナルサード(attackDepth >= HALF_L-28)では発火しない: ボックス際の過密は
  //    「シュートの直前」の正常な状態で、そこで逃げると攻撃が仕上げ直前に必ず中断される。
  //  - forwardOptionExists なら発火しない: 前進できる攻撃を対角へ「リセット」するのが
  //    shots 半減の主因だった(12×8min ablation: switch有 1.33 vs 無 2.96 shots/tm)。
  //    サイドチェンジは「過密で詰まった」ときの解放弁 — それが本来の意味。
  let switchTarget: Vec | null = null;
  if (
    attackDepth < HALF_L - 28 &&
    !forwardOptionExists &&
    world.clock >= world.switchReadyAt[owner.team]
  ) {
    let oppsNear = 0;
    for (const o of opponents(world, owner.team)) {
      if (dist(o.pos, owner.pos) < SWITCH_OVERLOAD_RADIUS) oppsNear++;
    }
    if (oppsNear >= 3) {
      const T = loftFlightTime(SWITCH_APEX);
      for (const t of teammates(world, owner)) {
        if (t.role === GK_ROLE) continue;
        if (t.pos.y * owner.pos.y >= 0 || Math.abs(t.pos.y) < 10) continue; // 逆サイドのワイドのみ
        if (isOffsidePosition(world, owner.team, t.pos, OFFSIDE_SOFT_MARGIN)) continue; // オフサイドの受け手は無効(Task AD)
        if (nearestOpponentDist(world, t) < 6) continue; // 受け手が既に詰められているなら意味がない
        const target = clampToPitch(add(t.pos, scale(t.vel, Math.min(1.6, T))), 1.5);
        const d = dist(owner.pos, target);
        if (d < SWITCH_MIN_DIST || d > SWITCH_MAX_DIST) continue;
        const risk = loftedRisk(world, owner, target, SWITCH_APEX, arrivalTime(dist(t.pos, target)));
        if (risk > 0.6) continue;
        const openness = Math.min(1, nearestOpponentDist(world, t) / 8);
        const score = (1 - risk) * W.switchBase * openness;
        if (score > bestScore) {
          bestScore = score;
          bestAction = 'switch';
          switchTarget = target;
        }
      }
    }
  }

  // hold(その場で待つ, Task V): 低圧で、他の全選択肢(シュート/ドリブル/パス)が乏しく、
  // かつ味方が攻撃参加のラン中(裏抜け/レイトラン/オーバー/アンダー/ワンツー)で走り込み途中の
  // とき、ボールを持って「ランの発展を待つ」。他のどの行動より高い時だけ選ぶ(=選択肢が良ければ
  // それを優先)。持続は HOLD_DURATION で頭打ち(圧力上昇/ランの失効でも自然に解ける=デッドロック防止)。
  // ファイナルサード限定: 中盤で待つとボールが停滞して前進・ゴールが激減するため(rejected lever #1
  // の位置押し上げと同型の失点)、ウィングが「崩しのランを待つ」高い位置でのみ発火させる。
  const inAttackingThird = attackDepth > HALF_L - 35;
  if (pressure < HOLD_MAX_PRESSURE && inAttackingThird) {
    let runsMidFlight = 0;
    for (const t of teammates(world, owner)) {
      if (t.role === GK_ROLE || !t.intent) continue;
      const k = t.intent.kind;
      // runBehind の「到着」はオンサイドのホールド点で測る(Task AD)。intent.target は
      // ライン裏のブレイク目標で、保持中は構造的に >3m 先のまま — 旧式だとラインで待機中の
      // ランナーが永遠に「走り込み中」と数えられ、保持者の hold が再武装され続けて
      // ファイナルサードの保持が異常に深くなる(goals 過熱の一因、40シード計測)。
      const runReadyPoint =
        k === 'runBehind'
          ? vec(clampOnsideX(world, t.team, t.intent.target.x), t.intent.target.y)
          : t.intent.target;
      if (
        (k === 'runBehind' || k === 'lateRun' || k === 'overlap' || k === 'underlap' || k === 'giveAndGo') &&
        t.intent.possTeam === owner.team &&
        t.intent.until > world.clock &&
        dist(t.pos, runReadyPoint) > 3 // まだ走り込み中(到着していない)
      ) {
        runsMidFlight++;
      }
    }
    if (runsMidFlight > 0) {
      const holdScore = W.holdBase + Math.min(2, runsMidFlight) * W.holdRunWait * (1 - pressure);
      if (holdScore > bestScore) {
        bestScore = holdScore;
        bestAction = 'hold';
      }
    }
  }

  // ── クリア(Task AA): 自陣ゴール前で詰められているのに、選ばれかけた行動が「運ぶ/構える/
  // 仕掛け」なら、明示のクリアで置き換える。「自ボックスで囲まれたCBが相手ゴールへ向かって
  // 冷静に運び出す」不条理を、まさにその選択が起きる瞬間に断つ。安全なパスが選ばれている
  // 局面には介入しない(プロは蹴り出さずに繋ぐ — それは正しい)。計測注: この守備時代は
  // プレスのコミットが1〜2枚なので「30m以内に安全な出口が全く無い」状態は構造的に発生せず
  // (25ゲート状態中0)、spec の字義どおりの条件ではクリアが一度も発火しない。
  // 近いタッチライン側の前方チャンネルへ高く蹴る(中央へは蹴り込まない=実守備セオリー)。
  // 意図された50/50: 着地は素のレースで争われ、canonical 完成度では「相手が回収した時だけ
  // 失敗」になる(クリアの独立イベント化は Task AB のスコープ)。
  // 置き換え対象: (a)危険地帯での運ぶ/構える/仕掛け(スワームの中を冷静に運び出す不条理 —
  // 計測ではこの時代の意思決定は100%パスを選ぶため、実質ガード)、(b)リスクの高いパス
  // (risk > 0.4 = 群がりの中を通す賭け。自ボックスでの失敗は即失点級なので、EV中立の
  // パス採点より現実の守備者ははるかにリスク回避的 — 蹴り出しがセオリー)。
  const clearanceInstead =
    bestAction === 'dribble' ||
    bestAction === 'hold' ||
    bestAction === 'takeOn' ||
    (typeof bestAction !== 'string' && bestPassRisk > 0.4);
  if (clearanceInstead && ownGoalD < CLEARANCE_GOAL_DIST) {
    let swarm = 0;
    for (const o of opponents(world, owner.team)) {
      if (dist(o.pos, owner.pos) < 6) swarm++;
    }
    if (pressure > CLEARANCE_PRESSURE || swarm >= 2) {
      const atkSign = owner.team === 0 ? 1 : -1;
      const ySide = owner.pos.y >= 0 ? 1 : -1;
      const target = clampToPitch(
        vec(owner.pos.x + atkSign * CLEARANCE_DIST, ySide * (HALF_W - 10)),
        2,
      );
      executeLoftedPass(world, owner, target, CLEARANCE_APEX, 'clearance');
      return;
    }
  }

  if (bestAction === 'shoot') {
    executeShot(world, owner);
  } else if (bestAction === 'takeOn') {
    // 仕掛け: ボールを相手の脇へ押し出しバーストで抜く(世界側で実行・徒競走に移行)。
    // bestAction が 'takeOn' になるのは takeOn 候補が非nullのときだけ。
    executeTakeOn(world, owner, takeOn!.defender);
  } else if (bestAction === 'cross') {
    // クロス(Task AA): 蹴ると同時にボックスラン(着地点アタック+ファーポスト)を発火させる。
    // 着地の争いで味方が勝てば、ボックス内の受けは Z のワンタッチ・バイパスに乗る。
    triggerCrossRuns(world, owner, crossAim!); // 実行ノイズが乗る前の狙い点へ走らせる
    // 実際の着弾はランナーの「手前」(ボール側)へ1.8mずらす — マーカーはランナーの
    // ゴール側に立つ(markTarget)ので、ゾーンの真上に落とすとマーカーが構造的に先着する。
    // 手前に落とせばランナーがマーカーとボールの間に入る(実クロスの蹴り分けと同じ)。
    const shortAim = add(crossAim!, scale(norm(sub(owner.pos, crossAim!)), 1.8));
    executeLoftedPass(world, owner, shortAim, CROSS_APEX, 'cross');
  } else if (bestAction === 'switch') {
    executeLoftedPass(world, owner, switchTarget!, SWITCH_APEX, 'switch');
    world.switchReadyAt[owner.team] = world.clock + SWITCH_COOLDOWN;
  } else if (bestAction === 'hold') {
    // 待つ: シールドして構える。持続は HOLD_DURATION まで。
    owner.moveTarget = shieldTarget(world, owner);
    owner.intent = {
      kind: 'hold',
      target: owner.moveTarget,
      until: world.clock + HOLD_DURATION,
      possTeam: owner.team,
    };
  } else if (bestAction !== 'dribble') {
    executePass(world, owner, passTarget(world, owner, bestAction));
    // ワンツー(give-and-go): 前進パスを出した直後、保持者とゴールの間に「抜ける価値のある
    // 守備者」がいて、自分が裏へ走り込めば数的優位を作れるなら、パサー自身が裏抜け意図を持つ。
    // リターンを受け手の decideOwner が giveAndGoReceiverBonus で拾う。
    maybeGiveAndGo(world, owner, bestReceiver!, goal);
  } else {
    // ドリブル: ゴール方向へ、ただしプレッシャーから逃げるベクトルを混ぜる
    const toGoal = norm(sub(goal, owner.pos));
    let escape = vec(0, 0);
    for (const opp of opponents(world, owner.team)) {
      const d = dist(opp.pos, owner.pos);
      if (d < 5) escape = add(escape, scale(norm(sub(owner.pos, opp.pos)), (5 - d) / 5));
    }
    const dir = norm(add(toGoal, scale(escape, 0.8)));
    // 前方が大きく開いている時は、より遠くまで(意味のある前進で)運び込み、
    // やり切る時間も延ばす。詰められている時は従来どおり短い逃げドリブル。
    const carryDist = 5 + spaceTerm * (1 - pressure) * 6; // 5〜11m
    const carryDur = 0.4 + spaceTerm * (1 - pressure) * 0.5; // 0.4〜0.9s
    owner.moveTarget = clampToPitch(add(owner.pos, scale(dir, carryDist)), 1);
    owner.intent = {
      kind: 'carry',
      target: owner.moveTarget,
      until: world.clock + carryDur,
      possTeam: owner.team,
    };
  }
}

/**
 * ワンツー(give-and-go)の発動判定。パスを出した保持者が、抜ける価値のある守備者の裏へ
 * 走り込む意図を設定する。条件:
 *  - 受け手(combination partner)が近くにいて前進方向の連携になる(横〜やや前)
 *  - 保持者とゴールの間に「越える対象の守備者」が1人いる(beatable)
 *  - その局面が数的優位(対象守備者の近くで攻撃側 >= 守備側)
 * 発動するとパサーは守備者の裏(攻撃方向に少し先)へ runBehind 同様のスルーパス受けを狙う。
 */
function maybeGiveAndGo(world: World, owner: Player, receiver: Player, goal: Vec): void {
  if (receiver.role === GK_ROLE || owner.role === GK_ROLE) return;
  const sign = owner.team === 0 ? 1 : -1;
  // ボックスのすぐ手前〜中盤前目でのみ(自陣深くでのワンツーは不要)。攻撃方向の深さで足切り。
  const attackDepth = sign * owner.pos.x; // +HALF_L=敵ゴール際
  if (attackDepth < -5) return;
  // 越える対象: 保持者より前(攻撃方向)、かつゴールまでの間にいる最寄りの守備者(GK除く)
  let beat: Player | null = null;
  let beatD = Infinity;
  for (const o of opponents(world, owner.team)) {
    if (o.role === GK_ROLE) continue;
    if (sign * (o.pos.x - owner.pos.x) <= 0.5) continue; // 前方のみ
    if (sign * (goal.x - o.pos.x) <= 0) continue; // ゴールより手前
    const d = dist(o.pos, owner.pos);
    if (d < 14 && d < beatD) {
      beatD = d;
      beat = o;
    }
  }
  if (!beat) return;
  // 数的優位: 対象守備者の周囲12mで攻撃側人数 >= 守備側人数(GK除く)。
  // パサーが裏へ走れば守備1人に対して受け手+パサーで上回る、という状況に絞る。
  let atk = 0;
  let def = 0;
  for (const p of world.players) {
    if (p.role === GK_ROLE) continue;
    if (dist(p.pos, beat.pos) > 12) continue;
    if (p.team === owner.team) atk++;
    else def++;
  }
  if (atk < def + 1) return;
  // 走り込む先: 対象守備者の裏(攻撃方向に6m先)を狙う。スルーパスのリードで受ける。
  const behind = clampToPitch(vec(beat.pos.x + sign * 6, owner.pos.y + (beat.pos.y - owner.pos.y) * 0.3), 2);
  owner.moveTarget = behind;
  owner.intent = {
    kind: 'giveAndGo',
    target: behind,
    until: world.clock + 2.0,
    possTeam: owner.team,
  };
}

function clampToPitch(v: Vec, margin = 2): Vec {
  return vec(
    Math.max(-HALF_L + margin, Math.min(HALF_L - margin, v.x)),
    Math.max(-HALF_W + margin, Math.min(HALF_W - margin, v.y)),
  );
}

/**
 * オフボール攻撃: 意味のある動きの候補(意図)を生成し、
 * それぞれ「守備がどう反応するか」を先読みして自分+チームの利得で採点。
 * 選んだ意図は持続時間のあいだやり切る。
 *
 * 囮(decoy)が選ばれるのは、自分が受ける価値(self)は低くても
 * 守備者を引っ張って味方が空く価値(team)が大きいとき。
 */
function chooseOffBallIntent(world: World, p: Player, owner: Player): void {
  const W = TEAM_WEIGHTS[p.team];
  const goal = goalCenter(p.team);
  const sign = p.team === 0 ? 1 : -1;
  const anchor = dynamicAnchor(world, p);
  // FWは攻撃時のアンカーが相手最終ラインにピン留めされている。
  // 「降りる」候補ばかり選んで持ち場が空かないよう、高い基準点を保つ規律を強める。
  const cls = classifyRole(world.formations[p.team], p.role);

  interface Cand {
    kind: IntentKind;
    target: Vec;
    bonus: number;
    duration: number;
    /** 採点用の到達点(Task AD)。runBehind はオンサイドのホールド点で価値を測る
     * (target はライン裏のブレイク目標 = リリース後にしか合法に立てない)。 */
    scoreTarget?: Vec;
  }
  // FWは高い位置を保つことに価値がある(相手DFと相対し、裏とライン間を伺う)。
  // hold(=高いアンカー維持)への加点を厚くする
  const holdBonus = cls.isFW ? W.holdBonus + 0.6 : W.holdBonus;
  const cands: Cand[] = [{ kind: 'hold', target: anchor, bonus: holdBonus, duration: 1.0 }];

  // サポート: 保持者から10mの位置に降りて短いパスコースを作る
  const baseAng = Math.atan2(p.pos.y - owner.pos.y, p.pos.x - owner.pos.x);
  for (const da of [-0.6, 0, 0.6]) {
    const ang = baseAng + da;
    cands.push({
      kind: 'support',
      target: clampToPitch(add(owner.pos, vec(Math.cos(ang) * 10, Math.sin(ang) * 10))),
      bonus: 0,
      duration: 1.2,
    });
  }

  // 裏抜け(Task AD 再調律): オフサイドライン(後方から2人目、共有 offsideLineX)を基準に、
  // ラインとレベル(オンサイド)で待機し、リリースでライン裏のブレイク目標へ走る。
  // 旧実装の「lineX+6 に張り付く(キャンプ)」を廃止 — target はブレイク目標(スルーパスの
  // 狙い先)、採点と待機は clampOnsideX のホールド点で行う。ブレイクは aiStep 側
  // (自チームのパス飛行中に target へ走る)が担う。
  const lineX = offsideLineX(world, (1 - p.team) as 0 | 1);
  const behindX = Math.max(-HALF_L + 2, Math.min(HALF_L - 2, lineX + sign * RUN_BREAK_DEPTH));
  for (const dy of [0, -7, 7]) {
    const target = clampToPitch(vec(behindX, p.pos.y + dy));
    cands.push({
      kind: 'runBehind',
      target,
      scoreTarget: clampToPitch(vec(clampOnsideX(world, p.team, target.x), target.y)),
      bonus: 0.05,
      duration: 3.2, // Task W §4: 20m超の裏抜けをやり切れる長さに
    });
  }

  // 囮: ワイドに開いて守備者を持ち場から引っ張り出す
  for (const ySide of [-1, 1]) {
    cands.push({
      kind: 'decoy',
      target: clampToPitch(vec(p.pos.x + sign * 4, ySide * (HALF_W - 4))),
      bonus: 0,
      duration: 1.8,
    });
  }
  // 囮(偽9番): 自陣方向へ降りてマーカーを最終ラインから引きずり出す。
  // 自分が受ける価値はほぼないが、空いた裏のスペースが味方のteamDeltaに表れる
  cands.push({
    kind: 'decoy',
    target: clampToPitch(vec(p.pos.x - sign * 7, p.pos.y * 0.7)),
    bonus: 0,
    duration: 1.8,
  });

  // 中盤(SB/CB/FW以外)の攻撃参加。ボールがファイナルサード(敵陣最後の35m)に
  // あるとき、ペナルティエリア内・エッジ(ゴール25m圏)へのレイトラン候補を出す。
  // 採点(predictRunUtility+規律ペナルティ)が引き受けるので、価値があるときだけ選ばれる。
  const isMid = !cls.isFW && !cls.isSB && !cls.isCB;
  const ballAttackX = sign * world.ball.pos.x; // 攻撃方向のボール深さ(+ほど敵陣)
  if (isMid && ballAttackX > HALF_L - 35) {
    for (const dy of [-8, 0, 8]) {
      cands.push({
        kind: 'lateRun',
        target: clampToPitch(vec(goal.x - sign * 13, dy)),
        bonus: W.lateRunBonus,
        duration: 3.2, // Task W §4
      });
    }
  }

  // オーバーラップ/アンダーラップ(監督の戦術 wideRuns でスケール)。
  // ボールがワイド(タッチラインから15m以内)で、保持者と同サイド・近くにいる
  // SB/中盤/ウィングが、外を追い越す or 内側のポケットへ走る候補を出す。
  const wideRuns = world.tactics[p.team].wideRuns;
  const ballY = world.ball.pos.y;
  const ballWide = Math.abs(ballY) > HALF_W - 15;
  const ySide = ballY >= 0 ? 1 : -1;
  const sameSide = p.pos.y * ballY > 0; // 保持者と同じサイド
  const eligibleWide = !cls.isCB; // CB以外(SB/中盤/FW)
  if (wideRuns > 0 && ballWide && eligibleWide && sameSide && dist(p.pos, owner.pos) < 28) {
    const wb = W.wideRunBonus * wideRuns;
    // オーバーラップ: 保持者の外側(タッチライン際)を前方へ追い越す
    cands.push({
      kind: 'overlap',
      target: clampToPitch(vec(owner.pos.x + sign * 12, ySide * (HALF_W - 3))),
      bonus: wb,
      duration: 3.0, // Task W §4
    });
    // アンダーラップ: 内側ハーフスペースのポケット(相手DFとMFの間)へ
    cands.push({
      kind: 'underlap',
      target: clampToPitch(vec(owner.pos.x + sign * 12, ySide * 13)),
      bonus: wb,
      duration: 3.0, // Task W §4
    });
  }

  // ポストへのボックスラン候補(Task AA)。ボールがファイナルサード(クロス圏の深さ)に
  // あるとき、クロスの的(ニア/ファーポスト)へ走り込む候補を出す。クロスは「人がいないと
  // 蹴れない」(decideOwner の bodies ゲート)ので、この候補がクロスの前段を作る — 保持者は
  // hold 機構(ランの発展を待つ)で自然に待ち、走者が届く距離に入った再判断でクロスが成立する。
  // 徴発(保持者側からの意図上書き)ではなく採点の土俵に乗せる: 価値が無ければ選ばれない。
  // CB以外(FW/中盤/SB)。lateRun 扱い=攻撃参加ラン(規律減点×0.25・到着失効なし・
  // 味方のパスを跨いで持続)。
  const ballFinalThird = ballAttackX > HALF_L - CROSS_ZONE_DEPTH;
  if (ballFinalThird && !cls.isCB) {
    const ySideB = ballY >= 0 ? 1 : -1;
    // ラン目標はゴールマウスではなくポスト前のゾーン(7〜9m)。6ヤードボックス内は密集で
    // predictRunUtility の受け値がほぼ0になり候補が常に負けるため、着地を襲える距離
    // (クロスの bodies 判定 ≈ 狙い点から19m)に入りつつ受け値の残るゾーンへ走らせる。
    const nearPost = clampToPitch(vec(goal.x - sign * 7, ySideB * 6), 1.5);
    const farPost = clampToPitch(vec(goal.x - sign * 8.5, -ySideB * 6.5), 1.5);
    for (const target of [nearPost, farPost]) {
      if (dist(p.pos, target) > 30) continue; // 届かない遠くからは走らない
      cands.push({ kind: 'lateRun', target, bonus: W.postRunBonus, duration: 2.5 });
    }
  }

  // 基準: 「動かず持ち場にいた場合」の予測。各候補の価値はここからの差分で測る
  const baseline = predictRunUtility(world, p, anchor);
  const ownerPressured = nearestOpponentDist(world, owner) < 3.5;

  let best: Cand = cands[0];
  let bestScore = -Infinity;
  for (const c of cands) {
    // 採点は「今合法に立てる到達点」(scoreTarget があればそれ)で行う(Task AD)。
    // predict はオフサイドポジションの受け値を0にするので、ライン裏の点をそのまま
    // 採点すると裏抜けが構造的に選ばれなくなる — ランの価値はラインとレベルの位置で測る。
    const reach = c.scoreTarget ?? c.target;
    const u = c.kind === 'hold' ? baseline : predictRunUtility(world, p, reach);
    // 囮の価値: 自分が動くことで味方の受けやすさがどれだけ「増える」か
    const teamDelta = u.team - baseline.team;
    const progress = -dist(c.target, goal) / PITCH_LENGTH;
    // FWは高い基準点(=相手最終ライン)から離れる動きを強めに抑制する。
    // ただしラインを越える裏抜けは別(下のrunBehindBonusで価値付け)。
    // 攻撃参加のラン(レイトラン/オーバーラップ/アンダーラップ)は基準点から大きく
    // 離れること自体が目的なので、規律ペナルティを軽くする(=ボックスへ届かせる)。
    // これがないと「持ち場から遠い」だけで常にhold/supportに負けて中盤が攻撃参加できない。
    const isAttackRun =
      c.kind === 'lateRun' || c.kind === 'overlap' || c.kind === 'underlap';
    const disciplineW =
      (c.kind === 'support' ? W.offDisciplineSupport : W.offDisciplineOther) *
      (cls.isFW && c.kind !== 'runBehind' ? 4 : 1) *
      (isAttackRun ? 0.25 : 1);
    const discipline = -dist(c.target, anchor) * disciplineW;

    let bonus = c.bonus;
    // 保持者が囲まれている時はサポートが急務
    if (c.kind === 'support' && ownerPressured) bonus += W.supportPressuredBonus;
    // 裏抜けの価値は「ラインを越えること」自体(パスコースは走った後に生まれる)
    if (c.kind === 'runBehind' && sign * (c.target.x - lineX) > 0) bonus += W.runBehindBonus;

    const score =
      u.self * W.offSelf + teamDelta * W.offTeamDelta + progress * W.offProgress + discipline + bonus;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  p.intent = {
    kind: best.kind,
    target: best.target,
    until: world.clock + best.duration,
    possTeam: owner.team,
  };
  // runBehind はオンサイドのホールド点で待機(Task AD)。ブレイクはリリース時(aiStep)。
  p.moveTarget =
    best.kind === 'runBehind'
      ? clampToPitch(vec(clampOnsideX(world, p.team, best.target.x), best.target.y))
      : best.target;
}

/**
 * ビルドアップ時の前線プレスの目標点(カバーシャドウ)。
 * 保持者に圧力をかけつつ、保持者の「後ろ(相手の攻撃方向と逆=出口)」の最深の味方への
 * パスコースを身体で切る。保持者と出口を結ぶ線上の、保持者寄り(0.9m)に詰める。
 * 出口が見つからなければ保持者へ素直に詰める。
 *
 * 注意: この式は predict.ts の守備ミラーに同一実装でコピーすること(invariant)。
 * oppSign = 相手(攻撃側)の攻撃方向(team0なら+1)。
 */
function coverShadowTarget(
  world: World,
  owner: Player,
  defendersTeam: number,
  oppSign: number,
): Vec {
  // 出口候補 = 保持者の後ろ(相手ゴールから遠い側)にいる相手フィールドプレーヤーのうち最深。
  // GKは除く(GKへの戻しは脅威ではないため切らない)。
  const outlets = world.players.filter(
    (q) =>
      q.team !== defendersTeam &&
      q.role !== GK_ROLE &&
      q.id !== owner.id &&
      oppSign * (q.pos.x - owner.pos.x) < -2, // 保持者より後ろ(自陣側)に2m以上
  );
  if (!outlets.length) return { ...owner.pos };
  // 最も後ろ(=ビルドアップの底)の出口を切る
  const outlet = outlets.reduce((a, b) =>
    oppSign * a.pos.x < oppSign * b.pos.x ? a : b,
  );
  // 保持者に詰めつつ(=コースを切る向きへ0.9mだけ寄せる)。詰めきりを優先し、
  // 受け身に間に立つだけにしない(これが「眺める」を「engageする」に変える)。
  const dir = norm(sub(outlet.pos, owner.pos));
  return clampToPitch(add(owner.pos, scale(dir, 0.9)), 1);
}

/**
 * コンパクトブロックの目標点。保持者が自ゴールを脅かす(危険地帯に侵入した)とき、
 * マークもコース切りも持たない「空き」ゾーン守備者を、遠い持ち場のアンカーから
 * ボールとゴールを結ぶシュートコース(=危険地帯)へ寄せる。狙いは2つ:
 *  - シュートコースを身体で埋めてシュート確度を下げる(シュート本数の抑制)
 *  - 攻撃が自陣に侵入しているのに持ち場で眺めるだけの守備者をなくす
 * 全員が一点へ collapse しないよう、奥行きはゴール前 ~10–15m のコース上の点へ 0.6 だけ
 * 寄せ、横はボールy軸±8m帯に収める(自分の横位置の相対順は保つ=コースに扇状に並ぶ)。
 *
 * 注意: predict.ts の守備ミラーに同一実装でコピーすること(invariant)。
 */
function compactBlockTarget(anchor: Vec, ballPos: Vec, ownGoal: Vec): Vec {
  // ボール→ゴールのシュートコース上、保持者の「6m ゴール側」に立って割って入る。ただし奥行きは
  // ゴールから 7〜14m に制限する: ゴール真ん前に壁を作ると(a)リバウンドで撃ち直され本数が減らず
  // (b)至近シュートまで全部塞いで得点が消える。ボックス手前で「コンテスト(shotRisk を上げて
  // 撃たせず循環に戻す)+持ち込み阻止」をしつつ、ゴール口は塞がない位置に置く。
  const depthFromGoal = Math.max(7, Math.min(14, dist(ballPos, ownGoal) - 6));
  const laneDir = norm(sub(ballPos, ownGoal)); // ゴール→ボール方向
  const lanePoint = add(ownGoal, scale(laneDir, depthFromGoal));
  // 横はコースのy軸±8m帯に収める(自分の横位置の相対順は保ち、コースに扇状に並ぶ)。
  const y = lanePoint.y + Math.max(-8, Math.min(8, anchor.y - lanePoint.y));
  return clampToPitch(vec(lanePoint.x, y), 1);
}

/**
 * ゾーン守備: ボールに最も近い1人がプレス、残りは自分の基準点(ゾーン)を守り、
 * ゾーンに入ってきた相手だけゴール側に立ってマークする。
 */
/** キー由来の決定論的ジッター(0..1)。rand()を使わない(リプレイ/predictを単純に保つ, Task W §3) */
function idJitter01(key: number): number {
  const h = (key * 2654435761) >>> 0; // Knuth 乗算ハッシュ
  return (h % 1000) / 1000;
}
/**
 * 守備の再判断カデンス(0.15〜0.25s、ジッター)。
 * 入力は「チーム相対id」(= p.id - チーム先頭id)であること(Task AL)。グローバルidを渡すと
 * team0(id 0-10)と team1(id 11-21)が別のジッター多重集合を持ち、平均カデンスが team0≈0.213s /
 * team1≈0.199s と恒久的に非対称になる(リーグ公平性の欠陥)。チーム相対idなら両チーム同一。
 */
function decideInterval(relId: number): number {
  return DEFENSE_DECIDE_MIN + (DEFENSE_DECIDE_MAX - DEFENSE_DECIDE_MIN) * idJitter01(relId);
}
/** チームの先頭プレイヤーid(=そのチームで最小のid)。id はチーム順の連番で振られる(world.ts)。 */
function teamBaseId(world: World, team: number): number {
  let base = Infinity;
  for (const p of world.players) if (p.team === team && p.id < base) base = p.id;
  return base;
}

/**
 * プレスの目標点(Task W)。保持者の現在位置ではなく速度ぶんリードした迎撃点を狙う。
 * predict.ts のミラーと一字一句揃えること(invariant)。
 */
function pressTarget(owner: Player): Vec {
  return add(owner.pos, scale(owner.vel, PRESS_LEAD_TIME));
}
/**
 * 抜かれたプレッサーの回復ラン目標(Task W)。保持者→自ゴール線上、保持者から
 * RECOVER_GOALSIDE_DIST ゴール側の点へ全力で戻る。predict.ts のミラーと揃えること(invariant)。
 */
function recoverTarget(owner: Player, ownGoal: Vec): Vec {
  return clampToPitch(add(owner.pos, scale(norm(sub(ownGoal, owner.pos)), RECOVER_GOALSIDE_DIST)), 1);
}
// マーク目標点は line.ts の markTargetPoint(共有実装)を使う(Task AD)。
// 旧・手動ミラー(ai.ts / predict.ts に同式を二重保守)は共有化により廃止。

function decideDefense(world: World, defendersTeam: number): void {
  // GKはプレス・マークに参加しない(aiStep側で専用ポジショニング)。
  // 仕掛けのバースト中の選手(Task Y)も除外: 押し出したルーズボールを追うことにコミットしており
  // 守備には回れない。これは owner===null(ルーズボール)の局面でしか起きず、その局面では predict が
  // early-return して守備反応を評価しないため、predict ミラーは不要(decideDefense の反応式は不変)。
  const defenders = world.players.filter(
    (p) =>
      p.team === defendersTeam &&
      p.role !== GK_ROLE &&
      p.burstUntil <= world.clock &&
      // Task AD: 自チームのパス飛行中にブレイク中の runBehind / lateRun ランナーは守備に回らない
      // (aiStep のブレイク分岐と対)。owner が存在する間は ballInFlightFrom は常に null
      // なので、predict が評価する owner非null の守備反応には現れない — ミラー不要
      // (Task Y の burst 除外と同じ前例)。
      !(
        world.ballInFlightFrom === p.team &&
        p.intent !== null &&
        (p.intent.kind === 'runBehind' ||
          (p.intent.kind === 'lateRun' &&
            (world.ball.z > 0 || world.ball.vz !== 0) &&
            dist(p.intent.target, goalCenter(p.team)) < 20)) &&
        p.intent.possTeam === p.team &&
        p.intent.until > world.clock
      ),
  );
  const atk = world.players.filter((p) => p.team !== defendersTeam && p.role !== GK_ROLE);
  const ball = world.ball;
  const ownGoal = ownGoalCenter(defendersTeam as 0 | 1);
  const tactics = world.tactics[defendersTeam];
  // 共有守備ライン(Task AD): マーク深度のクランプ基準。tick内で一定なので1回だけ計算する。
  // predict.ts のミラーも同じ defensiveLineX / markTargetPoint を使う(構築による一致)。
  const defSign = defendersTeam === 0 ? 1 : -1;
  const ownLineX = defensiveLineX(world, defendersTeam as 0 | 1);
  // 決定カデンスのジッターはチーム相対id(id - チーム先頭id)から導く(チーム間対称=リーグ公平性, Task AL)
  const teamBase = teamBaseId(world, defendersTeam);
  // マンマーク: ゾーン半径を拡大(=1で実質どこまでも付いていく)、マーク密着もlerp
  const zoneRadius = DEFENSE_ZONE_RADIUS * (1 + 2 * tactics.manMark);
  const markOffset = 1.6 + (1.0 - 1.6) * tactics.manMark; // lerp(1.6, 1.0)

  const owner = ballOwner(world);
  const possTeam = owner?.team ?? null;
  const setIntent = (m: Player, kind: IntentKind, target: Vec) => {
    m.moveTarget = target;
    m.intent = { kind, target, until: world.clock + 0.5, possTeam };
  };

  // ビルドアップ判定: 相手が自陣でボールを保持して落ち着いて循環している局面。
  const oppSign = owner ? (owner.team === 0 ? 1 : -1) : 0; // 相手の攻撃方向(守備側のゴール向き)
  const buildupDepth = owner ? oppSign * owner.pos.x : 0; // +HALF_L=相手ゴール際, 0=ハーフライン
  const buildup =
    owner !== null && owner.role !== GK_ROLE && buildupDepth < -8; // 相手が自陣8m以上深く保持

  // ビルドアップ時は前線(FW)を能動的なプレッサーに指名する。
  let fwPresser: Player | null = null;
  if (owner && buildup) {
    const fws = defenders.filter((d) => classifyRole(world.formations[defendersTeam], d.role).isFW);
    if (fws.length) {
      const nearestFw = fws.reduce((a, b) =>
        dist(a.pos, ball.pos) < dist(b.pos, ball.pos) ? a : b,
      );
      if (dist(nearestFw.pos, ball.pos) < 18) fwPresser = nearestFw;
    }
  }

  // ── プレッサー選定(ヒステリシス, Task W §1) ────────────────────────────
  // フリーボールは「軌道に最も早く追いつける選手」が回収(時間依存 = 高速反応、ヒステリシス無し)。
  // 保持中は前フレームのプレッサーを維持: 抜かれた / 別守備者が PRESS_HYSTERESIS_MARGIN 以上近い
  // ときだけ交代し、毎フレームの入れ替え(フラッピング)を止める。
  let presser: Player;
  let chaseTarget: Vec | null = null;
  let recoverer: Player | null = null; // 抜かれて回復ランへ回す旧プレッサー
  if (owner) {
    const nearest = defenders.reduce((a, b) =>
      dist(a.pos, ball.pos) < dist(b.pos, ball.pos) ? a : b,
    );
    if (fwPresser) {
      presser = fwPresser; // ビルドアップの前線プレスは位置ベースで最優先(ヒステリシス対象外)
    } else {
      const prevId = world.presserId[defendersTeam];
      const prev =
        prevId !== null
          ? defenders.find((d) => d.id === prevId && !d.instruction) ?? null
          : null;
      if (prev && prev.id !== nearest.id) {
        const beaten = oppSign * (owner.pos.x - prev.pos.x) > PRESS_BEATEN_DIST;
        const closerRival =
          dist(nearest.pos, ball.pos) < dist(prev.pos, ball.pos) - PRESS_HYSTERESIS_MARGIN;
        if (beaten) {
          recoverer = prev; // 抜かれた → 回復ランへ、プレスは最寄りへ明示的にハンドオーバー
          presser = nearest;
        } else if (closerRival) {
          presser = nearest;
        } else {
          presser = prev;
        }
      } else {
        presser = prev ?? nearest;
      }
    }
  } else {
    let bestTime = Infinity;
    presser = defenders[0];
    for (const d of defenders) {
      const info = interceptInfo(world, d);
      if (info.time < bestTime) {
        bestTime = info.time;
        presser = d;
        chaseTarget = info.point;
      }
    }
  }
  world.presserId[defendersTeam] = presser.id;

  // プレス: 保持者へリードして詰める。フリーボールなら軌道に先回り。
  if (!presser.instruction) {
    let target: Vec;
    let kind: IntentKind = owner ? 'press' : 'chase';
    if (owner) {
      if (presser === fwPresser) {
        target = coverShadowTarget(world, owner, defendersTeam, oppSign);
        kind = 'cutLane';
      } else {
        // 迎撃リード点。プレス弱(<0.3)なら保持者と自ゴールの間2.5m地点で構える(コンテイン)
        const lead = pressTarget(owner);
        target =
          tactics.pressIntensity < 0.3
            ? add(lead, scale(norm(sub(ownGoal, lead)), 2.5))
            : lead;
      }
    } else {
      target = chaseTarget ?? ball.pos;
    }
    setIntent(presser, kind, target);
  }
  presser.defenseRole = 'press';
  presser.markTargetId = null;

  // 抜かれた旧プレッサー: ゴール側へ全力で戻る回復ラン(Task W §1)
  if (recoverer && !recoverer.instruction && owner) {
    const rt = recoverTarget(owner, ownGoal);
    setIntent(recoverer, 'recover', rt);
    recoverer.defenseRole = 'recover';
    recoverer.markTargetId = null;
    recoverer.markSince = world.clock;
  }

  // プレス強(>0.6)のとき、2番目にボールに近い守備者も同時にプレス(挟み込み)
  // 除外は predict.ts と同一の defenseRole ベース: まだ抜かれている回復中の守備者は候補外にする
  // (同tickの recoverer だけを弾くと、ビート翌tickに回復中の守備者が2人目に指名され、§1で消した
  //  背後からの尾行を回復ランに上書きしてしまう。ミラー invariant を保つ)。
  let secondPresser: Player | null = null;
  if (owner && tactics.pressIntensity > 0.6) {
    const rest = defenders.filter(
      (d) => d !== presser && !(d.defenseRole === 'recover' && oppSign * (owner.pos.x - d.pos.x) > 0),
    );
    if (rest.length) {
      secondPresser = rest.reduce((a, b) =>
        dist(a.pos, ball.pos) < dist(b.pos, ball.pos) ? a : b,
      );
      if (!secondPresser.instruction) setIntent(secondPresser, 'press', pressTarget(owner));
      secondPresser.defenseRole = 'press';
      secondPresser.markTargetId = null;
    }
  }

  // ── ゾーン守備 + スティッキーマーク(Task W §2) ─────────────────────────
  // markers = プレッサー/2人目/回復中を除く守備者。
  const markers = defenders.filter((d) => {
    if (d === presser || d === secondPresser) return false;
    // 回復中で「まだ抜かれている(保持者がゴール側に前にいる)」なら回復ランを継続
    if (owner && d.defenseRole === 'recover' && oppSign * (owner.pos.x - d.pos.x) > 0) {
      if (!d.instruction) setIntent(d, 'recover', recoverTarget(owner, ownGoal));
      return false;
    }
    return true;
  });
  const targets = atk.filter((a) => a.id !== owner?.id);
  const targetById = new Map(targets.map((a) => [a.id, a] as const));

  // フリーボール(owner無し)はスクランブル=毎フレーム再割り当て(高速反応)。
  // 保持中のみ、スティッキー & カデンスでマークの identity をコミットする。
  const sticky = owner !== null;

  // Pass 1: 有効な現行マークを予約する(=別守備者に横取りされない)
  const used = new Set<number>();
  const keeping = new Map<number, Player>();
  if (sticky) {
    for (const m of markers) {
      if (m.instruction) continue;
      if (m.defenseRole !== 'mark' || m.markTargetId === null) continue;
      const t = targetById.get(m.markTargetId);
      if (!t) continue;
      if (used.has(t.id)) continue; // 念のため二重予約防止
      if (dist(t.pos, dynamicAnchor(world, m)) > zoneRadius) continue; // ゾーンから出た相手は手放す
      keeping.set(m.id, t);
      used.add(t.id);
    }
  }

  // Pass 2: 各マーカーの割り当てを確定
  for (const m of markers) {
    if (m.instruction) continue;
    const anchor = dynamicAnchor(world, m);
    const committed = keeping.get(m.id) ?? null;
    const held = world.clock - m.markSince;
    // カデンス: タイマーが切れたときだけ「どの相手をマークするか」を再考する。
    // 目標点(=マーク相手の追従)は毎フレーム更新するので追従自体は途切れない。
    const mayReconsider = !sticky || m.defenseTimer <= 0;
    if (mayReconsider) m.defenseTimer = decideInterval(m.id - teamBase);

    let mark: Player | null = committed;
    if (mayReconsider) {
      // ゾーン内で最も危険(自ゴールに近い)な、他者に予約されていない相手を探す
      let best: Player | null = null;
      let bestDanger = -Infinity;
      for (const t of targets) {
        if (used.has(t.id) && t.id !== committed?.id) continue;
        if (dist(t.pos, anchor) > zoneRadius) continue;
        const danger = -dist(t.pos, ownGoal);
        if (danger > bestDanger) {
          bestDanger = danger;
          best = t;
        }
      }
      if (!committed) {
        mark = best;
      } else if (best && best.id !== committed.id) {
        // 乗り換えは「持続 ≥ MARK_STICKY_TIME かつ明確に危険(≥ MARK_REASSIGN_MARGIN)」のときだけ
        const committedDanger = -dist(committed.pos, ownGoal);
        if (held >= MARK_STICKY_TIME && bestDanger > committedDanger + MARK_REASSIGN_MARGIN) {
          used.delete(committed.id);
          used.add(best.id);
          mark = best;
        } else {
          mark = committed;
        }
      } else {
        mark = committed; // best が現行と同じ / 候補なし
      }
    }

    if (mark) {
      if (m.markTargetId !== mark.id) m.markSince = world.clock;
      m.markTargetId = mark.id;
      m.defenseRole = 'mark';
      if (!keeping.has(m.id)) used.add(mark.id); // 新規割り当ての予約
      setIntent(m, 'mark', markTargetPoint(mark.pos, ownGoal, ball.pos, markOffset, ownLineX, defSign));
      continue;
    }

    // マーク対象なし: コミット解除して コンパクトブロック / コース切り / カバー
    m.markTargetId = null;
    m.defenseRole = 'cover';

    // 保持者が自ゴールを脅かす(COMPACT_BLOCK_RANGE 以内)ならシュートコースを身体で塞ぐ
    if (owner && dist(owner.pos, ownGoal) < COMPACT_BLOCK_RANGE) {
      setIntent(m, 'cutLane', compactBlockTarget(anchor, owner.pos, ownGoal));
      continue;
    }

    // 危険なパスコースが自分のゾーンを通るなら、その上に立って封鎖(既知の未ミラー分, task-q)
    if (owner) {
      let laneTarget: Vec | null = null;
      let bestLaneDanger = -Infinity;
      for (const t of targets) {
        if (t.team !== owner.team) continue;
        const toT = sub(t.pos, owner.pos);
        const L2 = toT.x * toT.x + toT.y * toT.y;
        if (L2 < 1) continue;
        let s = ((anchor.x - owner.pos.x) * toT.x + (anchor.y - owner.pos.y) * toT.y) / L2;
        s = Math.max(0.25, Math.min(0.85, s));
        const onLane = add(owner.pos, scale(toT, s));
        if (dist(onLane, anchor) > zoneRadius) continue;
        const danger = -dist(t.pos, ownGoal);
        if (danger > bestLaneDanger) {
          bestLaneDanger = danger;
          laneTarget = onLane;
        }
      }
      if (laneTarget) {
        setIntent(m, 'cutLane', laneTarget);
        continue;
      }
    }

    // 守るべき相手もコースもなければ持ち場を守る
    setIntent(m, 'cover', anchor);
  }
}

/** 全選手の意思決定を進める。ユーザー指示がある選手のAI移動は上書きしない */
export function aiStep(world: World, dt: number): void {
  const owner = ballOwner(world);
  const possTeam = owner?.team ?? null;

  // 攻守の切り替わりで守備コミット状態を無効化する(Task W §2 / Task V §5 stretch = Fix 3)。
  // Fix 3(真の攻守交替のみでワイプ): 従来は possTeam が飛行中 null になるため「全パスのリリース/受け」
  // でもワイプが発火し、スティッキーマーク(仕様 ≥1.5s)が実測中央値 0.86s しか持たず、パスの瞬間ごとに
  // 全マークが貪欲再導出されて受け手成立の瞬間に守備が締まり直していた(=受け手のレーンが塞がり
  // 完成度が落ちる)。Task W では旧テンポでこの修正が goals を 3.33→4.13 に悪化させ差し戻したが、
  // Task V の遅いテンポ(整え・カデンス・パスを跨ぐラン持続=飛行回数が減る)で再挑戦する(spec §5)。
  // lastPossTeam は「直近の非nullの保持チーム」を保持し、相手チームがボールを保持した瞬間だけワイプ。
  // 飛行中(null)や自チームの受け直しではワイプしない→マークがパスを跨いで持続し、レーンが空く→完成度↑。
  if (possTeam !== null && possTeam !== world.lastPossTeam) {
    for (const p of world.players) {
      p.defenseRole = null;
      p.markTargetId = null;
      p.markSince = 0;
      p.defenseTimer = 0;
    }
    world.presserId = [null, null];
    world.lastPossTeam = possTeam;
  }

  for (const p of world.players) {
    p.decisionTimer -= dt;
    p.defenseTimer -= dt;

    if (p.instruction?.kind === 'move') {
      p.moveTarget = p.instruction.target; // ユーザー指示が常に優先
      p.intent = null;
      continue;
    }

    // GK: ボール保持時以外は専用ポジショニング(ゴールとボールを結ぶ線上)。
    if (p.role === GK_ROLE && world.ball.ownerId !== p.id) {
      const shotInFlight = world.ball.ownerId === null && len(world.ball.vel) > 10;
      if (shotInFlight) {
        // GK反応ウィンドウ(Task Z Req4): 打たれた後 GK_REACT_TIME のあいだは構えたままコースを
        // 変えられない(=凍結ハックの置換)。その後だけ予測クロス地点へ全力で寄せる(pace の keeper
        // 昇格でシュート飛翔中はスプリント。速度は GK の上限で頭打ち)。「速いシュートが飛んでいる間は
        // コースを変えられない」という成立条件を、凍結ではなく「反応レイテンシ + 移動時間」に再機構化
        // する。据え置き位置と飛行時間ぶんの差で、正確に置かれたシュートはGKを破る。反応時間が長い
        // ほどGKは弱く=得点↑(得点バンドで較正するノブ)。速いパス(shotInFlightSince 未設定)には
        // 従来どおり反応しない(=飛行中は据え置き)。
        const since = world.shotInFlightSince;
        if (since !== null && world.clock - since >= GK_REACT_TIME) {
          const sign = p.team === 0 ? 1 : -1;
          const ownGoalX = -sign * HALF_L;
          const cross = predictGoalLineCrossing(world.ball, ownGoalX);
          if (cross) {
            const half = GOAL_WIDTH / 2 + 1.5; // ゴール枠 + リーチ余白まで寄せる(枠外へは追わない)
            const target = vec(ownGoalX + sign * 1.0, Math.max(-half, Math.min(half, cross.y)));
            p.moveTarget = target;
            p.intent = { kind: 'keeper', target, until: world.clock + 0.2, possTeam };
          }
        }
        // ウィンドウ内 / クロス予測不能: moveTarget を据え置き(=打たれる前の構えのまま)
        continue;
      }
      // スイーパー: 自陣ペナルティエリア付近に緩いフリーボールがあれば飛び出して回収。
      // 守備が崩れた後の処理をGKが担う(ビルドアップ参加の入口にもなる)。
      const sign = p.team === 0 ? 1 : -1;
      const ownGoalX = -sign * HALF_L;
      const ballOwnDepth = -sign * (world.ball.pos.x - ownGoalX); // 自ゴールからの距離(前方+)
      const dGKBall = dist(p.pos, world.ball.pos);
      // 安い前提条件で足切りしてから、必要なときだけ相手距離を計算(毎フレーム実行のため)
      let sweep = false;
      if (world.ball.ownerId === null && ballOwnDepth < 22 && dGKBall < 20) {
        const nearestOppToBall = Math.min(
          ...opponents(world, p.team).map((o) => dist(o.pos, world.ball.pos)),
        );
        // 浮き球(クロス/パント着地)への無条件突進はしない(Task AA): 地上ルーズボール用の
        // 「ボックス内なら出る」規則のままだと、GKがクロスの53%を回収してしまい(16×10min
        // トレース)着地の争いが消える。空中球は「明確に自分が最初に触れる」ときだけ出る —
        // トラフィックへの飛び出しをためらうのは実GKの挙動でもある。
        const airborne = world.ball.z > 0 || world.ball.vz !== 0;
        const inBox = ballOwnDepth < 11; // ゴール至近では相手より遅くても出る(地上球のみ)
        sweep = airborne
          ? dGKBall < nearestOppToBall - GK_AERIAL_SWEEP_MARGIN
          : inBox || dGKBall < nearestOppToBall + 1.5;
      }
      if (sweep) {
        p.moveTarget = { ...world.ball.pos };
        p.intent = { kind: 'chase', target: { ...world.ball.pos }, until: world.clock + 0.4, possTeam };
      } else {
        const target = dynamicAnchor(world, p);
        p.moveTarget = target;
        p.intent = { kind: 'keeper', target, until: world.clock + 0.5, possTeam };
      }
      continue;
    }

    // 仕掛け(テイクオン)のバースト中(Task Y): 押し出したルーズボールを追う。ボールが owner無しの
    // 局面なので、放置すると下の decideDefense(両チーム)に守備意図で上書きされる。ここで moveTarget を
    // ボールに固定し continue して守らせる。バーストは decideDefense 側でも defenders から除外される
    // (mirror不要: predict は owner===null でearly-return するため、この状態を評価しない)。
    if (p.burstUntil > world.clock && world.ball.ownerId !== p.id) {
      p.moveTarget = { ...world.ball.pos };
      p.intent = { kind: 'takeOn', target: { ...world.ball.pos }, until: p.burstUntil, possTeam };
      continue;
    }

    // ブレイク・オン・リリース(Task AD): 自チームのパスが飛行中、runBehind / lateRun の
    // ランナーはブレイク目標(intent.target)へ走り切る。lateRun はボックスラン(目標が敵ゴール
    // 20m圏)のみ: 従来は全ランがパス1本ごとに守備意図に上書きされ box 到達が構造的に0だった。
    // 全 lateRun を持続させると box 直行の受け手が増えすぎ goals が帯域を大きく超える(6×10計測)。
    // さらにロフト球(クロス/スイッチ)の飛行中のみ: 地上パスまで持続させると箱内へ足元で
    // 受ける得点機械になる — クロスに「人を残す」(Task AA の bodies)だけを持続させる。この局面(owner無し)では下の
    // decideDefense が両チームに守備意図を配るため、バースト(上)と同様に moveTarget を
    // ここで固定し、decideDefense 側の defenders フィルタでも除外する(対になっている)。
    // ミラー不要: ballInFlightFrom が非nullの間は必ず owner===null で、predict は
    // owner===null で early-return する(Task Y の burst 除外と同じ前例)。
    if (
      world.ballInFlightFrom === p.team &&
      p.intent !== null &&
      (p.intent.kind === 'runBehind' ||
        (p.intent.kind === 'lateRun' &&
          (world.ball.z > 0 || world.ball.vz !== 0) &&
          dist(p.intent.target, goalCenter(p.team)) < 20)) &&
      p.intent.possTeam === p.team &&
      p.intent.until > world.clock
    ) {
      p.moveTarget = p.intent.target;
      continue;
    }

    // 意図の失効: 時間切れ・攻守の切り替わり・目的地への到着。
    // Task W §4: 攻撃参加のラン(裏抜け/レイトラン/オーバーラップ/アンダーラップ/ワンツー)は
    // 「<1m到着」で失効させない — 20m超のランがスライドする目標の手前で途中失速して死ぬのを防ぐ。
    // これらは攻守の切り替わり(=パスが逸れた/奪われた)か持続時間の満了までやり切る。
    // (これは decideDefense の式ではないのでミラー不要)
    const isOwnerP = owner !== null && owner.id === p.id;
    if (p.intent) {
      const k = p.intent.kind;
      const isAttackRun =
        k === 'runBehind' ||
        k === 'lateRun' ||
        k === 'overlap' ||
        k === 'underlap' ||
        k === 'giveAndGo';
      // Task V: 保持者の hold は目標=自位置なので「到着」で毎tick失効してしまう。
      // 攻撃参加のランと同様に「到着失効」の対象外にして until までやり切らせる。
      const noArrivalExpiry = isAttackRun || (k === 'hold' && isOwnerP);
      // Task V(task-w §4 が Task V に委ねた宿題): 攻撃参加のランは「自チームのパス」では
      // 失効させない。従来は possTeam が飛行中に null になり、味方のパス1本ごとにランが切れて
      // box へ辿り着けなかった(タスクf/jが位置調整で直せなかった 0.000 box到達問題の一因)。
      // ランは真の攻守交替(相手がボールを保持した瞬間)か持続時間の満了までやり切る。これにより
      // hold(§3)が「発展を待つ対象」を持てるようになり、box占有が上がる。守備/その他の意図は
      // 従来どおり possTeam ベースで失効(この分岐は decideDefense ではないので predict ミラー不要)。
      const genuineTurnover = owner !== null && owner.team !== p.intent.possTeam;
      const runEnded = isAttackRun ? genuineTurnover : p.intent.possTeam !== possTeam;
      const expired =
        p.intent.until <= world.clock ||
        runEnded ||
        (!noArrivalExpiry && dist(p.pos, p.intent.target) < 1);
      if (expired) p.intent = null;
    }

    if (isOwnerP) {
      // Task V: 圧力連動カデンス + carry/hold のやり切り + ファーストタッチの整え。
      const pr = pressureOf(world, p);
      // 整えの割り込み: まだ意思決定していない(=整え中/シールド中)のに相手が詰めてきたら
      // (圧力スパイク)、奪われる前に即断する。整えのフル時間は「無圧で安全に落ち着ける」局面
      // だけに効かせ、詰められた瞬間はワンタッチ回避と同じく速く放す(steals/完成度の保護)。
      const onBallCommit =
        p.intent !== null &&
        (p.intent.kind === 'carry' || p.intent.kind === 'hold') &&
        p.intent.possTeam === p.team;
      if (p.decisionTimer > 0 && !onBallCommit && pr > SETTLE_BAILOUT_PRESSURE) {
        p.decisionTimer = 0; // 詰められた: 整えを打ち切り即断へ
      }
      if (p.decisionTimer <= 0) {
        p.decisionTimer = ownerDecisionInterval(pr);
        // Req 4: 未失効の carry 意図は、圧力が跳ねない限りやり切る(オフボールの「決めた意図は
        // やり切る」の保持者版)。carry の持続は短い(0.4〜0.9s)ので、明確に良い選択肢は
        // 次の再判断で拾われる。
        const keepCarry =
          p.intent !== null &&
          p.intent.kind === 'carry' &&
          p.intent.until > world.clock &&
          p.intent.possTeam === p.team &&
          pr <= CARRY_RELEASE_PRESSURE;
        // 未失効の hold 意図も、圧力が上がらない限り維持する(ランの発展を待つ)。
        const keepHold =
          p.intent !== null &&
          p.intent.kind === 'hold' &&
          p.intent.until > world.clock &&
          p.intent.possTeam === p.team &&
          pr < HOLD_MAX_PRESSURE;
        if (keepCarry) {
          p.moveTarget = p.intent!.target;
        } else if (keepHold) {
          p.moveTarget = shieldTarget(world, p);
        } else {
          decideOwner(world, p);
        }
      } else if (p.intent && p.intent.kind === 'carry' && p.intent.possTeam === p.team) {
        p.moveTarget = p.intent.target; // 再判断の合間: carry を継続
      } else if (p.intent && p.intent.kind === 'hold' && p.intent.possTeam === p.team) {
        p.moveTarget = shieldTarget(world, p); // hold 中: その場で構えてランを待つ
      } else {
        // ファーストタッチの整え(まだ意思決定していない): 前進を殺さず勢いを活かして運ぶ(無圧)
        p.moveTarget = settleTarget(world, p);
      }
      continue;
    }

    if (owner && owner.team === p.team) {
      if (p.intent) {
        if (p.intent.kind === 'runBehind') {
          // runBehind は保持中オンサイドのホールド点で待機し、ラインの動きに毎tick追従する
          // (Task AD)。ブレイクはリリース時(上の飛行分岐)。パサー側の passTarget は
          // intent.target(ライン裏)へスルーパスを出す — この対でキャンプが消える。
          p.moveTarget = clampToPitch(
            vec(clampOnsideX(world, p.team, p.intent.target.x), p.intent.target.y),
          );
        } else {
          p.moveTarget = p.intent.target; // 決めた意図はやり切る
        }
      } else if (p.decisionTimer <= 0) {
        p.decisionTimer = AI_DECISION_INTERVAL;
        chooseOffBallIntent(world, p, owner);
      }
      continue;
    }
    // 守備側・フリーボールは下のチーム単位の処理(decideDefense)で意図が付く
  }

  // 守備側はチーム単位でまとめて整合性を取る(毎フレームで安い)
  if (owner) {
    decideDefense(world, owner.team === 0 ? 1 : 0);
  } else {
    decideDefense(world, 0);
    decideDefense(world, 1);
  }
}
