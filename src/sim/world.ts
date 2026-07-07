import {
  BALL_DAMPING,
  BLOCK_RADIUS,
  CONTROL_RADIUS,
  CONTROLLABLE_BALL_SPEED,
  OPEN_CONTROL_RADIUS,
  OPEN_RECEIVER_RADIUS,
  GK_CATCH_SPEED,
  GK_REACH,
  DRIBBLE_OFFSET,
  DRIBBLE_SPEED_FACTOR,
  FIRST_TIME_BOX_DEPTH,
  FIRST_TIME_BOX_HALF_WIDTH,
  FIRST_TIME_DECISION,
  FIRST_TIME_MAX_DIST,
  FIRST_TIME_MIN_ANGLEQ,
  GOAL_WIDTH,
  KICK_COOLDOWN,
  PASS_SPEED_MAX,
  PASS_SPEED_MIN,
  PITCH_LENGTH,
  PITCH_WIDTH,
  PLAYER_ACCEL,
  PLAYER_ACCEL_DECAY,
  PLAYER_MAX_SPEED,
  SETTLE_BAILOUT,
  SETTLE_BAILOUT_PRESSURE,
  SETTLE_BALLSPEED_COEF,
  SETTLE_BASE,
  SETTLE_MAX,
  SETTLE_PRESSURE_COEF,
  SHOT_SPEED_MAX,
  SHOT_SPEED_MIN,
  STEAL_CONE_DOT,
  STEAL_RADIUS,
  STEAL_RATE,
} from './constants';
import {
  baseAnchors,
  classifyRole,
  forwardRole,
  GK_ROLE,
  kickoffPos,
  roleIndicesByClass,
  type FormationName,
} from './formation';
import {
  BALL_FLIGHT_REACH_RADIUS,
  CUT_LANE_NEAR_RADIUS,
  GK_THREAT_RADIUS,
  MARK_BALL_NEAR_RADIUS,
  OUT_OF_POSITION_DIST,
  effortSpeed,
  intentEffort,
  type Effort,
} from './pace';
import { mulberry32Step, rand, randomSeed } from './rng';
import type { Ball, IntentKind, Player, Team, World } from './types';
import { add, clampLen, dist, dot, len, norm, scale, sub, vec, type Vec } from './vec';

const HALF_L = PITCH_LENGTH / 2;
const HALF_W = PITCH_WIDTH / 2;

/** チームが攻めるゴールの中心 */
export function goalCenter(attacking: Team): Vec {
  return vec(attacking === 0 ? HALF_L : -HALF_L, 0);
}

export function ownGoalCenter(team: Team): Vec {
  return goalCenter(team === 0 ? 1 : 0);
}

export function createWorld(
  formations: [FormationName, FormationName] = ['4-4-2', '4-4-2'],
  seed: number = randomSeed(),
): World {
  // world オブジェクトはこの時点でまだ存在しないため、rand(world) ではなく
  // ローカルの state 変数に対して mulberry32Step を直接進める
  let rngState = seed >>> 0;
  const players: Player[] = [];
  let id = 0;
  for (const team of [0, 1] as Team[]) {
    const n = baseAnchors(formations[team]).length;
    for (let role = 0; role < n; role++) {
      const p = kickoffPos(team, role, formations[team]);
      let decisionRand: number;
      [rngState, decisionRand] = mulberry32Step(rngState);
      players.push({
        id: id++,
        team,
        number: role + 1,
        role,
        pos: { ...p },
        vel: vec(0, 0),
        moveTarget: { ...p },
        instruction: null,
        intent: null,
        decisionTimer: decisionRand * 0.2,
        kickCooldown: 0,
        receivedFrom: null,
        receivedAt: 0,
        defenseRole: null,
        markTargetId: null,
        markSince: 0,
        defenseTimer: 0,
      });
    }
  }
  const emptyStats = () => ({ shots: 0, passes: 0, steals: 0, interceptions: 0 });
  const world: World = {
    players,
    ball: { pos: vec(0, 0), vel: vec(0, 0), ownerId: null, lastTouchTeam: 0, lastPasserId: null },
    score: [0, 0],
    clock: 0,
    message: null,
    stats: [emptyStats(), emptyStats()],
    ballInFlightFrom: null,
    lastPossTeam: null,
    presserId: [null, null],
    formations,
    tactics: [
      { manMark: 0, pressIntensity: 0.5, lineHeight: 0, wideRuns: 0.5 },
      { manMark: 0, pressIntensity: 0.5, lineHeight: 0, wideRuns: 0.5 },
    ],
    seed,
    rngState,
    shotInFlightSince: null,
  };
  // 試合開始もゴール後と同じく、どちらかのキックオフ(FWがボールを持つ)で始める
  resetForKickoff(world, rand(world) < 0.5 ? 0 : 1);
  return world;
}

/**
 * 試合中のフォーメーション変更。
 * `Player.role` は新フォーメーションの基準点(baseAnchors)への位置index であり、
 * フォーメーションごとに意味が変わる(4-4-2のrole 1=CB が 4-3-3 では別役割)。
 * 純粋な距離最小マッチだと、たまたまFWスロットに近いCBが p.role=<FW index> になり、
 * 以降 classifyRole がそのCBを「FW」と誤分類してAI挙動が逆転してしまう。
 * そこで、まず旧フォーメーションでのセマンティック分類(GK/CB/SB/FW/中盤)を保持し、
 * 新フォーメーションの同分類スロットの中で現在位置に最も近い順に割り当てる。
 * 分類ごとの人数が新旧で違う(例: 4-4-2→3-5-2 でCBが2→3、中盤が4→5)場合の
 * 余りは、最後に全体の貪欲マッチでフォールバックする。
 */
export function setFormation(world: World, team: Team, name: FormationName): void {
  const oldName = world.formations[team];
  world.formations[team] = name;
  const members = world.players.filter((p) => p.team === team);
  const anchors = baseAnchors(name).map((_, role) => kickoffPos(team, role, name));

  const usedP = new Set<number>();
  const usedR = new Set<number>();
  const assign = (p: Player, role: number) => {
    usedP.add(p.id);
    usedR.add(role);
    p.role = role;
    p.number = role + 1;
  };

  // 候補ロール(candidateRoles)の範囲内で、未使用の選手・スロットを現在位置に近い順に貪欲マッチ
  const matchWithin = (players: Player[], candidateRoles: number[]) => {
    const pairs: { p: Player; role: number; d: number }[] = [];
    for (const p of players) {
      if (usedP.has(p.id)) continue;
      for (const role of candidateRoles) {
        if (usedR.has(role)) continue;
        pairs.push({ p, role, d: dist(p.pos, anchors[role]) });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    for (const { p, role } of pairs) {
      if (usedP.has(p.id) || usedR.has(role)) continue;
      assign(p, role);
    }
  };

  // GK は常に role 0
  const gk = members.find((p) => p.role === GK_ROLE);
  if (gk) assign(gk, GK_ROLE);

  // セマンティック分類ごとに、旧フォーメーションでの分類を保持したまま同分類スロットへ
  const classes: { isFW?: boolean; isSB?: boolean; isCB?: boolean }[] = [
    { isFW: true },
    { isSB: true },
    { isCB: true },
    {}, // 中盤
  ];
  for (const cls of classes) {
    const players = members.filter((p) => {
      if (usedP.has(p.id)) return false;
      const c = classifyRole(oldName, p.role);
      if (cls.isFW) return c.isFW;
      if (cls.isSB) return c.isSB;
      if (cls.isCB) return c.isCB;
      return !c.isFW && !c.isSB && !c.isCB; // 中盤
    });
    matchWithin(players, roleIndicesByClass(name, cls));
  }

  // 分類ごとの人数差で余った選手・スロットは全体貪欲でフォールバック
  const remainingRoles = anchors.map((_, role) => role).filter((role) => !usedR.has(role));
  const remainingPlayers = members.filter((p) => !usedP.has(p.id));
  matchWithin(remainingPlayers, remainingRoles);
}

export function teammates(world: World, p: Player): Player[] {
  return world.players.filter((q) => q.team === p.team && q.id !== p.id);
}

export function opponents(world: World, team: Team): Player[] {
  return world.players.filter((q) => q.team !== team);
}

export function ballOwner(world: World): Player | null {
  return world.ball.ownerId === null ? null : world.players[world.ball.ownerId];
}

/**
 * パスの初速。減衰込みの平均速度が選手の最高速(6.5m/s)を明確に上回るように
 * 係数を取る(遅いパスは走って追いつかれてしまい、つながらない)。
 * 受け手の手前では CONTROLLABLE_BALL_SPEED 未満まで減衰するのでトラップは可能。
 */
export function passSpeedFor(d: number): number {
  return Math.min(PASS_SPEED_MAX, Math.max(PASS_SPEED_MIN, d * BALL_DAMPING * 2.2));
}

/** dメートルのパスが、コース上s地点を通過する時刻(指数減衰モデルの解析解) */
export function ballTimeToCover(d: number, s: number): number {
  const v0 = passSpeedFor(d);
  const frac = (s * BALL_DAMPING) / v0;
  if (frac >= 0.95) return 10; // ほぼ届かない(転がり切る距離の限界)
  return -Math.log(1 - frac) / BALL_DAMPING;
}

/** パスがdメートル先に届くまでのおおよその時間(減衰込み平均速度の近似) */
export function passFlightTime(d: number): number {
  return d / (passSpeedFor(d) * 0.65);
}

export function executePass(world: World, passer: Player, target: Vec): void {
  const d = dist(passer.pos, target);
  // 実行ノイズ: プレッシャー下・長距離ほどパスがブレる。
  // これがないとパスが100%通り、守備がボールを奪う手段がなくなって試合が膠着する
  const oppDist = Math.min(...opponents(world, passer.team).map((o) => dist(o.pos, passer.pos)));
  const pressure = Math.min(1, Math.max(0, 1 - oppDist / 4));
  const noise = (rand(world) - 0.5) * 2 * (0.012 + 0.06 * pressure + 0.0012 * d);
  const dir0 = norm(sub(target, passer.pos));
  const c = Math.cos(noise);
  const s = Math.sin(noise);
  const dir = vec(dir0.x * c - dir0.y * s, dir0.x * s + dir0.y * c);
  world.ball.vel = scale(dir, passSpeedFor(d));
  world.ball.ownerId = null;
  world.ball.lastTouchTeam = passer.team;
  world.ball.lastPasserId = passer.id; // 受け手の receivedFrom 設定用(アンチピンポン)
  world.ballInFlightFrom = passer.team;
  world.stats[passer.team].passes++;
  passer.kickCooldown = KICK_COOLDOWN;
}

export function executeShot(world: World, shooter: Player): void {
  const goal = goalCenter(shooter.team);
  const distGoal = dist(shooter.pos, goal);
  const gk = opponents(world, shooter.team).find((p) => p.role === GK_ROLE);
  const gkY = gk ? gk.pos.y : 0;

  // 狙いのサンプリング(Task Z): GKのいない側のファーコーナーを主に、時々ニアコーナー・中央。
  // 「全シュートが同じファーコーナーのグラウンダー」という単調さを解消する。
  const half = GOAL_WIDTH / 2 - 0.5;
  const gkSide = Math.abs(gkY) > 0.3 ? Math.sign(gkY) : rand(world) < 0.5 ? 1 : -1;
  const r = rand(world);
  let aimY: number;
  if (r < 0.6) aimY = -gkSide * half; // ファーコーナー(GKの逆): 最も多い
  else if (r < 0.82) aimY = gkSide * half; // ニアコーナー: 時々
  else aimY = (rand(world) - 0.5) * half; // 中央寄り: たまに
  const aim = vec(goal.x, Math.max(-half, Math.min(half, aimY)));
  const dir = norm(sub(aim, shooter.pos));

  // 威力(Task Z): 距離連動。近距離は置きにいって遅め・正確、遠距離は強打。SHOT_SPEED_MIN〜MAX。
  const power = Math.max(
    SHOT_SPEED_MIN,
    Math.min(SHOT_SPEED_MAX, SHOT_SPEED_MIN + distGoal * 0.55 + (rand(world) - 0.5) * 3),
  );

  // 実行誤差(Task Z): 威力とプレッシャーが上がるほどブレる(距離でも僅かに)。角度誤差[rad]。
  const oppDist = Math.min(...opponents(world, shooter.team).map((o) => dist(o.pos, shooter.pos)));
  const pressure = Math.min(1, Math.max(0, 1 - oppDist / 4));
  const powerFrac = (power - SHOT_SPEED_MIN) / (SHOT_SPEED_MAX - SHOT_SPEED_MIN);
  const errMag = 0.02 + 0.09 * pressure + 0.05 * powerFrac + distGoal * 0.003;
  const noise = (rand(world) - 0.5) * 2 * errMag;
  const c = Math.cos(noise);
  const s = Math.sin(noise);
  world.ball.vel = scale(vec(dir.x * c - dir.y * s, dir.x * s + dir.y * c), power);
  world.ball.ownerId = null;
  world.ball.lastTouchTeam = shooter.team;
  world.ball.lastPasserId = null; // シュートはパスではない
  world.ballInFlightFrom = null;
  world.shotInFlightSince = world.clock; // GK反応ウィンドウの起点(Task Z)
  world.stats[shooter.team].shots++;
  shooter.kickCooldown = KICK_COOLDOWN;
}

/**
 * 速いボール(シュート)がゴールライン(x = goalLineX)を横切る地点を、指数減衰の解析解で予測する
 * (Task Z: GK反応)。ボールがそのラインへ向かっていない/減衰で届かないなら null。
 */
export function predictGoalLineCrossing(ball: Ball, goalLineX: number): Vec | null {
  const k = BALL_DAMPING;
  const dx = goalLineX - ball.pos.x;
  const vx = ball.vel.x;
  if (Math.abs(vx) < 0.1) return null;
  // x(t) = x0 + vx*(1 - e^{-k t})/k を goalLineX について解く → 1 - e^{-k t} = dx*k/vx
  const frac = (dx * k) / vx;
  if (frac <= 0 || frac >= 1) return null; // 逆向き / 減衰で届かない
  const t = -Math.log(1 - frac) / k;
  const yCross = ball.pos.y + (ball.vel.y * (1 - Math.exp(-k * t))) / k;
  return vec(goalLineX, yCross);
}

/**
 * ファーストタッチ・シュート候補か(Task Z Req2)。相手ペナルティエリア内で、近く・正面の受けは
 * 整えをバイパスしてワンタッチで撃つ。実際に撃つ/撃たないは decideOwner が(コースのふさがりも
 * 見て)判断する — ここは「整えの遅延をスキップしてよい局面か」だけを判定する。
 */
function isFirstTimeShot(receiver: Player): boolean {
  if (receiver.role === GK_ROLE) return false;
  const sign = receiver.team === 0 ? 1 : -1;
  const inBox =
    sign * receiver.pos.x > HALF_L - FIRST_TIME_BOX_DEPTH &&
    Math.abs(receiver.pos.y) < FIRST_TIME_BOX_HALF_WIDTH;
  if (!inBox) return false;
  const goal = goalCenter(receiver.team);
  if (dist(receiver.pos, goal) > FIRST_TIME_MAX_DIST) return false;
  const angleQ = 1 - Math.abs(receiver.pos.y - goal.y) / 22;
  return angleQ > FIRST_TIME_MIN_ANGLEQ;
}

function resetForKickoff(world: World, possession: Team): void {
  for (const p of world.players) {
    const home = kickoffPos(p.team, p.role, world.formations[p.team], p.team === possession);
    p.pos = { ...home };
    p.vel = vec(0, 0);
    p.moveTarget = { ...home };
    p.instruction = null;
    p.intent = null;
    p.kickCooldown = 0;
    p.receivedFrom = null;
    p.receivedAt = 0;
  }
  // キックオフはFWがセンターサークルで持つ
  const fwRole = forwardRole(world.formations[possession]);
  const receiver = world.players.find((p) => p.team === possession && p.role === fwRole)!;
  receiver.pos = vec(possession === 0 ? -1.2 : 1.2, 0);
  receiver.moveTarget = { ...receiver.pos };
  world.ball = { pos: { ...receiver.pos }, vel: vec(0, 0), ownerId: receiver.id, lastTouchTeam: possession, lastPasserId: null };
  world.shotInFlightSince = null; // Task Z: キックオフでGK反応ウィンドウをリセット
}

/**
 * 選手の意図から今フレームのエフォート(歩く/ジョグ/ラン/スプリント)を決めるための
 * 文脈を組み立てる。pace.ts の intentEffort は純粋関数なので、world状態の読み取りは
 * ここに閉じ込める。
 */
function effortForPlayer(world: World, p: Player, distToTarget: number): Effort {
  const ball = world.ball;
  const kind: IntentKind | null = p.intent?.kind ?? null;

  // 飛行中のボールの軌道に絡み得る距離にいれば、意図に関わらずスプリント
  // (受け手/コース上の守備者がPLAYER_MAX_SPEEDで反応する前提はpredict.tsの先読みと共有)。
  // hold/coverは「持ち場を守っているだけ」で、たまたまボールの軌道の近くにいても
  // 本人には無関係なので対象外にする(でないと大半の据え置き守備者が毎パスでスプリントする)
  const ballInFlightReach =
    world.ballInFlightFrom !== null &&
    kind !== 'hold' &&
    kind !== 'cover' &&
    dist(p.pos, ball.pos) < BALL_FLIGHT_REACH_RADIUS;

  const markBallNear =
    kind === 'mark' && p.intent !== null && dist(ball.pos, p.intent.target) < MARK_BALL_NEAR_RADIUS;
  const cutLaneBallNear =
    kind === 'cutLane' && p.intent !== null && dist(ball.pos, p.intent.target) < CUT_LANE_NEAR_RADIUS;

  // GK(keeper意図)専用: 自ゴールへの脅威度と、ボールが相手陣内にあるか
  let gkThreat = false;
  let gkBallInOppositionHalf = false;
  if (kind === 'keeper') {
    const shotInFlight = ball.ownerId === null && len(ball.vel) > 10;
    gkThreat = shotInFlight || dist(ball.pos, ownGoalCenter(p.team)) < GK_THREAT_RADIUS;
    const sign = p.team === 0 ? 1 : -1;
    gkBallInOppositionHalf = sign * ball.pos.x > 0;
  }

  return intentEffort(kind, {
    ballInFlightReach,
    outOfPosition: distToTarget > OUT_OF_POSITION_DIST,
    markBallNear,
    cutLaneBallNear,
    gkThreat,
    gkBallInOppositionHalf,
  });
}

function movePlayers(world: World, dt: number): void {
  for (const p of world.players) {
    p.kickCooldown = Math.max(0, p.kickCooldown - dt);

    const isOwner = world.ball.ownerId === p.id;
    const toTarget = sub(p.moveTarget, p.pos);
    const d = len(toTarget);

    // ボール保持中はドリブル速度上限(不変)。それ以外は意図のエフォートで速度上限を決める
    let maxSpeed: number;
    let standStill = false;
    if (isOwner) {
      maxSpeed = PLAYER_MAX_SPEED * DRIBBLE_SPEED_FACTOR;
    } else {
      const effort = effortForPlayer(world, p, d);
      maxSpeed = effortSpeed(effort);
      if (effort === 'walk') {
        // デッドゾーン: 持ち場の近くではその場に立つ。ヒステリシスは「今止まっているか」
        // (=速度がほぼ0か)を境界半径の切り替えに使うことで、新しいフィールドを増やさずに
        // 境界での往復振動を防ぐ(止まっていれば3.5m、動いていれば2.5mまで近づいて停止)。
        const wasStopped = len(p.vel) < 0.35;
        standStill = d < (wasStopped ? 3.5 : 2.5);
      }
    }

    // 到着時に減速する(arrive挙動)。デッドゾーン内は望む速度=0(立ち止まる)
    const desired = standStill ? vec(0, 0) : scale(norm(toTarget), maxSpeed * Math.min(1, d / 1.5));
    // 加速度は速度が上がるほど落ちる(=高速からの方向転換ほどコストが高い)。
    // 上限速度そのもの(PLAYER_MAX_SPEED)ではなく、その時点の実速度で正規化する
    const speed = len(p.vel);
    const accel = PLAYER_ACCEL * (1 - PLAYER_ACCEL_DECAY * Math.min(1, speed / PLAYER_MAX_SPEED));
    const steer = clampLen(sub(desired, p.vel), accel * dt);
    // 速度の上限はPLAYER_MAX_SPEED(物理的な絶対上限)。エフォート/ドリブルの上限は
    // desired側で表現し、ここでハードクランプしない — でないと意図が切り替わった瞬間
    // (例: スプリント→カバーで歩く)に加速度を無視して瞬時に減速する非現実的な挙動になる
    p.vel = clampLen(add(p.vel, steer), PLAYER_MAX_SPEED);
    p.pos = add(p.pos, scale(p.vel, dt));

    // ピッチ外には出ない(ボールは出る)
    p.pos.x = Math.max(-HALF_L - 1, Math.min(HALF_L + 1, p.pos.x));
    p.pos.y = Math.max(-HALF_W - 1, Math.min(HALF_W + 1, p.pos.y));

    // 移動指示は到着したら完了
    if (p.instruction?.kind === 'move' && dist(p.pos, p.instruction.target) < 0.8) {
      p.instruction = null;
    }
  }
}

function updateBall(world: World, dt: number): void {
  const ball = world.ball;
  const owner = ballOwner(world);

  // GK反応ウィンドウの終了(Task Z): シュートが誰かに収まった/減速したら飛翔起点をクリアする。
  if (!(ball.ownerId === null && len(ball.vel) > 10)) world.shotInFlightSince = null;

  if (owner) {
    // ドリブル: 進行方向の少し前にボールを置く
    const heading = len(owner.vel) > 0.5 ? norm(owner.vel) : norm(sub(goalCenter(owner.team), owner.pos));
    ball.pos = add(owner.pos, scale(heading, DRIBBLE_OFFSET));
    ball.vel = { ...owner.vel };

    // 密着した相手による奪取。Task W: 保持者の「運んでいる向き」(=heading)から120°以内、
    // つまりボール側/ゴール側から寄せた相手だけが奪える。真後ろから身体を通り抜けて奪う
    // (物理的にありえない)背後奪取を排除する。dot >= cos(120°) = -0.5。
    for (const opp of opponents(world, owner.team)) {
      if (dist(opp.pos, ball.pos) >= STEAL_RADIUS) continue;
      const toOpp = sub(opp.pos, owner.pos);
      const l = len(toOpp);
      // ほぼ同一地点(正面から重なっている)なら向きは問わない
      const ballSide = l < 0.3 || dot(heading, scale(toOpp, 1 / l)) >= STEAL_CONE_DOT;
      if (!ballSide) continue;
      if (rand(world) < STEAL_RATE * dt) {
        ball.ownerId = null;
        ball.vel = scale(vec(rand(world) - 0.5, rand(world) - 0.5), 4);
        owner.kickCooldown = 0.3;
        world.stats[opp.team].steals++;
        break;
      }
    }
    return;
  }

  // フリーボールの物理
  ball.pos = add(ball.pos, scale(ball.vel, dt));
  ball.vel = scale(ball.vel, Math.exp(-BALL_DAMPING * dt));

  // 速いボール(シュート・強いパス)は体に当たると弾かれる。
  // GKはリーチが広く、GK_CATCH_SPEED以上の速いボールはパリー(セーブ)になる
  const speed = len(ball.vel);
  for (const p of world.players) {
    if (p.kickCooldown > 0) continue;
    const isGK = p.role === GK_ROLE;
    const blockR = isGK ? GK_REACH : BLOCK_RADIUS;
    const blockMin = isGK ? GK_CATCH_SPEED : CONTROLLABLE_BALL_SPEED;
    if (speed >= blockMin && dist(p.pos, ball.pos) < blockR) {
      // フィールドプレーヤーのブロックは確率的(咄嗟に体を合わせられるとは限らない)。
      // ボールは半径内に数tick留まるので、tickあたり8%≒1回の通過で約3割止まる。
      // GKは読んで構えているので半径内なら確実にセーブ
      if (!isGK && rand(world) > 0.08) continue;
      const away = norm(sub(ball.pos, p.pos));
      const jitter = vec(rand(world) - 0.5, rand(world) - 0.5);
      ball.vel = scale(norm(add(away, jitter)), speed * 0.35);
      ball.lastTouchTeam = p.team;
      world.ballInFlightFrom = null;
      p.kickCooldown = 0.25;
      break;
    }
  }

  // オープンな受け手のトラップ: 速いパス(>= CONTROLLABLE_BALL_SPEED)でも、送出チームの
  // 選手が届く範囲(OPEN_CONTROL_RADIUS)にいて、かつトラップ地点の近く(OPEN_RECEIVER_RADIUS)
  // に守備者がいなければ、球速の上限なしで確実にコントロールする。フリーの受け手へボールが
  // すり抜けることはない(トラップミスは存在しない)。
  // ブロック判定(8%確率)を抜けたボールに対してのみ作用する。GKは既存のキャッチ/パリー
  // ロジックが優先なので対象外。守備のインターセプトはブロック判定と通常トラップで引き続き
  // 処理される — ここは送出チームのフリーな受け手だけを対象にするため、ターンオーバーは
  // コース上の守備(ブロック)・スロー化したボールの奪取からのみ生まれる。
  {
    const spd = len(ball.vel);
    if (
      ball.ownerId === null &&
      world.ballInFlightFrom !== null &&
      spd >= CONTROLLABLE_BALL_SPEED
    ) {
      let best: Player | null = null;
      let bestD = Infinity;
      for (const p of world.players) {
        if (p.kickCooldown > 0 || p.role === GK_ROLE) continue;
        if (p.team !== world.ballInFlightFrom) continue; // 送出チームのみ
        const d = dist(p.pos, ball.pos);
        if (d < OPEN_CONTROL_RADIUS && d < bestD) {
          best = p;
          bestD = d;
        }
      }
      if (best) {
        const oppDist = Math.min(
          ...opponents(world, best.team).map((o) => dist(o.pos, ball.pos)),
        );
        if (oppDist >= OPEN_RECEIVER_RADIUS) {
          ball.ownerId = best.id;
          ball.lastTouchTeam = best.team;
          recordReception(world, best);
          applyFirstTouchSettle(world, best);
          world.ballInFlightFrom = null;
        }
      }
    }
  }

  // トラップ判定: 十分近く、ボールが速すぎないこと(GKはより速いボールもキャッチできる)
  {
    let best: Player | null = null;
    let bestD = Infinity;
    const v = len(ball.vel);
    for (const p of world.players) {
      if (p.kickCooldown > 0) continue;
      const isGK = p.role === GK_ROLE;
      if (v >= (isGK ? GK_CATCH_SPEED : CONTROLLABLE_BALL_SPEED)) continue;
      const r = isGK ? GK_REACH : CONTROL_RADIUS;
      const d = dist(p.pos, ball.pos);
      if (d < r && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    if (best) {
      ball.ownerId = best.id;
      ball.lastTouchTeam = best.team;
      if (world.ballInFlightFrom !== null && best.team !== world.ballInFlightFrom) {
        world.stats[best.team].interceptions++;
      }
      recordReception(world, best);
      applyFirstTouchSettle(world, best);
      world.ballInFlightFrom = null;
    }
  }
}

/**
 * 受け手が誰からパスを受けたかを記録(アンチピンポン用)。
 * 直前のパサーが味方かつ別人なら receivedFrom に保存。それ以外(自分自身に
 * 戻る・敵のパスをカット・クリアの跳ね返りなど)は出し手情報をクリアする。
 */
function recordReception(world: World, receiver: Player): void {
  const passerId = world.ball.lastPasserId;
  if (passerId !== null && passerId !== receiver.id && world.players[passerId].team === receiver.team) {
    receiver.receivedFrom = passerId;
    receiver.receivedAt = world.clock;
  } else {
    receiver.receivedFrom = null;
  }
  world.ball.lastPasserId = null;
}

/** 線分 a→b への点 p の最短距離(線分外は端点距離)。ワンタッチ回避のコース判定用 */
function pointSegDist(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y;
  if (l2 < 1e-6) return dist(p, a);
  let t = ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, add(a, scale(ab, t)));
}

/**
 * ワンタッチ回避用: 受け手に安全な後方/横の出口(味方)があるか(Task V)。
 * 前方への刺しパスは対象外(=詰められた選手の逃げ場としての後ろ/横だけを見る)。GKは除外
 * (GKへの戻しを数えると常に真になり、整えのテンポ効果が薄れるため)。
 */
function safeOutletExists(world: World, receiver: Player): boolean {
  const sign = receiver.team === 0 ? 1 : -1;
  const opps = opponents(world, receiver.team);
  for (const t of world.players) {
    if (t.team !== receiver.team || t.id === receiver.id || t.role === GK_ROLE) continue;
    const d = dist(receiver.pos, t.pos);
    if (d < 4 || d > 22) continue; // 近すぎ/遠すぎる出口は除外
    if (sign * (t.pos.x - receiver.pos.x) > 4) continue; // 明確に前方=刺しパスは出口に数えない
    // 味方がフリー(最寄り相手が4m以上)かつパスコースが空いている(コース上2m以内に相手がいない)
    let ok = true;
    for (const o of opps) {
      if (dist(o.pos, t.pos) < 4 || pointSegDist(o.pos, receiver.pos, t.pos) < 2) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * ファーストタッチの「整え」(Task V)。受球のたびに保持者の decisionTimer を設定し、
 * 受けてすぐ放すのではなく一拍置いてからプレーさせる。トラップ自体は決定論のまま
 * (ファンブルではない、task-kの教訓): ボールは確実にコントロールし、遅らせるのは
 * 「意思決定」だけ。整えの間、保持者はシールドして構える(aiStep側)。
 * 例外(ワンタッチ回避): 受け時圧力が高く安全な後方/横の出口があれば素早く放せる。
 */
function applyFirstTouchSettle(world: World, receiver: Player): void {
  if (receiver.role === GK_ROLE) return; // GKは専用の配球ロジック(整え対象外)
  // ファーストタッチ・シュート(Task Z Req2): ボックス内・高質の受けは整えをバイパスしてワンタッチ。
  // これが「受け手はオーナーになってから1判断tick待つ必要がある=一発のフィニッシュが物理的に不可能」
  // という制約を外す。整えの直前オフボール意図はクリアし、意思決定を FIRST_TIME_DECISION まで即断。
  // median release ゲート(>=0.8s)を割らないよう、発火はボックス内の限定局面のみ(spec)。
  if (isFirstTimeShot(receiver)) {
    receiver.intent = null;
    receiver.decisionTimer = FIRST_TIME_DECISION;
    return;
  }
  const oppDist = Math.min(...opponents(world, receiver.team).map((o) => dist(o.pos, receiver.pos)));
  const pressure = Math.min(1, Math.max(0, 1 - oppDist / 4));
  const ballSpeed = len(world.ball.vel);
  // 受けた瞬間、直前のオフボール意図は用済み。整えの間はシールド(その場で構える)に入れる
  receiver.intent = null;
  // ワンタッチ回避(spec §1: 詰められた選手はタックルに立ち尽くさない): 受け時圧力が高いなら
  // 素早く放す。整え時間を長くしたまま立たせると、詰めてきた相手に大量に奪われ(steals 激増)、
  // かつ放す頃には守備が締まって完成度も落ちる。安全な後方/横の出口があれば最速(SETTLE_BAILOUT)、
  // 無くても短め(=2倍)で一拍だけ置いて即プレー。整えのフル時間は「無圧で安全に落ち着ける」
  // 局面にだけ効かせる(=median を担うのは無圧の受け、steals/完成度を守るのは圧下の速放し)。
  if (pressure > SETTLE_BAILOUT_PRESSURE) {
    receiver.decisionTimer = safeOutletExists(world, receiver) ? SETTLE_BAILOUT : SETTLE_BAILOUT * 2;
    return;
  }
  receiver.decisionTimer = Math.min(
    SETTLE_MAX,
    Math.max(SETTLE_BASE, SETTLE_BASE + SETTLE_PRESSURE_COEF * pressure + SETTLE_BALLSPEED_COEF * ballSpeed),
  );
}

function handleBoundaries(world: World): void {
  const ball = world.ball;
  if (ball.ownerId !== null) return;

  // ゴール判定
  if (Math.abs(ball.pos.x) > HALF_L && Math.abs(ball.pos.y) < GOAL_WIDTH / 2) {
    const scorer: Team = ball.pos.x > 0 ? 0 : 1;
    world.score[scorer]++;
    world.message = { text: scorer === 0 ? '青チーム ゴール!' : '赤チーム ゴール!', until: world.clock + 2.5 };
    resetForKickoff(world, scorer === 0 ? 1 : 0);
    return;
  }

  // ボールが外に出たら、最後に触っていない方の再開
  if (Math.abs(ball.pos.x) > HALF_L || Math.abs(ball.pos.y) > HALF_W) {
    const restartTeam: Team = ball.lastTouchTeam === 0 ? 1 : 0;

    // ゴールラインを越えた(サイドではなく)場合、再開側が自陣ゴール側なら
    // ゴールキック=GKが配球する(GKのビルドアップ参加)。
    const overGoalLine = Math.abs(ball.pos.x) > HALF_L;
    const restartOwnGoalX = restartTeam === 0 ? -HALF_L : HALF_L;
    const isGoalKick = overGoalLine && Math.sign(ball.pos.x) === Math.sign(restartOwnGoalX);
    if (isGoalKick) {
      const gk = world.players.find((p) => p.team === restartTeam && p.role === GK_ROLE)!;
      const spot = vec(restartOwnGoalX + (restartTeam === 0 ? 1 : -1) * 5.5, 0);
      gk.pos = { ...spot };
      gk.vel = vec(0, 0);
      gk.moveTarget = { ...spot };
      gk.instruction = null;
      gk.intent = null;
      gk.kickCooldown = 0;
      ball.pos = { ...spot };
      ball.vel = vec(0, 0);
      ball.ownerId = gk.id;
      ball.lastTouchTeam = restartTeam;
      world.ballInFlightFrom = null;
      return;
    }

    const spot = vec(
      Math.max(-HALF_L + 0.5, Math.min(HALF_L - 0.5, ball.pos.x)),
      Math.max(-HALF_W + 0.5, Math.min(HALF_W - 0.5, ball.pos.y)),
    );
    ball.pos = spot;
    ball.vel = vec(0, 0);
    // 再開側の最寄り選手にボールを渡し、その場に立たせる
    const taker = world.players
      .filter((p) => p.team === restartTeam)
      .reduce((a, b) => (dist(a.pos, spot) < dist(b.pos, spot) ? a : b));
    taker.pos = add(spot, scale(norm(sub(taker.pos, spot)), 0.3));
    taker.vel = vec(0, 0);
    ball.ownerId = taker.id;
    ball.lastTouchTeam = restartTeam;
  }
}

/** 物理を1ステップ進める(AIの意思決定は ai.ts 側) */
export function stepPhysics(world: World, dt: number): void {
  world.clock += dt;
  movePlayers(world, dt);
  updateBall(world, dt);
  handleBoundaries(world);
  if (world.message && world.clock > world.message.until) world.message = null;
}
