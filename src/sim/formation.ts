import { GK_BUILDUP_DEPTH, GK_DEPTH, GOAL_WIDTH, PITCH_LENGTH, PITCH_WIDTH } from './constants';
import { defensiveLineX } from './line';
import type { Player, World } from './types';
import { add, dist, norm, scale, sub, vec, type Vec } from './vec';

/** フィールド10人の並び。GK(role 0)は全フォーメーションに自動で付く */
export const FORMATION_NAMES = ['4-4-2', '4-3-3', '4-2-3-1', '3-5-2', '3-4-3', '5-3-2'] as const;
export type FormationName = (typeof FORMATION_NAMES)[number];

/** role 0 は常にGK。背番号1 */
export const GK_ROLE = 0;

const HALF_L = PITCH_LENGTH / 2;
const HALF_W = PITCH_WIDTH / 2;

/**
 * フォーメーション文字列から基準点(正規化座標)を生成。
 * x: -1(自ゴール)〜+1(相手ゴール), y: -1〜+1。
 * index 0 がGK、以降は守備ラインから順に並ぶ(計11人)。
 */
export function baseAnchors(name: FormationName): Vec[] {
  const lines = name.split('-').map(Number); // 例: [4, 4, 2]
  const anchors: Vec[] = [vec(-0.88, 0)]; // GK
  lines.forEach((count, lineIdx) => {
    const x = -0.6 + (lineIdx / (lines.length - 1)) * 1.0; // -0.6(DF) 〜 +0.4(FW)
    for (let i = 0; i < count; i++) {
      const y = count === 1 ? 0 : ((i - (count - 1) / 2) / ((count - 1) / 2)) * 0.6;
      anchors.push(vec(x, y));
    }
  });
  return anchors;
}

/**
 * キックオフ時の立ち位置。
 * 蹴る側はハーフライン近くまで上げる(中央のFWがすぐ後ろに味方を持てるように)。
 * 受ける側は自陣に深く圧縮して構える。蹴る側を深くするとFWが孤立して
 * 後方への長いパスしかなくなり、キックオフが構造的に不利になってしまう。
 */
export function kickoffPos(team: number, role: number, name: FormationName, kicking = false): Vec {
  const sign = team === 0 ? 1 : -1; // 攻撃方向
  if (role === GK_ROLE) return vec(-sign * (HALF_L - GK_DEPTH), 0);
  const a = baseAnchors(name)[role];
  const x = kicking ? a.x * 0.45 - 0.2 : a.x * 0.35 - 0.5;
  return vec(sign * x * HALF_L, a.y * HALF_W * 0.8);
}

/**
 * GKの基準位置。
 * 守備時・相手保持時: 自ゴールとボールを結ぶ線上、ゴールからGK_DEPTHだけ前(角度消し)。
 * 自チーム保持かつボールが自陣にあるとき: ゴールから前に出て(GK_BUILDUP_DEPTH)
 * バックパスの逃げ場を作る(ビルドアップ参加)。ボールが敵陣に入ったら通常ポジションへ戻す。
 */
export function gkAnchor(world: World, team: number): Vec {
  const sign = team === 0 ? 1 : -1;
  const goal = vec(-sign * HALF_L, 0);
  const ownerTeam =
    world.ball.ownerId === null ? null : world.players[world.ball.ownerId].team;
  // 自陣度: ボールが自ゴールに近いほど1、ハーフライン付近で0
  const ownHalfNess = Math.max(0, Math.min(1, (-sign * world.ball.pos.x) / HALF_L));

  if (ownerTeam === team && ownHalfNess > 0) {
    // ビルドアップ: ゴール前に出てバックパスのコースを作る。
    // 自陣深いほど前に出る(GK_DEPTH 〜 GK_BUILDUP_DEPTH)。横はボールy方向に少し寄せる
    const depth = GK_DEPTH + (GK_BUILDUP_DEPTH - GK_DEPTH) * ownHalfNess;
    const pos = vec(goal.x + sign * depth, world.ball.pos.y * 0.3);
    pos.y = Math.max(-GOAL_WIDTH / 2 - 4, Math.min(GOAL_WIDTH / 2 + 4, pos.y));
    return pos;
  }

  // ボールが近いほどさらに前に出て角度を消す(最大+2m)
  const close = Math.max(0, 1 - dist(world.ball.pos, goal) / 25);
  const pos = add(goal, scale(norm(sub(world.ball.pos, goal)), GK_DEPTH + close * 2));
  pos.y = Math.max(-GOAL_WIDTH / 2 - 1.5, Math.min(GOAL_WIDTH / 2 + 1.5, pos.y));
  pos.x = Math.max(-HALF_L + 0.8, Math.min(HALF_L - 0.8, pos.x));
  return pos;
}

/**
 * 現在の状況に応じた基準点(ワールド座標)。
 * 陣形全体がボールに引っ張られてスライドし、攻撃時は押し上げ・守備時は撤退する。
 * オフボールのランと守備のゾーンはここを中心に行われる。GKは専用ロジック。
 */
export function dynamicAnchor(world: World, p: Player): Vec {
  if (p.role === GK_ROLE) return gkAnchor(world, p.team);

  const name = world.formations[p.team];
  const anchors = baseAnchors(name);
  const a = anchors[p.role];
  const sign = p.team === 0 ? 1 : -1;
  const ownerTeam =
    world.ball.ownerId === null ? null : world.players[world.ball.ownerId].team;
  const attacking = ownerTeam === p.team;

  let x = sign * a.x * HALF_L * 0.78;
  let y = a.y * HALF_W * 0.8;
  x += world.ball.pos.x * 0.25;
  y += world.ball.pos.y * 0.35;
  // ライン高さ: ハイラインほど基準点を前進、深く構えるほど後退(攻守共通)
  x += sign * world.tactics[p.team].lineHeight * 7;

  if (!attacking) {
    // 守備時(または保持者なし): ブロックを圧縮し、一体でスライド/収縮させる。
    // 旧実装は全員一律 -7m の並進撤退で、ラインが縮まらずブロックが ~51m に間延びし、
    // FWは相手ラインにピン留めされて上端を押し上げていた(Task AC で修正)。
    const cls = classifyRole(name, p.role);

    // 横: ボール側へ強めに寄せる(共通の ball.y*0.35 に守備だけ +0.15 = 実質 ball.y*0.5)。
    y += world.ball.pos.y * 0.15;
    // 逆サイドのタック: ボールが片サイドに開くほど(|ball.y|→12mで最大)、逆サイドの
    // 選手を中央へ寄せてブロック幅を絞る。AE(攻撃SB)と同じ farFactor の滑らかな係数で、
    // ボール側(farFactor=0)は不変・逆サイドほど最大35%中央寄せ。ハードスイッチなし。
    // 中央の選手(a.y===0)は Math.sign で signAY=0 → farFactor=0(左右対称。旧 `a.y>=0?1:-1`
    // は中央選手を常に「+y側」と誤判定し、ボールが±yで圧縮が非対称になりミラー対称性を破っていた, Task AR)。
    const signAY = Math.sign(a.y);
    const farFactor = Math.max(0, Math.min(1, (-signAY * world.ball.pos.y) / 12));
    y *= 1 - 0.35 * farFactor;

    // DFラインの正規化深さ(GKを除く最小x)。中盤の圧縮基準に使う。
    let dfAX = Infinity;
    for (let i = 0; i < anchors.length; i++) {
      if (i !== GK_ROLE && anchors[i].x < dfAX) dfAX = anchors[i].x;
    }
    // 共有ラインコントローラ(Task AD): チーム単位の守備ライン基準x。バイアス0なら
    // 旧式(sign*dfAX*HALF_L*0.78 + ball.x*0.25 + lineHeight*7 + DF_RETREAT)と一致し、
    // ゲーム状態(無圧の保持者=ドロップ / 圧・後方へのボール=ステップ)で前後する。
    // DF・中盤・FWキャップが全てこの一つの基準から導かれる=バック4が一体で呼吸する。
    const dfWorldX = defensiveLineX(world, p.team);

    if (cls.isFW) {
      // FWは「相手の最終ライン(バックス)と中盤の間」にカバーシャドウで構える(Task J)。
      // 相手フィールドプレーヤーを攻撃方向の深さ(sign*x)で見る。バックス=最深の集団、
      // 中盤=その手前。両者の間(ややバックス寄り 0.62)に置く。
      const opp = world.players.filter((q) => q.team !== p.team && q.role !== GK_ROLE);
      const prog = opp.map((q) => sign * q.pos.x).sort((a, b) => b - a); // 降順(深い順)
      const backsProg = (prog[0] + prog[Math.min(1, prog.length - 1)]) / 2;
      const midProg = prog[Math.min(prog.length - 1, Math.floor(prog.length / 2))];
      const targetProg = midProg + (backsProg - midProg) * 0.62;
      // 自ブロック基準で深さを制限: 自DFラインより FW_CAP_AHEAD 以上前へは出ない。
      // 相手ラインにピン留めしてブロックを間延びさせるのを防ぐ(Task AC)。上限は
      // 「出口役のFWは高く残す=カウンターの逃げ場を保つ」ため深くしすぎない(得点床の保護)。
      const FW_CAP_AHEAD = 26;
      const fwCap = sign * dfWorldX + FW_CAP_AHEAD; // 前進方向(フォワード深さ)の上限
      x = sign * Math.min(targetProg, fwCap);
    } else {
      // ライン依存の圧縮: 中盤ほどDFライン側へ引き下げ、DF-MF間を詰める(≤~12m)。
      // DFライン(a.x==dfAX)はライン基準そのもの(圧縮ゼロ)= バック4はフラットに一体で動く。
      // 旧式(自基準からのシフト+一律撤退)と、コントローラのバイアス0時に代数的に一致(Task AD)。
      const BLOCK_COMPRESS = 0.25; // 中盤の対DFライン間隔を25%に圧縮(実質 ~5m のバンク)
      const compressedAX = dfAX + (a.x - dfAX) * BLOCK_COMPRESS;
      x = dfWorldX + sign * (compressedAX - dfAX) * HALF_L * 0.78;
    }
  } else {
    // 攻撃時: フォーメーションは守備時の形なので、役割別に攻撃の形へ変換する。
    // ボールが自陣深い(押し込まれている)ほど押し上げを弱め、敵陣では強める。
    const cls = classifyRole(name, p.role);
    // attackProgress: -1(自陣ゴール際)〜+1(敵陣ゴール際)。自チームの攻める向きで正規化
    const attackProgress = Math.max(-1, Math.min(1, (sign * world.ball.pos.x) / HALF_L));
    const advance = 0.5 + 0.5 * Math.max(0, attackProgress); // 0.5(自陣)〜1.0(敵陣)
    // ビルドアップ支援: 自陣でボールを保持している(attackProgress<0)あいだ、バックスは
    // 押し下げられず「出口」として押し上げる。全体スライド(上の x += ball.x*0.25)が
    // 自陣保持時にバックスを不必要に深く引く(=ビルドアップを支えず撤退する)問題への対処。
    // 0(ハーフライン)〜1(自ゴール際)。敵陣保持時(attackProgress>=0)は0。
    const buildupSupport = Math.max(0, -attackProgress);

    if (cls.isFW) {
      // 相手最終ライン(GK除く最深フィールドプレーヤー)にピン留め。少し手前に置いて裏抜けの助走を残す
      const opp = world.players.filter((q) => q.team !== p.team && q.role !== GK_ROLE);
      // 相手の最終ライン = 自チームのゴール方向に最も深い相手の位置
      const lineX =
        sign > 0 ? Math.max(...opp.map((q) => q.pos.x)) : Math.min(...opp.map((q) => q.pos.x));
      x = lineX - sign * 1.5; // ラインの1.5m手前(オフサイドの概念はないが助走と相対のため)
      // 注(Task AA): 「ファイナルサードでFWを中央へ絞る」アンカー変更は計測の結果 REJECTED —
      // 両FWが常時CBの目の前に立って裏抜け/受けの経済が悪化し shots が ~25% 落ちた
      // (12×8min ablation)。ボックスへ人を送るのはオフボールのラン(postRun/lateRun)が担う。
    } else if (cls.isSB) {
      // SBは大きく押し上げてオーバーラップ。幅も広く保つ。自陣保持中も出口として押し上げ、
      // 全体スライドで深く引かれない(buildupSupport)。
      // ただし両SBが同時に押し上げるのは非現実的(レストディフェンス欠如)。ボール逆サイドの
      // SBはカウンター保険として絞る。sameSideか否かをfarFactorで滑らか化: ボールがy=0に
      // 近い(中央)か同サイドならfarFactor=0(現行どおり)、逆サイドに開くほど1に近づく。
      // Math.sign で中央(a.y===0)は signAY=0(左右対称)。SBは常に|y|最大なので実挙動は不変(Task AR)。
      const signAY = Math.sign(a.y);
      const farFactor = Math.max(0, Math.min(1, (-signAY * world.ball.pos.y) / 12));
      const advanceCoef = 16 - 10 * farFactor; // 同サイド16 → 逆サイド6
      x += sign * (advanceCoef * advance + 8 * buildupSupport); // buildupSupportは対称のまま
      const widthFactor = 0.95 - 0.59 * farFactor; // 同サイドはタッチライン際(0.95)、逆サイドは絞る(0.36≒12m)
      y = a.y * HALF_W * widthFactor;
    } else if (cls.isCB) {
      // CBは押し上げ控えめ(カウンター保険)。ただし自陣ビルドアップ中は出口として押し上げ、
      // 全体スライドで不必要に深く引かれないようにする(buildupSupport)。
      x += sign * (5 * advance + 10 * buildupSupport);
    } else {
      // 中盤・その他: ボールが敵陣深い(ファイナルサード)ほど強く押し上げ、
      // レイトランでボックスに迫れる土台を作る。
      // 持続的なファイナルサード保持(attackProgressが高い)ときは中盤の基準点を
      // さらにボックス手前まで上げ、レイトラン/オーバーラップが時間内に届くようにする。
      // ただしボールがまだ深くない(ビルドアップ〜中盤)ときは控えめに保ち、
      // 押し上げが早すぎて後方が空く(task-Fのトレードオフ)のを避ける。
      // finalThird: 敵陣最後の~30m(attackProgress>0.43)で滑らかに立ち上がる係数。
      // ファイナルサードを持続的に保持するときは中盤の基準点をボックス手前(ゴール
      // 25m圏付近)まで引き上げ、レイトラン/オーバーラップを「短いバースト」で
      // 届かせる。ビルドアップ〜中盤(finalThird=0)では従来どおり控えめに保つ。
      const finalThird = Math.max(0, Math.min(1, (attackProgress - 0.43) / 0.4));
      x += sign * (9 + 9 * Math.max(0, attackProgress) + 18 * finalThird) * advance;
    }
  }

  x = Math.max(-HALF_L + 1.5, Math.min(HALF_L - 1.5, x));
  y = Math.max(-HALF_W + 1, Math.min(HALF_W - 1, y));
  return vec(x, y);
}

/** 最前線(FW)のロールindex。キックオフでボールを持つ選手 */
export function forwardRole(name: FormationName): number {
  const anchors = baseAnchors(name);
  let best = 0;
  anchors.forEach((a, i) => {
    if (a.x > anchors[best].x) best = i;
  });
  return best;
}

/**
 * ロールの役割分類(baseAnchorsの正規化座標から導出)。
 * フォーメーションは「守備時の形」なので、攻撃時はこの分類で基準点の変換を変える。
 * - DFライン: GKを除いて最も自陣寄り(最小x)の集団
 * - SB: DFラインで|y|が最大の両端2人(押し上げてオーバーラップ)
 * - CB: DFラインのうちSB以外(中央。押し上げ控えめでカウンター保険)
 * - FWライン: 最も相手ゴール寄り(最大x)の集団(相手最終ラインにピン留め)
 */
export interface RoleClass {
  isFW: boolean;
  isSB: boolean;
  isCB: boolean;
}

const EPS = 1e-6;

export function classifyRole(name: FormationName, role: number): RoleClass {
  if (role === GK_ROLE) return { isFW: false, isSB: false, isCB: false };
  const anchors = baseAnchors(name);
  const field = anchors.map((_, i) => i).filter((i) => i !== GK_ROLE);
  const minX = Math.min(...field.map((i) => anchors[i].x));
  const maxX = Math.max(...field.map((i) => anchors[i].x));
  const dfLine = field.filter((i) => Math.abs(anchors[i].x - minX) < EPS);
  const fwLine = field.filter((i) => Math.abs(anchors[i].x - maxX) < EPS);

  // SB = DFラインで|y|が大きい両端(2人。3バックでも両端をSB/WB扱いで押し上げる)
  const dfByAbsY = [...dfLine].sort((a, b) => Math.abs(anchors[b].y) - Math.abs(anchors[a].y));
  const sb = dfByAbsY.slice(0, 2).filter((i) => Math.abs(anchors[i].y) > EPS);

  const isFW = fwLine.includes(role);
  // FWラインがDFラインと同一になる事はない(複数ライン)。FW優先で判定
  const isSB = !isFW && sb.includes(role);
  const isCB = !isFW && dfLine.includes(role) && !isSB;
  return { isFW, isSB, isCB };
}

/**
 * 指定したフォーメーションで、与えたセマンティック分類に該当するロールindex一覧
 * (GKは除く)を返す。フォーメーション変更時に「CB→CB」「FW→FW」のように同分類で
 * マッチさせるために setFormation が使う。
 * cls が空(全フラグ未指定)の場合は中盤(FW/SB/CBのいずれでもない)を返す。
 */
export function roleIndicesByClass(
  name: FormationName,
  cls: { isFW?: boolean; isSB?: boolean; isCB?: boolean },
): number[] {
  const anchors = baseAnchors(name);
  return anchors
    .map((_, i) => i)
    .filter((i) => i !== GK_ROLE)
    .filter((i) => {
      const c = classifyRole(name, i);
      if (cls.isFW) return c.isFW;
      if (cls.isSB) return c.isSB;
      if (cls.isCB) return c.isCB;
      return !c.isFW && !c.isSB && !c.isCB; // 中盤
    });
}
