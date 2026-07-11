import './style.css';
import { InputHandler } from './input';
import { Renderer, type Overlays } from './render/renderer';
import { ReplayBuffer } from './replay';
import { aiStep } from './sim/ai';
import { SIM_DT } from './sim/constants';
import { FORMATION_NAMES, type FormationName } from './sim/formation';
import { createWorld, setFormation, stepPhysics } from './sim/world';

// --- URLパラメータ (?seed=N&home=4-4-2&away=4-3-3) / シード入力の共通ヘルパー ---
function isFormationName(v: string | null): v is FormationName {
  return v !== null && (FORMATION_NAMES as readonly string[]).includes(v);
}

// 入力/URLの文字列をシード値(uint32)に正規化する。空/不正な値は undefined = ランダムシード。
function parseSeed(raw: string | null | undefined): number | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return n >>> 0;
}

// 現在のシード/フォーメーションをURLに反映(履歴を汚さないreplaceState)。
// これにより「今見ている試合」は常にURLをコピーするだけで再現できる。
function syncUrl(formations: readonly [FormationName, FormationName], seed: number): void {
  const params = new URLSearchParams();
  params.set('seed', String(seed));
  params.set('home', formations[0]);
  params.set('away', formations[1]);
  history.replaceState(null, '', `${location.pathname}?${params.toString()}${location.hash}`);
}

const urlParams = new URLSearchParams(location.search);
const initialFormations: [FormationName, FormationName] = [
  isFormationName(urlParams.get('home')) ? (urlParams.get('home') as FormationName) : '4-4-2',
  isFormationName(urlParams.get('away')) ? (urlParams.get('away') as FormationName) : '4-4-2',
];
const initialSeed = parseSeed(urlParams.get('seed'));

// --- 戦術レバー診断バッジ (データ出典: reports/task-aj.md 「tactic-lever diagnostics」) ---
// league:contrast (N=20試合×10分, extreme-vs-default) の実測。wideRunsはTask AJのpost-U/pre-W計測
// のまま(再計測はtasks/BACKLOG.md「小items」#6の宿題)。pressIntensityはTask AFのプレス幾何後の
// 再計測値(reports/task-af.md)。lineHeightはTask AC後もLIVE 5.27σと再確認済み(reports/task-ac.md)。
// league:contrastを再実行したら、この3つの文言と数値もあわせて更新すること。
const LEVER_BADGE = {
  // 効果量0.08σ・有意差0.26σ: 攻撃サードでの張り出し(平均|y|)は5.09m→4.94mでほぼ無変化。
  // 「ワイドに張る」という設計意図どおりに動いていない、実質プラシーボのレバー。
  wideRuns:
    '<span class="lever-badge lever-badge--dead" title="効果量0.08σ・有意差0.26σ (task-aj, N=20×10分, post-U/pre-W)。攻撃サードでの張り出し(平均|y|)は5.09m→4.94mとほぼ無変化。現状はスライダーを動かしても試合内容にほぼ影響しない。post-W再計測は未実施。">効果検証中(現在ほぼ無効)</span>',
  // PPDA 0→4.96 / 0.3→3.96 / 0.6→3.82 / 1→3.66 (単調・正方向): 有意差4.55σ・効果量1.44σ
  // (task-af 最終構成, run 29134244505)。FW_CAP較正前の同一ジオメトリでは効果量2.24σ
  // (run 29105999886) — ブロック低下で守備アクション基準値が圧縮された分だけ縮む。詳細は reports/task-af.md §3。
  pressIntensity:
    '<span class="lever-badge lever-badge--live" title="PPDA 0→4.96 / 1→3.66、中間域も単調 0.3→3.96 / 0.6→3.82 (有意差4.55σ・効果量1.44σ, task-af, N=20×10分)。プレス幾何(2人組トラップ)の連続パラメータ化で復活(AJ時点は0.01σの完全無効)。強めるほど即時奪回=PPDAが下がる。1試合単位ではノイズに紛れることがある。">効果あり</span>',
  // DFライン高21.11m→31.41m: 効果5.82σ(post-U/pre-W)。Task ACのブロック圧縮リワーク後もLIVE
  // 5.27σで再確認済み(post-W) — このプール中で最も確実に効くレバー。
  lineHeight:
    '<span class="lever-badge lever-badge--live" title="DFライン高 21.11m→31.41m (効果5.82σ, task-aj, N=20×10分, post-U/pre-W)。Task ACのブロック圧縮後もLIVE 5.27σで再確認済み(post-W, reports/task-ac.md)。このプールで最も確実に効くレバー。">効果大</span>',
} as const;

// team0/team1で構造が同一の戦術スライダー行。バッジも含めて1か所で組み立て、数値更新時の食い違いを防ぐ。
function tacticsRow(team: 0 | 1, label: string): string {
  return `
  <div class="tactics team${team}">
    <span class="teamLabel">${label}</span>
    <label>フォーメーション <select id="form${team}"></select></label>
    <label>マンマーク <input type="range" id="manMark${team}" min="0" max="1" step="0.05" value="0" /></label>
    <label>プレス ${LEVER_BADGE.pressIntensity} <input type="range" id="press${team}" min="0" max="1" step="0.05" value="0.5" /></label>
    <label>ライン ${LEVER_BADGE.lineHeight} <input type="range" id="line${team}" min="-1" max="1" step="0.05" value="0" /></label>
    <label>ワイドのラン ${LEVER_BADGE.wideRuns} <input type="range" id="wideRuns${team}" min="0" max="1" step="0.05" value="0.5" /></label>
  </div>`;
}

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div id="toolbar">
    <button id="playPause">⏸ 一時停止</button>
    <label id="speedLabel">
      速度 <input type="range" id="speed" min="0.05" max="1" step="0.05" value="0.25" />
      <span id="speedValue">0.25x</span>
    </label>
    <label><input type="checkbox" id="passLanes" checked /> パスコース</label>
    <label><input type="checkbox" id="spaceControl" checked /> スペース支配</label>
    <label><input type="checkbox" id="anchors" /> 陣形</label>
    <label><input type="checkbox" id="intents" checked /> 意図</label>
    <label><input type="checkbox" id="futureSpace" /> 2秒後の支配</label>
    <label><input type="checkbox" id="defensiveLine" checked /> ライン表示</label>
    <button id="reset">リセット</button>
    <span id="seedBadge" title="現在の試合シード（クリックでコピー）">🌱 <code id="seedValue"></code></span>
    <label id="seedControl" title="同じシード・同じフォーメーション・同じ戦術スライダー値なら常に同じ試合を再現できます。再生中に戦術スライダーを動かすと、その後の展開は元の試合と一致しません。">
      <input type="number" id="seedInput" step="1" placeholder="シード（空欄=ランダム）" />
      <button id="seedApply">このシードで再生</button>
    </label>
    <span id="score"></span>
    <span id="clock"></span>
    <label>⏪ <input type="range" id="timeline" min="0" max="0" step="0.5" value="0" style="width:140px" /> <span id="timelineDisplay">0:00</span></label>
  </div>
  ${tacticsRow(0, '青')}
  ${tacticsRow(1, '赤')}
  <div id="pitchContainer"><canvas id="pitch"></canvas></div>
  <div id="help"><span id="stats"></span>選手からドラッグ = 移動指示 / ボール保持者から味方へドラッグ = パス指示 / 選手をタップ = 指示解除 / スペースキー = 一時停止</div>
`;

const canvas = document.querySelector<HTMLCanvasElement>('#pitch')!;
const renderer = new Renderer(canvas);

let world =
  initialSeed !== undefined ? createWorld(initialFormations, initialSeed) : createWorld(initialFormations);
syncUrl(world.formations, world.seed); // 初期表示のURLも常に「今の試合」を指すようにする
let playing = true;
let speed = 0.25;
const overlays: Overlays = {
  passLanes: true,
  spaceControl: true,
  anchors: false,
  intents: true,
  futureSpace: false,
  defensiveLine: true,
};

const input = new InputHandler(canvas, renderer, () => world);

const replayBuffer = new ReplayBuffer();
let scrubbed = false;

// --- UI ---
const playPauseBtn = document.querySelector<HTMLButtonElement>('#playPause')!;
const speedSlider = document.querySelector<HTMLInputElement>('#speed')!;
const speedValue = document.querySelector<HTMLSpanElement>('#speedValue')!;
const scoreEl = document.querySelector<HTMLSpanElement>('#score')!;
const clockEl = document.querySelector<HTMLSpanElement>('#clock')!;
const statsEl = document.querySelector<HTMLSpanElement>('#stats')!;
const timelineSlider = document.querySelector<HTMLInputElement>('#timeline')!;
const timelineDisplay = document.querySelector<HTMLSpanElement>('#timelineDisplay')!;
const seedBadge = document.querySelector<HTMLSpanElement>('#seedBadge')!;
const seedValueEl = document.querySelector<HTMLElement>('#seedValue')!;
const seedInputEl = document.querySelector<HTMLInputElement>('#seedInput')!;
const seedApplyBtn = document.querySelector<HTMLButtonElement>('#seedApply')!;

function setPlaying(v: boolean): void {
  // スクラブ後に再生を再開したら未来のスナップショットを破棄して歴史を分岐させる
  if (v && scrubbed) {
    replayBuffer.truncateAfter(world.clock);
    scrubbed = false;
  }
  playing = v;
  playPauseBtn.textContent = playing ? '⏸ 一時停止' : '▶ 再生';
}

playPauseBtn.addEventListener('click', () => setPlaying(!playing));
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    const tag = (e.target as HTMLElement).tagName;
    if (tag !== 'INPUT' && tag !== 'BUTTON') {
      e.preventDefault();
      setPlaying(!playing);
    }
  }
});

speedSlider.addEventListener('input', () => {
  speed = Number(speedSlider.value);
  speedValue.textContent = `${speed.toFixed(2)}x`;
});

timelineSlider.addEventListener('input', () => {
  scrubbed = true;
  setPlaying(false);
  const snapped = replayBuffer.seek(Number(timelineSlider.value));
  if (snapped) world = snapped;
});

document.querySelector('#passLanes')!.addEventListener('change', (e) => {
  overlays.passLanes = (e.target as HTMLInputElement).checked;
});
document.querySelector('#spaceControl')!.addEventListener('change', (e) => {
  overlays.spaceControl = (e.target as HTMLInputElement).checked;
});
document.querySelector('#anchors')!.addEventListener('change', (e) => {
  overlays.anchors = (e.target as HTMLInputElement).checked;
});
document.querySelector('#intents')!.addEventListener('change', (e) => {
  overlays.intents = (e.target as HTMLInputElement).checked;
});
document.querySelector('#futureSpace')!.addEventListener('change', (e) => {
  overlays.futureSpace = (e.target as HTMLInputElement).checked;
});
document.querySelector('#defensiveLine')!.addEventListener('change', (e) => {
  overlays.defensiveLine = (e.target as HTMLInputElement).checked;
});

const formSelects = [0, 1].map((t) => {
  const sel = document.querySelector<HTMLSelectElement>(`#form${t}`)!;
  for (const name of FORMATION_NAMES) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.value = world.formations[t];
  sel.addEventListener('change', () => {
    setFormation(world, t as 0 | 1, sel.value as FormationName);
  });
  return sel;
});

// 戦術スライダー: 値をworld.tacticsに直接反映。リセット時も現在値を引き継ぐ
const applyTactics = [0, 1].map((t) => {
  const mm = document.querySelector<HTMLInputElement>(`#manMark${t}`)!;
  const pr = document.querySelector<HTMLInputElement>(`#press${t}`)!;
  const ln = document.querySelector<HTMLInputElement>(`#line${t}`)!;
  const wr = document.querySelector<HTMLInputElement>(`#wideRuns${t}`)!;
  const apply = () => {
    Object.assign(world.tactics[t as 0 | 1], {
      manMark: Number(mm.value),
      pressIntensity: Number(pr.value),
      lineHeight: Number(ln.value),
      wideRuns: Number(wr.value),
    });
  };
  for (const el of [mm, pr, ln, wr]) el.addEventListener('input', apply);
  return apply;
});

// 新しい試合を開始する共通処理。seed省略時はcreateWorld側でランダムシードが振られる。
function startMatch(seed?: number): void {
  const formations: [FormationName, FormationName] = [
    formSelects[0].value as FormationName,
    formSelects[1].value as FormationName,
  ];
  world = seed !== undefined ? createWorld(formations, seed) : createWorld(formations);
  applyTactics.forEach((apply) => apply());
  replayBuffer.clear();
  scrubbed = false;
  syncUrl(world.formations, world.seed);
}

document.querySelector('#reset')!.addEventListener('click', () => {
  seedInputEl.value = ''; // リセットは常にランダムシード。前回入力が残っていると誤解を招くため消す
  startMatch();
});

seedApplyBtn.addEventListener('click', () => {
  startMatch(parseSeed(seedInputEl.value));
});
seedInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') seedApplyBtn.click();
});

seedBadge.addEventListener('click', () => {
  navigator.clipboard?.writeText(String(world.seed)).catch(() => {
    /* クリップボード権限が無い環境では静かに無視 */
  });
});

// --- メインループ: 実時間 × 速度 を固定タイムステップで消化 ---
let last = performance.now();
let accumulator = 0;

function frame(now: number): void {
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (playing) {
    accumulator += realDt * speed;
    let steps = 0;
    while (accumulator >= SIM_DT && steps < 30) {
      aiStep(world, SIM_DT);
      stepPhysics(world, SIM_DT);
      accumulator -= SIM_DT;
      steps++;
    }
    replayBuffer.record(world);
    // スライダーを現在時刻に追従させる
    const r = replayBuffer.range();
    if (r) {
      timelineSlider.min = String(r[0]);
      timelineSlider.max = String(r[1]);
      timelineSlider.value = String(world.clock);
    }
  }

  renderer.draw(world, overlays, input.drag);
  seedValueEl.textContent = String(world.seed);
  scoreEl.textContent = `青 ${world.score[0]} - ${world.score[1]} 赤`;
  const m = Math.floor(world.clock / 60);
  const s = Math.floor(world.clock % 60);
  const clockStr = `${m}:${String(s).padStart(2, '0')}`;
  clockEl.textContent = clockStr;
  timelineDisplay.textContent = clockStr;
  const [a, b] = world.stats;
  statsEl.textContent = `シュート ${a.shots}-${b.shots} / パス ${a.passes}-${b.passes} / 奪取 ${a.steals}-${b.steals} ・ `;

  requestAnimationFrame(frame);
}

function onResize(): void {
  renderer.resize();
}
window.addEventListener('resize', onResize);
onResize();
requestAnimationFrame(frame);
