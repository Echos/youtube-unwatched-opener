// 「後で見る」の自動削除の判定（DOM・YouTubeに依存しない純粋なロジック）
// メインワールドに注入して watch-later-auto-remove.js から使う。Node.js の単体テストからも require できる
(function (root) {
  'use strict';

  // 判定方法
  // - crossing: 閾値の手前から再生して閾値を通過した時（シークで閾値の先に飛んだだけでは外さない）
  // - coverage: 実際に再生した区間の合計が動画の長さの閾値%に達した時（飛ばした区間は数えない）
  // - position: 再生位置が閾値を超えた時（シークで飛んだ場合も外す）
  const MODES = ['crossing', 'coverage', 'position'];
  const DEFAULT_CONFIG = { enabled: true, percent: 90, mode: 'crossing' };
  const MIN_PERCENT = 50;
  const MAX_PERCENT = 99;
  const SMALL_SEEK_SECONDS = 10;

  function normalizeConfig(config) {
    const c = config || {};
    const percent = Number(c.percent);
    return {
      enabled: c.enabled !== false,
      percent: Number.isFinite(percent)
        ? Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round(percent)))
        : DEFAULT_CONFIG.percent,
      mode: MODES.includes(c.mode) ? c.mode : DEFAULT_CONFIG.mode
    };
  }

  // 前回のサンプルから今回までが「通常の再生」か（シーク・動画の切り替え・巻き戻しを除く）。
  // 再生速度ぶんの進み + 余裕（timeupdate の間隔のぶれ・一時的な詰まり）までを再生とみなす
  function isPlaybackStep(prev, sample) {
    const delta = sample.time - prev.time;
    if (!(delta > 0)) return false;
    const wallSeconds = Math.max(0, (sample.wallMs - prev.wallMs) / 1000);
    const rate = Number.isFinite(sample.rate) && sample.rate > 0 ? sample.rate : 1;
    return delta <= wallSeconds * rate * 1.5 + 1;
  }

  // 再生した区間 [start, end] の集合に追加し、重なり・隣接をまとめる
  function addRange(ranges, start, end) {
    const merged = [];
    let s = start;
    let e = end;
    for (const [rs, re] of ranges) {
      if (re < s - 0.5 || rs > e + 0.5) {
        merged.push([rs, re]);
      } else {
        s = Math.min(s, rs);
        e = Math.max(e, re);
      }
    }
    merged.push([s, e]);
    merged.sort((a, b) => a[0] - b[0]);
    return merged;
  }

  function totalLength(ranges) {
    return ranges.reduce((sum, [s, e]) => sum + (e - s), 0);
  }

  // 1つのタブの中で使う判定器。update() に再生状態を渡すと、外すべき時に一度だけ true を返す
  function createWatchLaterProgressTracker() {
    let current = null; // 再生中の動画ごとの状態
    const handled = new Set(); // 外す処理を始めた動画（同じ動画で何度も外そうとしない）

    function resetFor(videoId) {
      current = { videoId, prev: null, ranges: [], crossed: false, armed: false };
    }

    // sample: { videoId, time, duration, wallMs, rate, eligible, discontinuity }
    //  - eligible: 広告・ライブ・プレミア待機中などでないか（false の間は数えない）
    //  - discontinuity: 前回のサンプルとの間にシーク・メディアの読み込みがあったか
    function update(sample, config) {
      const cfg = normalizeConfig(config);
      if (!sample || !sample.videoId) return false;
      if (!current || current.videoId !== sample.videoId) resetFor(sample.videoId);

      const { time, duration } = sample;
      if (!cfg.enabled || !sample.eligible || !Number.isFinite(duration) || duration <= 0 ||
          !Number.isFinite(time) || time < 0) {
        // 対象外の間（広告など）の時間は数えず、復帰後の最初のサンプルを起点にし直す
        current.prev = null;
        return false;
      }

      const threshold = duration * cfg.percent / 100;
      const prev = current.prev;
      if (prev && prev.duration === duration) {
        const crossesThreshold = prev.time < threshold && time >= threshold;
        if (!sample.discontinuity && isPlaybackStep(prev, sample)) {
          current.ranges = addRange(current.ranges, prev.time, time);
          if (crossesThreshold) current.crossed = true;
        } else if (sample.discontinuity && crossesThreshold && time - prev.time <= SMALL_SEEK_SECONDS) {
          // 矢印キー（5秒）や「l」キー（10秒）の早送りで閾値をまたいだ場合も、再生して通過したとみなす
          // （再生した区間には数えない）
          current.crossed = true;
        }
      }
      // SPA遷移の直後は前の動画の終端付近の位置が残ることがあるため、
      // この動画で閾値より手前の位置を一度見てからでないと position モードでは外さない
      if (time < threshold) current.armed = true;
      current.prev = { time, duration, wallMs: sample.wallMs };

      if (handled.has(sample.videoId)) return false;
      let reached = false;
      if (cfg.mode === 'crossing') reached = current.crossed;
      else if (cfg.mode === 'coverage') reached = totalLength(current.ranges) >= threshold;
      else reached = current.armed && time >= threshold;

      if (reached) handled.add(sample.videoId);
      return reached;
    }

    return {
      update,
      isHandled(videoId) { return handled.has(videoId); },
      getPlayedSeconds() { return current ? totalLength(current.ranges) : 0; }
    };
  }

  // get_add_to_playlist の応答から「後で見る」の項目を取り出す
  // 戻り値: { contains: true|false|null, removeEndpoint: playlistEditEndpoint|null } / 見つからなければ null
  function findWatchLaterOption(response) {
    let found = null;
    (function walk(node, depth) {
      if (found || !node || typeof node !== 'object' || depth > 12) return;
      if (node.playlistId === 'WL' && 'containsSelectedVideos' in node) {
        found = node;
        return;
      }
      for (const key of Object.keys(node)) walk(node[key], depth + 1);
    })(response, 0);
    if (!found) return null;
    const containsValue = found.containsSelectedVideos;
    const contains = containsValue === 'ALL' ? true : containsValue === 'NONE' ? false : null;
    const endpoint = found.removeFromPlaylistServiceEndpoint &&
      found.removeFromPlaylistServiceEndpoint.playlistEditEndpoint;
    return { contains, removeEndpoint: endpoint && Array.isArray(endpoint.actions) ? endpoint : null };
  }

  // 削除の edit_playlist の本文。YouTube が保存ダイアログ用に返した削除操作をそのまま使い、
  // 無ければ同じ形（ACTION_REMOVE_VIDEO_BY_VIDEO_ID）を組み立てる
  function buildRemoveRequest(videoId, removeEndpoint) {
    const valid = removeEndpoint && removeEndpoint.playlistId === 'WL' &&
      removeEndpoint.actions.length > 0 &&
      removeEndpoint.actions.every(a => a && a.removedVideoId === videoId);
    if (valid) return { playlistId: 'WL', actions: removeEndpoint.actions };
    return {
      playlistId: 'WL',
      actions: [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId }]
    };
  }

  const api = {
    MODES,
    DEFAULT_CONFIG,
    MIN_PERCENT,
    MAX_PERCENT,
    normalizeConfig,
    isPlaybackStep,
    addRange,
    totalLength,
    createWatchLaterProgressTracker,
    findWatchLaterOption,
    buildRemoveRequest
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YouTubeUnwatchedOpenerWatchLater = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
