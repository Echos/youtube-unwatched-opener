// 見終わった動画を「後で見る」から外す（メインワールドで実行）
// - 再生状態は #movie_player のプレイヤーAPI（getVideoData / getCurrentTime など）から取る。
//   これらはYouTubeがメインワールドで生やしたメソッドで、隔離ワールドの content.js からは見えない
// - 登録の確認と削除は、YouTube の保存ダイアログが使うのと同じ InnerTube API
//   （playlist/get_add_to_playlist と browse/edit_playlist）をログイン中のセッションで呼ぶ
// - 判定は watch-later-progress.js（先に注入する）。設定は content.js が
//   <html data-youtube-unwatched-opener-watch-later> に JSON で書き、イベントで知らせる
(function () {
  'use strict';

  if (window.__youtubeUnwatchedOpenerWatchLater) return;
  window.__youtubeUnwatchedOpenerWatchLater = true;

  const core = window.YouTubeUnwatchedOpenerWatchLater;
  if (!core) {
    console.warn('[後で見る自動削除] 判定ロジックが読み込まれていません');
    return;
  }

  const SETTINGS_ATTR = 'data-youtube-unwatched-opener-watch-later';
  const SETTINGS_EVENT = 'youtube-unwatched-opener:watch-later-settings';
  const RESULT_EVENT = 'youtube-unwatched-opener:watch-later-auto-remove';
  const GO_EVENT = 'youtube-unwatched-opener:watch-later-auto-remove-go';
  // content.js からの合図（r キーの操作の完了待ち）を待つ上限。届かなくても外す
  const GO_TIMEOUT_MS = 30000;

  let config = core.normalizeConfig(core.DEFAULT_CONFIG);
  let debug = false;
  const tracker = core.createWatchLaterProgressTracker();
  let discontinuity = true;
  // 後で見るのリストから続けて再生している時に外した動画と、その次の動画
  let pendingAdvance = null;
  const ADVANCE_WAIT_MS = 3000;

  function log(...args) {
    if (debug) console.log('[後で見る自動削除]', ...args);
  }

  function readSettings() {
    try {
      const raw = JSON.parse(document.documentElement.getAttribute(SETTINGS_ATTR) || '{}');
      config = core.normalizeConfig(raw);
      debug = !!raw.debug;
    } catch (e) {
      config = core.normalizeConfig(core.DEFAULT_CONFIG);
    }
  }

  function emitResult(result) {
    // 隔離ワールドへ渡すため detail は文字列にする（オブジェクトはワールドをまたぐと読めない場合がある）
    document.dispatchEvent(new CustomEvent(RESULT_EVENT, { detail: JSON.stringify(result) }));
  }

  // ---------- 再生状態の取得 ----------
  function getPlayer() {
    const player = document.getElementById('movie_player');
    return player && typeof player.getVideoData === 'function' ? player : null;
  }

  function isAdShowing(player) {
    return player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
  }

  // ライブ配信中・プレミア公開の待機中/公開中は長さが定まらないため対象外。
  // 配信・プレミアが終わった後のアーカイブは通常の動画として扱う
  function isLiveOrUpcoming(player, videoData) {
    if (videoData.isLive) return true;
    const response = typeof player.getPlayerResponse === 'function' ? player.getPlayerResponse() : null;
    const details = response && response.videoDetails;
    return !!(details && (details.isLive || details.isUpcoming));
  }

  function isLoggedIn() {
    return !!(window.ytcfg && typeof window.ytcfg.get === 'function' && window.ytcfg.get('LOGGED_IN'));
  }

  function takeSample(player, video) {
    const videoData = player.getVideoData() || {};
    // ショートは /shorts のプレイヤーではループ再生になるため対象外（この拡張機能は通常 /watch に置き換える）
    const eligible = video.closest('#movie_player') === player &&
      !window.location.pathname.startsWith('/shorts') &&
      !isAdShowing(player) &&
      !isLiveOrUpcoming(player, videoData) &&
      isLoggedIn();
    const sample = {
      videoId: videoData.video_id || '',
      time: Number(player.getCurrentTime()),
      duration: Number(player.getDuration()),
      rate: typeof player.getPlaybackRate === 'function' ? Number(player.getPlaybackRate()) : 1,
      wallMs: performance.now(),
      eligible,
      discontinuity
    };
    discontinuity = false;
    return sample;
  }

  function onTimeUpdate(event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement) || !config.enabled) return;
    const player = getPlayer();
    if (!player || !player.contains(video)) return;

    const sample = takeSample(player, video);
    if (pendingAdvance && sample.videoId && sample.videoId !== pendingAdvance.removedVideoId) {
      pendingAdvance = null; // 次の動画へ進んだ
    }
    if (tracker.update(sample, config)) {
      log(`${config.percent}%に達したため確認します (${sample.videoId}, mode=${config.mode}, ` +
        `再生した区間 ${Math.round(tracker.getPlayedSeconds())}/${Math.round(sample.duration)}秒)`);
      removeIfInWatchLater(sample.videoId);
    }
  }

  // シーク・メディアの切り替えの直後のサンプルは「再生した区間」に数えない
  function markDiscontinuity(event) {
    const player = getPlayer();
    if (player && event.target instanceof HTMLVideoElement && player.contains(event.target)) {
      discontinuity = true;
    }
  }

  // ---------- 後で見るのリストの続きの再生 ----------
  // list=WL で再生中の動画を外しても、ページが持つリストは変わらないため通常は次へ進む。
  // 万一止まった時のために、外す前に次の動画を覚えておき、終了後に進んでいなければ進める
  function getWatchLaterListNext(player, videoId) {
    const listId = typeof player.getPlaylistId === 'function' ? player.getPlaylistId() : null;
    const urlListId = new URLSearchParams(window.location.search).get('list');
    if (listId !== 'WL' && urlListId !== 'WL') return null;
    const playlist = typeof player.getPlaylist === 'function' ? player.getPlaylist() : null;
    const index = typeof player.getPlaylistIndex === 'function' ? player.getPlaylistIndex() : null;
    return core.pickNextPlaylistVideo(playlist, index, videoId);
  }

  function isStuck(player) {
    const videoData = player.getVideoData() || {};
    return core.isStuckAfterRemoval(pendingAdvance, videoData.video_id, player.getPlayerState());
  }

  // 実機では短い動画だと削除の応答より先に再生が終わることがあるため、終了の時点では
  // pendingAdvance の有無を見ず、待ったあとで判断する
  function onEnded(event) {
    const player = getPlayer();
    if (!player || !(event.target instanceof HTMLVideoElement) || !player.contains(event.target)) return;
    setTimeout(() => {
      if (!pendingAdvance || !isStuck(player)) return;
      const nextVideoId = pendingAdvance.nextVideoId;
      log(`次の動画へ進んでいないため進めます (${nextVideoId})`);
      if (typeof player.nextVideo === 'function') player.nextVideo();
      setTimeout(() => {
        if (!isStuck(player)) return;
        pendingAdvance = null;
        window.location.assign(`/watch?v=${encodeURIComponent(nextVideoId)}&list=WL`);
      }, ADVANCE_WAIT_MS);
    }, ADVANCE_WAIT_MS);
  }

  // content.js に削除の準備ができたことを知らせ、r キーと同じ順番待ちを経て合図（go）が来るまで待つ。
  // 合図の前に edit_playlist を送ると、r キーの完了の確かめ（Resource Timing）と取り違える
  function waitForTurn(videoId) {
    const requestId = `${videoId}:${Date.now()}`;
    return new Promise((resolve) => {
      let timer = null;
      const onGo = (event) => {
        if (event.detail !== requestId) return;
        document.removeEventListener(GO_EVENT, onGo);
        clearTimeout(timer);
        resolve({ requestId, timedOut: false });
      };
      document.addEventListener(GO_EVENT, onGo);
      timer = setTimeout(() => {
        document.removeEventListener(GO_EVENT, onGo);
        log('content.js からの合図が無いため、そのまま外します');
        resolve({ requestId, timedOut: true });
      }, GO_TIMEOUT_MS);
      // リスナーを付けてから知らせる（content.js がその場で合図を返す場合がある）
      emitResult({ type: 'ready', videoId, requestId });
    });
  }

  // ---------- InnerTube API ----------
  async function sha1Hex(text) {
    const buffer = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
  }

  // YouTube のページが自分の API 呼び出しに付けるのと同じ SAPISIDHASH 認証
  async function buildAuthorization() {
    const match = document.cookie.match(/(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/);
    if (!match) return null;
    const timestamp = Math.floor(Date.now() / 1000);
    const hash = await sha1Hex(`${timestamp} ${match[1]} ${window.location.origin}`);
    return `SAPISIDHASH ${timestamp}_${hash}`;
  }

  async function callInnertube(endpoint, body) {
    const cfg = window.ytcfg;
    const context = cfg.get('INNERTUBE_CONTEXT');
    const authorization = await buildAuthorization();
    if (!context || !authorization) return { ok: false, status: 0, json: null, reason: 'no-session' };

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': authorization,
      'X-Origin': window.location.origin,
      'X-Goog-AuthUser': String(cfg.get('SESSION_INDEX') ?? 0)
    };
    const clientName = cfg.get('INNERTUBE_CONTEXT_CLIENT_NAME');
    const clientVersion = cfg.get('INNERTUBE_CLIENT_VERSION');
    if (clientName) headers['X-Youtube-Client-Name'] = String(clientName);
    if (clientVersion) headers['X-Youtube-Client-Version'] = String(clientVersion);
    const pageId = cfg.get('DELEGATED_SESSION_ID'); // ブランドアカウントで操作している場合
    if (pageId) headers['X-Goog-PageId'] = String(pageId);
    const visitorData = context.client && context.client.visitorData;
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;

    const response = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context, ...body })
    });
    const json = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, json };
  }

  async function removeIfInWatchLater(videoId) {
    try {
      const check = await callInnertube('playlist/get_add_to_playlist', {
        videoIds: [videoId],
        excludeWatchLater: false
      });
      if (!check.ok) {
        emitResult({ type: 'result', videoId, result: 'check-failed', status: check.status });
        return;
      }
      const option = core.findWatchLaterOption(check.json);
      if (!option || option.contains === null) {
        emitResult({ type: 'result', videoId, result: 'check-failed', status: check.status, reason: 'format' });
        return;
      }
      if (!option.contains) {
        log(`後で見るに入っていないため何もしません (${videoId})`);
        return;
      }

      const player = getPlayer();
      const nextVideoId = player ? getWatchLaterListNext(player, videoId) : null;
      const { requestId } = await waitForTurn(videoId);
      const startedAt = performance.now();
      const edit = await callInnertube('browse/edit_playlist', core.buildRemoveRequest(videoId, option.removeEndpoint));
      const succeeded = edit.ok && (!edit.json || !edit.json.status || edit.json.status === 'STATUS_SUCCEEDED');
      log(`edit_playlist: HTTP ${edit.status}, status=${edit.json && edit.json.status}`);
      if (succeeded && nextVideoId) pendingAdvance = { removedVideoId: videoId, nextVideoId };
      emitResult({
        type: 'result',
        videoId,
        requestId,
        result: succeeded ? 'removed' : 'remove-failed',
        status: edit.status,
        duration: performance.now() - startedAt
      });
    } catch (e) {
      log('エラー', e);
      emitResult({ type: 'result', videoId, result: 'check-failed', status: 0, reason: String(e && e.message) });
    }
  }

  readSettings();
  document.addEventListener(SETTINGS_EVENT, readSettings);
  // メディアイベントはバブリングしないが、キャプチャ段階なら document で受け取れる
  // （YouTube が video 要素を作り直しても付け直しが不要）
  document.addEventListener('timeupdate', onTimeUpdate, true);
  document.addEventListener('ended', onEnded, true);
  for (const type of ['seeking', 'emptied', 'loadstart']) {
    document.addEventListener(type, markDiscontinuity, true);
  }
})();
