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
  includeShorts: true
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
