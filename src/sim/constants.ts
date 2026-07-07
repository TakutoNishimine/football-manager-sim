/** 全て実世界単位: メートル, 秒, m/s */

export const PITCH_LENGTH = 105; // x方向 (ゴール〜ゴール)。実寸
export const PITCH_WIDTH = 68; // y方向。実寸
export const GOAL_WIDTH = 7.32;

export const DEFENSE_ZONE_RADIUS = 8; // ゾーン守備: 基準点からこの距離内の相手をマークする
// コンパクトブロックの発動距離: 保持者が自ゴールからこの距離以内に侵入したら、空きゾーン
// 守備者をシュートコース(危険地帯)へ寄せる。ai.ts/predict.tsの2箇所で使うので
// ここに一元化する(以前はそれぞれに手動ミラーされた private const だった)。
export const COMPACT_BLOCK_RANGE = 25;

// GK(role 0)。フィールドプレーヤーより広い範囲・速いボールを扱える
export const GK_REACH = 1.5; // キャッチ/セーブの届く距離
export const GK_CATCH_SPEED = 14; // これ以下の速さならキャッチ(より速いとパリーで弾く)
export const GK_DEPTH = 3.5; // ゴールラインからの基本的な飛び出し距離
export const GK_BUILDUP_DEPTH = 11; // ビルドアップ参加時、自陣保持で前に出る距離(バックパスの逃げ場)

export const PLAYER_RADIUS = 0.45;
export const PLAYER_MAX_SPEED = 6.5;
export const PLAYER_ACCEL = 6; // 人間の加速度上限相当(Task U以前は14=非現実的な超人加速)
export const PLAYER_ACCEL_DECAY = 0.15; // 速度が上がるほど利用可能な加速度(=旋回力)が落ちる比率
export const DRIBBLE_SPEED_FACTOR = 0.75; // ボール保持中は遅くなる

export const CONTROL_RADIUS = 0.9; // この距離でボールをトラップできる
export const CONTROLLABLE_BALL_SPEED = 9; // これより速いボールはトラップできない
export const DRIBBLE_OFFSET = 0.5; // 保持中、ボールを進行方向にこれだけ前に置く
// 奪取(密着ドリブルデュエル)の判定半径。Task U では守備の実効速度低下を補うため 0.85→2.0 に
// 広げたが、その結果ターンオーバーの約8割がこの近接ダイスロールになり(背後からの奪取を含む)、
// インターセプトを大きく上回った。Task W: コミット守備でプレスが実際に詰めるようになったので
// task 方針どおり ~1.3 へ戻し、背後奪取は STEAL_CONE_DOT で排除する。
export const STEAL_RADIUS = 1.3;
export const BLOCK_RADIUS = 0.45; // 速いボールが体に当たって弾かれる距離
export const STEAL_RATE = 0.8; // 1秒あたりの奪取確率(密着時)
// Task W: 奪取は保持者の「運んでいる向き」からこの内積(=cosθ)以上の相手だけが可能。
// 真後ろから身体を通り抜けて奪う(物理的にありえない)背後奪取を排除する。-0.5 = 前方120°コーン。
export const STEAL_CONE_DOT = -0.5;
export const KICK_COOLDOWN = 0.45; // 蹴った直後に自分で再トラップできない時間

export const BALL_DAMPING = 0.55; // 速度の指数減衰 /s
export const PASS_SPEED_MIN = 9;
export const PASS_SPEED_MAX = 24; // サイドチェンジ等のロングボール(最大約44m転がる)
export const SHOT_RANGE = 20; // 「主戦シュートレンジ」の目安。Task Z 以降ハードな壁ではなく事前分布として使う

// ── シュート・ファネル(Task Z) ────────────────────────────────────────────────
// SHOT_RANGE を越えても撃てるソフト上限。ここまでは「質」が十分高ければ(オープンなコース・
// 正面)まれにロングシュートが成立する。壁ではなく、質ゲートで連続的に抑える。
export const SHOT_MAX_RANGE = 26;
// 距離クオリティが 1 になる距離(これ以内は距離的には満点)。SHOT_MAX_RANGE との間で線形に減衰。
export const SHOT_QUALITY_DIST_FLOOR = 6;
// シュート実行の速度レンジ(m/s)。近距離は置きにいけて遅め、遠距離は強打。
export const SHOT_SPEED_MIN = 16;
export const SHOT_SPEED_MAX = 30;
// ファーストタッチ・シュート(Task Z Req2): ボックス内で高質の受けは整えをバイパスしてワンタッチ。
// 意思決定を FIRST_TIME_DECISION まで即座に切り上げる(整えの ~0.63s ではなく ~0.05s)。
// median release ゲート(>=0.8s)を割らないよう、発火はボックス内の限定局面のみ(spec)。
export const FIRST_TIME_DECISION = 0.05;
export const FIRST_TIME_BOX_DEPTH = 16.5; // 相手ペナルティエリアの奥行き(実寸)
export const FIRST_TIME_BOX_HALF_WIDTH = 20.16; // 相手ペナルティエリアの半幅(実寸 40.32/2)
export const FIRST_TIME_MAX_DIST = 16; // これ以内の受けだけワンタッチ・シュート候補(質の高い受けに限定)
export const FIRST_TIME_MIN_ANGLEQ = 0.4; // 正面度がこれ以上(=極端に浅い角度ではない)
// GK 反応ウィンドウ(Task Z Req4): シュート飛翔からこの秒数はコースを変えられない(=構えたまま)。
// その後、予測クロス地点へ全力で寄せる(pace の keeper 昇格でスプリント)。「GKは限定的」という
// 成立条件を凍結ハックからこの反応レイテンシへ再機構化する。長いほどGKが弱く=得点↑の主要ノブ。
export const GK_REACT_TIME = 0.25;

export const AI_DECISION_INTERVAL = 0.18; // 思考の間隔(秒)
export const SIM_DT = 1 / 120; // 物理の固定タイムステップ

// ── テンポ: ファーストタッチ整え & 圧力連動カデンス & hold(Task V) ─────────────
// ファーストタッチの「整え」= 意思決定レイテンシ(ファンブルではない。トラップは決定論のまま)。
// 受けた瞬間に必ず放していた(reception→release中央値0.01s)のを、受けてから一拍置いてから
// プレーするリズムに変える。timer = clamp(BASE + PRESSURE_COEF*圧力 + BALLSPEED_COEF*球速, BASE, MAX)。
export const SETTLE_BASE = 0.63; // 無圧の受けの整え下限。medianゲート(>=0.8s)を担う(spec例示0.25から引き上げ。整えは無圧局面のみフル、圧下は割り込みとワンタッチ回避で速放し)
export const SETTLE_PRESSURE_COEF = 0.35; // 受け時の圧力で整えを延ばす係数(囲まれているほど落ち着けない…ではなく、慎重になる)
export const SETTLE_BALLSPEED_COEF = 0.02; // 速いボールほど収めに一拍要る(秒/(m/s))
export const SETTLE_MAX = 1.0; // 整えの上限(秒)
// ワンタッチ回避: 受け時圧力が高く(> BAILOUT_PRESSURE)、安全な後方/横の出口があれば
// すぐ放せる(整え ~SETTLE_BAILOUT)。詰められた選手がタックルに立ち尽くさないための例外。
export const SETTLE_BAILOUT = 0.1;
export const SETTLE_BAILOUT_PRESSURE = 0.5;

// 保持者の再判断カデンス: 圧力連動 lerp(圧力0で~0.5s → 圧力1で0.15s)。
// 従来の一律0.18sを置き換える。無圧のCBは~0.5s刻みで考える(=マシンガン連打の解消)。
// spec例示は0.6sだが、0.6sは再判断が鈍く完成度を~2pp削るため、spec本文の「~0.5s beats」に合わせ0.5に。
// オフボールは従来どおり AI_DECISION_INTERVAL。
export const OWNER_DECIDE_MAX = 0.5; // 圧力0のときの再判断間隔
export const OWNER_DECIDE_MIN = 0.15; // 圧力1のときの再判断間隔

// carry(運ぶ)意図は、圧力がこの値を超えるまではやり切る(オフボールの「決めた意図はやり切る」の保持者版)
export const CARRY_RELEASE_PRESSURE = 0.5;
// hold(その場で待つ)を選ぶ/維持する上限圧力。これを超えたら hold は放棄してプレーする
export const HOLD_MAX_PRESSURE = 0.4;
// hold 意図の最大持続(秒)。デッドロック防止(圧力上昇/ランの失効でも自然に解ける)
export const HOLD_DURATION = 1.5;

// ── 守備コミット & 反応レイテンシ(Task W) ───────────────────────────────────
// プレスのリード時間: 保持者の現在位置ではなく owner.pos + owner.vel*T を狙う(尾行→迎撃)。
// U報告では hysteresis 無しで0.17がナイフエッジだったが、コミットで帯域が広がる想定で再掃引。
// 出荷パラメータ(STEAL 1.3/0.8)下での40シード再検証で 0.20 は goals FAIL、0.18 が PASS。
export const PRESS_LEAD_TIME = 0.18;
// プレッサーのヒステリシス: 別の守備者がこの距離以上近ければ交代(毎フレームの入れ替え防止)
export const PRESS_HYSTERESIS_MARGIN = 1.5;
// プレッサーが「抜かれた」と判定する距離: 保持者がプレッサーよりゴール側にこの距離以上進んだ
export const PRESS_BEATEN_DIST = 3;
// 抜かれたプレッサーの回復ラン目標: 保持者→自ゴール線上、保持者からこの距離ゴール側の点へ全力で戻る
export const RECOVER_GOALSIDE_DIST = 8;
// スティッキーマーク: 割り当ては最低この秒数維持し、これ未満では乗り換えない
export const MARK_STICKY_TIME = 1.5;
// マーク乗り換えの明確なマージン: 新候補が現マーク対象よりこの距離以上「危険(ゴール寄り)」なら乗り換え
export const MARK_REASSIGN_MARGIN = 2;
// マーク位置のボール寄りシェード(m)。マーク相手のゴール側に立ちつつ、この距離だけボール方向へ
// ずらしてパスコースを身体で消す。大きいほどパスカット(=インターセプト)を優先する。
export const MARK_BALL_SHADE = 0.5;
// 守備の再判断カデンス(秒)。この幅で id 由来のジッターを与え、ブロック全体が同tickで波打つのを防ぐ
export const DEFENSE_DECIDE_MIN = 0.15;
export const DEFENSE_DECIDE_MAX = 0.25;

// オープンな受け手のトラップ。トラップミスは存在しない: パス送出チームの届く範囲内の選手は、
// トラップ地点の近くに守備者がいなければ、球速の上限なしで速いパスも確実にコントロールする。
// ターンオーバーはインターセプト(コース上の守備=ブロック・スロー化後の奪取)からのみ生まれ、
// フリーの受け手がボールを失う(すり抜け・ファンブル)ことはない。
export const OPEN_CONTROL_RADIUS = 1.5; // フリーの受け手はこの距離内の速いパスを確実に収める(すり抜け防止)
export const OPEN_RECEIVER_RADIUS = 2.0; // トラップ地点からこの距離内に守備者がいなければ「フリー」とみなす
