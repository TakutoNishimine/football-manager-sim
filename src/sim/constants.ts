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
export const DRIBBLE_SPEED_FACTOR = 0.75; // ボール保持中のクロースコントロール速度係数(密着時。オープン時は CARRY_OPEN_SPEED まで上がる, Task Y)

export const CONTROL_RADIUS = 0.9; // この距離でボールをトラップできる
export const CONTROLLABLE_BALL_SPEED = 9; // これより速いボールはトラップできない
export const DRIBBLE_OFFSET = 0.5; // 保持中、足元(立ち止まり/シールド時)にボールを置くオフセット
export const BLOCK_RADIUS = 0.45; // 速いボールが体に当たって弾かれる距離
export const KICK_COOLDOWN = 0.45; // 蹴った直後に自分で再トラップできない時間

// ── デュエルの可視化(Task Y): 仕掛け・方向性タックル・タッチドリブル ──────────
// 旧 STEAL_RADIUS/STEAL_RATE/STEAL_CONE_DOT(近接ダイスロール+ランダム方向スクワート)は
// 廃止。奪取は「方向性タックル(踏み込み)」に置き換わり、背後奪取は踏み込みの物理ジオメトリ
// (heading 前方成分)で排除する(旧コーン規則を継承)。

// 仕掛け(テイクオン): 前方 TAKEON_RANGE 内に「抜ける対象」が1人だけ・その背後にスペースがある局面で、
// ボールを相手の脇〜背後へ押し出し、バースト速度でボールへの徒競走に持ち込む。失敗=守備がクリーンに回収。
export const TAKEON_RANGE = 5; // この距離内・前方の相手を「抜ける対象」とみなす
export const TAKEON_KNOCK_PAST = 2.5; // ボールを相手のこれだけ先(攻撃方向)へ押し出す
export const TAKEON_KNOCK_SIDE = 2.0; // 相手を迂回するための横オフセット(相手の足元へ通さない)
export const TAKEON_KNOCK_SPEED = 9.5; // 押し出しの初速(>CONTROLLABLE を僅かに超える: 迂回の一瞬だけトラップ不可、その後は減速しバースト本人が追いつく)
export const TAKEON_OPEN_BEHIND = 4.5; // 押し出す先のこの距離内に別の相手がいたら仕掛けない(=カバーされている)
export const TAKEON_BURST_SPEED = 7.5; // バースト中の速度上限(PLAYER_MAX_SPEED 超。仕掛けた本人・バースト窓のみ)
export const TAKEON_BURST_TIME = 1.1; // バースト持続(1.0〜1.5s。短く保ち predict の PLAYER_MAX_SPEED 前提に漏らさない)

// 方向性タックル(踏み込み): 密着した守備者が ~TACKLE_COMMIT_TIME 踏み込む。
// 成功=タックラー側にボールが渡る(オーナー化)、失敗=「抜かれた」= TACKLE_BEATEN_TIME の回復ペナルティ
// (鈍化・可視的に置いていかれる)。確率要素は rand(world) で残すが、結果ジオメトリは物理的(背後からは奪えない)。
export const TACKLE_RANGE = 2.2; // ボールからこの距離内の守備者が踏み込める(旧 STEAL_RADIUS の再較正。タッチで前に出たボールにも届く)
// 「削り続ける」経済: 旧 STEAL_RATE 0.8/s の連続的な圧を、踏み込み(頻繁)×成功率(中)×ビート死時間の
// デューティ比で再現する(trigger 8/s × p〜0.4 × duty〜0.3 ≈ 0.8-1.0 奪取/接触秒)。ビートは短め(0.5s)。
export const TACKLE_TRIGGER = 8; // 1秒あたりの踏み込み発生率(接触中)
export const TACKLE_COMMIT_TIME = 0.3; // 踏み込みのコミット(この間は再踏み込みしない)
export const TACKLE_BASE = 1.0; // 踏み込みの基本成功率スケール(至近・正面・ボールが露出した重いタッチ時に最大。pSuccess は 0.85 で頭打ち)
export const TACKLE_BEATEN_TIME = 0.5; // 踏み込み失敗で「抜かれた」ペナルティ持続(0.5〜1s)
export const TACKLE_BEATEN_SPEED = 2.6; // 抜かれている間の速度上限(鈍る=可視的に置いていかれる)

// タッチドリブル: 溶接ボール(毎フレーム 0.5m 前固定)を廃止し、保持者はボールを前へ押し出して追う。
// タッチ間はボールは「ルーズだが所有(owned)」= タックルが重いタッチのギャップを突ける。
export const CARRY_TOUCH_INTERVAL = 0.7; // 次のタッチまでの目安間隔(秒)
export const CARRY_TOUCH_MIN = 1.0; // 押し出す最小距離(密着=クロースコントロール)
export const CARRY_TOUCH_MAX = 2.5; // 押し出す最大距離(前方が開いているほど大きい)
export const CARRY_TIGHT_DIST = 4; // 最寄り相手がこの距離以内=クロースコントロール(openness 0)
export const CARRY_OPEN_DIST = 14; // 最寄り相手がこの距離以上=完全オープン(openness 1)
// オープンスペースでのタッチ&ラン上限速度。7.5 だと追走(6.5)が構造的に届かず攻撃が独走して
// goals が帯域を大きく超えた(掃引1)。5.5 = 旧キャリー(4.875)より速く見えるが、スプリント追走が
// 追いつける速度に留める。完全オープン(相手14m以遠)でのみ到達する。
export const CARRY_OPEN_SPEED = 5.2;
export const PLAYER_SEPARATION = 0.45; // 保持者の身体に守備者がこれ以上重ならない(すり抜け防止のソフト分離)

export const BALL_DAMPING = 0.55; // 速度の指数減衰 /s
export const PASS_SPEED_MIN = 9;
export const PASS_SPEED_MAX = 24; // サイドチェンジ等のロングボール(最大約44m転がる)

// ── z軸ボール物理(Task AA): 浮き球 ─────────────────────────────────────────────
// 接地球(z=0, vz=0)は従来の2D物理をバイト同一で通る(z分岐はスキップ)。浮き球のみ
// 重力+バウンドを統合する。飛行中(z>0)は転がり摩擦を受けず、水平速度は一定
// (揚力・空気抵抗は v1 では省略 — 弾道は解析的で、着地点 = 狙い点が厳密に成立する)。
export const GRAVITY = 9.8;
// この高さより上のボールは誰も触れない(頭上越え)。ロフトパスのインターセプト不可域。
export const BALL_HEAD_HEIGHT = 2.2;
// クロスバーの高さ。ゴールライン通過時にこれより上ならゴールではない(クリア/パントの
// 飛び越えがゴール判定を素通りしないためのガード)。
export const CROSSBAR_HEIGHT = 2.44;
// バウンド: 鉛直反発係数と、着地時の水平減衰(芝がエネルギーを吸収)
export const LOFT_RESTITUTION = 0.45;
export const LOFT_BOUNCE_FRICTION = 0.7;
// バウンド後の鉛直速度がこれ未満なら接地(z=0, vz=0)へ確定し、以後は転がり物理
export const LOFT_SETTLE_VZ = 1.5;
// ロフトキックの頂点高さ(m)。飛行時間 T = 2*sqrt(2*apex/g)、水平速度 = 距離/T。
export const CROSS_APEX = 7; // クロス: T≈2.39s
export const SWITCH_APEX = 9; // サイドチェンジ: T≈2.71s
export const CLEARANCE_APEX = 10; // クリア: T≈2.86s
export const PUNT_APEX = 12; // GKパント: T≈3.13s
// クロスの発火条件: ワイド(|y| > CROSS_MIN_WIDE_Y)のファイナルサード(敵ゴールから
// CROSS_ZONE_DEPTH 以内)で、飛距離 12〜40m の狙い点があるとき候補になる。
export const CROSS_MIN_WIDE_Y = 13;
export const CROSS_ZONE_DEPTH = 32;
// サイドチェンジ: 40〜70mのロフトの対角。ボールサイドが過密(15m内に相手2人以上)のときのみ。
export const SWITCH_MIN_DIST = 40;
export const SWITCH_MAX_DIST = 70;
export const SWITCH_OVERLOAD_RADIUS = 15;
// サイドチェンジのチーム内クールダウン(秒)。往復スパム(対角→逆サイド過密→対角…)を断つ
export const SWITCH_COOLDOWN = 15;
// クリア: 自ゴールから CLEARANCE_GOAL_DIST 以内で pressure > CLEARANCE_PRESSURE、かつ安全な
// ショートの出口(risk <= 0.45)が無いとき、CLEARANCE_DIST 前方のワイドチャンネルへ蹴り出す。
export const CLEARANCE_GOAL_DIST = 25;
export const CLEARANCE_PRESSURE = 0.4;
export const CLEARANCE_DIST = 42;
// GKパント: ショートが塞がれた時の圧力逃し。着地点は前方 PUNT_DIST(55〜70mの帯の中央)。
export const PUNT_DIST = 60;
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
// Task Z 出荷値 0.25(人間の反応窓)を維持する。Task Y 中に 0.10 へ下げて goals を帯域に収めたが、
// 0.10 は人間以下の反応窓で「GKは限定的」の実質を損ない Z の較正(0.25 で帯域内)を反転させるため
// 差し戻した。デュエルで増えたシュート本数は funnelExitBonus(循環)と質ゲートで源から抑える。
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
// 40シード再検証で 0.20 は goals FAIL、0.18 が PASS(Task W 較正)。以降のデュエル改修
// (Task Y: 旧 STEAL 系を方向性タックルへ置換)でも 0.18 は帯域内で維持している。
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
