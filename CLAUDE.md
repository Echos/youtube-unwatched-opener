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

## 技術仕様

### ファイル構成
```
youtube-unwatched-opener/
├── manifest.json        # 拡張機能設定（Manifest V3、Chrome/Firefox両対応）
├── browser-polyfill.js  # Chrome/Firefox API抽象化レイヤー
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
  hideRelatedVideos: true
};
```

### ポップアップUI（popup.html / popup.css / popup.js）
youtube-smart-speed と統一されたダークテーマデザイン：
- **デザイン言語**: `#0d0d0f` ベースのダークテーマ、Space Grotesk + DM Mono フォント
- **アクセントカラー**: `#ff4040`（YouTube赤）
- **ヘッダー**: ロゴアイコン + タイトル/サブタイトル + ON/OFF メイントグル
- **ステータスバー**: ドットインジケーター + モノスペーステキスト
- **セクション構成**: 基本設定 / ハイライト表示 / 後で見る / 詳細設定
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
