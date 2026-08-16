// YouTubeが「ユーザーが手動で選択した画質」として認識するlocalStorageキーに
// 直接書き込むことで、動画プレイヤー初期化前（document_start）に画質選択を
// 確定させる。setPlaybackQuality()等のプレイヤーAPI呼び出しは非同期かつ
// 再生開始直後に自動画質へ巻き戻されることがあり信頼性が低いため、
// YouTube自身が「前回選択した画質を復元する」際に参照する仕組みを利用する。
//
// quality には 1440 を指定する。1440pが利用できない動画では、YouTube側が
// 自動的に利用可能な範囲内の最高画質（例: 1080p）へクランプするため、
// 「1440pがあれば1440p、なければ1080p」という優先順位がこの一手で実現できる。
(function() {
  'use strict';

  const STORAGE_KEY = 'yt-player-quality';
  const TARGET_QUALITY = 1440;
  const PREFERENCE_TTL_MS = 360 * 24 * 60 * 60 * 1000; // YouTube実装に合わせた約360日

  function applyPreferredQualityPreference() {
    try {
      let previousQuality = 1080;
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const data = JSON.parse(parsed.data);
        if (data && typeof data.quality === 'number') {
          previousQuality = data.quality;
        }
      }

      const now = Date.now();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        data: JSON.stringify({ quality: TARGET_QUALITY, previousQuality }),
        expiration: now + PREFERENCE_TTL_MS,
        creation: now
      }));
    } catch (e) {
      // localStorage無効環境（プライベートモード等）では何もしない
    }
  }

  applyPreferredQualityPreference();

  // SPA内での動画切り替え（history.pushState等）では document_start は
  // 再実行されないため、YouTube自身が発火するナビゲーションイベントで
  // 次の動画のプレイヤー初期化前に再適用する
  document.addEventListener('yt-navigate-start', applyPreferredQualityPreference);
})();
