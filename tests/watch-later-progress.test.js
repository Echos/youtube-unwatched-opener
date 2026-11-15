// 実行: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../watch-later-progress.js');

// 再生のシミュレーション: 0.25秒ごと（timeupdate の間隔）に位置を進めてサンプルを渡す
function createPlayer(config, { videoId = 'vid1', duration = 100 } = {}) {
  const tracker = core.createWatchLaterProgressTracker();
  let wallMs = 0;
  let time = 0;
  let pendingDiscontinuity = true;
  const fired = [];
  const state = { videoId, duration, eligible: true, rate: 1 };

  function sample() {
    const result = tracker.update({
      videoId: state.videoId,
      time,
      duration: state.duration,
      wallMs,
      rate: state.rate,
      eligible: state.eligible,
      discontinuity: pendingDiscontinuity
    }, config);
    pendingDiscontinuity = false;
    if (result) fired.push({ videoId: state.videoId, time });
  }

  return {
    tracker,
    fired,
    state,
    // seconds 秒ぶん（動画内の時間）再生する
    play(seconds) {
      const steps = Math.round(seconds / (0.25 * state.rate));
      for (let i = 0; i < steps; i++) {
        wallMs += 250;
        time = Math.min(state.duration, time + 0.25 * state.rate);
        sample();
      }
    },
    seek(to) {
      wallMs += 50;
      time = to;
      pendingDiscontinuity = true;
      sample();
    },
    // SPA遷移: video の位置は前の動画のまま、動画IDと長さだけ変わる → 新しいメディアが 0 秒から始まる
    navigate(newVideoId, newDuration) {
      state.videoId = newVideoId;
      state.duration = newDuration;
      wallMs += 100;
      sample();
      pendingDiscontinuity = true;
      time = 0;
    },
    get time() { return time; }
  };
}

const crossing = { enabled: true, percent: 90, mode: 'crossing' };
const coverage = { enabled: true, percent: 90, mode: 'coverage' };
const position = { enabled: true, percent: 90, mode: 'position' };

test('通常の再生で90%を通過したら一度だけ外す', () => {
  for (const config of [crossing, coverage, position]) {
    const p = createPlayer(config);
    p.play(89.5);
    assert.equal(p.fired.length, 0, `${config.mode}: 90%より前では外さない`);
    p.play(1);
    assert.equal(p.fired.length, 1, `${config.mode}: 90%で外す`);
    assert.ok(p.fired[0].time >= 90 && p.fired[0].time < 90.5);
    p.play(9.5);
    p.seek(10);
    p.play(85);
    assert.equal(p.fired.length, 1, `${config.mode}: 同じ動画では何度も外さない`);
  }
});

test('冒頭からシークで95%に飛んだだけ', () => {
  const run = (config) => {
    const p = createPlayer(config);
    p.play(5);
    p.seek(95);
    p.play(4);
    return p.fired.length;
  };
  assert.equal(run(crossing), 0, 'crossing: 外さない');
  assert.equal(run(coverage), 0, 'coverage: 外さない');
  assert.equal(run(position), 1, 'position: 外す');
});

test('80%に飛んでから90%を再生で通過した場合', () => {
  const run = (config) => {
    const p = createPlayer(config);
    p.play(5);
    p.seek(80);
    p.play(12);
    return p.fired.length;
  };
  assert.equal(run(crossing), 1, 'crossing: 再生して通過したので外す');
  assert.equal(run(coverage), 0, 'coverage: 再生した区間は17秒しかないので外さない');
  assert.equal(run(position), 1, 'position: 外す');
});

test('矢印キー程度の早送り（10秒以内）で90%をまたいでも crossing では通過とみなす', () => {
  const p = createPlayer(crossing);
  p.play(87);
  p.seek(92); // 5秒の早送り
  assert.equal(p.fired.length, 1);

  const far = createPlayer(crossing);
  far.play(70);
  far.seek(92); // 22秒の早送りは通過とみなさない
  far.play(5);
  assert.equal(far.fired.length, 0);
});

test('coverage は途中を飛ばしても再生した合計が90%に達したら外す', () => {
  const p = createPlayer(coverage, { duration: 200 });
  p.play(100);
  p.seek(110); // 10秒飛ばす
  p.play(79);
  assert.equal(p.fired.length, 0, '合計179秒（90%未満）では外さない');
  p.play(2); // 合計181秒（最初のサンプルは起点のため数えない）
  assert.equal(p.fired.length, 1);
  assert.ok(Math.abs(p.tracker.getPlayedSeconds() - 181) < 1);
});

test('同じ区間を繰り返し再生しても coverage では重ねて数えない', () => {
  const p = createPlayer(coverage);
  for (let i = 0; i < 5; i++) {
    p.seek(0);
    p.play(50);
  }
  assert.equal(p.fired.length, 0);
  assert.ok(Math.abs(p.tracker.getPlayedSeconds() - 50) < 1);
});

test('倍速再生でも再生として数える', () => {
  const p = createPlayer(coverage);
  p.state.rate = 2;
  p.play(95);
  assert.equal(p.fired.length, 1);
});

test('広告の間（eligible=false）は数えない', () => {
  const p = createPlayer(coverage);
  p.play(30);
  p.state.eligible = false; // 広告中にサンプルが届いても無視する
  p.play(70);
  assert.equal(p.fired.length, 0);
  assert.ok(Math.abs(p.tracker.getPlayedSeconds() - 30) < 1);
});

test('ライブ（長さが Infinity）は外さない', () => {
  const p = createPlayer(position, { duration: Infinity });
  p.play(100);
  assert.equal(p.fired.length, 0);
});

test('設定でオフなら外さない', () => {
  const p = createPlayer({ ...crossing, enabled: false });
  p.play(100);
  assert.equal(p.fired.length, 0);
});

test('閾値の%は設定に従う', () => {
  const p = createPlayer({ enabled: true, percent: 60, mode: 'crossing' });
  p.play(59.5);
  assert.equal(p.fired.length, 0);
  p.play(1);
  assert.equal(p.fired.length, 1);
});

test('SPA遷移の直後に前の動画の終端付近の位置が残っていても、次の動画を外さない', () => {
  for (const config of [crossing, coverage, position]) {
    const p = createPlayer(config, { duration: 100 });
    p.play(100); // 1本目を最後まで再生（ここで1本目は外す）
    assert.equal(p.fired.length, 1);
    p.navigate('vid2', 100); // 位置 100 のまま次の動画のIDに変わる
    assert.equal(p.fired.length, 1, `${config.mode}: 遷移直後に2本目を外さない`);
    p.play(50);
    assert.equal(p.fired.length, 1, `${config.mode}: 2本目は90%前`);
    p.play(45);
    assert.equal(p.fired.length, 2, `${config.mode}: 2本目も90%で外す`);
    assert.equal(p.fired[1].videoId, 'vid2');
  }
});

test('position モードでも、閾値より手前を一度見ていない動画は外さない（終端付近を指定して開いた場合）', () => {
  const p = createPlayer(position);
  p.seek(95);
  p.play(5);
  assert.equal(p.fired.length, 0);
});

test('別の動画に移ってから戻っても、一度外した動画は外し直さない', () => {
  const p = createPlayer(crossing);
  p.play(95);
  p.navigate('vid2', 100);
  p.play(10);
  p.navigate('vid1', 100);
  p.play(95);
  assert.deepEqual(p.fired.map(f => f.videoId), ['vid1']);
});

test('normalizeConfig は範囲外の値を丸める', () => {
  assert.deepEqual(core.normalizeConfig({ percent: 120, mode: 'x' }), { enabled: true, percent: 99, mode: 'crossing' });
  assert.deepEqual(core.normalizeConfig({ percent: 10, enabled: false, mode: 'coverage' }), { enabled: false, percent: 50, mode: 'coverage' });
  assert.equal(core.normalizeConfig({ percent: 'abc' }).percent, 90);
});

test('isPlaybackStep はシーク相当の大きな進みと巻き戻しを再生とみなさない', () => {
  const prev = { time: 10, wallMs: 0 };
  assert.equal(core.isPlaybackStep(prev, { time: 10.25, wallMs: 250, rate: 1 }), true);
  assert.equal(core.isPlaybackStep(prev, { time: 9, wallMs: 250, rate: 1 }), false);
  assert.equal(core.isPlaybackStep(prev, { time: 40, wallMs: 250, rate: 1 }), false);
  // 一時停止から再開した直後（壁時計は長く進むが位置は少し）は再生
  assert.equal(core.isPlaybackStep(prev, { time: 10.25, wallMs: 60000, rate: 1 }), true);
});

// get_add_to_playlist の応答（Chrome の実機で確認した形。動画IDは置き換え）
function makeAddToPlaylistResponse(contains, videoId = 'vid1') {
  return {
    responseContext: {},
    contents: [{
      addToPlaylistRenderer: {
        playlists: [
          {
            playlistAddToOptionRenderer: {
              playlistId: 'WL',
              title: { simpleText: '後で見る' },
              containsSelectedVideos: contains,
              addToPlaylistServiceEndpoint: {
                playlistEditEndpoint: { playlistId: 'WL', actions: [{ addedVideoId: videoId, action: 'ACTION_ADD_VIDEO' }] }
              },
              removeFromPlaylistServiceEndpoint: {
                playlistEditEndpoint: {
                  playlistId: 'WL',
                  actions: [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId }]
                }
              }
            }
          },
          { playlistAddToOptionRenderer: { playlistId: 'PLxxxx', containsSelectedVideos: 'ALL' } }
        ]
      }
    }]
  };
}

test('findWatchLaterOption は後で見るの登録状況と削除操作を取り出す', () => {
  const added = core.findWatchLaterOption(makeAddToPlaylistResponse('ALL'));
  assert.equal(added.contains, true);
  assert.equal(added.removeEndpoint.actions[0].action, 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID');
  assert.equal(core.findWatchLaterOption(makeAddToPlaylistResponse('NONE')).contains, false);
  assert.equal(core.findWatchLaterOption(makeAddToPlaylistResponse('SOME')).contains, null);
  assert.equal(core.findWatchLaterOption({ contents: [] }), null);
  assert.equal(core.findWatchLaterOption(null), null);
});

test('buildRemoveRequest は YouTube の削除操作を使い、無い・別の動画向けなら組み立てる', () => {
  const option = core.findWatchLaterOption(makeAddToPlaylistResponse('ALL', 'vid1'));
  assert.deepEqual(core.buildRemoveRequest('vid1', option.removeEndpoint), {
    playlistId: 'WL',
    actions: [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: 'vid1' }]
  });
  const fallback = { playlistId: 'WL', actions: [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: 'vid2' }] };
  assert.deepEqual(core.buildRemoveRequest('vid2', null), fallback);
  assert.deepEqual(core.buildRemoveRequest('vid2', option.removeEndpoint), fallback);
});
