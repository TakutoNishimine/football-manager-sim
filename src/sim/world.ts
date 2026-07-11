import {
  BALL_DAMPING,
  BLOCK_RADIUS,
  CARRY_OPEN_DIST,
  CARRY_OPEN_SPEED,
  CARRY_TIGHT_DIST,
  CARRY_TOUCH_INTERVAL,
  CARRY_TOUCH_MAX,
  CARRY_TOUCH_MIN,
  CONTROL_RADIUS,
  CONTROLLABLE_BALL_SPEED,
  OPEN_CONTROL_RADIUS,
  OPEN_RECEIVER_RADIUS,
  GK_CATCH_SPEED,
  GK_REACH,
  GK_WALK_SPEED,
  DRIBBLE_OFFSET,
  DRIBBLE_SPEED_FACTOR,
  FIRST_TIME_BOX_DEPTH,
  FIRST_TIME_BOX_HALF_WIDTH,
  FIRST_TIME_DECISION,
  FIRST_TIME_MAX_DIST,
  FIRST_TIME_MIN_ANGLEQ,
  GOAL_WIDTH,
  GRAVITY,
  BALL_HEAD_HEIGHT,
  CROSSBAR_HEIGHT,
  LOFT_RESTITUTION,
  LOFT_BOUNCE_FRICTION,
  LOFT_SETTLE_VZ,
  KICK_COOLDOWN,
  KICKOFF_PASS_WINDOW,
  PASS_SPEED_MAX,
  PASS_SPEED_MIN,
  PITCH_LENGTH,
  PITCH_WIDTH,
  PLAYER_ACCEL,
  PLAYER_ACCEL_DECAY,
  PLAYER_MAX_SPEED,
  PLAYER_SEPARATION,
  SETTLE_BAILOUT,
  SETTLE_BAILOUT_PRESSURE,
  SETTLE_BALLSPEED_COEF,
  SETTLE_BASE,
  SETTLE_MAX,
  SETTLE_PRESSURE_COEF,
  SHOT_ERR_SCALE,
  SHOT_SPEED_MAX,
  SHOT_SPEED_MIN,
  TAKEON_BURST_SPEED,
  TAKEON_BURST_TIME,
  TAKEON_KNOCK_PAST,
  TAKEON_KNOCK_SIDE,
  TAKEON_KNOCK_SPEED,
  TACKLE_BASE,
  TACKLE_BEATEN_SPEED,
  TACKLE_BEATEN_TIME,
  TACKLE_COMMIT_TIME,
  TACKLE_RANGE,
  TACKLE_TRIGGER,
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
import { isOffsidePosition, OFFSIDE_ENGAGE_RADIUS } from './line';
import { flightReachRadius, tacklePressScale } from './press';
import {
  BALL_FLIGHT_REACH_RADIUS,
  CUT_LANE_NEAR_RADIUS,
  FAR_OUT_OF_POSITION_DIST,
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

/**
 * トラップ argmin の同着チャンネル診断カウンタ(Task AT, Part 3)。挙動不変・rand消費なし:
 * トラップが実際に解決した tick でのみ、反対チームの適格候補との距離差を計測する。
 * exactTies > 0 なら「id順の完全同着チャンネル」が実在する(team0 が同着を必ず勝つ)。
 * scripts/benchmark/trap-tie-probe.ts が読み出す。プロセス単位のグローバル(プローブ専用)。
 */
export const trapTieDebug = {
  resolutions: 0, // トラップ解決の総数
  contested: 0, // 反対チームの適格候補も半径内にいた解決
  exactTies: 0, // 最近接距離が完全同着(diff === 0)
  ties1e9: 0, // 1e-9 以内
  ties1mm: 0, // 1mm 以内(準同着の文脈)
  wonByTeam0: 0, // contested のうち team0 が勝った数
};

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
        burstUntil: 0,
        beatenUntil: 0,
        tackleCooldown: 0,
        touchTimer: 0,
        gkGainedAt: -1,
        gkHoldBase: 0,
      });
    }
  }
  const emptyStats = () => ({
    shots: 0,
    passes: 0,
    steals: 0,
    interceptions: 0,
    tackleLost: 0,
    takeOnAtt: 0,
    takeOnWon: 0,
    crosses: 0,
    switches: 0,
    clearances: 0,
    punts: 0,
    offsides: 0,
  });
  const world: World = {
    players,
    ball: { pos: vec(0, 0), vel: vec(0, 0), z: 0, vz: 0, ownerId: null, lastTouchTeam: 0, lastPasserId: null },
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
    takeOnRunnerId: null,
    takeOnDeadline: 0,
    switchReadyAt: [0, 0],
    offsideIds: [],
    lastOffsideOffenderId: null,
    kickoffCarrierId: null,
    kickoffPassUntil: 0,
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
  snapshotOffside(world, passer);
  world.stats[passer.team].passes++;
  passer.kickCooldown = KICK_COOLDOWN;
}

/**
 * オフサイド・スナップショット(Task AD)。パスのリリースの瞬間に、オフサイドポジション
 * (共有述語 isOffsidePosition: 敵陣・ボールより前・後方から2人目の守備者より前)にいた
 * パス側チームの味方を記録する。判定はリリース時・処罰は最初のタッチ時(whistleOffside)。
 * ball.pos はまだキッカーの足元なので、実行順はキック速度の設定と独立に正しい。
 */
function snapshotOffside(world: World, passer: Player): void {
  world.offsideIds = [];
  for (const t of world.players) {
    if (t.team !== passer.team || t.id === passer.id || t.role === GK_ROLE) continue;
    if (isOffsidePosition(world, passer.team, t.pos)) world.offsideIds.push(t.id);
  }
}

/**
 * オフサイドの笛(Task AD)。リリース時にオフサイドポジションにいた選手が最初にボールに
 * 触れた(コントロール/ブロック)瞬間に呼ぶ。守備側の間接FK相当の再開: 反則地点にボールを
 * 置き、最寄りの守備側選手が保持して再開する(既存の場外再開と同じ様式。決定論・randなし)。
 */
function whistleOffside(world: World, offender: Player): void {
  world.stats[offender.team].offsides++;
  world.lastOffsideOffenderId = offender.id; // レンダラーの反則者フラッシュ用(Task AF rider)
  const defTeam = (1 - offender.team) as Team;
  const ball = world.ball;
  const spot = vec(
    Math.max(-HALF_L + 0.5, Math.min(HALF_L - 0.5, offender.pos.x)),
    Math.max(-HALF_W + 0.5, Math.min(HALF_W - 0.5, offender.pos.y)),
  );
  ball.pos = { ...spot };
  ball.vel = vec(0, 0);
  ball.z = 0;
  ball.vz = 0;
  const taker = world.players
    .filter((p) => p.team === defTeam)
    .reduce((a, b) => (dist(a.pos, spot) < dist(b.pos, spot) ? a : b));
  taker.pos = add(spot, scale(norm(sub(taker.pos, spot)), 0.3));
  taker.vel = vec(0, 0);
  ball.ownerId = taker.id;
  ball.lastTouchTeam = defTeam;
  ball.lastPasserId = null;
  world.ballInFlightFrom = null;
  world.offsideIds = [];
  world.shotInFlightSince = null;
  resolveTakeOn(world, taker); // 仕掛け中のボールが笛で止まった場合もここで決着
  world.message = { text: 'オフサイド', until: world.clock + 1.5 };
}

/** 笛のゲート(Task AD): この選手のこのタッチはオフサイドか。フラグはパス側チームの
 * 飛行中のみ有効(ballInFlightFrom が一致しなければ、守備者が先に触れた等で失効している)。 */
function offsideTouch(world: World, p: Player): boolean {
  return (
    world.ballInFlightFrom !== null &&
    world.ballInFlightFrom === p.team &&
    world.offsideIds.length > 0 &&
    world.offsideIds.includes(p.id)
  );
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
  const errMag = (0.02 + 0.09 * pressure + 0.05 * powerFrac + distGoal * 0.003) * SHOT_ERR_SCALE;
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

/** ロフトキックの飛行時間(秒)。頂点 apexHeight の弾道(地面→地面)の解析解 */
export function loftFlightTime(apexHeight: number): number {
  return 2 * Math.sqrt((2 * apexHeight) / GRAVITY);
}

/** ロフト球の消費者別カウンタのフィールド名(Task AA) */
const LOFT_KIND_FIELD = {
  cross: 'crosses',
  switch: 'switches',
  clearance: 'clearances',
  punt: 'punts',
} as const;
export type LoftKind = keyof typeof LOFT_KIND_FIELD;

/**
 * ロフトパス(Task AA)。ターゲットへの弾道アーチ: 頂点 apexHeight、飛行時間
 * T = 2*sqrt(2*apex/g)、水平速度 = 距離/T(飛行中は水平減衰なし=無ノイズなら着地点=狙い点)。
 * z > BALL_HEAD_HEIGHT(2.2m)の間は誰も触れない(頭上越え)。蹴り出し直後と着地帯の
 * 低い区間だけが脆弱で、着地の争いは既存のレース(ブロック8%/トラップ最近傍/オープン受け)が
 * そのまま解決する — どれも順序中立(Task Y req4 の設計を継承)。
 * 実行ノイズ: 地上パスと同型の角度ブレ+距離ブレ(ロフトは低確率パス)。
 * 統計: パスとして数える(完成度トラッカーは「次にボールを収めたチーム」で解決するので、
 * クリア/パントの意図された50/50は相手が回収した時だけ失敗になる)+ kind別カウンタ。
 */
export function executeLoftedPass(
  world: World,
  kicker: Player,
  target: Vec,
  apexHeight: number,
  kind: LoftKind,
): void {
  const oppDist = Math.min(...opponents(world, kicker.team).map((o) => dist(o.pos, kicker.pos)));
  const pressure = Math.min(1, Math.max(0, 1 - oppDist / 4));
  const d = dist(kicker.pos, target);
  // 角度ノイズ(executePass と同型)+ 距離ノイズ(ロフトは長さも狂う)
  const angNoise = (rand(world) - 0.5) * 2 * (0.02 + 0.06 * pressure + 0.0012 * d);
  const lenNoise = 1 + (rand(world) - 0.5) * 2 * (0.04 + 0.05 * pressure);
  const dir0 = norm(sub(target, kicker.pos));
  const c = Math.cos(angNoise);
  const s = Math.sin(angNoise);
  const dir = vec(dir0.x * c - dir0.y * s, dir0.x * s + dir0.y * c);
  const T = loftFlightTime(apexHeight);
  world.ball.vel = scale(dir, (d * lenNoise) / T);
  world.ball.z = 0;
  world.ball.vz = (GRAVITY * T) / 2; // 打ち上げ初速(次tickから浮く)
  world.ball.ownerId = null;
  world.ball.lastTouchTeam = kicker.team;
  world.ball.lastPasserId = kicker.id;
  world.ballInFlightFrom = kicker.team;
  snapshotOffside(world, kicker); // ロフトもパス: リリース時にオフサイドを記録(Task AD)
  // 統計分類(Task AB 監査): クリアは StatsBomb ではパスではなく独立イベント型(Clearance)で、
  // 実データ比較(real.ts は type=Pass のみ集計)の母集合に入らない。意図された50/50をパスとして
  // 数えると正準の完成度(completion.ts は passes の増分を監視)が実データと定義ズレする。
  // クロス/スイッチ/パント(GK配球)は StatsBomb でも Pass なので従来どおり passes に数える。
  if (kind !== 'clearance') world.stats[kicker.team].passes++;
  world.stats[kicker.team][LOFT_KIND_FIELD[kind]]++;
  kicker.kickCooldown = KICK_COOLDOWN;
}

/**
 * 仕掛け(テイクオン)の実行(Task Y)。抜く相手 `defender` の脇〜背後へボールを押し出し、
 * 保持者はバースト速度(> PLAYER_MAX_SPEED)でボールへの徒競走に持ち込む。ボールはルーズ化するが
 * ballInFlightFrom は立てない(=パスではない: インターセプト計上もオープン受けトラップも起きない)。
 * 失敗時は守備がクリーンに回収する(ランダム方向スクワートは廃止)。勝敗は resolveTakeOn が確定。
 * バーストは仕掛け本人・短窓のみで、predict の PLAYER_MAX_SPEED 前提には漏らさない(mirror note)。
 */
export function executeTakeOn(world: World, owner: Player, defender: Player): void {
  const goal = goalCenter(owner.team);
  const dir = norm(sub(goal, owner.pos)); // 攻撃方向
  const perp = vec(-dir.y, dir.x);
  // 相手の足元へ通さないよう、相手が寄っていない側へ横オフセットして迂回させる
  const latD = dot(sub(defender.pos, owner.pos), perp); // 相手の攻撃方向に対する横位置
  const side = latD >= 0 ? -1 : 1; // 相手が寄っている側の逆へ回す
  const beyond = dist(owner.pos, defender.pos) + TAKEON_KNOCK_PAST;
  const knockPoint = clampWorld(
    add(add(owner.pos, scale(dir, beyond)), scale(perp, side * TAKEON_KNOCK_SIDE)),
    1,
  );
  const knockDir = norm(sub(knockPoint, owner.pos));
  world.ball.ownerId = null;
  world.ball.pos = add(owner.pos, scale(knockDir, DRIBBLE_OFFSET));
  world.ball.vel = scale(knockDir, TAKEON_KNOCK_SPEED);
  world.ball.lastTouchTeam = owner.team;
  world.ball.lastPasserId = null; // 仕掛けはパスではない
  world.ballInFlightFrom = null;
  owner.kickCooldown = KICK_COOLDOWN; // 押し出した直後は自分で即トラップしない(迂回して追いつく)
  owner.burstUntil = world.clock + TAKEON_BURST_TIME;
  owner.touchTimer = 0;
  owner.moveTarget = knockPoint;
  owner.intent = {
    kind: 'takeOn',
    target: knockPoint,
    until: world.clock + TAKEON_BURST_TIME,
    possTeam: owner.team,
  };
  world.takeOnRunnerId = owner.id;
  world.takeOnDeadline = world.clock + TAKEON_BURST_TIME + 0.8;
  world.stats[owner.team].takeOnAtt++;
}

/** ワールド座標のクランプ(ピッチ内 margin m)。ai.ts/predict.ts の clampToPitch と同義 */
function clampWorld(v: Vec, margin = 2): Vec {
  return vec(
    Math.max(-HALF_L + margin, Math.min(HALF_L - margin, v.x)),
    Math.max(-HALF_W + margin, Math.min(HALF_W - margin, v.y)),
  );
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
    p.burstUntil = 0;
    p.beatenUntil = 0;
    p.tackleCooldown = 0;
    p.touchTimer = 0;
  }
  world.takeOnRunnerId = null;
  // キックオフはFWがセンターサークルで持つ
  const fwRole = forwardRole(world.formations[possession]);
  const receiver = world.players.find((p) => p.team === possession && p.role === fwRole)!;
  receiver.pos = vec(possession === 0 ? -1.2 : 1.2, 0);
  receiver.moveTarget = { ...receiver.pos };
  world.ball = { pos: { ...receiver.pos }, vel: vec(0, 0), z: 0, vz: 0, ownerId: receiver.id, lastTouchTeam: possession, lastPasserId: null };
  world.shotInFlightSince = null; // Task Z: キックオフでGK反応ウィンドウをリセット
  world.offsideIds = []; // Task AD: オフサイドフラグもリセット
  world.lastOffsideOffenderId = null; // Task AF rider: 反則者フラッシュもリセット
  // Task AT: キックオフのバックパス誘導。持ち手の最初の意思決定を短い窓の間だけ後方の味方への
  // 短いパスに誘導する(下の decideOwner で消費・1回発火)。
  world.kickoffCarrierId = receiver.id;
  world.kickoffPassUntil = world.clock + KICKOFF_PASS_WINDOW;
  // AD レビュー指摘: ゴール経由のキックオフで古い ballInFlightFrom が残ると、
  // 保持中なのに ai.ts のブレイク分岐が発火し得る(稀・自己限定的だが不正確)。
  world.ballInFlightFrom = null;
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
  // Task AF: 相手のパス(守備の即時反応)は自チームの pressIntensity の連続関数の半径で、
  // 自チームのパス(受け手のラン)は従来の固定半径で反応する(press.ts 共有 = 価格付けとミラー)。
  const flightReach =
    world.ballInFlightFrom === p.team
      ? BALL_FLIGHT_REACH_RADIUS
      : flightReachRadius(world.tactics[p.team].pressIntensity);
  const ballInFlightReach =
    world.ballInFlightFrom !== null &&
    kind !== 'hold' &&
    kind !== 'cover' &&
    dist(p.pos, ball.pos) < flightReach;

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

  // 保持チームがファイナルサードを保持している間だけ、「大きく出遅れたら2段階(歩き→ラン)」で
  // 押し上げる(Task AA、pace.ts の注釈も参照)。ファイナルサード限定の理由(計測):
  // 全保持局面で急がせると、ビルドアップ中から前線がマーカーを引き連れて相手ブロックを深く
  // 圧縮し shots が -0.7/tm 落ちる。ボールが深い(=クロス/ボックス到達に人が要る)ときだけ
  // 急がせると、クロスの bodies とボックス占有は保ったまま shots が回復する(12×8min: 2.29→3.00)。
  const atkSign = p.team === 0 ? 1 : -1;
  const inPossession =
    ball.ownerId !== null &&
    world.players[ball.ownerId].team === p.team &&
    atkSign * ball.pos.x > HALF_L - 35;
  return intentEffort(kind, {
    ballInFlightReach,
    outOfPosition: distToTarget > OUT_OF_POSITION_DIST,
    farOutOfPosition: inPossession && distToTarget > FAR_OUT_OF_POSITION_DIST,
    markBallNear,
    cutLaneBallNear,
    gkThreat,
    gkBallInOppositionHalf,
  });
}

/** 選手pから最も近い相手(GK含む)までの距離。運ぶ速度・押し出し距離のスケールに使う(Task Y) */
function nearestOpponentDistTo(world: World, p: Player): number {
  let best = Infinity;
  for (const o of world.players) {
    if (o.team === p.team) continue;
    const d = dist(o.pos, p.pos);
    if (d < best) best = d;
  }
  return best;
}

/** キャリーの open-ness 0(密着=クロースコントロール)〜1(完全オープン)。CARRY_TIGHT_DIST〜CARRY_OPEN_DIST で線形 */
function carryOpenness(nearestOpp: number): number {
  return Math.max(0, Math.min(1, (nearestOpp - CARRY_TIGHT_DIST) / (CARRY_OPEN_DIST - CARRY_TIGHT_DIST)));
}

function movePlayers(world: World, dt: number): void {
  for (const p of world.players) {
    p.kickCooldown = Math.max(0, p.kickCooldown - dt);
    p.tackleCooldown = Math.max(0, p.tackleCooldown - dt);

    const isOwner = world.ball.ownerId === p.id;
    const bursting = p.burstUntil > world.clock; // 仕掛けのバースト中(ルーズボールを追う)
    const beaten = p.beatenUntil > world.clock; // タックルで抜かれて回復中(鈍化・旋回制限)
    const toTarget = sub(p.moveTarget, p.pos);
    const d = len(toTarget);

    // 速度上限の決定。保持者はスペース連動のキャリー速度(クロースコントロール〜タッチ&ラン)、
    // バーストは TAKEON_BURST_SPEED、それ以外は意図のエフォート。バースト/オープンキャリーは
    // PLAYER_MAX_SPEED を超えるので speedCap で個別に許可する(仕掛け本人/保持者のみ・短窓)。
    let maxSpeed: number;
    let speedCap = PLAYER_MAX_SPEED;
    let standStill = false;
    let accelScale = 1;
    if (isOwner && p.role === GK_ROLE && p.intent?.kind === 'gkHold') {
      // GK配球ホールド(Task AB): リリース地点へゆっくり歩く(キャリー速度ではなく歩行上限)
      maxSpeed = GK_WALK_SPEED;
    } else if (isOwner) {
      const openness = carryOpenness(nearestOpponentDistTo(world, p));
      const closeSpeed = PLAYER_MAX_SPEED * DRIBBLE_SPEED_FACTOR; // 密着時=クロースコントロール
      maxSpeed = closeSpeed + (CARRY_OPEN_SPEED - closeSpeed) * openness;
      speedCap = CARRY_OPEN_SPEED;
    } else if (bursting) {
      maxSpeed = TAKEON_BURST_SPEED;
      speedCap = TAKEON_BURST_SPEED;
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
    // 「抜かれた」守備者は鈍化・旋回制限(可視的に置いていかれる)。エフォートの上に被せる。
    if (beaten && !isOwner) {
      maxSpeed = Math.min(maxSpeed, TACKLE_BEATEN_SPEED);
      accelScale = 0.5;
      standStill = false;
    }

    // 到着時に減速する(arrive挙動)。デッドゾーン内は望む速度=0(立ち止まる)
    const desired = standStill ? vec(0, 0) : scale(norm(toTarget), maxSpeed * Math.min(1, d / 1.5));
    // 加速度は速度が上がるほど落ちる(=高速からの方向転換ほどコストが高い)。
    // 上限速度そのもの(PLAYER_MAX_SPEED)ではなく、その時点の実速度で正規化する
    const speed = len(p.vel);
    const accel =
      PLAYER_ACCEL * (1 - PLAYER_ACCEL_DECAY * Math.min(1, speed / PLAYER_MAX_SPEED)) * accelScale;
    const steer = clampLen(sub(desired, p.vel), accel * dt);
    // 速度の上限は speedCap(通常は PLAYER_MAX_SPEED、保持者/バーストのみ拡張)。エフォートの上限は
    // desired側で表現し、ここでハードクランプしない — でないと意図が切り替わった瞬間
    // (例: スプリント→カバーで歩く)に加速度を無視して瞬時に減速する非現実的な挙動になる
    p.vel = clampLen(add(p.vel, steer), speedCap);
    p.pos = add(p.pos, scale(p.vel, dt));

    // ピッチ外には出ない(ボールは出る)
    p.pos.x = Math.max(-HALF_L - 1, Math.min(HALF_L + 1, p.pos.x));
    p.pos.y = Math.max(-HALF_W - 1, Math.min(HALF_W + 1, p.pos.y));

    // 移動指示は到着したら完了
    if (p.instruction?.kind === 'move' && dist(p.pos, p.instruction.target) < 0.8) {
      p.instruction = null;
    }
  }

  // ソフト身体分離(Task Y): 守備者がボール保持者の身体をすり抜けない。ボールは足元より前(タッチ
  // オフセット)にあるので、身体を分離してもボールへの踏み込みは可能(=重いタッチのギャップは突ける)。
  applyBodySeparation(world);
}

/**
 * ソフト身体分離(Task Y)。ボール保持者と相手守備者が PLAYER_SEPARATION より近づいたら、
 * 重なりぶんを両者で半分ずつ押し離す。守備者が保持者をすり抜けて背後から奪う見た目を防ぐ。
 * 保持者↔相手のみ(cheap)。仕掛け中(ボールがルーズ=owner無し)は作用しない。
 */
function applyBodySeparation(world: World): void {
  const owner = ballOwner(world);
  if (!owner) return;
  const clampP = (v: Vec): Vec =>
    vec(
      Math.max(-HALF_L - 1, Math.min(HALF_L + 1, v.x)),
      Math.max(-HALF_W - 1, Math.min(HALF_W + 1, v.y)),
    );
  for (const o of world.players) {
    if (o.team === owner.team) continue;
    const delta = sub(o.pos, owner.pos);
    const dd = len(delta);
    if (dd >= PLAYER_SEPARATION || dd < 1e-4) continue;
    const push = (PLAYER_SEPARATION - dd) / 2;
    const dir = scale(delta, 1 / dd);
    o.pos = clampP(add(o.pos, scale(dir, push)));
    owner.pos = clampP(sub(owner.pos, scale(dir, push)));
  }
}

function updateBall(world: World, dt: number): void {
  const ball = world.ball;
  const owner = ballOwner(world);

  // GK反応ウィンドウの終了(Task Z): シュートが誰かに収まった/減速したら飛翔起点をクリアする。
  if (!(ball.ownerId === null && len(ball.vel) > 10)) world.shotInFlightSince = null;

  if (owner) {
    owner.touchTimer -= dt;
    const heading =
      len(owner.vel) > 0.5 ? norm(owner.vel) : norm(sub(goalCenter(owner.team), owner.pos));
    const moving = len(owner.vel) > 1.2; // 運んでいる(シールド/立ち止まりではない)
    if (!moving) {
      // 立ち止まり/シールド: ボールは足元(溶接)。動き出したら即タッチできるようにする。
      ball.pos = add(owner.pos, scale(heading, DRIBBLE_OFFSET));
      ball.vel = { ...owner.vel };
      owner.touchTimer = 0;
    } else {
      // タッチドリブル(Task Y): 溶接ではなく、ボールを前へ押し出して転がし、保持者が追う。
      // タッチ間はボールは「ルーズだが所有(owner維持)」= タックルが重いタッチのギャップを突ける。
      ball.pos = add(ball.pos, scale(ball.vel, dt));
      ball.vel = scale(ball.vel, Math.exp(-BALL_DAMPING * dt));
      const gap = dist(owner.pos, ball.pos);
      const openness = carryOpenness(nearestOpponentDistTo(world, owner));
      let pushDist = CARRY_TOUCH_MIN + (CARRY_TOUCH_MAX - CARRY_TOUCH_MIN) * openness;
      // セーフタッチ(Task Y): 押し出すライン上に構えた相手がいれば、その足元(タックル圏)に
      // ボールを届く前で止まる長さまでタッチを短くする。構えた守備者を通常タッチで「すり抜ける」
      // ことはできない — ラインを割る突破は、ゲート済み・カバー確認済み・失敗が守備の獲得になる
      // 明示の仕掛け(テイクオン)だけが担う。これがないと箱内へ雪崩れ込みシュートが倍増する。
      for (const o of opponents(world, owner.team)) {
        if (o.role === GK_ROLE) continue;
        const rel = sub(o.pos, owner.pos);
        const along = dot(rel, heading); // 押し出し方向の前方距離
        if (along <= 0 || along > 4) continue;
        const lateral = Math.abs(rel.x * heading.y - rel.y * heading.x); // ラインからの横ずれ
        if (lateral > 1.5) continue;
        pushDist = Math.min(pushDist, along - 1.4);
      }
      const canPush = pushDist >= 0.7;
      // 新しいタッチ: タイマー切れ / 追いついた / ボールが逸れすぎた のいずれか
      if (owner.touchTimer <= 0 || gap < DRIBBLE_OFFSET + 0.15 || gap > pushDist + 1.5) {
        if (canPush) {
          // CARRY_TOUCH_INTERVAL 秒で pushDist だけ転がる初速(指数減衰の解析解)
          const touchSpeed =
            (pushDist * BALL_DAMPING) / (1 - Math.exp(-BALL_DAMPING * CARRY_TOUCH_INTERVAL));
          ball.pos = add(owner.pos, scale(heading, DRIBBLE_OFFSET));
          ball.vel = scale(heading, touchSpeed);
          owner.touchTimer = CARRY_TOUCH_INTERVAL;
        } else {
          // 前が塞がっている: クロースコントロール(足元に置いて運ぶ/構える)
          ball.pos = add(owner.pos, scale(heading, DRIBBLE_OFFSET));
          ball.vel = { ...owner.vel };
          owner.touchTimer = 0.15; // 前が開いたらすぐ次のタッチ判定へ
        }
      }
    }

    // 方向性タックル(踏み込み): 密着した相手守備者が RNG スクワートではなく物理的に奪う(Task Y)。
    resolveTackles(world, owner, heading, dt);
    return;
  }

  // フリーボールの物理。浮き球(Task AA)は重力+バウンドを統合し、飛行中は転がり摩擦を
  // 受けない(水平速度一定=弾道は解析的)。接地球(z=0, vz=0)はこの分岐をスキップして
  // 従来の指数減衰をバイト同一で通る(z統合は浮き球にだけ課金される)。
  ball.pos = add(ball.pos, scale(ball.vel, dt));
  if (ball.z > 0 || ball.vz !== 0) {
    ball.z += ball.vz * dt;
    ball.vz -= GRAVITY * dt;
    if (ball.z <= 0) {
      // 着地: 鉛直は反発(LOFT_RESTITUTION)、水平は芝の吸収(LOFT_BOUNCE_FRICTION)。
      // 弾みが小さくなったら接地に確定し、以後は通常の転がり物理へ。
      ball.z = 0;
      ball.vz = Math.max(0, -ball.vz) * LOFT_RESTITUTION;
      ball.vel = scale(ball.vel, LOFT_BOUNCE_FRICTION);
      if (ball.vz < LOFT_SETTLE_VZ) ball.vz = 0;
    }
  } else {
    ball.vel = scale(ball.vel, Math.exp(-BALL_DAMPING * dt));
  }
  // 頭上(z > BALL_HEAD_HEIGHT)のボールは誰も触れない: 以下のブロック/オープン受け/トラップの
  // 各判定を丸ごとスキップする(接地球は常に overhead=false なので従来経路・rand消費とも同一)。
  const overhead = ball.z >= BALL_HEAD_HEIGHT;

  // 仕掛け(テイクオン)の判定期限切れ: バースト後もルーズなら未成功として本人idをクリア(Task Y)
  if (world.takeOnRunnerId !== null && world.clock > world.takeOnDeadline) {
    world.takeOnRunnerId = null;
  }

  // オフサイドの「プレー関与」判定(Task AD)。リリース時にフラグされた選手が、自チームの
  // パスの飛行中に(頭上より低い)ボールへ OFFSIDE_ENGAGE_RADIUS まで寄った=ボールに
  // チャレンジした瞬間に笛。実副審と同じく、タッチの成立を待たない(守備者と競っている
  // 時点でプレーへの関与)。最も近いフラグ選手を反則者に選ぶ(決定論・id順の同着は先勝ち)。
  if (!overhead && world.ballInFlightFrom !== null && world.offsideIds.length > 0) {
    let offender: Player | null = null;
    let offenderD = Infinity;
    for (const id of world.offsideIds) {
      const p = world.players[id];
      if (p.team !== world.ballInFlightFrom) break; // フラグはパス側チームのみ(安全ガード)
      const d = dist(p.pos, ball.pos);
      if (d < OFFSIDE_ENGAGE_RADIUS && d < offenderD) {
        offender = p;
        offenderD = d;
      }
    }
    if (offender) {
      whistleOffside(world, offender);
      return;
    }
  }

  // 速いボール(シュート・強いパス)は体に当たって弾かれる(確率的ブロック)。順序中立で解決
  // (Task Y req4): 資格のあるブロッカー各自が tickあたり8%(GKは確定)で「ブロックする」かを引き、
  // その中からボールに最も近い者を勝者に選ぶ(同距離は rand で分ける)。旧実装のグローバルid順
  // (=team0 が毎tick先に引く ≈52/48 の偏り, task-al §4)を除去。per-blocker 8% の意味は保つ。
  const speed = len(ball.vel);
  if (!overhead) {
    let winner: Player | null = null;
    let winnerD = Infinity;
    let ties = 0;
    for (const p of world.players) {
      if (p.kickCooldown > 0) continue;
      const isGK = p.role === GK_ROLE;
      const blockR = isGK ? GK_REACH : BLOCK_RADIUS;
      const blockMin = isGK ? GK_CATCH_SPEED : CONTROLLABLE_BALL_SPEED;
      if (speed < blockMin) continue;
      const dToBall = dist(p.pos, ball.pos);
      if (dToBall >= blockR) continue;
      // per-blocker 8%/tick(GKは読んで構えているので確定)。rand 消費順は id 順で決定論的だが、
      // 勝者は距離で選ぶので順序に依存しない(team バイアスなし)。
      const wouldBlock = isGK || rand(world) < 0.08;
      if (!wouldBlock) continue;
      if (dToBall < winnerD - 1e-9) {
        winner = p;
        winnerD = dToBall;
        ties = 1;
      } else if (dToBall <= winnerD + 1e-9) {
        // 同距離: reservoir 方式で公平に(team に依らず等確率で)勝者を選ぶ
        ties++;
        if (rand(world) < 1 / ties) winner = p;
      }
    }
    if (winner) {
      // オフサイド(Task AD): リリース時にフラグされた選手の「最初のタッチ」はブロック
      // (体に当たる)でも反則 — 笛を吹いて守備側の再開にする(はじき返しは起きない)。
      if (offsideTouch(world, winner)) {
        whistleOffside(world, winner);
        return;
      }
      const away = norm(sub(ball.pos, winner.pos));
      const jitter = vec(rand(world) - 0.5, rand(world) - 0.5);
      ball.vel = scale(norm(add(away, jitter)), speed * 0.35);
      ball.lastTouchTeam = winner.team;
      world.ballInFlightFrom = null;
      winner.kickCooldown = 0.25;
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
      !overhead &&
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
          // オフサイド(Task AD): フラグされた受け手が最初にコントロールした → 笛
          if (offsideTouch(world, best)) {
            whistleOffside(world, best);
            return;
          }
          ball.ownerId = best.id;
          ball.z = 0; // 足元に収める(Task AA: 低い浮き球の胸/腿トラップも接地に確定)
          ball.vz = 0;
          ball.lastTouchTeam = best.team;
          recordReception(world, best);
          applyFirstTouchSettle(world, best);
          world.ballInFlightFrom = null;
        }
      }
    }
  }

  // トラップ判定: 十分近く、ボールが速すぎないこと(GKはより速いボールもキャッチできる)
  if (!overhead) {
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
    // Task AT 診断カウンタ(挙動不変・rand消費なし): この argmin はグローバルid順の厳密比較
    // なので、両チーム候補の「距離の完全同着」は team0(若いid)が勝つ。そのチャンネルが
    // 実測で発生するかを、実際に解決したスキャンでだけ数える(trap-tie-probe.ts が読む)。
    if (best !== null) {
      trapTieDebug.resolutions++;
      let crossTeam = false;
      let minOtherDiff = Infinity;
      for (const p of world.players) {
        if (p.team === best.team || p.kickCooldown > 0) continue;
        const isGK = p.role === GK_ROLE;
        if (v >= (isGK ? GK_CATCH_SPEED : CONTROLLABLE_BALL_SPEED)) continue;
        const r = isGK ? GK_REACH : CONTROL_RADIUS;
        const d = dist(p.pos, ball.pos);
        if (d >= r) continue;
        crossTeam = true;
        minOtherDiff = Math.min(minOtherDiff, d - bestD);
      }
      if (crossTeam) {
        trapTieDebug.contested++;
        if (minOtherDiff === 0) trapTieDebug.exactTies++;
        if (minOtherDiff <= 1e-9) trapTieDebug.ties1e9++;
        if (minOtherDiff <= 1e-3) trapTieDebug.ties1mm++;
        if (best.team === 0) trapTieDebug.wonByTeam0++;
      }
    }
    if (best) {
      // オフサイド(Task AD): フラグされた受け手が最初にコントロールした → 笛
      if (offsideTouch(world, best)) {
        whistleOffside(world, best);
        return;
      }
      ball.ownerId = best.id;
      ball.z = 0; // 足元に収める(Task AA)
      ball.vz = 0;
      ball.lastTouchTeam = best.team;
      if (world.ballInFlightFrom !== null && best.team !== world.ballInFlightFrom) {
        world.stats[best.team].interceptions++;
      }
      // 仕掛け本人が自分の押し出しボールを収めた=仕掛け成功。この収球ではワンタッチ・シュートの
      // バイパスを効かせない: ボックスへ抜け出した仕掛けが自動でシュートに直結せず、整えを通して
      // decideOwner に「循環の出口(funnelExit)/繋ぎ/シュート」を天秤にかけ直させる(Task Y 是正)。
      const wonTakeOn = world.takeOnRunnerId === best.id;
      resolveTakeOn(world, best); // 仕掛け中のルーズボールが収まった → 勝敗確定(Task Y)
      recordReception(world, best);
      applyFirstTouchSettle(world, best, !wonTakeOn);
      world.ballInFlightFrom = null;
    }
  }
}

/**
 * 方向性タックル(Task Y。旧 RNG 奪取スクワートを置換)。ボールから TACKLE_RANGE 内の相手守備者は
 * 既定ではコンテイン(ジョッキー)し、TACKLE_TRIGGER の割合で踏み込む(コミット)。踏み込みは
 * rand(world) で確率解決するが、結果ジオメトリは物理的:
 *  - 成功 → タックラー側にボールが渡る(オーナー化・タックラーの前へ収める)。stats.steals++。
 *  - 失敗 → タックラーは「抜かれた」(beatenUntil = clock + TACKLE_BEATEN_TIME、鈍化・旋回制限)。
 * 背後(heading の後方)からは奪えない(frontFactor=0)= 旧 STEAL_CONE_DOT を物理ジオメトリで継承。
 * 露出(重いタッチ=ボールが保持者から離れているほど)成功率が上がる。決定論(rand(world)のみ)。
 */
function resolveTackles(world: World, owner: Player, heading: Vec, dt: number): void {
  const ball = world.ball;
  const gap = dist(owner.pos, ball.pos); // ボールが保持者からどれだけ離れているか(重いタッチ)
  const defs = opponents(world, owner.team);
  for (const opp of defs) {
    if (opp.role === GK_ROLE) continue;
    if (opp.beatenUntil > world.clock || opp.tackleCooldown > 0 || opp.kickCooldown > 0) continue;
    const dToBall = dist(opp.pos, ball.pos);
    if (dToBall >= TACKLE_RANGE) continue; // ボール(タッチで前に出た位置)に届く守備者だけが踏み込む
    // 「最後の1人は飛び込まない」(現実の守備セオリー): 自分より自ゴール側にカバーの味方
    // フィールドプレーヤーがいなければ踏み込まない(=コンテインで遅らせる)。踏み込み失敗の
    // ビートが即ブレイクアウェイ(GKと1対1)になる局面を、賭けではなく遅延で守る。
    const ownGoal = ownGoalCenter(opp.team as Team);
    const dOppGoal = dist(opp.pos, ownGoal);
    let hasCover = false;
    for (const tm of defs) {
      if (tm.id === opp.id || tm.role === GK_ROLE) continue;
      if (dist(tm.pos, ownGoal) < dOppGoal - 0.5) {
        hasCover = true;
        break;
      }
    }
    if (!hasCover) continue;
    // 前方成分: タックラーが保持者の運んでいる向きに対してどこにいるか。ボールは身体より前
    // (タッチで押し出されている)ので、ボールに届く=ほぼ前方〜横。真後ろ(front<=-0.6)だけは
    // 身体越しになるため不可(旧 STEAL_CONE_DOT の物理継承)。横からの踏み込みは十分有効。
    const toOpp = sub(opp.pos, owner.pos);
    const l = len(toOpp);
    const front = l < 0.3 ? 1 : dot(heading, scale(toOpp, 1 / l));
    const frontFactor = Math.max(0, Math.min(1, (front + 0.6) / 1.2)); // 真後ろ(front<=-0.6)=0, 横≈0.5, 前=1
    if (frontFactor <= 0) continue; // 真後ろからは踏み込まない(=物理的に奪えない)
    // ジョッキー: 毎tick踏み込むわけではない。TACKLE_TRIGGER/s の割合でコミットする。
    // Task AF: 踏み込み率は自チームの pressIntensity の連続係数で変わる(既定 0.5 で従来と一致)。
    if (rand(world) >= TACKLE_TRIGGER * tacklePressScale(world.tactics[opp.team].pressIntensity) * dt) continue;
    opp.tackleCooldown = TACKLE_COMMIT_TIME;
    // 成功率: 至近ほど / 正面ほど / 重いタッチ(ボール露出)ほど高い。
    const prox = Math.max(0, 1 - dToBall / TACKLE_RANGE);
    // 露出: 重いタッチ(ボールが保持者から離れている)ほど僅かに奪いやすい。クロースコントロールでも
    // 極端には下げない(0.8 が下限)= 密着ドリブルへのタックルも十分成立する。
    const exposure = Math.min(1.4, 0.8 + 0.5 * (gap / CARRY_TOUCH_MAX));
    const pSuccess = Math.min(0.85, TACKLE_BASE * (0.5 + 0.5 * prox) * frontFactor * exposure);
    if (rand(world) < pSuccess) {
      // 成功: タックラー側にボールが渡る(タックラーの前=自分の攻撃方向へ収める)
      const tacklerHeading = norm(sub(goalCenter(opp.team), opp.pos));
      ball.ownerId = opp.id;
      ball.vel = { ...opp.vel };
      ball.pos = add(opp.pos, scale(tacklerHeading, DRIBBLE_OFFSET));
      ball.lastTouchTeam = opp.team;
      ball.lastPasserId = null;
      world.ballInFlightFrom = null;
      owner.kickCooldown = 0.3; // 奪われた側は一瞬コントロールを失う
      opp.touchTimer = CARRY_TOUCH_INTERVAL; // 収めた直後は一拍おく
      // タックル勝者も他の受球と同じファーストタッチの整え(V)を通す: 足を出して奪った直後に
      // 即座に前線へ展開できると、全タックルが即発カウンターになりショット/ゴールが倍増する
      // (v4計測)。整えは意思決定レイテンシでありファンブルではない(task-k の教訓に整合)。
      recordReception(world, opp);
      applyFirstTouchSettle(world, opp);
      // 分類は実データ(StatsBomb)のセマンティクスに合わせる: 保持者の足元(gap<=1.2m)で
      // ボールに挑んで勝った=タックル(steals)。重いタッチで保持者から離れた(gap>1.2m)
      // ボールを先読みして回収した=インターセプション(ルーズタッチの回収は tackle ではなく
      // recovery/interception として記録されるのが実データの分類)。
      if (gap > 1.2) world.stats[opp.team].interceptions++;
      else world.stats[opp.team].steals++;
      return; // 1tickに踏み込みの成功は1回だけ
    }
    // 失敗: 保持者が動いてタックラーの脇を運び抜けている時だけ「抜かれた」(鈍化・旋回制限で
    // 可視的に置いていかれる)。静止/シールド相手への失敗は踏み込みの空振り(コミットのみ)で、
    // ビートにはしない — 全失敗をビートにすると接触時間の約半分がビート死時間になり、
    // プレス(Task W)が構造的に弱体化して goals が帯域を超える(掃引2の教訓)。
    // 「抜かれた」= 保持者がほぼ全力で運び抜けている(クロースコントロール上限級)ときだけ。
    // 低速の失敗はただの空振り(コミットのみ)— ビートを乱発するとプレスが構造的に弱体化する。
    if (len(owner.vel) > 4.2) {
      opp.beatenUntil = world.clock + TACKLE_BEATEN_TIME;
      world.stats[opp.team].tackleLost++;
    }
  }
}

/**
 * 仕掛け(テイクオン)の勝敗確定(Task Y)。押し出したルーズボールを誰かが収めた時点で呼ぶ。
 * 収めたのが仕掛け本人のチームなら成功(takeOnWon++)、相手なら失敗(=クリーンに回収された)。
 */
function resolveTakeOn(world: World, newOwner: Player): void {
  if (world.takeOnRunnerId === null) return;
  const runner = world.players[world.takeOnRunnerId];
  if (newOwner.team === runner.team) world.stats[runner.team].takeOnWon++;
  runner.burstUntil = 0; // 仕掛けは決着 → バースト終了(この後は通常の保持者/守備者へ)
  world.takeOnRunnerId = null;
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
function applyFirstTouchSettle(world: World, receiver: Player, allowFirstTime = true): void {
  if (receiver.role === GK_ROLE) return; // GKは専用の配球ロジック(整え対象外)
  // ファーストタッチ・シュート(Task Z Req2): ボックス内・高質の受けは整えをバイパスしてワンタッチ。
  // これが「受け手はオーナーになってから1判断tick待つ必要がある=一発のフィニッシュが物理的に不可能」
  // という制約を外す。整えの直前オフボール意図はクリアし、意思決定を FIRST_TIME_DECISION まで即断。
  // median release ゲート(>=0.8s)を割らないよう、発火はボックス内の限定局面のみ(spec)。
  // allowFirstTime=false(仕掛け成功の収球, Task Y 是正)ではバイパスせず整えを通す。
  if (allowFirstTime && isFirstTimeShot(receiver)) {
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
  if (ball.ownerId !== null) {
    // 通常、所有ボールは足元にあるので場外判定しない。だがタッチドリブル(Task Y)で押し出した
    // ボールはルーズだが所有のまま転がるため、ラインを越えても handleBoundaries が素通りして
    // ~数m 外に留まる artifact があった。場内なら従来どおり素通り、場外に出ていたら「運び出した」
    // =場外として扱い、所有を解いてから下のゴール/再開ロジックへフォールスルーする(安価な修正)。
    if (Math.abs(ball.pos.x) <= HALF_L && Math.abs(ball.pos.y) <= HALF_W) return;
    const carrier = world.players[ball.ownerId];
    ball.ownerId = null;
    ball.vel = vec(0, 0);
    ball.lastTouchTeam = carrier.team; // 運び出した側の最後のタッチ
    world.ballInFlightFrom = null;
  }

  // ゴール判定。浮き球はクロスバー(2.44m)より下で越えた時だけゴール(Task AA:
  // クリア/パントの飛び越えはゴールではなく、下の場外再開へフォールスルーする)
  if (Math.abs(ball.pos.x) > HALF_L && Math.abs(ball.pos.y) < GOAL_WIDTH / 2 && ball.z < CROSSBAR_HEIGHT) {
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
      gk.gkGainedAt = -1; // ゴールキック再開: ホールドを再 seed させる(Task AB)
      // 競技規則16(Task AB): ゴールキック時、相手競技者はペナルティエリアの外に出る。
      // 従来は直前の攻撃の相手がボックス内に残留したまま再開され、GKの再開ホールド(lull)が
      // 即座に潰され、至近距離の即時プレスがボックス内ターンオーバーを養殖していた(4×5min
      // トレース: GKICK spell の相手初期距離 3.7〜9.7m、held 0.18s → box-TO → 1.2m で PUNT)。
      // ボックス内の相手をエリア境界の1m前方(x方向)へ出す。y はそのまま=横の散らばりを保つ。
      // 乱数不使用。ボックス内に相手がいなければ挙動は従来と同一。ゴールキックはこのタスクの
      // 「GK自身のリリース」の一部(スローイン/コーナー等の他の再開は Task AI)。
      const inSign = restartTeam === 0 ? 1 : -1; // 再開側ゴールからピッチ中央への向き
      const boxEdgeX = restartOwnGoalX + inSign * (FIRST_TIME_BOX_DEPTH + 1);
      for (const opp of world.players) {
        if (opp.team === restartTeam) continue;
        const depthIntoBox = inSign * (opp.pos.x - restartOwnGoalX); // 自ゴールからの前方距離
        const insideBox =
          depthIntoBox < FIRST_TIME_BOX_DEPTH && Math.abs(opp.pos.y) < FIRST_TIME_BOX_HALF_WIDTH;
        if (insideBox) {
          opp.pos.x = boxEdgeX;
          opp.vel = vec(0, 0);
          opp.moveTarget = { ...opp.pos };
          opp.intent = null;
        }
      }
      ball.pos = { ...spot };
      ball.vel = vec(0, 0);
      ball.z = 0;
      ball.vz = 0;
      ball.ownerId = gk.id;
      ball.lastTouchTeam = restartTeam;
      world.ballInFlightFrom = null;
      resolveTakeOn(world, gk); // 仕掛けのボールが外に出た場合もここで決着(バースト残留を防ぐ)
      return;
    }

    const spot = vec(
      Math.max(-HALF_L + 0.5, Math.min(HALF_L - 0.5, ball.pos.x)),
      Math.max(-HALF_W + 0.5, Math.min(HALF_W - 0.5, ball.pos.y)),
    );
    ball.pos = spot;
    ball.vel = vec(0, 0);
    ball.z = 0;
    ball.vz = 0;
    // 再開側の最寄り選手にボールを渡し、その場に立たせる
    const taker = world.players
      .filter((p) => p.team === restartTeam)
      .reduce((a, b) => (dist(a.pos, spot) < dist(b.pos, spot) ? a : b));
    taker.pos = add(spot, scale(norm(sub(taker.pos, spot)), 0.3));
    taker.vel = vec(0, 0);
    ball.ownerId = taker.id;
    ball.lastTouchTeam = restartTeam;
    resolveTakeOn(world, taker); // 仕掛けのボールが外に出た場合もここで決着(バースト残留を防ぐ)
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
