/**
 * 自己対戦による採点重み最適化CLI。
 * (1+λ)ガウス摂動ヒルクライムで DEFAULT_WEIGHTS を出発点に探索する。
 *
 * 実行例:
 *   npx tsx scripts/optimize.ts
 *   npx tsx scripts/optimize.ts --gens 50 --pop 10 --matches 20 --minutes 5
 */
import { evaluate } from './selfplay';
import { DEFAULT_WEIGHTS, type AiWeights } from '../src/sim/weights';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ------- CLI引数パース -------

function parseArgs(): { gens: number; pop: number; matches: number; minutes: number; seed?: number } {
  const args = process.argv.slice(2);
  const get = (flag: string, def: number): number => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] !== undefined ? Number(args[idx + 1]) : def;
  };
  const getOptional = (flag: string): number | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] !== undefined ? Number(args[idx + 1]) : undefined;
  };
  return {
    gens: get('--gens', 20),
    pop: get('--pop', 8),
    matches: get('--matches', 10),
    minutes: get('--minutes', 5),
    seed: getOptional('--seed'),
  };
}

// ------- 乱数・摂動ユーティリティ -------

/** Box-Muller変換による標準正規乱数 */
function gaussRandom(): number {
  // u=0 だと log(0)=-Infinity になるため小さな値でガード
  const u = Math.random() || 1e-10;
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 基準重みにガウス摂動を加えた候補を生成する。
 * 各重みを相対σ(デフォルト15%)でスケールした摂動を加え、下限0でクランプ。
 */
function perturbWeights(base: AiWeights, relSigma = 0.15): AiWeights {
  const result = { ...base };
  for (const key of Object.keys(result) as (keyof AiWeights)[]) {
    const delta = gaussRandom() * relSigma * base[key];
    result[key] = Math.max(0, base[key] + delta);
  }
  return result;
}

// ------- ログユーティリティ -------

/** 基準からの差分を人間が読みやすい文字列にする(変化が小さい項目は省略) */
function diffStr(base: AiWeights, candidate: AiWeights): string {
  const diffs: string[] = [];
  for (const key of Object.keys(base) as (keyof AiWeights)[]) {
    const delta = candidate[key] - base[key];
    if (Math.abs(delta) >= 0.005) {
      diffs.push(`${key}: ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`);
    }
  }
  return diffs.length > 0 ? diffs.join(', ') : '(変化なし)';
}

// ------- メイン -------

async function main(): Promise<void> {
  const { gens, pop, matches, minutes, seed } = parseArgs();
  console.log(`最適化開始: ${gens}世代 × ${pop}候補 × ${matches}試合 × ${minutes}分/試合${seed !== undefined ? ` (seed=${seed})` : ''}`);
  console.log('---');

  let bestWeights: AiWeights = { ...DEFAULT_WEIGHTS };

  for (let gen = 1; gen <= gens; gen++) {
    // pop個の候補を現在のベスト重みへの摂動で生成し、評価する
    let genBestFitness = -Infinity;
    let genBestWeights: AiWeights = bestWeights;

    for (let i = 0; i < pop; i++) {
      const candidate = perturbWeights(bestWeights);
      const fitness = evaluate(candidate, bestWeights, matches, minutes, seed);
      if (fitness > genBestFitness) {
        genBestFitness = fitness;
        genBestWeights = candidate;
      }
    }

    // 候補が現在のベストを上回っていれば更新(fitness > 0 = 候補 > 基準)
    if (genBestFitness > 0) {
      console.log(`世代 ${gen}: 適応度 ${genBestFitness.toFixed(3)} → 重みを更新`);
      console.log(`  差分: ${diffStr(bestWeights, genBestWeights)}`);
      bestWeights = genBestWeights;
    } else {
      console.log(`世代 ${gen}: 適応度 ${genBestFitness.toFixed(3)} → 現状維持`);
    }
  }

  // 結果をJSONに保存
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const outPath = path.join(__dirname, 'best-weights.json');
  fs.writeFileSync(outPath, JSON.stringify(bestWeights, null, 2), 'utf-8');

  console.log('\n=== 最適化完了 ===');
  console.log(`保存先: ${outPath}`);
  console.log('ベスト重み:');
  console.log(JSON.stringify(bestWeights, null, 2));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
