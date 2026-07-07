import type { DragState, Renderer } from './render/renderer';
import type { World } from './sim/types';
import { teammates } from './sim/world';
import { dist, type Vec } from './sim/vec';
import { PITCH_LENGTH, PITCH_WIDTH } from './sim/constants';

const GRAB_RADIUS = 1.4; // 選手をつかめる距離(m)

/**
 * ポインタ(マウス/タッチ共通)で選手に指示を出す。
 * - 選手からドラッグ → その地点への移動指示
 * - ボール保持者から味方へドラッグ → パス指示
 * - 選手をタップ → 指示をクリア(AIに戻す)
 */
export class InputHandler {
  drag: DragState | null = null;
  private canvas: HTMLCanvasElement;
  private renderer: Renderer;
  private getWorld: () => World;

  constructor(canvas: HTMLCanvasElement, renderer: Renderer, getWorld: () => World) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.getWorld = getWorld;
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', () => (this.drag = null));
  }

  private toWorld(e: PointerEvent): Vec {
    const rect = this.canvas.getBoundingClientRect();
    return this.renderer.toWorld(e.clientX - rect.left, e.clientY - rect.top);
  }

  private onDown(e: PointerEvent): void {
    const w = this.toWorld(e);
    const world = this.getWorld();
    let best = null;
    let bestD = GRAB_RADIUS;
    for (const p of world.players) {
      const d = dist(p.pos, w);
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
    if (best) {
      this.drag = { player: best, current: w };
      this.canvas.setPointerCapture(e.pointerId);
    }
  }

  private onMove(e: PointerEvent): void {
    if (this.drag) this.drag.current = this.toWorld(e);
  }

  private onUp(e: PointerEvent): void {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    const w = this.toWorld(e);
    const world = this.getWorld();
    const p = drag.player;

    // ほぼ動かさず離した → タップとして指示をクリア
    if (dist(p.pos, w) < 1.0) {
      p.instruction = null;
      return;
    }

    // ボール保持者から味方の上で離した → パス指示
    if (world.ball.ownerId === p.id) {
      const receiver = teammates(world, p).find((t) => dist(t.pos, w) < 1.5);
      if (receiver) {
        p.instruction = { kind: 'pass', receiverId: receiver.id };
        return;
      }
    }

    // それ以外は移動指示(ピッチ内にクランプ)
    p.instruction = {
      kind: 'move',
      target: {
        x: Math.max(-PITCH_LENGTH / 2, Math.min(PITCH_LENGTH / 2, w.x)),
        y: Math.max(-PITCH_WIDTH / 2, Math.min(PITCH_WIDTH / 2, w.y)),
      },
    };
  }
}
