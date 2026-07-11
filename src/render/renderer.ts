import { laneRisk } from '../sim/ai';
import { dynamicAnchor, GK_ROLE } from '../sim/formation';
import {
  GOAL_WIDTH,
  PITCH_LENGTH,
  PITCH_WIDTH,
  PLAYER_MAX_SPEED,
  PLAYER_RADIUS,
} from '../sim/constants';
import { defensiveLineX } from '../sim/line';
import type { IntentKind, Player, Team, World } from '../sim/types';
import { ballOwner, teammates } from '../sim/world';
import { dist, type Vec } from '../sim/vec';

const TEAM_COLORS = ['#3b82f6', '#ef4444'];
const GK_COLORS = ['#06b6d4', '#f97316']; // GKはチームと違う色のユニフォーム
const MARGIN = 4; // ピッチ外周の余白(m)

export interface DragState {
  player: Player;
  current: Vec; // ワールド座標
}

export interface Overlays {
  passLanes: boolean;
  spaceControl: boolean;
  anchors: boolean;
  intents: boolean;
  futureSpace: boolean;
  /** 守備ライン(defensiveLineX, Task AD)の破線表示。Task AU */
  defensiveLine: boolean;
}

/**
 * 選手の moveTarget に向かって PLAYER_MAX_SPEED * seconds * 0.85 だけ進んだ予測位置。
 * moveTarget が近ければそこで停止。
 */
export function predictedPos(p: { pos: { x: number; y: number }; moveTarget: { x: number; y: number } }, seconds: number): { x: number; y: number } {
  const maxDist = PLAYER_MAX_SPEED * seconds * 0.85;
  const dx = p.moveTarget.x - p.pos.x;
  const dy = p.moveTarget.y - p.pos.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9 || d <= maxDist) return { x: p.moveTarget.x, y: p.moveTarget.y };
  const t = maxDist / d;
  return { x: p.pos.x + dx * t, y: p.pos.y + dy * t };
}

const INTENT_LABELS: Record<IntentKind, string> = {
  hold: '維持',
  support: 'サポート',
  runBehind: '裏抜け',
  lateRun: 'レイトラン',
  giveAndGo: 'ワンツー',
  overlap: 'オーバーラップ',
  underlap: 'アンダーラップ',
  decoy: '囮',
  takeOn: '仕掛け',
  press: 'プレス',
  mark: 'マーク',
  cutLane: 'コース切り',
  cover: 'カバー',
  recover: '戻り',
  carry: '運ぶ',
  chase: '回収',
  keeper: 'GK',
  gkHold: 'GK配球',
};

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;

  // オフサイド・オーバーレイ(Task AU): 笛の瞬間のボール位置(=反則地点)を1回だけ捕捉し、
  // 再開後にボールが動いても「その場所」に表示し続ける。world.message は再利用される
  // (ゴール表示など)ため参照の変化を見て新規メッセージかどうかを判定する。
  private lastMessage: { text: string; until: number } | null = null;
  private offsideSpot: Vec | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  /** キャンバスサイズに合わせてワールド→画面の変換を再計算 */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const worldW = PITCH_LENGTH + MARGIN * 2;
    const worldH = PITCH_WIDTH + MARGIN * 2;
    this.scale = Math.min(w / worldW, h / worldH);
    this.offsetX = w / 2;
    this.offsetY = h / 2;
  }

  toScreen(p: Vec): Vec {
    return { x: this.offsetX + p.x * this.scale, y: this.offsetY + p.y * this.scale };
  }

  toWorld(screenX: number, screenY: number): Vec {
    return { x: (screenX - this.offsetX) / this.scale, y: (screenY - this.offsetY) / this.scale };
  }

  draw(world: World, overlays: Overlays, drag: DragState | null): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#1a4a26';
    ctx.fillRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);

    if (overlays.spaceControl) this.drawSpaceControl(world);
    if (overlays.futureSpace) this.drawFutureSpace(world);
    this.drawPitch();
    if (overlays.defensiveLine) this.drawDefensiveLine(world);
    if (overlays.anchors) this.drawAnchors(world);
    if (overlays.passLanes) this.drawPassLanes(world);
    if (overlays.defensiveLine) this.drawOffsideHints(world);
    this.drawInstructions(world);
    for (const p of world.players) this.drawPlayer(world, p);
    if (overlays.intents) this.drawIntents(world);
    this.drawBall(world);
    if (drag) this.drawDrag(world, drag);
    this.drawOffsideMessage(world);
  }

  /**
   * 笛の瞬間のボール位置を捕捉する(Task AU)。world.message は同一オブジェクトが
   * until経過までそのまま保持されるので、参照が変わった=新規メッセージの発生とみなす。
   */
  private captureOffsideSpot(world: World): void {
    if (world.message === this.lastMessage) return;
    this.lastMessage = world.message;
    this.offsideSpot = world.message && world.message.text === 'オフサイド' ? { ...world.ball.pos } : null;
  }

  /** オフサイドの笛のみ専用オーバーレイ(反則地点付近・フェード)。他のメッセージ(ゴール等)は既存のdrawMessageのまま */
  private drawOffsideMessage(world: World): void {
    this.captureOffsideSpot(world);
    if (!world.message) return;
    if (world.message.text === 'オフサイド' && this.offsideSpot) {
      const remain = world.message.until - world.clock;
      this.drawOffsideOverlay(this.offsideSpot, remain);
      this.drawOffsideOffenderFlash(world, remain);
      return;
    }
    this.drawMessage(world.message.text);
  }

  private line(a: Vec, b: Vec): void {
    const sa = this.toScreen(a);
    const sb = this.toScreen(b);
    this.ctx.beginPath();
    this.ctx.moveTo(sa.x, sa.y);
    this.ctx.lineTo(sb.x, sb.y);
    this.ctx.stroke();
  }

  private drawPitch(): void {
    const ctx = this.ctx;
    const hl = PITCH_LENGTH / 2;
    const hw = PITCH_WIDTH / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 2;

    const tl = this.toScreen({ x: -hl, y: -hw });
    ctx.strokeRect(tl.x, tl.y, PITCH_LENGTH * this.scale, PITCH_WIDTH * this.scale);
    this.line({ x: 0, y: -hw }, { x: 0, y: hw });

    const c = this.toScreen({ x: 0, y: 0 });
    ctx.beginPath();
    ctx.arc(c.x, c.y, 9.15 * this.scale, 0, Math.PI * 2);
    ctx.stroke();

    // ペナルティエリア(16.5m)・ゴールエリア(5.5m)・ペナルティスポット(11m)
    for (const side of [-1, 1]) {
      for (const [depth, width] of [
        [16.5, 40.32],
        [5.5, 18.32],
      ]) {
        const topLeft = this.toScreen({ x: side > 0 ? hl - depth : -hl, y: -width / 2 });
        ctx.strokeRect(topLeft.x, topLeft.y, depth * this.scale, width * this.scale);
      }
      const spot = this.toScreen({ x: side * (hl - 11), y: 0 });
      ctx.beginPath();
      ctx.arc(spot.x, spot.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fill();
    }

    // ゴール
    ctx.lineWidth = 5;
    for (const side of [-1, 1]) {
      ctx.strokeStyle = side === 1 ? TEAM_COLORS[0] : TEAM_COLORS[1]; // 攻める側の色
      this.line({ x: side * hl, y: -GOAL_WIDTH / 2 }, { x: side * hl, y: GOAL_WIDTH / 2 });
    }
  }

  /** 各マスに先に到達できるチームで塗る(到達時間 = 距離 / 最高速度) */
  private drawSpaceControl(world: World): void {
    const ctx = this.ctx;
    const cell = 2;
    for (let x = -PITCH_LENGTH / 2; x < PITCH_LENGTH / 2; x += cell) {
      for (let y = -PITCH_WIDTH / 2; y < PITCH_WIDTH / 2; y += cell) {
        const center = { x: x + cell / 2, y: y + cell / 2 };
        let t0 = Infinity;
        let t1 = Infinity;
        for (const p of world.players) {
          const t = dist(p.pos, center) / PLAYER_MAX_SPEED;
          if (p.team === 0) t0 = Math.min(t0, t);
          else t1 = Math.min(t1, t);
        }
        const adv = t1 - t0; // 正なら青が先に着く
        const alpha = Math.min(0.30, Math.abs(adv) * 0.18);
        ctx.fillStyle = adv > 0 ? `rgba(59,130,246,${alpha})` : `rgba(239,68,68,${alpha})`;
        const s = this.toScreen({ x, y });
        ctx.fillRect(s.x, s.y, cell * this.scale + 1, cell * this.scale + 1);
      }
    }
  }

  /** 2秒後の予測位置をもとにスペース支配をドットで表示し、ゴーストを描く */
  private drawFutureSpace(world: World): void {
    const ctx = this.ctx;
    const FUTURE_SEC = 2;
    const cell = 2;
    const ghosts = world.players.map((p) => predictedPos(p, FUTURE_SEC));

    // セル中央に小さな丸ドットで未来のスペース支配を表示
    const dotR = 0.38 * this.scale;
    for (let x = -PITCH_LENGTH / 2; x < PITCH_LENGTH / 2; x += cell) {
      for (let y = -PITCH_WIDTH / 2; y < PITCH_WIDTH / 2; y += cell) {
        const center = { x: x + cell / 2, y: y + cell / 2 };
        let t0 = Infinity;
        let t1 = Infinity;
        for (let i = 0; i < world.players.length; i++) {
          const p = world.players[i];
          const g = ghosts[i];
          const t = dist(g, center) / PLAYER_MAX_SPEED;
          if (p.team === 0) t0 = Math.min(t0, t);
          else t1 = Math.min(t1, t);
        }
        const adv = t1 - t0;
        if (Math.abs(adv) < 0.05) continue; // 差がほぼない場所はスキップ
        const alpha = Math.min(0.80, Math.abs(adv) * 0.28 + 0.15);
        ctx.fillStyle = adv > 0 ? `rgba(59,130,246,${alpha})` : `rgba(239,68,68,${alpha})`;
        const s = this.toScreen(center);
        ctx.beginPath();
        ctx.arc(s.x, s.y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 予測位置にゴースト(半透明の破線輪郭円、背番号なし)
    for (let i = 0; i < world.players.length; i++) {
      const p = world.players[i];
      const s = this.toScreen(ghosts[i]);
      const r = PLAYER_RADIUS * this.scale * 1.4;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = `${TEAM_COLORS[p.team]}88`;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /**
   * 守備ライン(Task AD `defensiveLineX`, 読み取り専用インポート)を薄い破線で表示する(Task AU)。
   * ボール保持チームがはっきりしていれば「守備側(非保持)」だけ、こぼれ球(保持者なし)は
   * 両チームを表示する — 描画は players より前(＝背後)、細く低アルファでクラッター回避。
   */
  private drawDefensiveLine(world: World): void {
    const ctx = this.ctx;
    const owner = ballOwner(world);
    const teams: Team[] = owner ? [((1 - owner.team) as Team)] : [0, 1];
    const hw = PITCH_WIDTH / 2;
    for (const team of teams) {
      const x = defensiveLineX(world, team);
      ctx.strokeStyle = `${TEAM_COLORS[team]}4d`; // 低アルファ(約30%)
      ctx.lineWidth = 1.5;
      ctx.setLineDash([7, 6]);
      this.line({ x, y: -hw }, { x, y: hw });
      ctx.setLineDash([]);
    }
  }

  /**
   * 飛行中のパスでオフサイド・ポジションにフラグされている受け手(world.offsideIds)を
   * 薄いリング(点線・低アルファ)で示す(Task AU、任意)。world状態を読むだけで
   * 追加計算なし= 「trivially cheap」の要件を満たす。
   */
  private drawOffsideHints(world: World): void {
    if (world.ballInFlightFrom === null || world.offsideIds.length === 0) return;
    const ctx = this.ctx;
    for (const id of world.offsideIds) {
      const p = world.players[id];
      const s = this.toScreen(p.pos);
      const r = PLAYER_RADIUS * this.scale * 2.2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(250,204,21,0.55)'; // 旗を意識した薄い黄
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** 各選手のフォーメーション基準点(×印)と持ち場への線 */
  private drawAnchors(world: World): void {
    const ctx = this.ctx;
    for (const p of world.players) {
      const a = this.toScreen(dynamicAnchor(world, p));
      const r = 5;
      ctx.strokeStyle = `${TEAM_COLORS[p.team]}99`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(a.x - r, a.y - r);
      ctx.lineTo(a.x + r, a.y + r);
      ctx.moveTo(a.x + r, a.y - r);
      ctx.lineTo(a.x - r, a.y + r);
      ctx.stroke();
      ctx.setLineDash([3, 5]);
      this.line(p.pos, dynamicAnchor(world, p));
      ctx.setLineDash([]);
    }
  }

  /** ボール保持者から味方へのパスコースを、カットされる危険度の色で表示 */
  private drawPassLanes(world: World): void {
    const owner = ballOwner(world);
    if (!owner) return;
    const ctx = this.ctx;
    for (const t of teammates(world, owner)) {
      const risk = laneRisk(world, owner.pos, t.pos, owner.team);
      const hue = (1 - risk) * 120; // 緑→赤
      ctx.strokeStyle = `hsla(${hue}, 90%, 55%, 0.65)`;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 6]);
      this.line(owner.pos, t.pos);
      ctx.setLineDash([]);
    }
  }

  private drawArrow(from: Vec, to: Vec, color: string): void {
    const ctx = this.ctx;
    const sa = this.toScreen(from);
    const sb = this.toScreen(to);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
    const ang = Math.atan2(sb.y - sa.y, sb.x - sa.x);
    ctx.beginPath();
    ctx.moveTo(sb.x, sb.y);
    ctx.lineTo(sb.x - 10 * Math.cos(ang - 0.4), sb.y - 10 * Math.sin(ang - 0.4));
    ctx.lineTo(sb.x - 10 * Math.cos(ang + 0.4), sb.y - 10 * Math.sin(ang + 0.4));
    ctx.fill();
  }

  /** ユーザーが出した指示を矢印で表示 */
  private drawInstructions(world: World): void {
    for (const p of world.players) {
      if (p.instruction?.kind === 'move') {
        this.drawArrow(p.pos, p.instruction.target, 'rgba(255,255,0,0.8)');
      } else if (p.instruction?.kind === 'pass') {
        const r = world.players[p.instruction.receiverId];
        this.drawArrow(p.pos, r.pos, 'rgba(0,255,255,0.8)');
      }
    }
  }

  private drawPlayer(world: World, p: Player): void {
    const ctx = this.ctx;
    const s = this.toScreen(p.pos);
    const r = PLAYER_RADIUS * this.scale * 1.4;

    if (world.ball.ownerId === p.id) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = p.role === GK_ROLE ? GK_COLORS[p.team] : TEAM_COLORS[p.team];
    ctx.fill();
    if (p.instruction) {
      ctx.strokeStyle = '#ffff00';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(r * 1.1)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.number), s.x, s.y);
  }

  /** 各選手の現在の意図(動きの意味)をラベルと細い矢印で表示 */
  private drawIntents(world: World): void {
    const ctx = this.ctx;
    for (const p of world.players) {
      const label = p.instruction ? '指示' : p.intent ? INTENT_LABELS[p.intent.kind] : null;
      if (!label) continue;

      // 意図の行き先への細い線(ユーザー指示の矢印は別で描かれる)
      if (!p.instruction && p.intent && dist(p.pos, p.intent.target) > 2) {
        ctx.strokeStyle = `${TEAM_COLORS[p.team]}66`;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        this.line(p.pos, p.intent.target);
        ctx.setLineDash([]);
      }

      const s = this.toScreen(p.pos);
      const y = s.y + PLAYER_RADIUS * this.scale * 1.4 + 11;
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(label, s.x, y);
      ctx.fillStyle = p.instruction ? '#ffff66' : '#ffffff';
      ctx.fillText(label, s.x, y);
    }
  }

  private drawBall(world: World): void {
    const ctx = this.ctx;
    const s = this.toScreen(world.ball.pos);
    const z = world.ball.z;
    // 浮き球(Task AA): 地面の影は (x,y) に落ち、ボール本体は高さに応じて上へオフセット+拡大。
    // 接地球(z=0)は従来と同じ見た目(影なし・スケール1)。
    if (z > 0.05) {
      const shadowR = Math.max(0.18, 0.3 - z * 0.012) * this.scale;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, shadowR * 1.3, shadowR, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fill();
    }
    const ballY = s.y - z * 0.45 * this.scale; // 高さぶん画面上方へ
    const r = 0.3 * (1 + z * 0.1) * this.scale;
    ctx.beginPath();
    ctx.arc(s.x, ballY, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private drawDrag(world: World, drag: DragState): void {
    // パスになるドラッグ(保持者→味方の近く)はシアン、移動指示は黄色
    const isPass =
      world.ball.ownerId === drag.player.id &&
      teammates(world, drag.player).some((t) => dist(t.pos, drag.current) < 1.5);
    this.drawArrow(drag.player.pos, drag.current, isPass ? 'rgba(0,255,255,0.9)' : 'rgba(255,255,0,0.9)');
  }

  private drawMessage(text: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.fillRect(w / 2 - 140, h / 2 - 30, 280, 60);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);
  }

  /**
   * オフサイドの笛専用オーバーレイ(Task AU): 中央のモーダル風メッセージではなく、
   * 反則地点付近に小さくラベルを出し、残り0.5秒でフェードアウトする。
   * spot は笛が鳴った瞬間のボール位置(=再開地点)のスナップショット。
   */
  private drawOffsideOverlay(spot: Vec, remain: number): void {
    const ctx = this.ctx;
    const alpha = Math.max(0, Math.min(1, remain / 0.5));
    if (alpha <= 0) return;
    const s = this.toScreen(spot);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText('オフサイド', s.x, s.y - 26);
    ctx.fillStyle = '#facc15';
    ctx.fillText('オフサイド', s.x, s.y - 26);
    ctx.restore();
  }

  /**
   * オフサイドの反則者フラッシュ(Task AF rider — AU の文書化済みギャップ)。笛のメッセージ
   * 表示中、world.lastOffsideOffenderId の選手に点滅する黄リングを重ねる(drawOffsideHints
   * と同じ旗色・同じオーバーレイ様式。追加計算なし=world状態を読むだけ)。
   */
  private drawOffsideOffenderFlash(world: World, remain: number): void {
    const id = world.lastOffsideOffenderId;
    if (id === null || !world.players[id]) return;
    const alpha = Math.max(0, Math.min(1, remain / 0.5));
    if (alpha <= 0) return;
    const pulse = 0.55 + 0.45 * Math.sin(remain * 12); // 点滅(残り時間由来なので決定論)
    const ctx = this.ctx;
    const s = this.toScreen(world.players[id].pos);
    ctx.save();
    ctx.globalAlpha = alpha * pulse;
    ctx.beginPath();
    ctx.arc(s.x, s.y, PLAYER_RADIUS * this.scale * 2.6, 0, Math.PI * 2);
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  }
}
