// content.js（コンテンツスクリプトの隔離ワールド）から実行しても、
// #movie_player の getAvailableQualityLevels/setPlaybackQuality 等は
// YouTube本体がメインワールドでDOM要素に直接生やしたプロパティのため
// 参照できず、常に何も起きないまま終わっていた。
// そのためこのファイルは <script> タグとしてページに注入され、
// YouTube自身のスクリプトと同じメインワールドで実行される。
(function() {
  'use strict';

  if (window.__youtubeUnwatchedOpenerQualityEnforcerLoaded) {
    return;
  }
  window.__youtubeUnwatchedOpenerQualityEnforcerLoaded = true;

  const LOG_PREFIX = '[YouTube未視聴動画オープナー/画質設定]';
  const PREFERRED_QUALITY_ORDER = ['hd1440', 'hd1080'];

  // 戻り値: 'pending'（プレイヤー未準備・画質リスト未取得・要再確認）
  //         'confirmed'（目標画質が実際に反映済み）
  //         'not-applicable'（1080p/1440pがそもそも利用不可）
  function applyPreferredVideoQuality() {
    const player = document.getElementById('movie_player');
    if (!player || typeof player.getAvailableQualityLevels !== 'function') {
      return 'pending';
    }

    const availableLevels = player.getAvailableQualityLevels();
    if (!availableLevels || availableLevels.length === 0) {
      return 'pending';
    }

    const targetQuality = PREFERRED_QUALITY_ORDER.find(quality => availableLevels.includes(quality));
    if (!targetQuality) {
      return 'not-applicable';
    }

    const currentQuality = typeof player.getPlaybackQuality === 'function' ? player.getPlaybackQuality() : null;
    if (currentQuality === targetQuality) {
      return 'confirmed';
    }

    if (typeof player.setPlaybackQualityRange === 'function') {
      player.setPlaybackQualityRange(targetQuality, targetQuality);
    }
    if (typeof player.setPlaybackQuality === 'function') {
      player.setPlaybackQuality(targetQuality);
    }

    return 'pending';
  }

  // YouTube側の画質反映は非同期（数秒かかる）かつ再生直後にautoへ戻すことが
  // あるため、実際に目標画質へ切り替わったことを確認できるまでポーリングする
  function enforcePreferredVideoQuality() {
    let attempts = 0;
    const maxAttempts = 20; // 500ms間隔で最大10秒間確認・再適用

    const timer = setInterval(() => {
      attempts++;
      const result = applyPreferredVideoQuality();
      if (result === 'confirmed' || result === 'not-applicable' || attempts >= maxAttempts) {
        clearInterval(timer);
      }
    }, 500);
  }

  function attachStateListenerOnce(player) {
    if (!player || player.__youtubeUnwatchedOpenerQualityListenerAttached) {
      return;
    }
    player.__youtubeUnwatchedOpenerQualityListenerAttached = true;

    if (typeof player.addEventListener === 'function') {
      player.addEventListener('onStateChange', (state) => {
        if (state === 1) { // 1 = playing
          enforcePreferredVideoQuality();
        }
      });
    }
  }

  // #movie_player はSPA遷移直後はまだ新しい動画向けに準備できていないことが
  // あるため、利用可能画質が取得できるようになるまで待ってから開始する
  function waitForPlayerAndEnforce() {
    let attempts = 0;
    const maxAttempts = 20; // 500ms間隔で最大10秒待機

    const timer = setInterval(() => {
      attempts++;
      const player = document.getElementById('movie_player');
      const ready = player && typeof player.getAvailableQualityLevels === 'function'
        && player.getAvailableQualityLevels().length > 0;

      if (ready) {
        clearInterval(timer);
        attachStateListenerOnce(player);
        enforcePreferredVideoQuality();
      } else if (attempts >= maxAttempts) {
        clearInterval(timer);
        console.log(`${LOG_PREFIX} movie_playerの準備がタイムアウトしました`);
      }
    }, 500);
  }

  waitForPlayerAndEnforce();

  // SPA内の動画切り替え時にも再適用する
  document.addEventListener('yt-navigate-start', waitForPlayerAndEnforce);
})();
