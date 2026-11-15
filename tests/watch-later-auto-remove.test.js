// watch-later-auto-remove.js（メインワールド側）を、プレイヤー・ytcfg・fetch を差し替えた環境で動かす
// 実行: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CORE_SRC = fs.readFileSync(path.join(ROOT, 'watch-later-progress.js'), 'utf8');
const GLUE_SRC = fs.readFileSync(path.join(ROOT, 'watch-later-auto-remove.js'), 'utf8');

function addToPlaylistResponse(contains, videoId) {
  return {
    contents: [{
      addToPlaylistRenderer: {
        playlists: [{
          playlistAddToOptionRenderer: {
            playlistId: 'WL',
            containsSelectedVideos: contains,
            removeFromPlaylistServiceEndpoint: {
              playlistEditEndpoint: {
                playlistId: 'WL',
                actions: [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId }]
              }
            }
          }
        }]
      }
    }]
  };
}

function createEnvironment({ inWatchLater = true, loggedIn = true, settings = { enabled: true, percent: 90, mode: 'crossing' }, editStatus = 200, search = '?v=vid1', playlist = null } = {}) {
  const listeners = {};
  const results = [];
  const requests = [];
  const timers = [];
  const navigations = [];
  let wallMs = 0;

  class HTMLVideoElement {
    constructor(player) { this.player = player; }
    closest(selector) { return selector === '#movie_player' ? this.player : null; }
  }

  const player = {
    classList: { classes: new Set(), contains(c) { return this.classes.has(c); } },
    videoData: { video_id: 'vid1', isLive: false },
    time: 0,
    duration: 100,
    getVideoData() { return this.videoData; },
    getCurrentTime() { return this.time; },
    getDuration() { return this.duration; },
    getPlaybackRate() { return 1; },
    getPlayerResponse() { return { videoDetails: { isLive: false, isUpcoming: false } }; },
    getPlaylistId() { return playlist ? 'WL' : null; },
    getPlaylist() { return playlist; },
    getPlaylistIndex() { return playlist ? playlist.indexOf(this.videoData.video_id) : -1; },
    state: 1,
    getPlayerState() { return this.state; },
    nextVideoCalls: 0,
    nextVideo() { this.nextVideoCalls++; if (this.onNextVideo) this.onNextVideo(); },
    contains(node) { return node === video; }
  };
  const video = new HTMLVideoElement(player);

  const document = {
    cookie: 'PREF=x; SAPISID=abc123; other=1',
    documentElement: {
      getAttribute: (name) => name === 'data-youtube-unwatched-opener-watch-later' ? JSON.stringify(settings) : null
    },
    getElementById: (id) => id === 'movie_player' ? player : null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatchEvent(event) {
      if (event.type === 'youtube-unwatched-opener:watch-later-auto-remove') results.push(JSON.parse(event.detail));
      for (const fn of listeners[event.type] || []) fn(event);
      return true;
    }
  };

  const ytcfgValues = {
    LOGGED_IN: loggedIn,
    INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '2.2026', visitorData: 'visitor' } },
    INNERTUBE_CONTEXT_CLIENT_NAME: 1,
    INNERTUBE_CLIENT_VERSION: '2.2026',
    SESSION_INDEX: 0
  };

  async function fetch(url, init) {
    const body = JSON.parse(init.body);
    requests.push({ url, headers: init.headers, body });
    if (url.includes('playlist/get_add_to_playlist')) {
      return { ok: true, status: 200, json: async () => addToPlaylistResponse(inWatchLater ? 'ALL' : 'NONE', body.videoIds[0]) };
    }
    if (url.includes('browse/edit_playlist')) {
      return { ok: editStatus === 200, status: editStatus, json: async () => ({ status: editStatus === 200 ? 'STATUS_SUCCEEDED' : undefined }) };
    }
    throw new Error(`unexpected ${url}`);
  }

  const window = {
    location: { pathname: '/watch', search, origin: 'https://www.youtube.com', assign: (url) => navigations.push(url) },
    ytcfg: { get: (key) => ytcfgValues[key] }
  };
  const context = {
    window,
    document,
    HTMLVideoElement,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    Event: class { constructor(type) { this.type = type; } },
    performance: { now: () => wallMs },
    crypto: globalThis.crypto,
    TextEncoder,
    URLSearchParams,
    setTimeout: (fn) => timers.push(fn),
    fetch,
    console
  };
  context.globalThis = context;
  Object.assign(window, { YouTubeUnwatchedOpenerWatchLater: undefined });
  vm.createContext(context);
  vm.runInContext(CORE_SRC, context);
  // コアは globalThis（= context）に生やすため、window からも参照できるようにする
  window.YouTubeUnwatchedOpenerWatchLater = context.YouTubeUnwatchedOpenerWatchLater;
  vm.runInContext(GLUE_SRC, context);

  function fire(type) {
    for (const fn of listeners[type] || []) fn({ type, target: video });
  }

  return {
    player,
    results,
    requests,
    navigations,
    fire,
    // 待ち時間（setTimeout）を進める
    runTimers() {
      const pending = timers.splice(0);
      pending.forEach(fn => fn());
    },
    play(seconds) {
      for (let i = 0; i < seconds * 4; i++) {
        wallMs += 250;
        player.time = Math.min(player.duration, player.time + 0.25);
        fire('timeupdate');
      }
    },
    seek(to) {
      fire('seeking');
      wallMs += 50;
      player.time = to;
      fire('timeupdate');
    },
    flush: () => new Promise(resolve => setTimeout(resolve, 20))
  };
}

test('後で見るに入っている動画は、90%を再生で通過した時に一度だけ外す', async () => {
  const env = createEnvironment();
  env.play(89);
  await env.flush();
  assert.equal(env.requests.length, 0);
  env.play(11);
  await env.flush();
  assert.deepEqual(env.requests.map(r => r.url.split('?')[0]), [
    '/youtubei/v1/playlist/get_add_to_playlist',
    '/youtubei/v1/browse/edit_playlist'
  ]);
  const edit = env.requests[1];
  assert.deepEqual(edit.body.actions, [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: 'vid1' }]);
  assert.equal(edit.body.playlistId, 'WL');
  assert.match(edit.headers.Authorization, /^SAPISIDHASH \d+_[0-9a-f]{40}$/);
  assert.equal(edit.headers['X-Origin'], 'https://www.youtube.com');
  assert.deepEqual(env.results, [{ videoId: 'vid1', result: 'removed', status: 200, percent: 90 }]);

  env.seek(50);
  env.play(50);
  await env.flush();
  assert.equal(env.requests.length, 2, '同じ動画で再び外そうとしない');
});

test('後で見るに入っていない動画は確認だけして何も知らせない', async () => {
  const env = createEnvironment({ inWatchLater: false });
  env.play(100);
  await env.flush();
  assert.equal(env.requests.length, 1);
  assert.deepEqual(env.results, []);
});

test('シークで95%に飛んだだけでは外さない（crossing）', async () => {
  const env = createEnvironment();
  env.play(3);
  env.seek(95);
  env.play(5);
  await env.flush();
  assert.equal(env.requests.length, 0);
});

test('広告の再生中は数えず、ライブ・未ログイン・ショートのページでは外さない', async () => {
  const ad = createEnvironment();
  ad.player.classList.classes.add('ad-showing');
  ad.play(100);
  await ad.flush();
  assert.equal(ad.requests.length, 0, '広告');

  const live = createEnvironment();
  live.player.videoData.isLive = true;
  live.play(100);
  await live.flush();
  assert.equal(live.requests.length, 0, 'ライブ');

  const loggedOut = createEnvironment({ loggedIn: false });
  loggedOut.play(100);
  await loggedOut.flush();
  assert.equal(loggedOut.requests.length, 0, '未ログイン');
});

test('設定でオフなら外さない', async () => {
  const env = createEnvironment({ settings: { enabled: false, percent: 90, mode: 'crossing' } });
  env.play(100);
  await env.flush();
  assert.equal(env.requests.length, 0);
});

test('削除に失敗したら remove-failed を知らせる', async () => {
  const env = createEnvironment({ editStatus: 403 });
  env.play(100);
  await env.flush();
  assert.deepEqual(env.results, [{ videoId: 'vid1', result: 'remove-failed', status: 403, percent: 90 }]);
});

test('後で見るのリストから続けて再生している時も外し、YouTube が次へ進めば何もしない', async () => {
  const env = createEnvironment({ search: '?v=vid1&list=WL', playlist: ['vid1', 'vid2'] });
  env.play(100);
  await env.flush();
  assert.equal(env.results[0].result, 'removed');
  env.player.state = 0;
  env.fire('ended');
  // YouTube がリストの次の動画へ進んだ
  env.player.videoData = { video_id: 'vid2', isLive: false };
  env.player.state = 1;
  env.runTimers();
  env.runTimers();
  assert.equal(env.player.nextVideoCalls, 0);
  assert.deepEqual(env.navigations, []);
});

test('外したあとに次の動画へ進まなければ、プレイヤーで次へ進め、それでも駄目ならページを移る', async () => {
  const env = createEnvironment({ search: '?v=vid1&list=WL', playlist: ['vid1', 'vid2'] });
  env.play(100);
  await env.flush();
  env.player.state = 0;
  env.fire('ended');
  env.runTimers(); // 3秒後: 進んでいない → nextVideo()
  assert.equal(env.player.nextVideoCalls, 1);
  env.runTimers(); // さらに3秒後: まだ進んでいない → 次の動画のページへ
  assert.deepEqual(env.navigations, ['/watch?v=vid2&list=WL']);
});

test('nextVideo() で進んだらページは移らない', async () => {
  const env = createEnvironment({ search: '?v=vid1&list=WL', playlist: ['vid1', 'vid2'] });
  env.player.onNextVideo = () => { env.player.videoData = { video_id: 'vid2', isLive: false }; env.player.state = 1; };
  env.play(100);
  await env.flush();
  env.player.state = 0;
  env.fire('ended');
  env.runTimers();
  env.runTimers();
  assert.equal(env.player.nextVideoCalls, 1);
  assert.deepEqual(env.navigations, []);
});

test('リストの最後の動画や、リスト外の再生では次へ進めない', async () => {
  for (const options of [{ search: '?v=vid1&list=WL', playlist: ['vid0', 'vid1'] }, {}]) {
    const env = createEnvironment(options);
    env.play(100);
    await env.flush();
    assert.equal(env.results[0].result, 'removed');
    env.player.state = 0;
    env.fire('ended');
    env.runTimers();
    env.runTimers();
    assert.equal(env.player.nextVideoCalls, 0);
    assert.deepEqual(env.navigations, []);
  }
});

test('削除の応答より先に再生が終わった場合も、止まっていれば次へ進める', async () => {
  const env = createEnvironment({ search: '?v=vid1&list=WL', playlist: ['vid1', 'vid2'] });
  env.play(100); // 90%で確認・削除が始まり、応答を待つ間に最後まで再生される
  env.player.state = 0;
  env.fire('ended');
  await env.flush(); // ここで削除が完了する
  env.runTimers();
  assert.equal(env.player.nextVideoCalls, 1);
});
