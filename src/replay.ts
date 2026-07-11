import type { World } from './sim/types';

// 0.5秒間隔で最大600件(=5分)のスナップショットを保持するリングバッファ
const MAX_SNAPSHOTS = 600;
const RECORD_INTERVAL = 0.5; // シミュレーション秒

export class ReplayBuffer {
  private snapshots: World[] = [];
  private lastRecordedClock = -Infinity;

  /** 前回記録から0.5秒以上経過していたらスナップショットをリングバッファに追加 */
  record(world: World): void {
    if (world.clock - this.lastRecordedClock < RECORD_INTERVAL) return;
    this.lastRecordedClock = world.clock;
    this.snapshots.push(structuredClone(world));
    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots.shift();
    }
  }

  /** 指定時刻に最も近いスナップショットのdeep copyを返す。バッファが空の場合null */
  seek(t: number): World | null {
    if (this.snapshots.length === 0) return null;
    let best = this.snapshots[0];
    let bestDiff = Math.abs(best.clock - t);
    for (let i = 1; i < this.snapshots.length; i++) {
      const diff = Math.abs(this.snapshots[i].clock - t);
      if (diff < bestDiff) {
        best = this.snapshots[i];
        bestDiff = diff;
      }
    }
    return structuredClone(best);
  }

  /** 指定時刻より未来のスナップショットを破棄(巻き戻し再開時に歴史を分岐させるため) */
  truncateAfter(t: number): void {
    this.snapshots = this.snapshots.filter((s) => s.clock <= t);
    if (this.snapshots.length > 0) {
      this.lastRecordedClock = this.snapshots[this.snapshots.length - 1].clock;
    } else {
      this.lastRecordedClock = -Infinity;
    }
  }

  /** バッファの[最古, 最新]のclockを返す。空の場合null */
  range(): [number, number] | null {
    if (this.snapshots.length === 0) return null;
    return [this.snapshots[0].clock, this.snapshots[this.snapshots.length - 1].clock];
  }

  clear(): void {
    this.snapshots = [];
    this.lastRecordedClock = -Infinity;
  }
}
