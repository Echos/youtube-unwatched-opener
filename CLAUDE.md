# YouTube未視聴動画オープナー ブラウザ拡張機能

## 概要
YouTube登録チャンネルページ（https://www.youtube.com/feed/subscriptions）で未視聴動画を効率的に別タブで開くブラウザ拡張機能です。動画のビジュアルハイライト、プレイリスト管理、ショート動画の通常動画化など多彩な機能を提供します。

**対応ブラウザ**: Google Chrome、Firefox 109+（Manifest V3 + Service Worker対応）

## 主な機能

### 未視聴動画オープナー
- 設定可能なショートカットキー（デフォルト：Ctrl+Enter）で未視聴動画を開く
- 開く動画数を設定可能（デフォルト：5本）
- 古い動画から優先して開く
- YouTube構造変更にある程度対応

### 動画ハイライト機能
- 未視聴動画の視覚的ハイライト（青色ボーダー＋ラベル）
- ライブ中動画のハイライト（赤色ボーダー＋パルスアニメーション）
- 視聴済み動画の完全非表示（display: none）
- 公開予定動画の完全非表示（display: none）
- プレミア公開動画の識別とハイライト（オレンジ色）
- Ctrl+Shift+Hでハイライト機能のON/OFF切り替え

### 動画プレイヤー機能
- 「r」キーで後で見るプレイリストの追加/削除
- 右サイドバーにプレイリストパネル表示
- ショート動画の通常動画プレイヤーでの再生
- 動画再生時に1440p（あれば）／1080pを優先的に自動選択（4K等への過剰な上振れは避ける）
- 再生音量の平滑化（どの動画でも指定したラウドネスに揃える）

## 技術仕様

### ファイル構成
```
youtube-unwatched-opener/
├── manifest.json        # 拡張機能設定（Manifest V3、Chrome/Firefox両対応）
├── browser-polyfill.js  # Chrome/Firefox API抽象化レイヤー
├── quality-preference.js # 優先画質設定（document_startで実行、localStorage直接操作）
├── quality-enforcer.js  # 優先画質設定のセーフティネット（<script>注入でメインワールド実行）
├── volume-normalizer.js # 音量平滑化（Web Audio API、<script>注入でメインワールド実行）
├── content.js           # メインロジック（未視聴動画検出、ハイライト、ショート動画変換）
├── background.js        # バックグラウンド処理（タブ作成）
├── popup.html           # 設定画面HTML
├── popup.js             # 設定画面JavaScript
├── popup.css            # 設定画面スタイル（ダークテーマ、youtube-smart-speed統一デザイン）
├── highlight.css        # ハイライト機能とプレイリストパネルのスタイル
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── README.md            # ユーザー向け使用方法
└── CLAUDE.md            # 開発仕様書（このファイル）
```

### 設定値
```javascript
const DEFAULT_SETTINGS = {
  shortcutKey: 'ctrl+enter',
  videoCount: 5,
  enabled: true,
  highlightEnabled: true,
  highlightToggleKey: 'ctrl+shift+h',
  watchLaterKey: 'r',
  showPlaylistPanel: true,
  debugMode: false,
  historyMaxCount: 10000,
  includeShorts: true,
  hideRelatedVideos: true,
  volumeNormalizeEnabled: true,
  volumeTargetLufs: -14
};
```

### ポップアップUI（popup.html / popup.css / popup.js）
youtube-smart-speed と統一されたダークテーマデザイン：
- **デザイン言語**: `#0d0d0f` ベースのダークテーマ、Space Grotesk + DM Mono フォント
- **アクセントカラー**: `#ff4040`（YouTube赤）
- **ヘッダー**: ロゴアイコン + タイトル/サブタイトル + ON/OFF メイントグル
- **ステータスバー**: ドットインジケーター + モノスペーステキスト
- **セクション構成**: 基本設定 / ハイライト表示 / 後で見る / 関連動画欄 / 音量平滑化 / 詳細設定
- **トグル**: `toggle-track` + `toggle-thumb` 構造（Smart Speed 統一）
- **入力フィールド**: ダークサーフェス（`--surface2`）スタイル
- **バリデーション**: CSS `:not(:empty)` によるエラー表示制御

### 未視聴動画の識別ロジック
- **主要セレクタ**: `#contents ytd-rich-item-renderer, #contents ytd-video-renderer`
- **未視聴判定**:
  - 未視聴インジケーター（青い点）の有無
  - プログレスバーが0%または存在しない
  - 再生済みオーバーレイがない
- **フォールバック**: 複数の判定方法を組み合わせてYouTube構造変更に対応

### ハイライト機能
- CSS注入による視覚的表示
- MutationObserverによる動的コンテンツ監視
- 複数の判定条件による確実な動画状態識別

### プレイリストパネル
- YouTubeネイティブダイアログの直接埋め込み
- オーバーレイ削除による背景暗転防止
- 動画変更時の自動更新

### ショート動画変換ロジック
```javascript
if (window.location.href.indexOf('youtube.com/shorts') > -1) {
    const newUrl = window.location.toString().replace('/shorts/', '/watch?v=');
    window.location.replace(newUrl);
}
```

### 音量平滑化（volume-normalizer.js）
- **信号経路**: `video → [video.volume打ち消しGain] → [ラウドネス補正Gain] → [コンプレッサー] → [リミッター] → [スライダー音量Gain] → 出力`。計測用に `video → [K特性近似フィルタ] → Analyser` の分岐を別に持つ
- **計測**: 100msごとにAnalyserの二乗平均からラウドネスを求める。-60 LUFS以下の無音ブロックは無視する
- **推定**: 直近15秒をBS.1770の相対ゲート（窓内平均-10LU未満のブロックを除外）付きでエネルギー平均し、補正量を決める。直近3秒の同じ推定値が15秒窓より3LU以上大きい時だけ3秒窓に合わせて素早く下げる。補正は下げる方向を速く（時定数0.5秒）、上げる方向を遅く（3秒）する
  - 3秒窓だけで追従させていた初版では、声の合間（BGMだけの区間）で補正Gainが持ち上がり、BGMが声より大きく聞こえた。長い窓と相対ゲートで声のある区間のレベルに合わせる
- **コンプレッサー**: 閾値は目標ラウドネス+8dB・レシオ2で、突発的なピークを抑えるだけにする。初版の「目標-4dB・レシオ3」は波高率の大きい声のピークだけを潰し、波高率の小さいBGMが相対的に持ち上がっていた（合成した声＋BGM素材で、声とBGMの差が素材16.4dB→初版10.0dB→現行14.7dB）。リミッターは-1dB
- **メインワールド実行**: スライダー値の取得に `.html5-video-player` の `getVolume()`（YouTubeがメインワールドで生やしたメソッド）が必要なため、quality-enforcer.jsと同様に `<script src>` で注入する。設定は content.js が `<html data-youtube-unwatched-opener-volume>` にJSONで書き込み、`youtube-unwatched-opener:volume-settings` イベントで通知する
- **video.volumeの扱い（Chrome実測）**: `video.volume` / `muted` はMediaElementSourceの出力にも線形に反映される。さらに `video.volume` にはスライダー値に加えYouTube自身のラウドネス正規化による減衰も掛かっている。このため計測値から `video.volume` 分を戻して素材のレベルを求め、出力側では打ち消しGainで `video.volume` を相殺したうえで、スライダー値（`getVolume()/100`）をリミッターの**後段**で掛ける。前段のままだとコンプレッサーにスライダーの音量差が圧縮され、50%にしても約-3dBしか下がらなかった
- **自動再生ポリシー**: `MediaElementSource` を作ると元の出力経路に戻せず、AudioContextが停止中だと無音になる。そのため `AudioContext.state === 'running'` を確認してから経路を作成し、停止中なら最初のユーザー操作（pointerdown/keydown）で再開する。OFF時は `source → destination` 直結に切り替える
- **初期推定にplayerResponseのラウドネス値を使わない理由**: `playerConfig.audioConfig.trackAbsoluteLoudnessLkfs` は動画全体の値で、再生位置付近の実測とのズレが動画ごとに一定しないため。0.5秒分の計測が貯まるまでは直前の補正量を維持する
- **未検証**: Firefoxで `video.volume` がMediaElementSourceの出力に反映されるかは未確認（反映されない実装だと、スライダーの減衰が二重に打ち消される方向にずれる）

### Firefox対応
`browser-polyfill.js`でChrome/FirefoxのAPI差異を吸収：
- Firefox: ネイティブの`browser` API（Promise対応）
- Chrome: `chrome` APIをPromiseラッパーで包む
- すべてのAPI呼び出しを`browserAPI.*`で統一

## 実装済み機能

### ✅ 完了
1. **未視聴動画オープナー** - ショートカットキー、古い順優先、重複排除
2. **動画ハイライト** - 未視聴（青）・ライブ（赤）・プレミア（オレンジ）・非表示（視聴済み・公開予定）
3. **プレイリスト機能** - 後で見る（rキー）、プレイリストパネル、ネイティブダイアログ埋め込み
4. **ショート動画変換** - クリック時変換・URL監視リダイレクト・MutationObserver監視
5. **設定画面** - ダークテーマポップアップ、Storage API同期、リアルタイムバリデーション
6. **Firefox対応** - 単一コードベースでChrome/Firefox両対応

## 実装時の注意点
- YouTube APIではなくDOM操作を使用
- content_scriptはページ読み込み完了後に実行
- 動的に読み込まれるコンテンツ（無限スクロール）への対応
- MutationObserverによるYouTube構造変更への対応
- YouTube Shortsは通常動画プレイヤーで再生するよう変換

## 開発指針

### エラーハンドリング
- YouTube DOM構造の取得失敗時の対応
- 設定値の検証とサニタイズ（バリデーション関数による範囲チェック）

### パフォーマンス
- MutationObserverのデバウンス処理（1秒間に最大1回のハイライト更新）
- デバッグログのスロットリング制御

### セキュリティ
- XSS対策
- 設定値の適切な検証
- 最小権限の原則（activeTab・storage・tabs のみ）

## 更新履歴

### 2026-10-20: 音量平滑化でBGMが声より持ち上がる問題を修正
- **症状**: 声の合間のBGMが持ち上がり、声よりBGMが大きく聞こえることがあった
- **原因**: (1) 補正量を直近3秒だけで決めていたため、BGMだけの区間で補正Gainが上がる（AGCのポンピング）、(2) コンプレッサーの閾値が目標ラウドネス-4dB・レシオ3で、声のピークだけが常時圧縮されていた
- **修正**: 補正量の推定を15秒窓＋相対ゲートに変更し、3秒窓は急に大きくなった時に下げる用途に限定。コンプレッサーをピーク抑制だけの設定（目標+8dB・レシオ2）に緩め、追従の時定数も下げ0.5秒・上げ3秒に変更
- **検証**: (1) 声4秒＋BGMのみ2秒を繰り返すブロック列のシミュレーションで、補正Gainの振れ幅が 3.9dB → 0.6dB、(2) OfflineAudioContextで合成素材を旧・新の経路に通し、声とBGMの差が 素材16.4dB / 旧10.0dB / 新14.7dB、(3) ローカルのテストページで修正後スクリプトを実行し、エラーなく動作しBGMだけの区間で補正Gainが跳ね上がらないことを確認。YouTube実機での聴感確認は未実施

### 2026-10-20: 「r」キーの処理中表示と、切り替えが正しく往復しない不具合の修正
- **実測（Claude in Chrome・拡張機能導入済み環境）**: キー押下から `browse/edit_playlist` 送信まで7〜12ms（keydownハンドラ自体は9〜18ms）。サーバー応答（TTFB）は追加で約1.1〜1.5秒、削除で約0.9秒で、体感の遅さの大半はYouTubeサーバー側の処理時間であり、クライアント側では短縮できない
- **不具合1（状態判定）**: 新UI（`toggleable-list-item-view-model`）では選択状態が内側の `button[role=menuitem]` の `aria-pressed` / `aria-label` にあるが、`getWatchLaterItemState()` は属性を持たない `yt-list-item-view-model[role=presentation]` を見て常に `null` を返していた。そのため直前に入れた予測表示・再埋め込み省略が実機では一度も効いていなかった。`[aria-pressed], [aria-checked]` を持つ要素を最優先で探すよう修正
- **不具合2（往復しない）**: パネルが保持するオフスクリーンのダイアログは、クリック後に通信が完了しても YouTube 内部の選択状態・aria属性が更新されない（実測で確認）。さらに押下1.5秒後の再埋め込み（`get_panel`）が `edit_playlist` の完了前に走ると反映前の状態が返り、次の r で削除ではなく**追加が再送**されていた（実測で再現）
- **新しい処理フロー**: 押下直後にトースト（スピナー付き「後で見るに追加中…／削除中…」）とパネルのバッジで処理中を表示し、パネル内の一覧を半透明にする → `PerformanceObserver`（Resource Timing）で `edit_playlist` の完了とHTTPステータスを検知してトーストを「追加しました／削除しました」（失敗時はエラー）に更新 → 完了後にダイアログを取り直し（実測300〜530ms）、実際の状態でバッジを確定。処理中に押された r は完了後に1回だけ実行する。8秒以内に完了を検知できない場合も取り直して状態を合わせる
- **検証**: 実機ページで新しい状態判定が正しい値を返すこと、`edit_playlist` の完了検知（HTTP 200、900〜1138ms）、完了後の取り直しで正しい状態（追加→`true`、削除→`false`）が得られ、追加→削除の往復で後で見るリストが元に戻ることを確認。処理中表示の見た目はCSS/DOMを再現して確認
- **通し計測（拡張機能を再読み込みした実機）**: 押下後9〜13msでトースト・バッジに処理中を表示 → `edit_playlist` 完了直後（0.9〜1.6秒）にトーストを「追加しました／削除しました」に更新（隔離ワールドからの `PerformanceObserver` 受信も動作）→ 取り直し後（1.4〜2.2秒）にバッジ確定。追加→削除の往復、300ms間隔の連打（追加→完了後に削除）とも後で見るリストが期待どおりの状態になることを確認。単発時の内訳は edit_playlist 1230ms ＋ get_panel 520ms ＋ YouTubeのダイアログ描画 約110ms ＋ 拡張機能のパネル反映 11ms で、拡張機能側の処理は合計20ms強。パネル一覧の複製（約730要素）は `cloneNode` 約3ms・配置とレイアウト込みで約18ms。動画終了時など YouTube 側の描画が重い時間帯は、keydown 処理自体が最大150ms待たされることがある（拡張機能の処理ではない）

### 2026-10-20: 「r」キー（後で見る切り替え）の反応速度と全体の処理性能を改善
- **「r」キーの反応**: プレイリストパネル経由のトグル時、クリック直前の状態から予測した結果をバッジに即時表示し、YouTube側の反映後に実際の状態で確定させる（予測表示中の1.5秒間は反映前の古い状態で表示を戻さない）。`syncObserver` が新UIの選択状態（`aria-pressed` / `aria-label`）を監視していなかったため4回の遅延再構築に頼っていた点を修正し、デバウンスも150ms→50msに短縮
- **保存ダイアログの再埋め込みを条件付きに**: 従来は r キーのたびに1.8秒後に保存ボタンを再クリックしてダイアログを取り直しており、その間はパネル状態が空になって次の r キーが遅い経路（保存ボタン経由）に落ちていた。クリック前の状態から変化していない（=反映されていない）場合だけ再埋め込みするよう変更。埋め込み処理中の r キーは完了後に1回だけ処理する
- **視聴履歴判定のキャッシュ化**: `watchHistoryManager.isUrlWatched()` が判定のたびに最大10000件の履歴JSONを2回解析し全件を走査していたため、登録チャンネルページで動画数×履歴件数の処理がメインスレッドを塞いでいた。履歴をメモリにキャッシュし、動画IDの `Set` で判定する（Node.jsでの計測: 履歴10000件・200動画の判定が 806ms → 5ms）。他タブでの更新は `storage` イベントでキャッシュを破棄する
- **ハイライト再判定の範囲縮小**: `#contents` 内のDOM変化のたびに全動画のキャッシュを破棄していたのを、変化した動画要素と追加された動画要素だけに限定
- **その他**: `isButtonVisible()` を `checkVisibility()` ベースに変更（YouTube実機の273ボタンで旧判定と完全一致・約8倍高速。`opacityProperty` は祖先のopacityまで見て旧判定とずれるため使わない）、調査用に残っていた常時出力のDEBUGログ・スタックトレース付きObserverを削除または `debugMode` 時のみに限定、非表示タブではシークバー維持用の疑似mousemoveを止める、SPA遷移を `yt-navigate-finish` で検知（隔離ワールドでの `history.pushState` 差し替えはYouTube本体の呼び出しを捕捉できないため）、バックグラウンドタブで埋め込みを保留した際に `_isEmbedding` が戻らず再開できなかった不具合を修正
- **未検証**: ブラウザペインはYouTube未ログインのため、「後で見る」の実トグル（予測表示→確定、再埋め込みの省略）は実機で確認できていない

### 2026-10-17: 再生音量の平滑化機能を追加
- **機能追加**: どの動画でも指定した目標ラウドネス（`volumeTargetLufs`、デフォルト -14 LUFS、-30〜-6）に再生音量を自動で揃える `volume-normalizer.js` を追加。popupに「音量平滑化」セクション（ON/OFF・目標レベル）を新設。設定変更は再生中の動画にも即時反映
- **検証（ブラウザペインのYouTube実機にスクリプトを注入）**: (1) 計測値の絶対レベルがYouTube自身の値と一致（Despacito: 実装 -8.4 / 左右分離のBS.1770計算 -7.8 / YouTubeの`loudnessDb`から逆算 -8.3 LUFS）、(2) OFF時に -16.4 / -20.3 LUFSと差があった2本の動画がON時に -12.2 / -11.4 LUFSへ揃う、(3) スライダー100%→50%の交互切り替えで出力が -5.7dB（理論値 -6dB）下がり補正Gainは動かない、(4) OFFで直結経路に戻る、(5) `video.volume` の出力反映が線形（0.5→-6.8dB、0.1→-21.1dB）であることを確認。拡張機能としてのパッケージ読み込み（popup操作→content.js経由の設定反映）は未実施

### 2026-08-15: content.js側の画質ポーリングが「隔離ワールド」制約で無効化されていた不具合を修正
- **不具合**: localStorage方式（`quality-preference.js`）を導入した後も、実際のChrome（拡張機能導入・最新化済み環境、Claude in Chromeで検証）では1080p/1440pが優先利用されないケースが残っていた
- **調査**: Claude in Chromeで実機検証したところ、デバッグモードが有効で他の`[DEBUG]`ログは大量に出力されているにもかかわらず、content.js内の画質関連ログ（`[画質設定] 現在: ...`）が一度も出力されていないことを発見。これは`applyPreferredVideoQuality()`が実質的に一度も実行されていないことを意味する
- **根本原因**: `#movie_player`の`getAvailableQualityLevels`/`setPlaybackQuality`/`onStateChange`等はYouTube本体のページスクリプトが**メインワールド**でDOM要素に直接生やした自前プロパティ（`Object.getOwnPropertyNames`で確認、`hasOwnProperty`は`true`）。content.jsはChrome拡張機能の**隔離ワールド（isolated world）**で実行されるため、DOM構造自体は共有されていてもページスクリプトが後付けしたJSプロパティ・メソッドは参照できず、常に`typeof player.getAvailableQualityLevels !== 'function'`側の早期returnに落ちて何も起きないまま終わっていた（かつ当時はこの分岐にログ出力がなく気づきにくかった）
- **修正内容**: content.js内にあったポーリング関数（`applyPreferredVideoQuality`/`enforcePreferredVideoQuality`/`attachPreferredQualityStateListener`/`setupPreferredVideoQuality`）を全て削除し、同等のロジックを`quality-enforcer.js`として切り出した上で、content.jsから`<script src="chrome-extension://.../quality-enforcer.js">`をページに注入してメインワールドで実行させる方式に変更（`injectQualityEnforcerScript()`、`web_accessible_resources`に追加）。YouTube自身が発火する`yt-navigate-start`イベントでSPA遷移のたびに再適用する
- **検証**: Claude in Chromeの実機環境で、(1) `player.getOwnPropertyNames`から画質関連メソッドが自前プロパティであることを確認、(2) メインワールド相当の実行コンテキストからは同一ロジックが確実に動作することを複数回確認、(3) `quality-preference.js`（localStorage方式）は実機で既に正常動作していることも別途確認。なお`textContent`によるインラインスクリプト注入はYouTubeのTrusted Types CSPでブロックされることも確認しており、`script.src`（web_accessible_resources経由）を使う現在の実装が正しいアプローチであることの裏付けとなった
- **教訓**: DOM要素に対する`typeof element.method === 'function'`チェックだけでは「メソッドが存在しない」と「隔離ワールドから見えない」を区別できず、静的なコード確認や単純な動作確認だけでは見つけにくい。今後YouTubeの内部プレイヤーAPI（`#movie_player`のカスタムメソッド群）を直接操作するコードは、content.js（隔離ワールド）ではなく必ずメインワールドに注入したスクリプトから実行すること

### 2026-08-15: 優先画質設定をlocalStorage直接操作方式に全面刷新
- **背景**: ポーリング＋`setPlaybackQuality()`方式（直前の修正）を適用しても、実際には1080p/1440pが優先利用されないという報告が継続。プレイヤーAPI経由の画質制御はYouTube側の実装変更の影響を受けやすく信頼性に欠けると判断し、類似事例（GreasyFork等の画質固定系ユーザースクリプトで広く使われている手法）を調査した上で設計を全面的に見直した
- **調査で判明した事実**: YouTubeは`localStorage`の`yt-player-quality`キー（形式: `{"data":"{\"quality\":<数値>,\"previousQuality\":<数値>}","expiration":<epoch ms>,"creation":<epoch ms>}`）に「ユーザーが設定画面から手動選択した画質」を保存しており、動画プレイヤー初期化時にこの値を読んで開始画質を決定する。実機の設定メニューから実際に画質を変更してlocalStorageの差分を観測することでこの形式を特定した
- **新実装**: `quality-preference.js`を`document_start`で新規注入し、`quality: 1440`を常に書き込む。YouTube側が「保存された画質が動画の利用可能範囲を超える場合は範囲内の最高画質にクランプする」という挙動を持つため、1440p非対応の動画では自動的に1080p等へ収まる（＝「1440pがあれば1440p、なければ1080p」を1回の書き込みだけで実現）。SPA内の動画切り替え（`history.pushState`)ではdocument_startが再実行されないため、YouTube自身が発火する`yt-navigate-start`イベントでも同じ処理を再実行する
- **検証**: 実際のYouTube上で (1) 4K対応動画への遷移時に`yt-player-quality`をこの形式で書き込むと即座に`hd1440`で再生開始、(2) 1080p止まりの動画では自動的に`hd1080`にクランプ、(3) 240p程度しかない動画では`small`（利用可能な最高画質）に収まりエラーにならない、(4) 実際にSPA内で関連動画リンクをクリックして遷移した場合も`yt-navigate-start`ハンドラだけで追加のポーリングなしに正しい画質で開始される、の4パターンをそれぞれ実機ブラウザで確認済み
- **既存のポーリング方式は保持**: `content.js`側の`enforcePreferredVideoQuality()`等はセーフティネットとしてそのまま残し、二重の担保とした

### 2026-08-15: 優先画質設定が反映されない不具合を修正
- **不具合**: 「1080p(あれば1440p)を優先的に利用する」機能を実装したが、実際には画質が優先設定通りに切り替わらないケースがあった
- **原因**: `applyPreferredVideoQuality()` が `setPlaybackQuality()` を呼び出した時点で即座に成功扱い（リトライ終了）していたため、YouTube側の画質反映が非同期（実測で数秒かかる）であることや、再生直後にYouTubeが画質をautoへ巻き戻すことがある点に対応できていなかった
- **修正内容**: `applyPreferredVideoQuality()` の戻り値を `'pending'`（未確定・要リトライ）/`'confirmed'`（`getPlaybackQuality()` で目標画質への切り替えを実際に確認できた）/`'not-applicable'`（1080p/1440pが利用不可）の3値に変更し、`enforcePreferredVideoQuality()` は `'confirmed'` になるまで500ms間隔・最大10秒間ポーリングして再適用し続けるよう変更。`onStateChange` での再生開始時（state 1）にも単発呼び出しではなく `enforcePreferredVideoQuality()`（確認付きポーリング）を呼ぶよう統一
- **検証**: 実際のYouTube動画ページに修正後のロジックをそのまま注入し、ページ遷移直後から自動実行させた結果、約1.5秒・3回のポーリングで `hd1440` への切り替えが確認（`confirmed`）されることを確認済み

### 2026-08-15: 動画再生画質の優先設定機能を追加
- **機能追加**: 動画ページ（`/watch`）でプレイヤーの利用可能画質に`hd1440`（1440p）があればそれを、なければ`hd1080`（1080p）を自動的に優先選択するよう変更。4K等それ以上の画質には自動で上げない（通信量とのバランスを考慮）
- **実装内容**:
  - `applyPreferredVideoQuality()`: `#movie_player` の `getAvailableQualityLevels()` で利用可能画質を取得し、`hd1440` → `hd1080` の優先順で最初に一致したものを `setPlaybackQualityRange()` / `setPlaybackQuality()` で適用
  - `enforcePreferredVideoQuality()`: YouTube側が動画開始直後に画質をautoへ戻すことがあるため、500ms間隔・最大10回までリトライして確実に適用
  - `attachPreferredQualityStateListener()`: プレイヤーの `onStateChange` イベント（再生開始 = state 1）でも再適用し、動画切り替え後の画質リセットに対応
  - `setupPreferredVideoQuality()`: `initializeVideoPageFeatures()` および `history.pushState`/`replaceState` フック内から呼び出し、SPA遷移で動画が切り替わるたびに再適用
- **検証**: 実際のYouTube動画ページのコンソールで `movie_player` の `getAvailableQualityLevels()` / `setPlaybackQuality()` / `onStateChange` イベントの挙動を直接確認し、画質切り替えが数秒後に反映されること（即時反映ではないため実装側でリトライが必要なこと）を確認済み

### 2026-08-10: SPA遷移時のハイライトキャッシュ不整合を修正
- **不具合**: 動画ページ／ショートページなど別のYouTubeページから登録チャンネルページ（`/feed/subscriptions`）に戻ると、遷移前にキャッシュされた未視聴／視聴済みステータスがそのまま残り、実際には視聴済みになった動画が未視聴として扱われ続ける問題を修正
- **原因**: `applySimpleHighlighting()` は判定コストを抑えるため動画要素へ `dataset.simpleHighlightProcessed` フラグを立てて判定結果（`dataset.videoStatus`）をキャッシュしているが、これを無効化するはずの `startSimpleHighlightObserver()` 内のMutationObserverコールバックが `if (!el.dataset.simpleHighlightProcessed) { delete el.dataset.simpleHighlightProcessed; }` という条件反転（未処理要素からフラグを消す＝実質何もしない）になっており、DOM変化時にキャッシュが破棄されていなかった。YouTubeのSPAナビゲーションで `ytd-rich-item-renderer` 要素がDOM上で使い回された場合、この壊れたキャッシュが遷移後も残ってしまう
- **修正内容**:
  - `resetSimpleHighlightCache()` 関数を新設し、`#contents ytd-rich-item-renderer` 全要素の `simpleHighlightProcessed` / `videoStatus` キャッシュを確実に破棄するよう修正
  - `handleUrlChangeForHighlighting()` を新設し、SPA遷移（`history.pushState` / `history.replaceState` フック内、および `popstate` イベント）のたびにキャッシュを破棄。登録チャンネルページに戻った場合は `startSimpleHighlightObserver()` を再起動して確実に再判定させ、それ以外のページに遷移した場合はオブザーバーを停止しカウントオーバーレイを除去する
  - 併せて `pushstate` / `replacestate` というカスタムイベントが（`dispatchEvent` されておらず）実際には一度も発火しない死んだリスナーだった点を確認。今回の修正では `history.pushState`/`replaceState` のフック内から直接呼び出す形で対応（既存の `updatePlaylistPanelForNewVideo` と同じ呼び出しパターンに合わせた）

### 2026-08-08: 関連動画欄の非表示・通信量削減機能追加
- **設定項目追加**: `hideRelatedVideos`（デフォルト`true`）。popup.htmlに「関連動画欄」セクションを新設し、ON/OFF切り替え可能に（要ページ再読み込み）
- **CSSによる早期非表示**: `manifest.json` の `content_scripts` を分割し、`highlight.css` を `document_start` タイミングで先に注入するよう変更（従来は `content.js` と同じ `document_idle`）。`body.youtube-unwatched-opener-hide-related #related { display: none !important; }` を追加し、動画ページ右側の関連動画欄（`#related`）をHTML構築の早い段階から非表示にする
- **通信量削減の仕組み**: `display:none` の要素はブラウザのIntersectionObserverが交差判定しないため、YouTube側のサムネイル遅延読み込み（`img`要素への`src`設定）自体が発火しなくなり、非表示だけでなく通信量削減にもつながる。念のため `content.js` に `removeRelatedVideosRenderer()` / `initializeRelatedVideosBlocker()` を追加し、`ytd-watch-next-secondary-results-renderer` をDOMから完全に削除する保険処理も併用
- プレイリストパネル（`#playlist`）・ライブチャット（`#chat-container`）など `#secondary-inner` 内の他要素には影響しない（`#related` のみを対象化）

### 2026-08-08: シークバー常時表示機能追加
- **動画プレイヤーの下部コントロールバー常時表示**: `highlight.css` にCSSルールを追加し、マウス操作がない自動非表示（`.ytp-autohide`）状態でも `.ytp-chrome-bottom`（シークバー・各種ボタン・背景グラデーション）を常に表示するよう変更
- **コントロールバーの位置調整**: `bottom: 0` / `padding-bottom: 0` により、コントロールバーが動画最下部にぴったりフィットするよう調整（浮き解消）
- **不具合修正（シーク位置が更新されなくなる問題・2段階）**:
  - 試行1: CSSで `.ytp-progress-bar-container` に `pointer-events` / `transform` を強制 → YouTube側が「ユーザー操作中」と誤認識し、進捗更新（`.ytp-play-progress` の `scaleX` アニメーション）が停止。pointer-events/transformの強制を撤廃。
  - 試行2: `.ytp-autohide` クラス自体をMutationObserverで検知して都度除去する方式に変更 → 表示は常時されるが、進捗更新の停止は再発。マウスを動かすと一時的に追いつく挙動から、YouTube内部の進捗再計算はDOM classではなく「直近にmousemoveイベントが発生したか」という内部の操作中フラグをトリガーにしていると判明。
  - 現在の実装: `startSeekBarKeepAlive()` を追加し、動画再生中は800ms間隔でプレイヤーへ微小な `mousemove` イベントを疑似発行してYouTube自身に「操作中」と認識させ続けることで、内部の進捗更新ロジックを正常に動作させる（`.ytp-autohide` クラス除去・CSSのopacity/visibility上書きは表示保証のフォールバックとして併用）
- 既存の `injectCSS()` の仕組み（`highlight.css` を全ページに読み込み）をそのまま利用

### 2026-03-08: 自動削除機能の削除・ポップアップリデザイン
- **自動削除機能を削除**: `autoRemoveWatchLater` / `watchLaterRemovalTime` 設定、`monitorVideoProgress()` / `removeFromWatchLater()` / `checkAndRemoveFromWatchLater()` 関数を完全削除
- **ポップアップUIリデザイン**: youtube-smart-speed と統一されたダークテーマデザインに変更
  - `popup.css` を独立ファイルとして新規作成（インラインスタイルから分離）
  - ダークテーマ（`#0d0d0f` ベース）、Space Grotesk + DM Mono フォント採用
  - セクション構成による設定項目の整理
  - ドットインジケーター付きステータスバー
- **popup.js リファクタリング**: バリデーション統合、設定取得ヘルパー、不要なメッセージリスナー削除

### 2025-12-06: Firefox対応
- Browser API Polyfill実装、Promiseベース化、manifest.json更新

### 2025-10-25: Watch laterボタン対応・プレイリスト機能強化
- 「Watch later」ボタンキャプション変更に対応、直接表示保存ボタン検出

### 2025-09-04: YouTube構造変更対応
- 新セレクタパターン追加、デバッグモード・構造診断機能追加

### 2025-08-13: 公開予定動画非表示機能追加
