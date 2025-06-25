const DEFAULT_SETTINGS = {
  shortcutKey: 'ctrl+enter',
  videoCount: 5,
  enabled: true,
  highlightEnabled: true,
  highlightToggleKey: 'ctrl+shift+h',
  watchLaterKey: 'r',
  showPlaylistPanel: true,
  debugMode: false,  // デバッグモード（詳細ログ出力のON/OFF）
  historyMaxCount: 10000,  // 視聴履歴の最大保持件数
  includeShorts: true  // 未視聴動画オープナーでショート動画を含めるか
};

let settings = DEFAULT_SETTINGS;

// デバッグログ制御機能
const debugLogController = {
  lastMessages: new Map(),
  maxSameMessageCount: 5,
  timeWindow: 10000, // 10秒間
  
  shouldLog: function(message) {
    if (!settings.debugMode) return false;
    
    const now = Date.now();
    const messageData = this.lastMessages.get(message);
    
    if (!messageData) {
      this.lastMessages.set(message, { count: 1, firstTime: now, lastTime: now });
      return true;
    }
    
    // 時間窓をリセット
    if (now - messageData.firstTime > this.timeWindow) {
      this.lastMessages.set(message, { count: 1, firstTime: now, lastTime: now });
      return true;
    }
    
    // 同じメッセージの連続出力制限
    if (messageData.count >= this.maxSameMessageCount) {
      if (messageData.count === this.maxSameMessageCount) {
        console.log(`[DEBUG-THROTTLED] 上記メッセージは制限されました（${this.timeWindow/1000}秒以内に${this.maxSameMessageCount}回以上）`);
        messageData.count++;
      }
      return false;
    }
    
    messageData.count++;
    messageData.lastTime = now;
    return true;
  },
  
  log: function(message) {
    if (this.shouldLog(message)) {
      console.log(message);
    }
  }
};

// MutationObserverベースの要素出現待機ユーティリティ
function waitForElement(selector, options = {}) {
  const { timeout = 5000, root = document, contentCheck = null } = options;
  return new Promise((resolve, reject) => {
    const check = (el) => el && (!contentCheck || contentCheck(el));
    const existing = root.querySelector(selector);
    if (existing && check(existing)) return resolve(existing);

    const observeRoot = (root.nodeType === Node.DOCUMENT_NODE) ? root.body : root;
    const observer = new MutationObserver(() => {
      const el = root.querySelector(selector);
      if (el && check(el)) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });
    observer.observe(observeRoot, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`waitForElement timeout: ${selector}`));
    }, timeout);
  });
}

function parseShortcut(shortcutStr) {
  const parts = shortcutStr.toLowerCase().split('+');
  return {
    ctrl: parts.includes('ctrl'),
    alt: parts.includes('alt'),
    shift: parts.includes('shift'),
    key: parts[parts.length - 1]
  };
}

function isMatchingShortcut(event, shortcutStr) {
  const shortcut = parseShortcut(shortcutStr);
  
  return event.ctrlKey === shortcut.ctrl &&
         event.altKey === shortcut.alt &&
         event.shiftKey === shortcut.shift &&
         event.key.toLowerCase() === shortcut.key;
}

// 視聴履歴管理機能
const watchHistoryManager = {
  STORAGE_KEY: 'youtube-unwatched-opener-watch-history',
  
  // 動画URLから動画IDを抽出
  extractVideoId: function(url) {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
      /youtube\.com\/shorts\/([^&\n?#]+)/
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return match[1];
      }
    }
    return null;
  },
  
  // 履歴をlocalStorageから読み込み
  getHistory: function() {
    try {
      const historyJson = localStorage.getItem(this.STORAGE_KEY);
      if (!historyJson) {
        return [];
      }
      const history = JSON.parse(historyJson);
      return Array.isArray(history) ? history : [];
    } catch (error) {
      debugLogController.log(`[履歴] 履歴読み込みエラー: ${error.message}`);
      return [];
    }
  },
  
  // 履歴をlocalStorageに保存
  saveHistory: function(history) {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(history));
    } catch (error) {
      debugLogController.log(`[履歴] 履歴保存エラー: ${error.message}`);
    }
  },
  
  // 動画を視聴済みとして履歴に追加
  addToHistory: function(videoUrl) {
    const videoId = this.extractVideoId(videoUrl);
    if (!videoId) {
      debugLogController.log(`[履歴] 無効な動画URL: ${videoUrl}`);
      return false;
    }
    
    const history = this.getHistory();
    const timestamp = Date.now();
    const maxCount = settings.historyMaxCount || DEFAULT_SETTINGS.historyMaxCount;
    
    // 既存の履歴から同じ動画IDを削除（重複防止）
    const filteredHistory = history.filter(item => item.videoId !== videoId);
    
    // 新しいエントリを先頭に追加
    filteredHistory.unshift({
      videoId: videoId,
      url: videoUrl,
      timestamp: timestamp,
      watchedAt: new Date().toISOString()
    });
    
    // 履歴数を制限（FIFO：古いものから削除）
    if (filteredHistory.length > maxCount) {
      filteredHistory.splice(maxCount);
    }
    
    this.saveHistory(filteredHistory);
    debugLogController.log(`[履歴] 動画を履歴に追加: ${videoId} (履歴数: ${filteredHistory.length}/${maxCount})`);
    
    // Toast通知を表示
    toastController.show(`視聴履歴に保存しました (${videoId})`, 'success', 2500);
    
    return true;
  },
  
  // 動画IDが視聴済みかチェック
  isWatched: function(videoId) {
    if (!videoId) return false;
    
    const history = this.getHistory();
    const found = history.some(item => item.videoId === videoId);
    
    if (found) {
      debugLogController.log(`[履歴] 視聴済み動画を検出: ${videoId}`);
    }
    
    return found;
  },
  
  // 動画URLが視聴済みかチェック（ショート⇔通常動画の相互変換対応）
  isUrlWatched: function(videoUrl) {
    const videoId = this.extractVideoId(videoUrl);
    if (!videoId) return false;
    
    // 基本的な履歴チェック
    if (this.isWatched(videoId)) {
      return true;
    }
    
    // ショート動画と通常動画の相互変換でチェック
    const history = this.getHistory();
    const found = history.some(item => {
      if (item.videoId === videoId) {
        return true;
      }
      
      // URLの形式変換をチェック
      const itemVideoId = this.extractVideoId(item.url);
      return itemVideoId === videoId;
    });
    
    return found;
  },
  
  // 履歴のクリア
  clearHistory: function() {
    try {
      localStorage.removeItem(this.STORAGE_KEY);
      debugLogController.log('[履歴] 視聴履歴をクリアしました');
      return true;
    } catch (error) {
      debugLogController.log(`[履歴] 履歴クリアエラー: ${error.message}`);
      return false;
    }
  },
  
  // 履歴の統計情報を取得
  getHistoryStats: function() {
    const history = this.getHistory();
    return {
      count: history.length,
      maxCount: settings.historyMaxCount || DEFAULT_SETTINGS.historyMaxCount,
      oldest: history.length > 0 ? history[history.length - 1].watchedAt : null,
      newest: history.length > 0 ? history[0].watchedAt : null
    };
  }
};

// 従来の未視聴判定関数（非推奨：getSimpleVideoStatus関数に統合済み）
// この関数は新しい統一判定ロジック getSimpleVideoStatus() に置き換えられました
/*
function isUnwatchedVideo(videoElement) {
  // ショート動画は除外（判定対象外）
  const isShorts = videoElement.querySelector('a[href*="/shorts/"]') !== null;
  
  if (isShorts) {
    debugLogController.log('[DEBUG] ショート動画のため判定スキップ');
    return false; // ショート動画は常に対象外
  }
  
  // デバッグ用：動画の基本情報を出力（新YouTube構造対応）
  const titleSelectors = [
    '#video-title',                    // 従来のタイトル
    '.ytd-rich-grid-media #video-title', // リッチグリッドメディア内
    'a[title]',                       // リンクのtitle属性
    '.video-title',                   // 一般的なタイトルクラス
    'h3',                            // h3タグ（新構造で多用）
    'a[href*="/watch"] span',         // 動画リンク内のspan
    'a[href*="/watch"]',             // 動画リンク自体
    '[class*="title"]'               // titleを含むクラス
  ];
  
  let titleElement = null;
  let videoTitle = 'タイトル取得不可';
  
  for (const selector of titleSelectors) {
    titleElement = videoElement.querySelector(selector);
    if (titleElement) {
      videoTitle = titleElement.textContent?.trim() || titleElement.title || titleElement.getAttribute('aria-label') || '';
      if (videoTitle && videoTitle.length > 0) {
        break;
      }
    }
  }
  
  if (!videoTitle || videoTitle === '') {
    videoTitle = 'タイトル不明';
  }
  debugLogController.log(`[DEBUG] 未視聴判定開始: "${videoTitle.substring(0, 30)}"`);
  
  // デバッグ用：要素の構造を詳細に調査（一時的）
  if (settings.debugMode) {
    const overlayElements = videoElement.querySelectorAll('[class*="overlay"], [class*="status"], [class*="progress"], [class*="resume"]');
    if (overlayElements.length > 0) {
      debugLogController.log(`[DEBUG] オーバーレイ要素発見 (${overlayElements.length}個):`);
      Array.from(overlayElements).slice(0, 3).forEach((el, i) => {
        debugLogController.log(`[DEBUG]   [${i}] ${el.tagName}.${el.className.split(' ').slice(0, 2).join('.')} - ${el.textContent?.substring(0, 20) || 'テキストなし'}`);
      });
    }
  }
  
  // 2025年9月時点のYouTube構造に対応した未視聴判定ロジック（新構造対応強化版）
  const unwatchedIndicators = [
    // 新しい青い点インジケーター（従来）
    'ytd-thumbnail-overlay-time-status-renderer [style*="blue"]',
    'ytd-thumbnail-overlay-time-status-renderer [style*="#065fd4"]',
    'ytd-thumbnail-overlay-time-status-renderer .badge-style-type-notification',
    
    // 新しいバッジ系統
    '.badge-style-type-simple.style-scope.ytd-badge-supported-renderer[style*="blue"]',
    '.badge-style-type-simple.style-scope.ytd-badge-supported-renderer[style*="#065fd4"]',
    
    // 新しいリッチグリッドメディア構造対応
    'ytd-rich-grid-media [style*="blue"]',
    'ytd-rich-grid-media [style*="#065fd4"]',
    'ytd-rich-grid-media .badge[style*="blue"]',
    '.ytd-rich-grid-media [class*="badge"][style*="blue"]',
    
    // より広範なオーバーレイ検索
    '[class*="overlay"][style*="blue"]',
    '[class*="overlay"][style*="#065fd4"]',
    '[class*="status"][style*="blue"]',
    '[class*="indicator"][style*="blue"]',
    
    // aria-labelやtitle属性ベース
    '[aria-label*="未視聴"]',
    '[title*="未視聴"]',
    '[aria-label*="unwatched"]',
    '[title*="unwatched"]',
    '[data-context-item-id] [style*="blue"]',  // コンテキストアイテム内の青い要素
    
    // 新しいオーバーレイ系統
    'ytd-thumbnail-overlay-time-status-renderer div[style*="background-color: rgb(6, 95, 212)"]',
    'ytd-thumbnail-overlay-time-status-renderer div[style*="background-color:#065fd4"]',
    
    // その他の可能性のある要素
    '.ytd-thumbnail-overlay-time-status-renderer span[style*="background"]',
    '.ytd-thumbnail-overlay-time-status-renderer .style-scope[style*="color: rgb(6, 95, 212)"]',
    
    // 動画リンクから構築された要素用の追加判定
    'img[src*="maxresdefault"] ~ * [style*="blue"]',  // サムネイルの兄弟要素の青い点
    '[class*="thumbnail"] + * [style*="blue"]',       // サムネイル隣接要素の青い点
    
    // 新YouTube構造：時間バッジのみの場合は未視聴（2025-09-04追加）
    'yt-thumbnail-badge-view-model:not([class*="live"])',  // ライブではない時間バッジ
    'yt-thumbnail-overlay-badge-view-model:not([class*="live"])'  // ライブではないオーバーレイバッジ
  ];
  
  // まず視聴済みの明示的なインジケーターをチェック
  const watchedIndicators = [
    '.ytd-thumbnail-overlay-resume-playback-renderer[style*="width: 100%"]',
    '.ytd-thumbnail-overlay-resume-playback-renderer .ytp-progress-bar[style*="width: 100%"]',
    '[data-is-watched="true"]',
    '[class*="watched"]'
  ];
  
  for (const selector of watchedIndicators) {
    const element = videoElement.querySelector(selector);
    if (element) {
      debugLogController.log(`[DEBUG] 視聴済みインジケーター検出: ${selector} -> 視聴済み判定`);
      return false;
    }
  }
  
  // 未視聴インジケーターをチェック
  for (const selector of unwatchedIndicators) {
    const element = videoElement.querySelector(selector);
    if (element) {
      // デバッグ情報を出力
      debugLogController.log(`[DEBUG] 未視聴インジケーター検出: ${selector} -> 未視聴判定`);
      return true;
    }
  }
  
  // プログレスバーによる判定（改良版）
  const progressBars = [
    '.ytd-thumbnail-overlay-resume-playback-renderer',
    'ytd-thumbnail-overlay-resume-playback-renderer',
    '.progress-bar',
    '[class*="progress"]'
  ];
  
  let hasProgressBar = false;
  for (const selector of progressBars) {
    const progressBar = videoElement.querySelector(selector);
    if (progressBar) {
      hasProgressBar = true;
      
      // 進行状況を確認
      const watchedOverlay = progressBar.querySelector('[style*="width"]');
      if (watchedOverlay) {
        const widthStyle = watchedOverlay.style.width;
        const widthMatch = widthStyle.match(/(\d+(?:\.\d+)?)/);
        if (widthMatch) {
          const width = parseFloat(widthMatch[1]);
          if (width === 0 || width < 1) {
            debugLogController.log(`[DEBUG] プログレスバー幅0%検出 -> 未視聴判定: ${width}%`);
            return true;
          }
        }
      } else {
        // プログレスバー要素はあるが、進行状況がない = 未視聴
        debugLogController.log('[DEBUG] プログレスバー要素あり、進行状況なし -> 未視聴判定');
        return true;
      }
      break;
    }
  }
  
  // プログレスバーがない場合の判定を保守的に変更
  if (!hasProgressBar) {
    // ライブやプレミアでない場合のみ、より詳細な検証を実行
    if (!checkIsLive(videoElement) && !checkIsPremiere(videoElement)) {
      // 追加の未視聴インジケーターを詳細に検索
      const additionalUnwatchedIndicators = [
        // より具体的なセレクタ
        'ytd-thumbnail-overlay-time-status-renderer[overlay-style="DEFAULT"]',
        '.ytd-thumbnail-overlay-time-status-renderer[style*="display: block"]',
        // 新しいYouTube構造に対応
        '[class*="unwatched"]',
        '[class*="new"]',
        '[data-is-watched="false"]'
      ];
      
      // 新YouTube構造：時間バッジがある場合の特別な判定（2025-09-04追加）
      const timeBadges = videoElement.querySelectorAll('yt-thumbnail-badge-view-model, yt-thumbnail-overlay-badge-view-model');
      if (timeBadges.length > 0) {
        for (const badge of timeBadges) {
          const badgeText = badge.textContent?.trim() || '';
          // 時間形式（MM:SS または HH:MM:SS）かつライブではない場合
          if (badgeText.match(/^\d+:\d{2}(:\d{2})?$/) && !badgeText.includes('ライブ') && !badgeText.includes('LIVE')) {
            debugLogController.log(`[DEBUG] 新YouTube構造：時間バッジ検出 "${badgeText}" -> 未視聴判定`);
            return true;
          }
        }
      }
      
      for (const selector of additionalUnwatchedIndicators) {
        if (videoElement.querySelector(selector)) {
          debugLogController.log(`[DEBUG] 追加未視聴インジケーター検出: ${selector} -> 未視聴判定`);
          return true;
        }
      }
      
      debugLogController.log('[DEBUG] プログレスバーなし、明示的未視聴インジケーターも見つからず -> デフォルトで未視聴判定（保守的）');
      return true;
    }
  }
  
  debugLogController.log('[DEBUG] 明確な判定ができず -> デフォルトで未視聴判定（新YouTube構造対応）');
  return true;
}
*/

// isUnwatchedShortsVideo 関数は削除（ショート動画の視聴状態判定は行わない）

function isShortVideo(videoElement) {
  // 方法1: ショートリンクの存在確認
  const hasShortLink = videoElement.querySelector('a[href*="/shorts/"]');
  if (hasShortLink) {
    return true;
  }
  
  // 方法2: ショート動画専用要素の確認
  const isReelRenderer = videoElement.tagName === 'YTD-REEL-ITEM-RENDERER' || 
                         videoElement.closest('ytd-reel-item-renderer');
  if (isReelRenderer) {
    return true;
  }
  
  // 方法3: ショート動画の特徴的なクラスや属性の確認
  const shortIndicators = [
    '[class*="reel"]',
    '[class*="shorts"]', 
    '[class*="Short"]',
    '[data-is-short="true"]',
    '[aria-label*="ショート"]',
    '[aria-label*="Short"]',
    '[title*="ショート"]',
    '[title*="Short"]',
    '[data-content-type="shorts"]',
    '[data-video-type="shorts"]'
  ];
  
  for (const selector of shortIndicators) {
    if (videoElement.querySelector(selector) || videoElement.matches(selector)) {
      return true;
    }
  }
  
  // 方法4: 縦向きアスペクト比のサムネイル確認（9:16比率）
  const thumbnails = videoElement.querySelectorAll('ytd-thumbnail, img');
  for (const thumbnail of thumbnails) {
    const style = thumbnail.getAttribute('style') || '';
    if (style.includes('aspect-ratio: 9/16') || 
        style.includes('aspect-ratio:9/16') ||
        style.includes('aspect-ratio: 0.5625') ||
        style.includes('aspect-ratio:0.5625')) {
      return true;
    }
  }
  
  // 方法5: YouTubeの動画時間表示でショート動画を識別（60秒以下）
  const timeIndicators = videoElement.querySelectorAll('.ytd-thumbnail-overlay-time-status-renderer, #time-status, .badge-time');
  for (const timeElement of timeIndicators) {
    const timeText = timeElement.textContent?.trim();
    if (timeText) {
      // 60秒以下の短い動画かつ特定のスタイルを持つ場合はショート動画とみなす
      const timeMatch = timeText.match(/^(\d{1,2}):(\d{2})$/);
      if (timeMatch) {
        const minutes = parseInt(timeMatch[1]);
        const seconds = parseInt(timeMatch[2]);
        const totalSeconds = minutes * 60 + seconds;
        if (totalSeconds <= 60) {
          // 縦型レイアウトやショート特有の要素があるかチェック
          const hasVerticalLayout = videoElement.querySelector('[class*="vertical"], [style*="aspect-ratio"], [data-shorts]');
          if (hasVerticalLayout) {
            return true;
          }
        }
      }
    }
  }
  
  // 方法6: DOM内のテキストコンテンツからショート動画を識別
  const textContent = videoElement.textContent || '';
  if (textContent.includes('#Shorts') || textContent.includes('#shorts') || textContent.includes('ショート動画')) {
    return true;
  }
  
  // 方法7: データ属性やカスタム属性の確認
  const dataAttributes = videoElement.getAttributeNames ? videoElement.getAttributeNames() : [];
  for (const attr of dataAttributes) {
    const value = videoElement.getAttribute(attr);
    if (attr.includes('short') || (value && value.includes('/shorts/'))) {
      return true;
    }
  }
  
  return false;
}

function getVideoUrl(videoElement) {
  // 2025年9月構造変更対応: より幅広いリンク検索（書き換え済みショート動画含む）
  const linkSelectors = [
    'a[href*="/watch?v="]',              // 従来の動画リンク
    'a[href*="/watch"]',                 // より広範な動画リンク
    'a[href*="/shorts/"]',               // ショート動画リンク（書き換え前）
    'a[data-converted="true"]',          // 書き換え済みショート動画リンク
    '[data-context-item-id] a[href*="/watch"]', // 新しいコンテキストアイテム内のリンク
    '[data-context-item-id] a[href*="/shorts/"]', // 新しいコンテキストアイテム内のショートリンク
    '[data-context-item-id] a[data-converted="true"]' // 新しいコンテキストアイテム内の書き換え済みリンク
  ];
  
  for (const selector of linkSelectors) {
    const linkElement = videoElement.querySelector(selector);
    if (linkElement) {
      const url = linkElement.href;
      // 通常動画とショート動画の両方を取得
      if (url.includes('/watch') || url.includes('/shorts/')) {
        debugLogController.log(`[URL取得] セレクタ "${selector}" で取得: ${url}`);
        return url;
      }
    }
  }
  
  // リンクが見つからない場合、親要素から動画リンクを探索
  if (videoElement.tagName === 'A' && videoElement.href) {
    const url = videoElement.href;
    if (url.includes('/watch') || url.includes('/shorts/')) {
      debugLogController.log(`[URL取得] 親要素から取得: ${url}`);
      return url;
    }
  }
  
  debugLogController.log('[URL取得] URLが見つかりませんでした');
  return null;
}

function getVideoTimestamp(videoElement) {
  const timeSelectors = [
    '#metadata-line span:nth-child(2)',
    '.ytd-video-meta-block #metadata-line span:last-child',
    'ytd-video-meta-block #metadata-line span',
    '[id="metadata-line"] span',
    '.style-scope.ytd-video-meta-block span'
  ];
  
  for (const selector of timeSelectors) {
    const timeElement = videoElement.querySelector(selector);
    if (timeElement) {
      const timeText = timeElement.textContent.trim();
      const timePattern = /(\d+)\s*(分|時間|日|週間|か月|年)前/;
      const match = timeText.match(timePattern);
      
      if (match) {
        const value = parseInt(match[1]);
        const unit = match[2];
        
        const now = Date.now();
        switch (unit) {
          case '分': return now - (value * 60 * 1000);
          case '時間': return now - (value * 60 * 60 * 1000);
          case '日': return now - (value * 24 * 60 * 60 * 1000);
          case '週間': return now - (value * 7 * 24 * 60 * 60 * 1000);
          case 'か月': return now - (value * 30 * 24 * 60 * 60 * 1000);
          case '年': return now - (value * 365 * 24 * 60 * 60 * 1000);
        }
      }
    }
  }
  
  const orderIndex = Array.from(document.querySelectorAll('#contents ytd-rich-item-renderer, #contents ytd-video-renderer, #contents ytd-reel-item-renderer')).indexOf(videoElement);
  return Date.now() - (orderIndex * 1000);
}

function findPlaylistVideos() {
  console.log('[DEBUG] プレイリスト動画検索開始');

  const videoElements = document.querySelectorAll('#contents ytd-playlist-video-renderer');
  console.log(`[DEBUG] プレイリスト動画要素数: ${videoElements.length}`);

  const videos = [];

  for (let i = 0; i < videoElements.length; i++) {
    const videoElement = videoElements[i];

    const linkElement = videoElement.querySelector('a#video-title[href*="/watch?v="]');
    if (!linkElement) {
      console.log(`[DEBUG] 動画${i}: リンク要素が見つかりません`);
      continue;
    }

    let videoUrl = linkElement.href;

    if (videoUrl.includes('/shorts/')) {
      videoUrl = videoUrl.replace('/shorts/', '/watch?v=');
      console.log(`[DEBUG] ショート動画を通常動画に変換: ${videoUrl}`);
    }

    videos.push({
      url: videoUrl,
      timestamp: i
    });

    console.log(`[DEBUG] 動画${i}: ${videoUrl}`);
  }

  console.log(`[DEBUG] プレイリスト動画検索完了 - 合計: ${videos.length}本`);

  return videos;
}

function findUnwatchedVideos() {
  // ページ制限: 未視聴動画検索は登録チャンネルページでのみ動作
  const allowedPages = [
    '/feed/subscriptions',    // 登録チャンネルページ（メイン対象）
    '/feed/subscriptions/',   // トレイリングスラッシュ対応
  ];
  
  const currentPath = window.location.pathname;
  const isAllowedPage = allowedPages.some(page => currentPath === page || currentPath.startsWith(page));
  
  if (!isAllowedPage) {
    console.log(`[DEBUG] 未視聴動画検索スキップ: 対象外ページ (${currentPath})`);
    console.log(`[INFO] 未視聴動画オープナーは登録チャンネルページ（/feed/subscriptions）でのみ動作します。`);
    return []; // 対象外のページでは空配列を返す
  }
  
  console.log(`[DEBUG] 未視聴動画検索実行: 対象ページ (${currentPath})`);
  
  // ハイライト機能と統一したセレクタを使用
  const videoElements = document.querySelectorAll('#contents ytd-rich-item-renderer');
  
  console.log(`[DEBUG] 未視聴動画検索開始 - 要素数: ${videoElements.length}`);
  
  const unwatchedVideos = [];
  let totalElements = videoElements.length;
  let shortsExcluded = 0;
  let scheduledExcluded = 0;
  let liveExcluded = 0;
  let premiereExcluded = 0;
  let regularVideosFound = 0;

  for (const videoElement of videoElements) {
    // 新しい統一判定ロジックを使用
    const status = getSimpleVideoStatus(videoElement);
    debugLogController.log(`[DEBUG] 動画要素判定: ${status}`);

    // 配信予定、視聴済み動画（プレミア・LIVE・ショート）を除外
    if (status === 'shorts-watched') {
      shortsExcluded++;
      console.log('[DEBUG] 視聴済みショート動画を除外');
      continue;
    }

    if (status === 'scheduled') {
      scheduledExcluded++;
      console.log('[DEBUG] 配信予定動画を除外');
      continue;
    }

    if (status === 'live-watched') {
      liveExcluded++;
      console.log('[DEBUG] 視聴済みライブ動画を除外');
      continue;
    }

    if (status === 'premiere-watched') {
      premiereExcluded++;
      console.log('[DEBUG] 視聴済みプレミア動画を除外');
      continue;
    }

    // 未視聴動画、未視聴LIVE動画、プレミア動画を対象とする
    // ショート動画は設定に応じて含める
    const includeThisStatus = status === 'unwatched' || status === 'live' || status === 'premiere' ||
                             (settings.includeShorts && (status === 'shorts-unwatched' || status === 'shorts'));
    
    debugLogController.log(`[DEBUG] includeThisStatus: ${includeThisStatus}, settings.includeShorts: ${settings.includeShorts}, status: ${status}`);
    
    if (includeThisStatus) {
      const url = getVideoUrl(videoElement);
      debugLogController.log(`[DEBUG] URL取得結果: ${url}`);
      
      // URLが有効であることを確認（ショート動画も含める）
      if (url) {
        regularVideosFound++;
        const videoType = status === 'live' ? 'LIVE' :
                          status === 'premiere' ? 'プレミア' :
                          (status === 'shorts-unwatched' || status === 'shorts') ? 'ショート' : '通常';
        console.log(`[DEBUG] 未視聴${videoType}動画を追加: ${url}`);
        unwatchedVideos.push({
          url: url,
          timestamp: getVideoTimestamp(videoElement),
          element: videoElement,
          type: status
        });
      }
    }
  }
  
  console.log(`[DEBUG] 検索結果 - 合計要素: ${totalElements}, 視聴済みショート除外: ${shortsExcluded}, 配信予定除外: ${scheduledExcluded}, 視聴済みライブ除外: ${liveExcluded}, 視聴済みプレミア除外: ${premiereExcluded}, 未視聴動画（LIVE・プレミア・ショート含む): ${regularVideosFound}`);
  
  return unwatchedVideos.sort((a, b) => a.timestamp - b.timestamp);
}

function openUnwatchedVideos() {
  if (!settings.enabled) {
    return;
  }

  const currentPath = window.location.pathname;
  const urlParams = new URLSearchParams(window.location.search);
  const isWatchLaterPlaylist = currentPath === '/playlist' && urlParams.get('list') === 'WL';

  let videos;
  let messagePrefix;

  if (isWatchLaterPlaylist) {
    console.log('[DEBUG] 後で見るリストページで動画を開きます');
    videos = findPlaylistVideos();
    messagePrefix = 'YouTube後で見るオープナー';
  } else {
    console.log('[DEBUG] 登録チャンネルページで未視聴動画を開きます');
    videos = findUnwatchedVideos();
    messagePrefix = 'YouTube未視聴動画オープナー';
  }

  const videosToOpen = videos.slice(0, settings.videoCount);

  if (videosToOpen.length === 0) {
    console.log(`${messagePrefix}: 動画が見つかりませんでした`);
    return;
  }

  const videoUrls = videosToOpen.map(video => video.url);
  const uniqueUrls = [...new Set(videoUrls)];

  if (uniqueUrls.length === 0) {
    console.log(`${messagePrefix}: 有効な動画が見つかりませんでした`);
    return;
  }

  console.log(`${messagePrefix}: ${uniqueUrls.length}本の動画を開きます`);

  uniqueUrls.forEach(url => {
    console.log(`開くURL: ${url}`);
    // 視聴履歴に即座に追加
    watchHistoryManager.addToHistory(url);
    
    browserAPI.runtime.sendMessage({
      action: 'openTab',
      url: url
    });
  });
}

document.addEventListener('keydown', function(event) {
  if (event.target.tagName === 'INPUT' || 
      event.target.tagName === 'TEXTAREA' || 
      event.target.isContentEditable) {
    return;
  }
  
  if (isMatchingShortcut(event, settings.shortcutKey)) {
    event.preventDefault();
    const currentPath = window.location.pathname;
    const urlParams = new URLSearchParams(window.location.search);
    const isWatchLaterPlaylist = currentPath === '/playlist' && urlParams.get('list') === 'WL';

    if (currentPath === '/feed/subscriptions' || isWatchLaterPlaylist) {
      openUnwatchedVideos();
    }
  }
  
  if (isMatchingShortcut(event, settings.highlightToggleKey)) {
    event.preventDefault();
    toggleHighlighting();
  }
  
  if (isMatchingShortcut(event, settings.watchLaterKey)) {
    event.preventDefault();
    if ((window.location.pathname.startsWith('/watch') || window.location.pathname.startsWith('/shorts')) &&
        window.location.pathname !== '/') {
      savedFocusBeforePlaylistPanel = document.activeElement;
      toggleWatchLater();
    }
  }
  
  // 視聴済み履歴への保存（+キー）
  if (event.key === '+') {
    event.preventDefault();
    if ((window.location.pathname.startsWith('/watch') || window.location.pathname.startsWith('/shorts')) && 
        window.location.pathname !== '/') {
      const success = watchHistoryManager.addToHistory(window.location.href);
      if (success) {
        console.log('[視聴履歴] +キーで視聴済みに登録しました');
      }
    }
  }
  
  if (event.key === 'p' && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    if ((window.location.pathname.startsWith('/watch') || window.location.pathname.startsWith('/shorts')) && 
        window.location.pathname !== '/') {
      console.log('[pキー] プレイリストパネル再配置を実行');
      createPlaylistPanel();
    }
  }
});

browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getUnwatchedCount') {
    if (window.location.pathname === '/feed/subscriptions') {
      const unwatchedVideos = findUnwatchedVideos();
      sendResponse({ count: unwatchedVideos.length });
    } else {
      sendResponse({ count: 0 });
    }
  }
});

function injectCSS() {
  if (!document.getElementById('youtube-unwatched-opener-styles')) {
    const link = document.createElement('link');
    link.id = 'youtube-unwatched-opener-styles';
    link.rel = 'stylesheet';
    link.href = browserAPI.runtime.getURL('highlight.css');
    document.head.appendChild(link);
  }
}

function getVideoStatus(videoElement) {
  // まず履歴チェックを追加（最優先）
  const url = getVideoUrl(videoElement);
  if (url && watchHistoryManager.isUrlWatched(url)) {
    if (settings.debugMode) {
      debugLogController.log(`[DEBUG] 履歴に存在する動画のため視聴済みと判定: ${url}`);
    }
    return 'watched';
  }

  const isLive = checkIsLive(videoElement);
  const isPremiere = checkIsPremiere(videoElement);
  const isScheduled = checkIsScheduled(videoElement);
  const isUnwatched = isUnwatchedVideo(videoElement);
  
  // デバッグ情報: 各判定結果を出力
  if (settings.debugMode) {
    debugLogController.log(`[DEBUG] 動画ステータス判定: Live=${isLive}, Premiere=${isPremiere}, Scheduled=${isScheduled}, Unwatched=${isUnwatched}`);
  }
  
  // 優先度ベースの排他的ステータス決定システム
  // 1. ライブ配信は最高優先度（現在配信中の動画）
  if (isLive) {
    // ライブ配信で視聴済みかどうかを判定
    if (!isUnwatched) {
      if (settings.debugMode) {
        debugLogController.log(`[DEBUG] ステータス決定: live-watched (ライブ配信 + 視聴済み)`);
      }
      return 'live-watched';
    } else {
      if (settings.debugMode) {
        debugLogController.log(`[DEBUG] ステータス決定: live (ライブ配信 + 未視聴)`);
      }
      return 'live';
    }
  }
  
  // 2. プレミア公開（特別な形式の公開）
  if (isPremiere) {
    if (settings.debugMode) {
      debugLogController.log(`[DEBUG] ステータス決定: premiere (プレミア公開)`);
    }
    return 'premiere';
  }
  
  // 3. 公開予定（未来の動画）
  if (isScheduled) {
    if (settings.debugMode) {
      debugLogController.log(`[DEBUG] ステータス決定: scheduled (公開予定)`);
    }
    return 'scheduled';
  }
  
  // 4. 通常動画の視聴状態判定
  if (isUnwatched) {
    if (settings.debugMode) {
      debugLogController.log(`[DEBUG] ステータス決定: unwatched (未視聴)`);
    }
    return 'unwatched';
  }
  
  // 5. デフォルト: 視聴済み
  if (settings.debugMode) {
    debugLogController.log(`[DEBUG] ステータス決定: watched (視聴済み - デフォルト)`);
  }
  return 'watched';
}

function checkIsLive(videoElement) {
  // 1. 明確なライブバッジの確認
  const liveIndicators = [
    '.badge-style-type-live-now',
    '.ytd-badge-supported-renderer[aria-label*="ライブ"]',
    '.ytd-badge-supported-renderer[aria-label*="LIVE"]',
    '.live-badge',
    
    // 新YouTube構造のライブバッジ対応（2025-09-04追加）
    'yt-thumbnail-overlay-badge-view-model',     // 新しいライブオーバーレイ
    'yt-thumbnail-badge-view-model',             // 新しいライブバッジ
    '[class*="badge-view-model"]',               // バッジビューモデル系
    '[class*="overlay-badge"]',                  // オーバーレイバッジ系
    
    // 追加のライブ関連要素
    '[aria-label*="Live"]',
    '[aria-label*="ライブ"]',
    '[aria-label*="生放送"]'
  ];
  
  for (const selector of liveIndicators) {
    const element = videoElement.querySelector(selector);
    if (element) {
      const text = element.textContent?.toLowerCase() || '';
      const ariaLabel = element.getAttribute('aria-label')?.toLowerCase() || '';
      
      // より厳格なライブ判定
      if ((text.includes('live') && !text.includes('delivered')) || 
          text.includes('ライブ') || text.includes('生放送') ||
          (ariaLabel.includes('live') && !ariaLabel.includes('delivered')) || 
          ariaLabel.includes('ライブ') || ariaLabel.includes('生放送')) {
        return true;
      }
    }
  }
  
  // 2. 赤色背景のライブ要素を確認
  const liveTextElements = videoElement.querySelectorAll('span, div');
  for (const element of liveTextElements) {
    const text = element.textContent?.trim();
    if (text === 'LIVE' || text === 'ライブ配信中' || text === 'ライブ中' || text === '生放送') {
      const styles = window.getComputedStyle(element);
      // 赤色背景または赤色テキストのライブ表示
      if (styles.backgroundColor.includes('255, 0, 0') || 
          styles.color.includes('255, 0, 0') ||
          styles.backgroundColor.includes('rgb(255, 0, 0)') || 
          styles.color.includes('rgb(255, 0, 0)')) {
        return true;
      }
    }
  }
  
  // 3. ライブストリーミング関連のCSSクラスを確認
  const hasLiveClass = videoElement.querySelector('[class*="live"], [class*="streaming"]');
  if (hasLiveClass) {
    const text = hasLiveClass.textContent?.toLowerCase() || '';
    if (text.includes('live') || text.includes('ライブ')) {
      return true;
    }
  }
  
  return false;
}

function checkIsPremiere(videoElement) {
  // 1. 明確なプレミアバッジの確認
  const premiereIndicators = [
    '.badge-style-type-premiere',
    '.ytd-badge-supported-renderer[aria-label*="プレミア"]',
    '.premiere-badge',
    
    // 新YouTube構造のプレミア関連要素
    '[aria-label*="Premiere"]',
    '[aria-label*="premiere"]',
    '[aria-label*="プレミア"]',
    '[aria-label*="プレミア公開"]',
    '[class*="premiere"]'
  ];
  
  for (const selector of premiereIndicators) {
    const element = videoElement.querySelector(selector);
    if (element) {
      const text = element.textContent?.toLowerCase() || '';
      const ariaLabel = element.getAttribute('aria-label')?.toLowerCase() || '';
      
      // プレミア関連のキーワード検索（より厳格に）
      if (text.includes('premiere') || text.includes('プレミア') || text.includes('プレミア公開') ||
          ariaLabel.includes('premiere') || ariaLabel.includes('プレミア') || ariaLabel.includes('プレミア公開')) {
        return true;
      }
    }
  }
  
  // 2. プレミア関連のテキスト要素を確認
  const premiereTextElements = videoElement.querySelectorAll('span, div');
  for (const element of premiereTextElements) {
    const text = element.textContent?.trim();
    // より具体的なプレミア表示を探す
    if (text === 'PREMIERE' || text === 'Premiere' || text === 'プレミア公開' || text === 'プレミア') {
      return true;
    }
  }
  
  return false;
}

function checkIsScheduled(videoElement) {
  // 1. 明確なスケジュールバッジの確認
  const scheduledIndicators = [
    '.badge-style-type-upcoming',
    '.ytd-badge-supported-renderer[aria-label*="公開予定"]',
    '.ytd-badge-supported-renderer[aria-label*="配信予定"]',
    '.scheduled-badge'
  ];
  
  for (const selector of scheduledIndicators) {
    const element = videoElement.querySelector(selector);
    if (element) {
      const text = element.textContent?.toLowerCase() || '';
      const ariaLabel = element.getAttribute('aria-label')?.toLowerCase() || '';
      
      if (text.includes('公開予定') || text.includes('配信予定') || text.includes('scheduled') ||
          ariaLabel.includes('公開予定') || ariaLabel.includes('配信予定') || ariaLabel.includes('scheduled')) {
        return true;
      }
    }
  }

  // 2. 明確なスケジュール関連のテキスト（動画の長さではない形式）
  const scheduledTextElements = videoElement.querySelectorAll('span, div');
  for (const element of scheduledTextElements) {
    const text = element.textContent?.trim();
    
    // 明確なスケジューリング関連の文言のみチェック
    if (text && (text.includes('公開予定') || text.includes('配信予定') || 
                 text.includes('Scheduled') || text.includes('Upcoming'))) {
      return true;
    }
    
    // 日付形式 (MM/DD, YYYY/MM/DD など) の厳密チェック - ただし動画時間は除外
    const datePattern = /^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}\/\d{1,2}\/\d{1,2})$/;
    const timeOnlyPattern = /^\d{1,2}:\d{2}$/; // 動画の長さ（5:30など）
    
    if (text && datePattern.test(text) && !timeOnlyPattern.test(text)) {
      // 日付形式が見つかった場合、近辺にスケジュール関連の文言があるかチェック
      const surroundingText = (element.parentElement?.textContent || '').toLowerCase();
      if (surroundingText.includes('公開予定') || surroundingText.includes('配信予定') || 
          surroundingText.includes('scheduled') || surroundingText.includes('upcoming')) {
        return true;
      }
    }
  }
  
  // 3. サムネイルオーバーレイでのスケジュール確認
  const thumbnailOverlay = videoElement.querySelector('.ytd-thumbnail-overlay-time-status-renderer');
  if (thumbnailOverlay) {
    const overlayText = thumbnailOverlay.textContent?.toLowerCase() || '';
    if (overlayText.includes('公開予定') || overlayText.includes('scheduled')) {
      return true;
    }
  }
  
  return false;
}

function applyHighlightToVideo(videoElement) {
  // 短時間での重複処理を防ぐチェック
  const currentTime = Date.now();
  const lastProcessed = videoElement.dataset.lastHighlightProcessed;
  
  if (lastProcessed && (currentTime - parseInt(lastProcessed)) < 500) {
    debugLogController.log(`[DEBUG] 重複ハイライト処理をスキップ (${currentTime - parseInt(lastProcessed)}ms前に処理済み)`);
    return;
  }
  
  const status = getVideoStatus(videoElement);
  
  // 現在のステータスと同じ場合はスキップ（不要な処理を避ける）
  const currentStatus = videoElement.dataset.currentHighlightStatus;
  if (currentStatus === status) {
    debugLogController.log(`[DEBUG] 同一ステータス (${status}) のため処理をスキップ`);
    return;
  }
  
  // 動画タイトル取得（isUnwatchedVideo関数と統一されたロジック）
  const titleSelectors = [
    '#video-title', '.ytd-rich-grid-media #video-title', 'a[title]', '.video-title',
    'h3', 'a[href*="/watch"] span', 'a[href*="/watch"]', '[class*="title"]'
  ];
  
  let titleElement = null;
  let videoTitle = 'タイトル取得不可';
  
  for (const selector of titleSelectors) {
    titleElement = videoElement.querySelector(selector);
    if (titleElement) {
      videoTitle = titleElement.textContent?.trim() || titleElement.title || titleElement.getAttribute('aria-label') || '';
      if (videoTitle && videoTitle.length > 0) {
        break;
      }
    }
  }
  
  if (!videoTitle || videoTitle === '') {
    videoTitle = 'タイトル不明';
  }
  
  const linkElement = videoElement.querySelector('a[href*="/watch"]');
  const videoUrl = linkElement ? linkElement.href : '動画URL不明';
  
  debugLogController.log(`[DEBUG] 動画ハイライト適用: "${videoTitle.substring(0, 30)}" - ステータス: ${status} (前回: ${currentStatus || 'なし'})`);
  
  // 全てのハイライトクラスを削除
  videoElement.classList.remove(
    'youtube-unwatched-opener-unwatched',
    'youtube-unwatched-opener-live',
    'youtube-unwatched-opener-watched',
    'youtube-unwatched-opener-premiere',
    'youtube-unwatched-opener-live-watched',
    'youtube-unwatched-opener-scheduled'
  );
  
  // ステータスに応じて適切なクラスを追加
  switch (status) {
    case 'unwatched':
      videoElement.classList.add('youtube-unwatched-opener-unwatched');
      debugLogController.log(`[DEBUG] 未視聴ハイライト適用: "${videoTitle.substring(0, 30)}"`);
      break;
    case 'live':
      videoElement.classList.add('youtube-unwatched-opener-live');
      debugLogController.log(`[DEBUG] ライブハイライト適用: "${videoTitle.substring(0, 30)}"`);
      break;
    case 'live-watched':
      videoElement.classList.add('youtube-unwatched-opener-live-watched');
      debugLogController.log(`[DEBUG] 視聴済みライブハイライト適用: "${videoTitle.substring(0, 30)}"`);
      break;
    case 'premiere':
      videoElement.classList.add('youtube-unwatched-opener-premiere');
      debugLogController.log(`[DEBUG] プレミアハイライト適用: "${videoTitle.substring(0, 30)}"`);
      break;
    case 'scheduled':
      videoElement.classList.add('youtube-unwatched-opener-scheduled');
      debugLogController.log(`[DEBUG] 公開予定（非表示）適用: "${videoTitle.substring(0, 30)}"`);
      break;
    case 'watched':
      videoElement.classList.add('youtube-unwatched-opener-watched');
      debugLogController.log(`[DEBUG] 視聴済み（非表示）適用: "${videoTitle.substring(0, 30)}"`);
      break;
  }
  
  // 処理済みフラグを更新
  videoElement.dataset.lastHighlightProcessed = currentTime.toString();
  videoElement.dataset.currentHighlightStatus = status;
}

function updateHighlighting() {
  // 破綻したハイライト処理を無効化
  // TODO: 新しいシンプルなハイライト機能に置き換え予定
  if (settings.highlightEnabled) {
    document.body.classList.remove('youtube-unwatched-opener-highlight-disabled');
    applySimpleHighlighting();
  } else {
    document.body.classList.add('youtube-unwatched-opener-highlight-disabled');
  }
}

// YouTube構造変更時の情報収集関数
function outputYouTubeStructureInfo() {
  console.log('============= YouTube構造変更診断情報 =============');
  console.log('拡張機能：YouTube未視聴動画オープナー');
  console.log('日付:', new Date().toISOString());
  console.log('URL:', window.location.href);
  console.log('User Agent:', navigator.userAgent);
  
  // 基本的なYouTube要素の存在確認
  const basicElements = [
    'ytd-app',
    'ytd-page-manager', 
    '#contents',
    '#primary',
    '#secondary',
    'ytd-browse',
    'ytd-two-column-browse-results-renderer'
  ];
  
  console.log('\n--- 基本YouTube要素の存在確認 ---');
  basicElements.forEach(selector => {
    const elements = document.querySelectorAll(selector);
    console.log(`${selector}: ${elements.length}個`);
    if (elements.length > 0) {
      console.log(`  - 最初の要素のクラス:`, elements[0].className);
    }
  });
  
  // 動画関連要素の調査
  const videoSelectors = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer', 
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-playlist-video-renderer',
    'ytd-reel-item-renderer',
    '[class*="video"]',
    '[class*="rich"]',
    '[class*="item-renderer"]'
  ];
  
  console.log('\n--- 動画関連要素の調査 ---');
  videoSelectors.forEach(selector => {
    const elements = document.querySelectorAll(selector);
    console.log(`${selector}: ${elements.length}個`);
    
    if (elements.length > 0 && elements.length <= 3) {
      // 3個以下の場合、詳細情報を出力
      Array.from(elements).forEach((el, index) => {
        console.log(`  [${index}] クラス:`, el.className);
        console.log(`  [${index}] タグ:`, el.tagName);
        console.log(`  [${index}] 内容(50文字):`, el.textContent?.substring(0, 50) || 'なし');
      });
    }
  });
  
  // コンテンツエリアの調査
  const contentsArea = document.querySelector('#contents');
  if (contentsArea) {
    console.log('\n--- #contents エリア内の要素調査 ---');
    const childElements = Array.from(contentsArea.children);
    childElements.forEach((child, index) => {
      console.log(`子要素[${index}]:`, child.tagName, child.className);
      if (index < 5) { // 最初の5つの子要素のみ詳細出力
        const grandChildren = Array.from(child.children);
        grandChildren.slice(0, 3).forEach((grandChild, gIndex) => {
          console.log(`  孫要素[${gIndex}]:`, grandChild.tagName, grandChild.className.substring(0, 50));
        });
      }
    });
  }
  
  // 新しい可能性のある要素パターンを探索
  console.log('\n--- 新しい可能性のある要素パターン ---');
  const potentialNewPatterns = [
    '[data-testid*="video"]',
    '[aria-label*="video"]', 
    '[role="article"]',
    '[role="listitem"]',
    '.video-renderer',
    '.rich-item',
    '[class*="2025"]',
    '[class*="thumbnail"]'
  ];
  
  potentialNewPatterns.forEach(selector => {
    const elements = document.querySelectorAll(selector);
    if (elements.length > 0) {
      console.log(`${selector}: ${elements.length}個 - 有望な候補`);
      if (elements.length <= 2) {
        Array.from(elements).forEach((el, index) => {
          console.log(`  [${index}] クラス:`, el.className.substring(0, 100));
        });
      }
    }
  });
  
  // 未視聴インジケーターの調査
  console.log('\n--- 未視聴インジケーター調査 ---');
  const unwatchedPatterns = [
    '[style*="blue"]',
    '[style*="#065fd4"]',
    '[style*="rgb(6, 95, 212)"]', 
    '.badge',
    '[class*="badge"]',
    '[class*="notification"]',
    '[aria-label*="未視聴"]',
    '[aria-label*="unwatched"]'
  ];
  
  unwatchedPatterns.forEach(selector => {
    const elements = document.querySelectorAll(selector);
    if (elements.length > 0) {
      console.log(`${selector}: ${elements.length}個`);
    }
  });
  
  console.log('\n============= 診断情報終了 =============');
  console.log('この情報を拡張機能の開発者に提供してください。');
  console.log('GitHub Issues: https://github.com/your-repo/youtube-unwatched-opener/issues');
  console.log('\n手動で診断を実行する場合は、コンソールで以下を実行:');
  console.log('YouTubeUnwatchedOpener.diagnose()');
}

function initializeHighlighting() {
  injectCSS();
  updateHighlighting();
  
  // ハイライト専用Observerは削除 - メインObserverに統合済み
  // 重複実行を防ぐためコメントアウト
}

function toggleHighlighting() {
  settings.highlightEnabled = !settings.highlightEnabled;
  browserAPI.storage.sync.set({ highlightEnabled: settings.highlightEnabled });
  updateHighlighting();

  const status = settings.highlightEnabled ? 'ON' : 'OFF';
  console.log(`YouTube未視聴動画オープナー: ハイライト機能を${status}にしました`);
}

// ============================================================
// プレイリストパネル ユーティリティ
// ============================================================

// プレイリストパネルの DOM id
const PANEL_ID = 'youtube-unwatched-opener-playlist-panel';

// パネル状態管理: panel要素 → { originalDialog, syncObserver, bodyObserver }
const playlistPanelState = new WeakMap();

// ダイアログ検索セレクタ
const PLAYLIST_DIALOG_SELECTORS = [
  '.ytContextualSheetLayoutContentContainer',
  '[class*="ytContextualSheetLayoutContentContainer"]',
  'tp-yt-iron-dropdown',
  'ytd-add-to-playlist-renderer',
  'ytd-popup-container ytd-add-to-playlist-renderer',
  'yt-save-video-to-playlist-modal-view-model',
  '[class*="add-to-playlist"]'
];

// ダイアログの有効性検証
function isValidPlaylistDialog(el) {
  if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const tagName = el.tagName ? el.tagName.toLowerCase() : '';
  if (tagName === 'ytd-add-to-playlist-renderer') {
    return el.children.length > 0 || el.shadowRoot !== null;
  }
  if (tagName === 'tp-yt-iron-dropdown') {
    return el.children.length > 0;
  }
  if (el.querySelector('ytd-add-to-playlist-renderer') !== null) return true;
  if (el.querySelectorAll('tp-yt-paper-checkbox, input[type="checkbox"], [role="checkbox"]').length > 0) return true;
  for (const item of el.getElementsByTagName('toggleable-list-item-view-model')) {
    const t = (item.innerText || '').toLowerCase();
    if (t.includes('watch later') || t.includes('後で見る')) return true;
  }
  return false;
}

// プレイリストダイアログの出現を MutationObserver で待機
// preClickVisible: クリック前から可視だった要素の Set（誤検出防止）
function waitForPlaylistDialog(timeout = 8000, preClickVisible = new Set()) {
  const isNew = (el) => !preClickVisible.has(el) && isValidPlaylistDialog(el);
  return new Promise((resolve, reject) => {
    for (const sel of PLAYLIST_DIALOG_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (isNew(el)) return resolve(el);
      }
    }
    const obs = new MutationObserver(() => {
      for (const sel of PLAYLIST_DIALOG_SELECTORS) {
        for (const el of document.querySelectorAll(sel)) {
          if (isNew(el)) {
            obs.disconnect();
            clearTimeout(timer);
            resolve(el);
            return;
          }
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      obs.disconnect();
      reject(new Error('waitForPlaylistDialog timeout'));
    }, timeout);
  });
}

// パネル表示用のクローンを生成しスタイルを適用
function buildStyledClone(originalDialog) {
  const clone = originalDialog.cloneNode(true);
  clone.style.position = 'static';
  clone.style.top = 'auto';
  clone.style.left = 'auto';
  clone.style.zIndex = 'auto';
  clone.style.transform = 'none';
  clone.style.margin = '0';
  clone.style.maxHeight = '640px';
  clone.style.background = 'var(--yt-spec-base-background)';
  clone.style.border = '1px solid var(--yt-spec-10-percent-layer)';
  clone.style.borderRadius = '8px';
  clone.style.boxShadow = 'none';
  clone.style.opacity = '1';
  clone.style.pointerEvents = 'auto';
  clone.querySelectorAll('[autofocus]').forEach(el => el.removeAttribute('autofocus'));
  const closeBtn = clone.querySelector(
    '#close-button, button[aria-label*="閉じる"], button[aria-label*="Close"]'
  );
  if (closeBtn) closeBtn.style.display = 'none';
  return clone;
}

// クローン内クリックをオリジナルダイアログの対応要素に転送
// cloneNode(true) でクローンとオリジナルは完全一致の構造を持つため
// querySelectorAll('*') のインデックスで対応要素を特定する
function forwardClickToOriginal(event, originalDialog) {
  const clone = event.currentTarget;
  const clickedEl = event.target;

  // クローン全要素（ルート含む）でインデックスを特定
  const cloneEls = [clone, ...Array.from(clone.querySelectorAll('*'))];
  const idx = cloneEls.indexOf(clickedEl);

  if (idx === -1) return;

  // オリジナルの同インデックス要素をクリック
  const originalEls = [originalDialog, ...Array.from(originalDialog.querySelectorAll('*'))];
  const originalTarget = originalEls[idx];

  if (!originalTarget) return;

  event.preventDefault();
  event.stopPropagation();
  console.log(`[クリック転送] idx=${idx} ${clickedEl.tagName} → ${originalTarget.tagName}`);
  // Shadow DOM 内の対話要素を優先してクリック
  const shadowBtn = originalTarget.shadowRoot &&
    originalTarget.shadowRoot.querySelector('button, [role="checkbox"], input, tp-yt-paper-checkbox, yt-checkbox-shape');
  const childBtn = originalTarget.querySelector('button, [role="checkbox"], input, tp-yt-paper-checkbox, yt-checkbox-shape');
  (shadowBtn || childBtn || originalTarget).click();
}

// オリジナルダイアログの変化を監視してクローンを自動更新
function setupCloneSync(panel, originalDialog) {
  const container = panel.querySelector('.playlist-dialog-container');
  let syncTimeout = null;
  const doSync = () => {
    if (!document.contains(panel)) return;
    const newClone = buildStyledClone(originalDialog);
    newClone.addEventListener('click', (e) => forwardClickToOriginal(e, originalDialog));
    container.innerHTML = '';
    container.appendChild(newClone);
  };
  const syncObserver = new MutationObserver(() => {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(doSync, 150);
  });
  syncObserver.observe(originalDialog, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-checked', 'checked', 'class']
  });
  // オリジナルが DOM から消えた場合は再取得
  // subtree: true で ytd-popup-container 内部の削除も検知する
  const bodyObserver = new MutationObserver(() => {
    if (!document.contains(originalDialog)) {
      bodyObserver.disconnect();
      syncObserver.disconnect();
      if (document.contains(panel)) embedPlaylistDialog(panel);
    }
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });
  return { syncObserver, bodyObserver };
}

// クローンをパネルにマウント。オリジナルは元の DOM 位置のままオフスクリーンに保持
// (DOM 移動すると Polymer の disconnectedCallback/connectedCallback が発火し
//  内部バインディングがリセットされてクリックが機能しなくなるため移動しない)
function mountDialogClone(panel, originalDialog) {
  const container = panel.querySelector('.playlist-dialog-container');
  // オリジナルを元の位置のままオフスクリーンに隠す
  // pointer-events は設定しない（none にするとカスタム要素の内部クリック処理が阻害される）
  originalDialog.style.position = 'fixed';
  originalDialog.style.left = '-9999px';
  originalDialog.style.top = '-9999px';
  originalDialog.style.opacity = '0';
  // オーバーレイ（背景暗転）を削除
  document.querySelectorAll('tp-yt-iron-overlay-backdrop, iron-overlay-backdrop, .scrim')
    .forEach(el => el.remove());
  // クローンを生成してパネルにマウント
  const clone = buildStyledClone(originalDialog);
  clone.addEventListener('click', (e) => forwardClickToOriginal(e, originalDialog));
  container.innerHTML = '';
  container.appendChild(clone);
  // 同期機構を開始して状態を保存
  const { syncObserver, bodyObserver } = setupCloneSync(panel, originalDialog);
  playlistPanelState.set(panel, { originalDialog, syncObserver, bodyObserver });
  // フォーカスを元の要素に戻す
  setTimeout(() => {
    if (savedFocusBeforePlaylistPanel && document.contains(savedFocusBeforePlaylistPanel)) {
      savedFocusBeforePlaylistPanel.focus();
    } else {
      document.body.focus();
    }
    savedFocusBeforePlaylistPanel = null;
  }, 0);
  console.log('[SUCCESS] プレイリストパネル: クローンのマウントが完了しました');
}

// パネル削除時のクリーンアップ（Observer 停止・オリジナル非表示）
function teardownPlaylistPanel(panel) {
  const state = playlistPanelState.get(panel);
  if (!state) return;
  const { originalDialog, syncObserver, bodyObserver } = state;
  if (syncObserver) syncObserver.disconnect();
  if (bodyObserver) bodyObserver.disconnect();
  if (panel._fallbackObserver) {
    panel._fallbackObserver.disconnect();
    panel._fallbackObserver = null;
  }
  // オリジナルダイアログのスタイルをリセットして YouTube の閉じる機構で閉じる
  if (originalDialog && document.contains(originalDialog)) {
    originalDialog.style.position = '';
    originalDialog.style.left = '';
    originalDialog.style.top = '';
    originalDialog.style.opacity = '';
    // 閉じるボタンをクリックして YouTube 側の状態を正常にクローズ
    const closeBtn = originalDialog.querySelector(
      '#close-button button, button[aria-label*="閉じる"], button[aria-label*="Close"], button[aria-label*="Cancel"]'
    );
    if (closeBtn) {
      closeBtn.click();
    } else {
      originalDialog.style.display = 'none';
    }
  }
  playlistPanelState.delete(panel);
}

// 直接表示の保存ボタンを検索
function findDirectSaveButton() {
  const selectors = [
    'button[aria-label*="Watch later"]',
    'button[aria-label*="Save"]',
    'button[aria-label*="保存"]',
    '#actions button[aria-label*="Watch later"]',
    '#actions button[aria-label*="Save"]',
    '#actions button[aria-label*="保存"]',
    '#top-level-buttons button[aria-label*="Watch later"]',
    '#top-level-buttons button[aria-label*="Save"]',
    '#top-level-buttons button[aria-label*="保存"]',
    'ytd-button-renderer button[aria-label*="Watch later"]',
    'ytd-button-renderer button[aria-label*="Save"]',
    'ytd-button-renderer button[aria-label*="保存"]'
  ];
  for (const selector of selectors) {
    for (const button of document.querySelectorAll(selector)) {
      const label = (button.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('保存') || label.includes('save') ||
          label.includes('watch later') || label.includes('watchlater')) {
        return button;
      }
    }
  }
  return null;
}

// 「その他の操作」メニューボタンを検索
function findPlaylistMenuButton() {
  const selectors = [
    '#actions button[aria-label*="その他"]',
    '#actions button[aria-label*="More"]',
    '#top-level-buttons button[aria-label*="その他"]',
    '#top-level-buttons button[aria-label*="More"]',
    'button[aria-label*="その他の操作"]',
    'button[aria-label*="More actions"]',
    'ytd-menu-renderer button',
    'ytd-button-renderer button[aria-label*="その他"]',
    'ytd-button-renderer button[aria-label*="More"]'
  ];
  for (const selector of selectors) {
    for (const button of document.querySelectorAll(selector)) {
      const label = (button.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('その他') || label.includes('more')) {
        return button;
      }
    }
  }
  return null;
}

// クリック前に可視状態の tp-yt-iron-dropdown を記録（誤検出防止）
function getVisibleDropdowns() {
  return new Set(
    Array.from(document.querySelectorAll('tp-yt-iron-dropdown')).filter(el =>
      el.offsetWidth > 0 && el.offsetHeight > 0 &&
      window.getComputedStyle(el).display !== 'none'
    )
  );
}

// 保存ボタンをクリックしてプレイリストダイアログを取得して返す
async function findAndClickSaveButton() {
  // ytd-watch-metadata の #actions にアクションボタンが揃うまで待機
  await waitForElement('ytd-watch-metadata', {
    timeout: 10000,
    contentCheck: (el) => {
      const actions = el.querySelector('#actions');
      return actions !== null && actions.querySelector('button[aria-label]') !== null;
    }
  }).catch(() => {}); // タイムアウト時も続行

  // 直接保存ボタン経由
  const directBtn = findDirectSaveButton();
  if (directBtn) {
    console.log(`[INFO] プレイリストパネル: 直接保存ボタン発見 (aria-label: "${directBtn.getAttribute('aria-label')}")`);
    const preClick = getVisibleDropdowns();
    savedFocusBeforePlaylistPanel = document.activeElement;
    directBtn.click();
    return waitForPlaylistDialog(8000, preClick);
  }

  console.log('[WARNING] プレイリストパネル: 直接保存ボタンが見つかりません。メニュー経由を試行');

  // メニュー経由
  const menuBtn = findPlaylistMenuButton();
  if (menuBtn) {
    console.log(`[INFO] プレイリストパネル: メニューボタン発見 (aria-label: "${menuBtn.getAttribute('aria-label')}")`);
    menuBtn.click();
    const menuSaveItem = await waitForElement(
      'menuitem, [role="menuitem"], ytd-menu-service-item-renderer, ytd-menu-navigation-item-renderer, tp-yt-paper-item, yt-formatted-string',
      {
        timeout: 3000,
        contentCheck: (el) => {
          const text = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
          return text.includes('保存') || text.includes('save') ||
                 text.includes('watch later') || text.includes('watchlater');
        }
      }
    );
    console.log('[INFO] プレイリストパネル: メニュー内保存項目発見');
    savedFocusBeforePlaylistPanel = document.activeElement;
    menuSaveItem.click();
    return waitForPlaylistDialog(8000);
  }

  throw new Error('保存ボタンもメニューボタンも見つかりませんでした');
}

// エラー表示と再試行ボタン、フォールバック Observer の設定
function showPanelError(panel, message) {
  const container = panel.querySelector('.playlist-dialog-container');
  container.innerHTML = `
    <div class="error-message">
      ${message}
      <button class="retry-button" id="playlist-retry-btn">再試行</button>
    </div>
  `;
  const retryBtn = container.querySelector('#playlist-retry-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => embedPlaylistDialog(panel));
  }
  // ユーザーが手動で保存ボタンをクリックした場合のフォールバック
  if (panel._fallbackObserver) panel._fallbackObserver.disconnect();
  const fallbackObserver = new MutationObserver(() => {
    for (const sel of PLAYLIST_DIALOG_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (isValidPlaylistDialog(el)) {
          fallbackObserver.disconnect();
          panel._fallbackObserver = null;
          mountDialogClone(panel, el);
          return;
        }
      }
    }
  });
  fallbackObserver.observe(document.body, { childList: true, subtree: true });
  panel._fallbackObserver = fallbackObserver;
}

// 共通のダイアログ操作関数
function handlePlaylistDialog(action = 'toggle') {
  console.log(`[ダイアログ操作] アクション: ${action} を開始`);
  const savedFocus = document.activeElement;

  const dialogSelector =
    'ytd-add-to-playlist-renderer, ' +
    'tp-yt-paper-dialog, ' +
    '[role="dialog"], ' +
    '#dialog, ' +
    '.ytContextualSheetLayoutContentContainer, ' +
    '#youtube-unwatched-opener-playlist-panel .playlist-dialog-container';

  waitForElement(dialogSelector, {
    timeout: 5000,
    contentCheck: (el) => el.offsetWidth > 0 && el.offsetHeight > 0
  })
  .then(dialog => {
    console.log(`[ダイアログ操作] ダイアログ発見: <${dialog.tagName}>`);

    // チェックボックスを探す
    const checkboxes = dialog.querySelectorAll(
      'tp-yt-paper-checkbox, ' +
      'input[type="checkbox"], ' +
      '[role="checkbox"], ' +
      'ytd-playlist-add-to-option-renderer, ' +
      'div[role="option"], ' +
      'yt-formatted-string, ' +
      '.yt-formatted-string, ' +
      'yt-list-item-view-model, ' +
      'toggleable-list-item-view-model'
    );
    console.log(`[ダイアログ操作] チェックボックス/候補要素数: ${checkboxes.length}`);

    let targetCheckbox = null;

    for (const cb of checkboxes) {
      const text = (cb.textContent || cb.getAttribute('aria-label') || '').toLowerCase().trim();

      if (text === '後で見る' || text === 'watch later' || text === 'watchlater' || text === 'wl' || text === 'あとで見る' ||
          (text.includes('後で見る') && text.length < 20) ||
          (text.includes('watch later') && text.length < 20)) {

        console.log(`[ダイアログ操作] 候補チェック(一致): "${text}" in <${cb.tagName}>`);

        if (cb.tagName.toLowerCase() === 'ytd-playlist-add-to-option-renderer') {
          targetCheckbox = cb;
        } else {
          const parentRenderer = cb.closest('ytd-playlist-add-to-option-renderer');
          targetCheckbox = parentRenderer || cb;
        }
        break;
      }
    }

    if (targetCheckbox) {
      console.log('[ダイアログ操作] 後で見るチェックボックスを発見');

      if (action === 'toggle') {
        const clickable = targetCheckbox.querySelector('yt-list-item-view-model') || targetCheckbox.querySelector('#checkbox') || targetCheckbox.querySelector('input') || targetCheckbox;
        clickable.click();
        console.log(`[ダイアログ操作] トグル実行: <${clickable.tagName}>`);
      } else if (action === 'remove') {
        const isChecked = targetCheckbox.getAttribute('aria-checked') === 'true' ||
                          targetCheckbox.checked === true ||
                          targetCheckbox.querySelector('[checked]') !== null;
        if (isChecked) {
          targetCheckbox.click();
          console.log('[ダイアログ操作] 削除実行（チェック解除）');
        } else {
          console.log('[ダイアログ操作] 既に未チェックのため何もしません');
        }
      }

      // クリック後即時クローズ（500ms待機を廃止）
      const closeBtn = dialog.querySelector('#close-button, button[aria-label*="Close"], button[aria-label*="閉じる"]');
      if (closeBtn) closeBtn.click();
      else document.body.click();

      // フォーカス復帰
      if (savedFocus && document.contains(savedFocus)) savedFocus.focus();
    } else {
      console.log('[ダイアログ操作] ダイアログ内に後で見るチェックボックスが見つかりません');
    }
  })
  .catch(() => {
    console.log('[ダイアログ操作] ダイアログが見つかりません（タイムアウト）');
  });
}

function toggleWatchLater() {
  console.log('[後で見る切り替え] toggleWatchLater関数開始');
  
  // 1. プレイリストパネルがある場合はオリジナルダイアログを直接操作
  const playlistPanel = document.getElementById(PANEL_ID);
  if (playlistPanel) {
    console.log('[後で見る切り替え] プレイリストパネルを検出');
    const state = playlistPanelState.get(playlistPanel);
    if (state && state.originalDialog && document.contains(state.originalDialog)) {
      const itemSelectors =
        'ytd-playlist-add-to-option-renderer, yt-list-item-view-model, toggleable-list-item-view-model';
      const items = state.originalDialog.querySelectorAll(itemSelectors);
      console.log(`[後で見る切り替え] オリジナルダイアログ内の項目数: ${items.length}`);
      for (const item of items) {
        const text = (item.textContent || item.getAttribute('aria-label') || '').toLowerCase();
        if (text.includes('後で見る') || text.includes('watch later') ||
            text.includes('watchlater') || text.includes('wl') || text.includes('あとで見る')) {
          console.log(`[後で見る切り替え] オリジナルダイアログの項目をクリック: ${item.tagName}`);
          // Shadow DOM 内のボタン/チェックボックスを優先してクリック
          const shadowBtn = item.shadowRoot &&
            item.shadowRoot.querySelector('button, [role="checkbox"], input, tp-yt-paper-checkbox, yt-checkbox-shape');
          const childBtn = item.querySelector('button, [role="checkbox"], input, tp-yt-paper-checkbox, yt-checkbox-shape');
          (shadowBtn || childBtn || item).click();
          // setupCloneSync の MutationObserver が自動でクローンを更新する
          return;
        }
      }
      console.log('[後で見る切り替え] オリジナルダイアログ内に後で見る項目が見つかりませんでした');
    } else {
      console.log('[後で見る切り替え] パネルはあるがオリジナルダイアログへの参照がありません');
    }
  } else {
    console.log('[後で見る切り替え] プレイリストパネルが見つかりません');
  }

  // 2. 直接表示されている「保存」ボタンを探す
  const actionButtons = document.querySelectorAll(
    'ytd-watch-metadata #actions button, ' +
    'ytd-watch-metadata #actions yt-button-shape button, ' + 
    '#actions button, ' +
    '#menu-container button'
  );

  for (const button of actionButtons) {
    const label = (button.getAttribute('aria-label') || button.textContent || '').toLowerCase();
    if (label.includes('保存') || label.includes('save') || (label.includes('watch') && label.includes('later'))) {
      console.log('[後で見る切り替え] 直接表示の保存ボタンをクリック');
      button.click();
      handlePlaylistDialog('toggle');
      return;
    }
  }

  // 3. メニュー（三点リーダー）内の保存ボタンを探す
  const menuButtons = document.querySelectorAll(
    'ytd-watch-metadata #actions button[aria-label*="More"], ' +
    'ytd-watch-metadata #actions button[aria-label*="その他"], ' +
    'button[aria-label*="More actions"], ' +
    'button[aria-label*="その他の操作"], ' +
    '.ytp-menu-button' // プレイヤー内のメニューボタンも候補に
  );

  if (menuButtons.length > 0) {
    console.log('[後で見る切り替え] メニューボタンをクリック');
    let clicked = false;
    for (const btn of menuButtons) {
      if (btn.offsetWidth > 0) {
        btn.click();
        clicked = true;
        break;
      }
    }
    if (!clicked && menuButtons.length > 0) menuButtons[0].click();

    waitForElement('ytd-menu-service-item-renderer, tp-yt-paper-item, ytd-menu-navigation-item-renderer', {
      timeout: 2000,
      contentCheck: (el) => {
        const t = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
        return t.includes('保存') || t.includes('save') || (t.includes('watch') && t.includes('later'));
      }
    })
    .then(item => {
      console.log('[後で見る切り替え] メニュー内の保存項目をクリック');
      item.click();
      handlePlaylistDialog('toggle');
    })
    .catch(() => console.log('[後で見る切り替え] メニュー内に保存項目が見つかりません'));
  } else {
    console.log('[後で見る切り替え] メニューボタンが見つかりませんでした');
  }
}

function createPlaylistPanel() {
  if (!settings.showPlaylistPanel || (!window.location.pathname.startsWith('/watch') && !window.location.pathname.startsWith('/shorts')) || window.location.pathname === '/') {
    return;
  }

  // バックグラウンドタブでは遅延させる
  if (document.visibilityState === 'hidden') {
    document.addEventListener('visibilitychange', function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        setTimeout(() => {
          createPlaylistPanel();
        }, 500);
      }
    });
    return;
  }

  const existingPanel = document.getElementById('youtube-unwatched-opener-playlist-panel');
  if (existingPanel) {
    return;
  }
  
  // より包括的なセレクタでsecondary要素を探す
  const secondarySelectors = [
    '#secondary',
    '#secondary-inner', 
    '#secondary #secondary-inner',
    'div[id="secondary"]',
    'ytd-watch-flexy #secondary',
    'ytd-watch-flexy #secondary-inner',
    '#columns #secondary',
    '#columns ytd-secondary-column-renderer',
    'ytd-secondary-column-renderer',
    '[slot="secondary"]',
    '#related',
    '#sidebar',
    '.watch-sidebar',
    '.ytd-watch-flexy #secondary',
    '.ytd-watch-flexy #secondary-inner'
  ];
  
  let secondary = null;
  for (const selector of secondarySelectors) {
    secondary = document.querySelector(selector);
    if (secondary) {
      break;
    }
  }

  if (!secondary) {
    // フォールバック：ytd-watch-flexyの最初の子要素を使用
    const watchFlexy = document.querySelector('ytd-watch-flexy');
    if (watchFlexy) {
      const columns = watchFlexy.querySelector('#columns');
      if (columns && columns.children.length >= 2) {
        secondary = columns.children[1]; // 通常は2番目の列がsecondary
      }
    }

    if (!secondary) {
      console.log('[ERROR] プレイリストパネル: secondary要素が見つかりません。パネル作成を中止します。');
      return;
    }
  }
  const panel = document.createElement('div');
  panel.id = 'youtube-unwatched-opener-playlist-panel';
  panel.innerHTML = `
    <div class="panel-header">
      <h3>プレイリストに保存</h3>
      <button id="toggle-playlist-panel" aria-label="プレイリストパネルを閉じる">×</button>
    </div>
    <div class="panel-content">
      <div class="playlist-dialog-container">
        <div class="loading">プレイリストダイアログを読み込み中...</div>
      </div>
    </div>
  `;
  
  // パネルの挿入位置を改善
  if (secondary.firstChild) {
    secondary.insertBefore(panel, secondary.firstChild);
  } else {
    secondary.appendChild(panel);
  }

  const toggleButton = document.getElementById('toggle-playlist-panel');
  if (toggleButton) {
    toggleButton.addEventListener('click', () => {
      teardownPlaylistPanel(panel);
      panel.remove();
      document.body.focus();
    });
  }

  embedPlaylistDialog(panel);
}

async function embedPlaylistDialog(panel) {
  teardownPlaylistPanel(panel);

  const container = panel.querySelector('.playlist-dialog-container');
  container.innerHTML = '<div class="loading">プレイリストを読み込み中...</div>';

  // バックグラウンドタブでは処理をスキップ
  if (document.visibilityState === 'hidden') {
    container.innerHTML = '<div class="loading">タブがアクティブになったらプレイリストが読み込まれます</div>';
    document.addEventListener('visibilitychange', function onVisible() {
      if (document.visibilityState === 'visible') {
        document.removeEventListener('visibilitychange', onVisible);
        setTimeout(() => embedPlaylistDialog(panel), 1000);
      }
    });
    return;
  }

  console.log('[INFO] プレイリストパネル: ダイアログ埋め込み処理を開始');

  try {
    const originalDialog = await findAndClickSaveButton();
    mountDialogClone(panel, originalDialog);
  } catch (err) {
    console.log('[ERROR] プレイリストパネル:', err.message);
    [...PLAYLIST_DIALOG_SELECTORS, 'ytd-popup-container', 'tp-yt-paper-dialog', 'yt-sheet-vm'].forEach(sel => {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        console.log(`[DEBUG] ヒット (${sel}):`, Array.from(els).map(el => ({
          tag: el.tagName,
          visible: el.offsetWidth > 0 && el.offsetHeight > 0,
          display: window.getComputedStyle(el).display,
          children: el.children.length
        })));
      }
    });
    showPanelError(panel, 'プレイリストダイアログが見つかりませんでした<br><small>保存ボタンをクリックするか、再試行してください</small>');
  }
}

// ショート動画のURLリダイレクト機能
function initializeShortsRedirect() {
  let oldHref = document.location.href;
  
  // 初回チェック
  if (window.location.href.indexOf('youtube.com/shorts') > -1) {
    const newUrl = window.location.toString().replace('/shorts/', '/watch?v=');
    console.log(`ショート動画をリダイレクト: ${window.location.href} → ${newUrl}`);
    window.location.replace(newUrl);
    return;
  }
  
  // URL変更を監視
  const shortsRedirectObserver = new MutationObserver(() => {
    if (oldHref !== document.location.href) {
      oldHref = document.location.href;
      console.log('URL変更を検出:', oldHref);
      
      // ショート動画ページの場合はリダイレクト
      if (window.location.href.indexOf('youtube.com/shorts') > -1) {
        const newUrl = window.location.toString().replace('/shorts/', '/watch?v=');
        console.log(`ショート動画をリダイレクト: ${window.location.href} → ${newUrl}`);
        window.location.replace(newUrl);
        return;
      }
      
      // プレイリストパネルと動画監視の初期化（#secondary出現を待って実行）
      waitForElement('#secondary', { timeout: 3000 })
        .then(() => initializeVideoPageFeatures())
        .catch(() => initializeVideoPageFeatures());
    }
  });
  
  shortsRedirectObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
}


// analyzeYouTubeStructure 関数は削除（大量ログ出力の原因のため）

// ショート動画リスト表示関連の関数群は削除
// - findShortsVideos
// - injectShortsListViewCSS
// - convertShortsToListView
// - convertSingleShortToListView

function interceptShortsLinks() {
  // クリックイベントでリンクを変換（キャプチャフェーズで処理）
  document.addEventListener('click', function(event) {
    const link = event.target.closest('a[href*="/shorts/"]');
    if (link) {
      const originalUrl = link.href;
      const videoIdMatch = originalUrl.match(/\/shorts\/([^?&]+)/);
      
      if (videoIdMatch) {
        const videoId = videoIdMatch[1];
        const newUrl = `https://www.youtube.com/watch?v=${videoId}`;
        
        // イベントをキャンセルして独自の処理を実行
        event.preventDefault();
        event.stopPropagation();
        
        // 新しいURLで直接移動
        if (event.ctrlKey || event.metaKey || event.button === 1) {
          // 新しいタブで開く
          window.open(newUrl, '_blank');
        } else {
          // 同じタブで開く
          window.location.href = newUrl;
        }
      }
    }
  }, true);
  
  function convertExistingShortsLinks() {
    
    const shortsLinks = document.querySelectorAll('a[href*="/shorts/"]:not([data-converted])');
    const convertedVideos = new Set();
    
    shortsLinks.forEach(link => {
      const originalUrl = link.href;
      const videoIdMatch = originalUrl.match(/\/shorts\/([^?&]+)/);
      
      if (videoIdMatch) {
        const videoId = videoIdMatch[1];
        const newUrl = `https://www.youtube.com/watch?v=${videoId}`;
        
        // hrefだけでなく、data-*属性も更新
        link.href = newUrl;
        link.setAttribute('href', newUrl);
        if (link.hasAttribute('data-sessionlink')) {
          const sessionLink = link.getAttribute('data-sessionlink');
          link.setAttribute('data-sessionlink', sessionLink.replace(/\/shorts\//, '/watch?v='));
        }
        link.setAttribute('data-converted', 'true');
        
        convertedVideos.add(videoId);
      }
    });
  }
  
  // 初回変換
  setTimeout(convertExistingShortsLinks, 2000);
  
  // 動的に追加されるリンクを監視
  const linkObserver = new MutationObserver((mutations) => {
    let hasNewLinks = false;
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches('a[href*="/shorts/"]:not([data-converted])') || node.querySelector('a[href*="/shorts/"]:not([data-converted])')) {
            hasNewLinks = true;
          }
        }
      });
    });
    
    if (hasNewLinks) {
      setTimeout(convertExistingShortsLinks, 100);
    }
  });
  
  linkObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
}

browserAPI.storage.sync.get(DEFAULT_SETTINGS).then((result) => {
  settings = result;
  initializeHighlighting();
  interceptShortsLinks();
  initializeShortsRedirect();

  // #secondary要素の出現を待って即時初期化（最大4秒、タイムアウト時はそのまま実行）
  waitForElement('#secondary', { timeout: 4000 })
    .then(() => initializeVideoPageFeatures())
    .catch(() => initializeVideoPageFeatures());

  // さらに遅延して追加チェック
  setTimeout(() => {
    if (settings.showPlaylistPanel &&
        (window.location.pathname.startsWith('/watch') || window.location.pathname.startsWith('/shorts')) &&
        !document.getElementById('youtube-unwatched-opener-playlist-panel')) {
      initializeVideoPageFeatures();
    }
  }, 5000);
});

browserAPI.storage.onChanged.addListener((changes) => {
  for (let key in changes) {
    settings[key] = changes[key].newValue;
  }
  if (changes.highlightEnabled) {
    updateHighlighting();
  }
  if (changes.showPlaylistPanel) {
    if (settings.showPlaylistPanel) {
      // 動画ページの場合のみパネルを作成
      if ((window.location.pathname.startsWith('/watch') || window.location.pathname.startsWith('/shorts')) &&
          window.location.pathname !== '/') {
        setTimeout(() => {
          initializeVideoPageFeatures();
        }, 500);
      }
    } else {
      const panel = document.getElementById('youtube-unwatched-opener-playlist-panel');
      if (panel) {
        panel.remove();
      }
    }
  }
});

let currentVideoId = '';

function getCurrentVideoId() {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('v') || '';
}

function updatePlaylistPanelForNewVideo() {
  const newVideoId = getCurrentVideoId();
  if (newVideoId !== currentVideoId) {
    currentVideoId = newVideoId;

    // 既存のプレイリストパネルを削除
    const existingPanel = document.getElementById('youtube-unwatched-opener-playlist-panel');
    if (existingPanel) {
      teardownPlaylistPanel(existingPanel);
      existingPanel.remove();
    }

    // 新しい動画用のプレイリストパネルを作成
    if ((window.location.pathname.startsWith('/watch') || window.location.pathname.startsWith('/shorts')) &&
        settings.showPlaylistPanel && window.location.pathname !== '/') {
      waitForElement('#secondary', { timeout: 3000 })
        .then(() => initializeVideoPageFeatures())
        .catch(() => initializeVideoPageFeatures());
    }

  }
}

// デバウンス機能付きMutationObserver
let observerTimeout = null;
let lastObserverRun = 0;
let observerRunCount = 0;

const observer = new MutationObserver(() => {
  const now = Date.now();
  observerRunCount++;
  
  // 短時間での連続実行を制限（1秒間に最大2回まで）
  if (now - lastObserverRun < 500) {
    if (observerTimeout) {
      clearTimeout(observerTimeout);
    }
    observerTimeout = setTimeout(() => {
      performObserverTasks();
      lastObserverRun = Date.now();
    }, 1000);
    return;
  }
  
  performObserverTasks();
  lastObserverRun = now;
});

// ハイライト更新のデバウンス制御
let highlightUpdateTimeout = null;
let lastHighlightUpdate = 0;

function performObserverTasks() {
  // ハイライト更新の頻度制限（1秒間に最大1回）
  if (settings.highlightEnabled) {
    const now = Date.now();
    if (now - lastHighlightUpdate > 1000) {
      // 直ちに実行
      updateHighlighting();
      lastHighlightUpdate = now;
    } else {
      // デバウンス処理
      if (highlightUpdateTimeout) {
        clearTimeout(highlightUpdateTimeout);
      }
      highlightUpdateTimeout = setTimeout(() => {
        updateHighlighting();
        lastHighlightUpdate = Date.now();
      }, 1000);
    }
  }
  
  // 動画の変更を監視（頻度を制限）
  updatePlaylistPanelForNewVideo();
  
}

observer.observe(document.body, {
  childList: true,
  subtree: true
});

// URLの変更も監視（履歴API使用時）
window.addEventListener('popstate', updatePlaylistPanelForNewVideo);
window.addEventListener('pushstate', updatePlaylistPanelForNewVideo);
window.addEventListener('replacestate', updatePlaylistPanelForNewVideo);

// Toast通知機能
const toastController = {
  currentToast: null,
  
  show: function(message, type = 'info', duration = 3000) {
    // 既存のToastを削除
    if (this.currentToast) {
      this.currentToast.remove();
    }
    
    // Toastコンテナを作成
    const toast = document.createElement('div');
    toast.id = 'youtube-unwatched-opener-toast';
    toast.className = `youtube-unwatched-opener-toast ${type}`;
    
    // アイコンを設定
    let icon = '📱';
    switch (type) {
      case 'success':
        icon = '✅';
        break;
      case 'info':
        icon = 'ℹ️';
        break;
      case 'warning':
        icon = '⚠️';
        break;
      case 'error':
        icon = '❌';
        break;
    }
    
    // Toastの内容を設定
    toast.innerHTML = `
      <span class="toast-icon">${icon}</span>
      <span class="toast-message">${message}</span>
    `;
    
    // ページに追加
    document.body.appendChild(toast);
    this.currentToast = toast;
    
    // アニメーション表示
    setTimeout(() => {
      toast.classList.add('show');
    }, 10);
    
    // 自動削除
    setTimeout(() => {
      if (this.currentToast === toast) {
        this.hide();
      }
    }, duration);
    
    debugLogController.log(`[Toast] ${type}: ${message}`);
  },
  
  hide: function() {
    if (this.currentToast) {
      this.currentToast.classList.remove('show');
      setTimeout(() => {
        if (this.currentToast) {
          this.currentToast.remove();
          this.currentToast = null;
        }
      }, 300);
    }
  }
};

// 視聴履歴記録機能
let watchHistoryTimer = null;
let lastWatchedUrl = null;

function recordVideoWatchHistory() {
  // 視聴ページかどうかをチェック
  if (!window.location.pathname.startsWith('/watch')) {
    return;
  }
  
  const currentUrl = window.location.href;
  
  // 同じ動画の場合はスキップ
  if (lastWatchedUrl === currentUrl) {
    return;
  }
  
  // 既存のタイマーをクリア
  if (watchHistoryTimer) {
    clearTimeout(watchHistoryTimer);
  }
  
  // 新しいURLを記録
  lastWatchedUrl = currentUrl;
  
  // 一定時間後に履歴に追加（実際に視聴開始したと判定）
  watchHistoryTimer = setTimeout(() => {
    const videoId = watchHistoryManager.extractVideoId(currentUrl);
    if (videoId) {
      watchHistoryManager.addToHistory(currentUrl);
      debugLogController.log(`[視聴記録] 動画視聴を記録: ${videoId}`);
    }
  }, 5000); // 5秒後に履歴に追加（実際の視聴開始と判定）
}

// 履歴API操作をフック
const originalPushState = history.pushState;
const originalReplaceState = history.replaceState;

history.pushState = function() {
  originalPushState.apply(history, arguments);
  setTimeout(recordVideoWatchHistory, 50);
  setTimeout(updatePlaylistPanelForNewVideo, 100);
};

history.replaceState = function() {
  originalReplaceState.apply(history, arguments);
  setTimeout(recordVideoWatchHistory, 50);
  setTimeout(updatePlaylistPanelForNewVideo, 100);
};

// プレイリストパネル表示前のフォーカス保存用
let savedFocusBeforePlaylistPanel = null;

// 動画ページでの初期化処理を更新
function initializeVideoPageFeatures() {
  if ((window.location.pathname.startsWith('/watch') || window.location.pathname.startsWith('/shorts')) &&
      window.location.pathname !== '/') {
    createPlaylistPanel();
  }
}

console.log('YouTube未視聴動画オープナー: コンテンツスクリプトが読み込まれました');

// グローバルAPIオブジェクト - コンソールからアクセス可能
window.YouTubeUnwatchedOpener = {
  // 診断情報出力
  diagnose: outputYouTubeStructureInfo,
  
  // 設定確認
  getSettings: () => settings,
  
  // ハイライト強制実行
  forceHighlight: updateHighlighting,
  
  // 未視聴動画検索
  findUnwatched: findUnwatchedVideos,
  
  // ログ統計情報表示
  getLogStats: () => {
    console.log('=== デバッグログ統計 ===');
    console.log(`デバッグモード: ${settings.debugMode ? 'ON' : 'OFF'}`);
    console.log(`Observer実行回数: ${observerRunCount}`);
    console.log('メッセージ別ログ統計:');
    debugLogController.lastMessages.forEach((data, message) => {
      console.log(`  "${message.substring(0, 50)}..." : ${data.count}回`);
    });
  },
  
  // ログ統計リセット
  resetLogStats: () => {
    debugLogController.lastMessages.clear();
    observerRunCount = 0;
    console.log('ログ統計をリセットしました');
  },
  
  // バージョン情報
  version: '1.4.1',
  lastUpdated: '2025-09-04'
};

console.log('コンソールからアクセス可能: window.YouTubeUnwatchedOpener');
console.log('診断実行: YouTubeUnwatchedOpener.diagnose()');

// ========== 新しいシンプルなハイライト機能 ==========

function applySimpleHighlighting() {
  if (!settings.highlightEnabled) {
    removeVideoCountOverlay();
    return;
  }

  // 登録チャンネルページでのみ動作
  if (window.location.pathname !== '/feed/subscriptions') {
    removeVideoCountOverlay();
    return;
  }

  // シンプルなセレクタで動画要素を取得
  const videoElements = document.querySelectorAll('#contents ytd-rich-item-renderer');

  const counts = {
    total: videoElements.length,
    unwatched: 0,
    watched: 0,
    live: 0,
    liveWatched: 0,
    scheduled: 0,
    premiere: 0,
    premiereWatched: 0,
    shortsUnwatched: 0,
    shortsWatched: 0,
    unknown: 0
  };

  videoElements.forEach(videoElement => {
    let status;
    if (videoElement.dataset.simpleHighlightProcessed) {
      // 処理済み要素はキャッシュしたステータスを利用
      status = videoElement.dataset.videoStatus || 'unknown';
    } else {
      status = getSimpleVideoStatus(videoElement);
      applySimpleVideoStyle(videoElement, status);
      videoElement.dataset.simpleHighlightProcessed = 'true';
      videoElement.dataset.videoStatus = status;
    }

    switch (status) {
      case 'unwatched': counts.unwatched++; break;
      case 'watched': counts.watched++; break;
      case 'live': counts.live++; break;
      case 'live-watched': counts.liveWatched++; break;
      case 'scheduled': counts.scheduled++; break;
      case 'premiere': counts.premiere++; break;
      case 'premiere-watched': counts.premiereWatched++; break;
      case 'shorts-unwatched': counts.shortsUnwatched++; break;
      case 'shorts-watched': counts.shortsWatched++; break;
      default: counts.unknown++; break;
    }
  });

  updateVideoCountOverlay(counts);
}

function buildOverlayHTML(counts) {
  const hiddenCount = counts.watched + counts.liveWatched + counts.premiereWatched + counts.shortsWatched;
  const rows = [
    '<div class="yuo-count-title">動画カウント</div>',
    `<div class="yuo-count-row yuo-unwatched"><span>未視聴</span><span>${counts.unwatched}</span></div>`,
  ];
  if (counts.shortsUnwatched > 0) {
    rows.push(`<div class="yuo-count-row yuo-shorts"><span>ショート未視聴</span><span>${counts.shortsUnwatched}</span></div>`);
  }
  if (counts.live > 0) {
    rows.push(`<div class="yuo-count-row yuo-live"><span>ライブ中</span><span>${counts.live}</span></div>`);
  }
  if (counts.premiere > 0) {
    rows.push(`<div class="yuo-count-row yuo-premiere"><span>プレミア</span><span>${counts.premiere}</span></div>`);
  }
  if (counts.scheduled > 0) {
    rows.push(`<div class="yuo-count-row yuo-scheduled"><span>配信予定</span><span>${counts.scheduled}</span></div>`);
  }
  rows.push(`<div class="yuo-count-row yuo-watched"><span>視聴済み</span><span>${hiddenCount}</span></div>`);
  rows.push(`<div class="yuo-count-row yuo-total"><span>総数</span><span>${counts.total}</span></div>`);
  return rows.join('');
}

function applyOverlayPosition(overlay, pos) {
  overlay.style.left = pos.x + 'px';
  overlay.style.top = pos.y + 'px';
}

function attachOverlayDrag(overlay) {
  let dragging = false;
  let startX, startY, origX, origY;

  overlay.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    origX = overlay.getBoundingClientRect().left;
    origY = overlay.getBoundingClientRect().top;
    overlay.style.cursor = 'grabbing';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const newX = Math.max(0, Math.min(window.innerWidth - overlay.offsetWidth, origX + e.clientX - startX));
    const newY = Math.max(0, Math.min(window.innerHeight - overlay.offsetHeight, origY + e.clientY - startY));
    overlay.style.left = newX + 'px';
    overlay.style.top = newY + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    overlay.style.cursor = 'grab';
    const pos = {
      x: parseInt(overlay.style.left, 10),
      y: parseInt(overlay.style.top, 10)
    };
    browserAPI.storage.sync.set({ countOverlayPosition: pos });
  });
}

function updateVideoCountOverlay(counts) {
  let overlay = document.getElementById('youtube-unwatched-opener-count-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'youtube-unwatched-opener-count-overlay';
    document.body.appendChild(overlay);
    attachOverlayDrag(overlay);

    // 保存済み位置を復元
    browserAPI.storage.sync.get('countOverlayPosition').then((result) => {
      const pos = result.countOverlayPosition || { x: 10, y: 60 };
      applyOverlayPosition(overlay, pos);
    });
  }

  overlay.innerHTML = buildOverlayHTML(counts);
}

function removeVideoCountOverlay() {
  const overlay = document.getElementById('youtube-unwatched-opener-count-overlay');
  if (overlay) overlay.remove();
}

function getSimpleVideoStatus(videoElement) {
  // ショート動画のチェック（書き換え前と書き換え後の両方に対応）
  const shortsLink = videoElement.querySelector('a[href*="/shorts/"]');
  const convertedShortsLink = videoElement.querySelector('a[data-converted="true"]');
  
  if (shortsLink || convertedShortsLink) {
    // 視聴履歴でショート動画の視聴状態を判定
    let videoUrl;
    
    if (shortsLink) {
      // 書き換え前のショートURL
      videoUrl = shortsLink.href;
      debugLogController.log(`[ショート判定] 書き換え前URL検出: ${videoUrl}`);
    } else if (convertedShortsLink) {
      // 書き換え後の通常URL（元はショート動画）
      videoUrl = convertedShortsLink.href;
      debugLogController.log(`[ショート判定] 書き換え後URL検出: ${videoUrl}`);
      
      // 書き換え後URLをショートURLに戻して履歴チェック
      const videoIdMatch = videoUrl.match(/[?&]v=([^&]+)/);
      if (videoIdMatch) {
        const shortsUrl = `https://www.youtube.com/shorts/${videoIdMatch[1]}`;
        debugLogController.log(`[ショート判定] 元ショートURL推定: ${shortsUrl}`);
        
        // 元のショートURLでも履歴をチェック
        if (watchHistoryManager.isUrlWatched(shortsUrl)) {
          debugLogController.log(`[ショート判定] 履歴により視聴済みと判定: ${shortsUrl}`);
          return 'shorts-watched';
        }
      }
    }
    
    const isWatched = watchHistoryManager.isUrlWatched(videoUrl);
    
    if (isWatched) {
      debugLogController.log(`[ショート判定] 履歴により視聴済みと判定: ${videoUrl}`);
      return 'shorts-watched';
    } else {
      debugLogController.log(`[ショート判定] 未視聴ショート動画: ${videoUrl}`);
      return 'shorts-unwatched';
    }
  }
  
  const textContent = videoElement.textContent || '';
  
  // 配信予定をチェック（最優先で判定）
  if (textContent.includes('公開予定') || 
      textContent.includes('配信予定') || 
      textContent.includes('配信スタート') ||
      textContent.includes('に公開予定') ||
      textContent.match(/\d+月\d+日.*\d+:\d+.*公開/)) {
    return 'scheduled';
  }
  
  // プレミア公開をチェック
  if (textContent.includes('プレミア公開') ||
      textContent.includes('プレミア') ||
      textContent.includes('PREMIERE') ||
      textContent.includes('待機中')) {

    // プレミア動画の視聴済みチェック
    const newProgressBarIndicator = videoElement.querySelector('yt-thumbnail-overlay-progress-bar-view-model');
    const progressBar = videoElement.querySelector(
      '.ytd-thumbnail-overlay-resume-playback-renderer, ' +
      '[aria-label*="進行状況"], ' +
      '[aria-label*="再開"], ' +
      '.progress-bar, ' +
      '[class*="progress"]'
    );
    const watchedIndicators = videoElement.querySelector(
      '.ytd-thumbnail-overlay-playback-status-renderer, ' +
      '[aria-label*="視聴済み"], ' +
      '[title*="視聴済み"]'
    );

    // 視聴履歴でのプレミア動画判定を追加
    let isHistoryWatched = false;
    const videoLink = videoElement.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
    if (videoLink) {
      const videoUrl = videoLink.href;
      isHistoryWatched = watchHistoryManager.isUrlWatched(videoUrl);
      if (isHistoryWatched) {
        debugLogController.log(`[プレミア判定] 履歴によりプレミア動画を視聴済みと判定: ${videoUrl}`);
      }
    }

    if (newProgressBarIndicator || progressBar || watchedIndicators || isHistoryWatched) {
      return 'premiere-watched';
    } else {
      return 'premiere';
    }
  }
  
  // ライブ配信をチェック
  if (textContent.includes('ライブ') || textContent.includes('LIVE')) {
    // 現在配信中の場合（視聴者数表示があることで判定）
    if (textContent.includes('人が視聴中') || 
        textContent.match(/\d+\s*(人|viewers?)\s*(が視聴中|watching)/) ||
        textContent.includes('視聴者数')) {
      
      // LIVE中だが視聴済みかどうかをチェック
      const newProgressBarIndicator = videoElement.querySelector('yt-thumbnail-overlay-progress-bar-view-model');
      const progressBar = videoElement.querySelector(
        '.ytd-thumbnail-overlay-resume-playback-renderer, ' +
        '[aria-label*="進行状況"], ' +
        '[aria-label*="再開"], ' +
        '.progress-bar, ' +
        '[class*="progress"]'
      );
      const watchedIndicators = videoElement.querySelector(
        '.ytd-thumbnail-overlay-playback-status-renderer, ' +
        '[aria-label*="視聴済み"], ' +
        '[title*="視聴済み"]'
      );
      
      // 視聴履歴でのLIVE動画判定を追加
      let isHistoryWatched = false;
      const videoLink = videoElement.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
      if (videoLink) {
        const videoUrl = videoLink.href;
        isHistoryWatched = watchHistoryManager.isUrlWatched(videoUrl);
        if (isHistoryWatched) {
          debugLogController.log(`[LIVE判定] 履歴によりLIVE動画を視聴済みと判定: ${videoUrl}`);
        }
      }
      
      if (newProgressBarIndicator || progressBar || watchedIndicators || isHistoryWatched) {
        return 'live-watched';
      } else {
        return 'live';
      }
    }
  }
  
  // 通常動画の時間表示をチェック（MM:SS または H:MM:SS パターン）
  const hasTimeStamp = /\d+:\d+(?::\d+)?/.test(textContent);
  
  if (hasTimeStamp) {
    // 時間表示がある場合は通常動画

    // 視聴履歴での判定を追加（最優先）
    const videoLink = videoElement.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
    if (videoLink) {
      const videoUrl = videoLink.href;
      if (watchHistoryManager.isUrlWatched(videoUrl)) {
        debugLogController.log(`[通常動画判定] 履歴により視聴済みと判定: ${videoUrl}`);
        return 'watched';
      }
    }
    
    // 新しいプログレスバー表示（視聴済み）の確認（最優先）
    const newProgressBarIndicator = videoElement.querySelector('yt-thumbnail-overlay-progress-bar-view-model');
    
    if (newProgressBarIndicator) {
      return 'watched';
    }
    
    // 従来の視聴済み判定
    const progressBar = videoElement.querySelector(
      '.ytd-thumbnail-overlay-resume-playback-renderer, ' +
      '[aria-label*="進行状況"], ' +
      '[aria-label*="再開"], ' +
      '.progress-bar, ' +
      '[class*="progress"]'
    );
    
    // 追加の視聴済み判定要素
    const watchedIndicators = videoElement.querySelector(
      '.ytd-thumbnail-overlay-playback-status-renderer, ' +
      '[aria-label*="視聴済み"], ' +
      '[title*="視聴済み"]'
    );
    
    // 従来の未視聴インジケーター（青い点）の存在チェック
    const legacyUnwatchedIndicator = videoElement.querySelector(
      '.ytd-thumbnail-overlay-time-status-renderer .badge-style-type-simple, ' +
      '.ytd-badge-supported-renderer, ' +
      '[class*="unwatched"]'
    );
    
    if (progressBar || watchedIndicators) {
      return 'watched';
    } else if (legacyUnwatchedIndicator) {
      return 'unwatched';
    } else {
      // プログレスバーも未視聴インジケーターもない場合
      // より厳密に判定するため、追加の要素をチェック
      
      // サムネイル上に再生済みオーバーレイがあるかチェック
      const playedOverlay = videoElement.querySelector(
        '.ytd-thumbnail .ytd-thumbnail-overlay-resume-playback-renderer'
      );
      
      if (playedOverlay) {
        return 'watched';
      } else {
        // デフォルトは未視聴として扱う（保守的判定）
        return 'unwatched';
      }
    }
  }
  
  // 時間表示がない場合はライブ系または特殊動画の可能性
  // より厳密にチェックする
  
  // 最終的にはテキスト内容から判定
  if (textContent.includes('配信') && !textContent.includes('人が視聴中')) {
    return 'scheduled'; // 配信系で視聴中でなければ予定
  }
  
  // どのパターンにも該当しない場合は動画として扱わない（非表示にしない）
  return 'unknown';
}

function applySimpleVideoStyle(videoElement, status) {
  // 既存のハイライトクラスをクリア
  const highlightClasses = [
    'youtube-unwatched-opener-unwatched',
    'youtube-unwatched-opener-live',
    'youtube-unwatched-opener-live-watched',
    'youtube-unwatched-opener-watched',
    'youtube-unwatched-opener-scheduled',
    'youtube-unwatched-opener-premiere',
    'youtube-unwatched-opener-premiere-watched',
    'youtube-unwatched-opener-shorts-unwatched',
    'youtube-unwatched-opener-shorts-watched'
  ];

  videoElement.classList.remove(...highlightClasses);
  videoElement.style.display = ''; // 表示状態をリセット

  switch (status) {
    case 'unwatched':
      videoElement.classList.add('youtube-unwatched-opener-unwatched');
      break;
    case 'live':
      videoElement.classList.add('youtube-unwatched-opener-live');
      break;
    case 'live-watched':
      videoElement.classList.add('youtube-unwatched-opener-live-watched');
      break;
    case 'scheduled':
      videoElement.classList.add('youtube-unwatched-opener-scheduled');
      // 公開予定動画はハイライト表示のみ（非表示にしない）
      break;
    case 'premiere':
      videoElement.classList.add('youtube-unwatched-opener-premiere');
      break;
    case 'premiere-watched':
      videoElement.classList.add('youtube-unwatched-opener-premiere-watched');
      // 視聴済みプレミア動画はハイライト表示のみ（非表示にしない）
      break;
    case 'watched':
      videoElement.classList.add('youtube-unwatched-opener-watched');
      // 視聴済み動画はハイライト表示のみ（非表示にしない）
      break;
    case 'shorts-unwatched':
      videoElement.classList.add('youtube-unwatched-opener-shorts-unwatched');
      break;
    case 'shorts-watched':
      videoElement.classList.add('youtube-unwatched-opener-shorts-watched');
      break;
    case 'shorts':
    case 'unknown':
    default:
      // 判定不能、その他は何もしない（通常表示のまま）
      break;
  }
}

// ページ変更を監視して再実行
let simpleHighlightObserver = null;

function startSimpleHighlightObserver() {
  if (simpleHighlightObserver) {
    simpleHighlightObserver.disconnect();
  }
  
  simpleHighlightObserver = new MutationObserver(() => {
    // 新しい動画要素が追加されたときに処理済みフラグをリセット
    const videoElements = document.querySelectorAll('#contents ytd-rich-item-renderer');
    videoElements.forEach(el => {
      if (!el.dataset.simpleHighlightProcessed) {
        delete el.dataset.simpleHighlightProcessed;
      }
    });
    
    // 500ms後にハイライト処理を実行（連続実行を防ぐ）
    clearTimeout(window.simpleHighlightTimeout);
    window.simpleHighlightTimeout = setTimeout(applySimpleHighlighting, 500);
  });
  
  const contentsElement = document.querySelector('#contents');
  if (contentsElement) {
    simpleHighlightObserver.observe(contentsElement, {
      childList: true,
      subtree: true
    });
  }
}

// 初期化時にオブザーバーを開始
if (window.location.pathname === '/feed/subscriptions') {
  startSimpleHighlightObserver();
}

// 初期化時に視聴履歴記録機能を開始
setTimeout(recordVideoWatchHistory, 1000);