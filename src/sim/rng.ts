import type { World } from './types';

/**
 * 非決定的なuint32シードを生成する。src/sim/ 内で Math.random を使ってよいのはここだけ。
 */
export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

/**
 * mulberry32を純粋に1ステップ進める。状態を引数で受け取り、
 * [次の状態, [0,1)の乱数値] を返す(worldオブジェクトが未構築の段階でも使える)。
 */
export function mulberry32Step(state: number): [number, number] {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [state, value];
}

/** world.rngState を1ステップ進め、[0, 1)の浮動小数を返す */
export function rand(world: World): number {
  const [state, value] = mulberry32Step(world.rngState);
  world.rngState = state;
  return value;
}
