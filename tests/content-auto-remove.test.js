// content.js の「見終わった動画を後で見るから外す」の表示と順番待ちが、r キーと同じ処理を通ることを確かめる
// content.js をそのまま読み込み、DOM・拡張機能API は何をしても壊れない仮のオブジェクトで置き換える
// 実行: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CONTENT_SRC = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const READY_EVENT = 'youtube-unwatched-opener:watch-later-auto-remove';
const GO_EVENT = 'youtube-unwatched-opener:watch-later-auto-remove-go';

// 何を読んでも呼んでも new しても、同じ種類のオブジェクトを返す
function stub() {
  return new Proxy(function () {}, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === Symbol.iterator) return function* () {};
      if (prop === 'then') return undefined;
      if (prop === 'length') return 0;
      return stub();
    },
    apply: () => stub(),
    construct: () => stub(),
    set: () => true
  });
}

function loadContentScript() {
  const listeners = {};
  const timers = [];
  const dispatched = [];
  const state = { panel: null };

  const document = new Proxy({
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter(f => f !== fn); },
    dispatchEvent(event) {
      dispatched.push(event);
      for (const fn of [...(listeners[event.type] || [])]) fn(event);
      return true;
    },
    getElementById: (id) => (id === 'youtube-unwatched-opener-playlist-panel' ? state.panel : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => true,
    documentElement: { setAttribute() {}, getAttribute: () => null, dataset: {} },
    fullscreenElement: null,
    visibilityState: 'visible'
  }, {
    get(target, prop) { return prop in target ? target[prop] : stub(); }
  });

  const context = {
    document,
    location: { pathname: '/watch', search: '?v=vid1', href: 'https://www.youtube.com/watch?v=vid1' },
    history: { pushState() {}, replaceState() {} },
    browserAPI: {
      storage: {
        sync: { get: () => new Promise(() => {}), set: () => Promise.resolve() },
        onChanged: { addListener() {} }
      },
      runtime: { onMessage: { addListener() {} }, getURL: (f) => f, sendMessage: () => Promise.resolve() }
    },
    MutationObserver: class { observe() {} disconnect() {} },
    PerformanceObserver: class { observe() {} disconnect() {} },
    performance: { now: () => 0 },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    Event: class { constructor(type) { this.type = type; } },
    URLSearchParams,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    addEventListener() {},
    removeEventListener() {}
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(CONTENT_SRC, context, { filename: 'content.js' });

  // 表示とパネルの取り直しを記録に置き換える
  const calls = [];
  vm.runInContext(`
    toastController.show = (m, t, d) => __record('toast.show', m, t, d);
    toastController.update = (m, t, d) => __record('toast.update', m, t, d);
    centerToastController.show = (m, t, d) => __record('center.show', m, t, d);
    embedPlaylistDialog = (panel) => __record('embed', panel && panel.id);
    setPlaylistBusy = (panel, busy, text) => { panel._playlistBusy = busy; __record('busy', busy, text); };
  `, Object.assign(context, { __record: (...args) => calls.push(args) }));

  // vm の中で作った配列・オブジェクトは Node 側と型が違うため、比較用に作り直す
  const run = (code) => {
    const json = JSON.stringify(vm.runInContext(code, context));
    return json === undefined ? undefined : JSON.parse(json);
  };
  return {
    context,
    calls,
    state,
    run,
    // メインワールドからの知らせ（後で見るに入っていて、削除の準備ができた／結果）
    sendFromMainWorld(detail) {
      document.dispatchEvent({ type: READY_EVENT, detail: JSON.stringify(detail) });
    },
    goSignals: () => dispatched.filter(e => e.type === GO_EVENT).map(e => e.detail),
    flush: () => new Promise(resolve => setImmediate(resolve))
  };
}

function makePanel() {
  return { id: 'youtube-unwatched-opener-playlist-panel', _pendingToggles: [], _playlistBusy: false, _isEmbedding: false };
}

test('自動削除の表示は r キーで外す時と同じ（右上・中央とも、文言・種類・表示時間が一致）', async () => {
  // r キー: 後で見るに入っている状態で押す → trackPlaylistToggle(panel, 後で見る, false)
  const r = loadContentScript();
  r.run(`waitForPlaylistEditRequest = () => Promise.resolve({ ok: true, status: 200, duration: 900 });`);
  r.run(`trackPlaylistToggle(null, WATCH_LATER_TARGET, false)`);
  await r.flush();

  // 自動削除
  const auto = loadContentScript();
  auto.sendFromMainWorld({ type: 'ready', videoId: 'vid1', requestId: 'vid1:1' });
  assert.deepEqual(auto.goSignals(), ['vid1:1'], '順番待ちが無ければすぐに合図を返す');
  auto.sendFromMainWorld({ type: 'result', videoId: 'vid1', requestId: 'vid1:1', result: 'removed', status: 200, duration: 900 });
  await auto.flush();

  assert.deepEqual(auto.calls, r.calls);
  assert.deepEqual(auto.calls, [
    ['toast.show', '後で見るから削除中…', 'pending', 10000],
    ['center.show', '後で見るから削除中…', 'pending', 10000],
    ['toast.update', '後で見るから削除しました', 'success', 2000],
    ['center.show', '後で見るから削除しました', 'success', 1500]
  ]);
});

test('パネルがある時は r キーと同じくバッジを処理中にし、完了後にダイアログを取り直す', async () => {
  const env = loadContentScript();
  env.state.panel = makePanel();
  env.sendFromMainWorld({ type: 'ready', videoId: 'vid1', requestId: 'vid1:1' });
  env.sendFromMainWorld({ type: 'result', videoId: 'vid1', requestId: 'vid1:1', result: 'removed', status: 200 });
  await env.flush();
  const kinds = env.calls.map(c => c[0]);
  assert.deepEqual(kinds, ['toast.show', 'center.show', 'busy', 'toast.update', 'center.show', 'embed']);
  assert.deepEqual(env.calls[2], ['busy', true, '後で見るから削除中…']);
});

test('r キーの処理中（パネルが処理中）なら、自動削除はパネルの待ち行列に並び、前の操作の後で始まる', async () => {
  const env = loadContentScript();
  const panel = makePanel();
  panel._playlistBusy = true;
  env.state.panel = panel;
  env.sendFromMainWorld({ type: 'ready', videoId: 'vid1', requestId: 'vid1:1' });
  assert.deepEqual(env.goSignals(), [], 'まだ合図を返さない（edit_playlist が r キーの通信と重ならない）');
  assert.equal(panel._pendingToggles.length, 1);

  panel._playlistBusy = false;
  env.context.__panel = panel;
  env.run('runNextPendingToggle(__panel)');
  assert.deepEqual(env.goSignals(), ['vid1:1']);
});

test('パネルが無い時も、r キーの完了を待ってから自動削除を始め、その間の r キーは自動削除の後に回す', async () => {
  const env = loadContentScript();
  // r キーの切り替えが完了待ち
  env.run(`
    var __finishR;
    waitForPlaylistEditRequest = () => new Promise(resolve => { __finishR = resolve; });
    trackPlaylistToggle(null, WATCH_LATER_TARGET, true);
  `);
  env.sendFromMainWorld({ type: 'ready', videoId: 'vid1', requestId: 'vid1:1' });
  assert.deepEqual(env.goSignals(), [], 'r キーの完了前は合図を返さない');

  env.run('__finishR({ ok: true, status: 200, duration: 800 })');
  await env.flush();
  assert.deepEqual(env.goSignals(), ['vid1:1'], 'r キーの完了後に合図を返す');

  // 自動削除の完了待ちの間に r キーを押す → 自動削除の後に回る
  env.run(`var __toggled = []; findDirectSaveButton = () => { __toggled.push('direct'); return null; };`);
  env.run('togglePlaylist(WATCH_LATER_TARGET)');
  assert.deepEqual(env.run('__toggled'), [], '自動削除の完了前は r キーの切り替えを始めない');
  assert.deepEqual(env.calls.at(-2), ['toast.update', '前の操作の完了後に後で見るを切り替えます', 'pending', 10000]);

  env.sendFromMainWorld({ type: 'result', videoId: 'vid1', requestId: 'vid1:1', result: 'removed', status: 200 });
  await env.flush();
  assert.deepEqual(env.run('__toggled'), ['direct'], '自動削除の完了後に r キーの切り替えが始まる');
});

test('削除に失敗した時・確認できなかった時も r キーと同じ形で知らせる', async () => {
  const failed = loadContentScript();
  failed.sendFromMainWorld({ type: 'ready', videoId: 'vid1', requestId: 'vid1:1' });
  failed.sendFromMainWorld({ type: 'result', videoId: 'vid1', requestId: 'vid1:1', result: 'remove-failed', status: 403 });
  await failed.flush();
  assert.deepEqual(failed.calls.slice(-2), [
    ['toast.update', '後で見るの更新に失敗しました（HTTP 403）', 'error', 4000],
    ['center.show', '後で見るの更新に失敗しました（HTTP 403）', 'error', 1500]
  ]);

  const unknown = loadContentScript();
  unknown.sendFromMainWorld({ type: 'result', videoId: 'vid1', result: 'check-failed', status: 500 });
  assert.deepEqual(unknown.calls, [
    ['toast.show', '後で見るの登録状況を確認できませんでした', 'warning', 3000],
    ['center.show', '後で見るの登録状況を確認できませんでした', 'warning', 1500]
  ]);
});

test('別の動画に移ってから順番が来た場合は、今の動画のパネルを処理中にしない', async () => {
  const env = loadContentScript();
  env.state.panel = makePanel();
  env.context.location.search = '?v=vid2';
  env.sendFromMainWorld({ type: 'ready', videoId: 'vid1', requestId: 'vid1:1' });
  assert.ok(!env.calls.some(c => c[0] === 'busy'));
  assert.deepEqual(env.goSignals(), ['vid1:1']);
});
