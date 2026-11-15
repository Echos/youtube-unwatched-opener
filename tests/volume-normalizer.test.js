// volume-normalizer.js を、Web Audio API を真似た仮の環境で動かして確かめる
// - AudioParam に範囲外の値を入れていないか（Chrome は範囲外の値を入れるたびにコンソールへ警告を出す）
// - コンプレッサーの閾値を必要な時だけ設定しているか
// 実行: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'volume-normalizer.js'), 'utf8');

// Chrome の AudioParam の値の範囲（nominal range）
const RANGES = {
  DynamicsCompressor: {
    threshold: [-100, 0], knee: [0, 40], ratio: [1, 20], attack: [0, 1], release: [0, 1]
  }
};

function createAudioEnvironment({ targetLufs, enabled = true, voiceEmphasis = true }) {
  const warnings = [];
  const thresholdSets = [];

  let compressorCount = 0;
  // isCompressor: 1つ目の DynamicsCompressor（コンプレッサー。2つ目はリミッター）
  function makeParam(nodeType, name, initial, isCompressor = false) {
    const range = (RANGES[nodeType] || {})[name];
    let value = initial;
    const check = (v, how) => {
      if (range && (v < range[0] || v > range[1])) {
        warnings.push(`${nodeType}.${name}.${how} ${v} outside nominal range [${range[0]}, ${range[1]}]`);
      }
    };
    return {
      get value() { return value; },
      set value(v) {
        check(v, 'value');
        if (isCompressor && name === 'threshold') thresholdSets.push(v);
        value = range ? Math.min(range[1], Math.max(range[0], v)) : v;
      },
      setTargetAtTime(v) { check(v, 'setTargetAtTime'); value = v; return this; }
    };
  }

  function makeNode(nodeType, params = {}, isCompressor = false) {
    const node = { connect() {}, disconnect() {}, reduction: 0, channelCount: 2 };
    for (const [name, initial] of Object.entries(params)) node[name] = makeParam(nodeType, name, initial, isCompressor);
    return node;
  }

  class AudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = makeNode('Destination');
    }
    resume() { return Promise.resolve(); }
    createMediaElementSource() { return makeNode('MediaElementSource'); }
    createGain() { return makeNode('Gain', { gain: 1 }); }
    createBiquadFilter() { return makeNode('BiquadFilter', { frequency: 350, Q: 1, gain: 0 }); }
    createChannelSplitter() { return makeNode('ChannelSplitter'); }
    createChannelMerger() { return makeNode('ChannelMerger'); }
    createDynamicsCompressor() {
      compressorCount++;
      return makeNode('DynamicsCompressor', { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }, compressorCount === 1);
    }
    createAnalyser() {
      const node = makeNode('Analyser');
      node.fftSize = 2048;
      // 一定のレベルの音（振幅0.1の正弦波）が流れている
      node.getFloatTimeDomainData = (buffer) => {
        for (let i = 0; i < buffer.length; i++) buffer[i] = 0.1 * Math.sin(i / 10);
      };
      return node;
    }
  }

  const listeners = {};
  const intervals = [];
  const player = { getVolume: () => 100 };
  const video = { volume: 1, closest: () => player, addEventListener() {} };
  let settingsJson = JSON.stringify({ enabled, targetLufs, voiceEmphasis, showOverlay: false });

  const document = {
    documentElement: { getAttribute: () => settingsJson },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelectorAll: (selector) => (selector === 'video.html5-main-video' ? [video] : [])
  };
  const context = {
    document,
    AudioContext,
    Float32Array,
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    setTimeout: () => 0,
    console: { log() {}, warn() {} }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(SRC, context, { filename: 'volume-normalizer.js' });

  return {
    warnings,
    thresholdSets,
    // 100ms ごとの計測を count 回進める
    tick(count) {
      const tick = intervals[1];
      for (let i = 0; i < count; i++) tick();
    },
    changeSettings(next) {
      settingsJson = JSON.stringify({ enabled, targetLufs, voiceEmphasis, showOverlay: false, ...next });
      for (const fn of listeners['youtube-unwatched-opener:volume-settings'] || []) fn({});
    },
    status: () => JSON.parse(JSON.stringify(context.__youtubeUnwatchedOpenerVolumeNormalizer.getStatus()))
  };
}

test('目標レベル -6 LUFS（報告された設定）でもコンプレッサーの閾値は範囲内で、警告は出ない', () => {
  const env = createAudioEnvironment({ targetLufs: -6 });
  env.tick(100); // 10秒分
  assert.deepEqual(env.warnings, []);
  assert.deepEqual(env.thresholdSets, [0], '0dBFS（表せる上限）を1回だけ設定する');
});

test('設定できる目標レベル（-30〜-6 LUFS）のどれでも、範囲外の値を入れない', () => {
  for (let target = -30; target <= -6; target++) {
    const env = createAudioEnvironment({ targetLufs: target });
    env.tick(20);
    assert.deepEqual(env.warnings, [], `目標 ${target} LUFS`);
    const expected = Math.min(0, target + 12);
    assert.deepEqual(env.thresholdSets, [expected], `目標 ${target} LUFS の閾値`);
  }
});

test('目標が -12 LUFS 以下なら、閾値は従来どおり目標 + 12dB', () => {
  const env = createAudioEnvironment({ targetLufs: -14 });
  env.tick(10);
  assert.deepEqual(env.thresholdSets, [-2]);
  assert.equal(env.status().videos[0].compressorThresholdDb, -2);
});

test('閾値は100msごとに設定し直さず、目標レベルを変えた時だけ設定する', () => {
  const env = createAudioEnvironment({ targetLufs: -14 });
  env.tick(300); // 30秒分
  assert.equal(env.thresholdSets.length, 1);

  env.changeSettings({ targetLufs: -20 });
  env.tick(50);
  assert.deepEqual(env.thresholdSets, [-2, -8]);

  env.changeSettings({ voiceEmphasis: false, targetLufs: -20 }); // 目標が同じなら設定しない
  env.tick(50);
  assert.deepEqual(env.thresholdSets, [-2, -8]);

  env.changeSettings({ targetLufs: -8 }); // 上限を超える目標に変えても範囲内
  env.tick(50);
  assert.deepEqual(env.thresholdSets, [-2, -8, 0]);
  assert.deepEqual(env.warnings, []);
});
