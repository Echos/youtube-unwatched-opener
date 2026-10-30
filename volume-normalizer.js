// 再生音量の平滑化（どの動画でも指定したラウドネス(LUFS)に揃える）
//
// .html5-video-player の getVolume() は
// YouTube本体がメインワールドでDOM要素に生やしたメソッドのため、
// このファイルは <script> 注入でメインワールドで実行する。
// 設定は content.js が <html data-youtube-unwatched-opener-volume> にJSONで書き込み、
// 'youtube-unwatched-opener:volume-settings' イベントで変更を通知する。
//
// 信号経路: video → [video.volume打ち消しGain] → [声の強調] → [ラウドネス補正Gain] → [コンプレッサー]
//                → [リミッター] → [スライダー音量Gain] → 出力
//          声の強調の出力 → [K特性近似フィルタ] → Analyser（補正量を決める計測用。出力には流さない）
//          リミッター → [K特性近似フィルタ] → Analyser（補正後の確認用。可視化オーバーレイ表示時に使う）
//
// 補正量は15秒窓・相対ゲート付きの推定で決める。声の合間のBGMだけの区間で利得を上げたり、
// コンプレッサーで声のピークだけを潰したりすると、BGMが声より持ち上がって聞こえるため
(function() {
  'use strict';

  if (window.__youtubeUnwatchedOpenerVolumeNormalizerLoaded) {
    return;
  }
  window.__youtubeUnwatchedOpenerVolumeNormalizerLoaded = true;

  const LOG_PREFIX = '[YouTube未視聴動画オープナー/音量平滑化]';
  const SETTINGS_ATTR = 'data-youtube-unwatched-opener-volume';
  const SETTINGS_EVENT = 'youtube-unwatched-opener:volume-settings';

  const MEASURE_INTERVAL_MS = 100;
  // 補正量は長めの窓（15秒）で決め、声の合間やBGMだけの区間で利得が持ち上がらないようにする。
  // 3秒窓（EBU R128のshort-term相当）は急に大きくなった時に素早く下げる判定にだけ使う
  const LONG_WINDOW_BLOCKS = 150;    // 100ms × 150 = 15秒
  const SHORT_WINDOW_BLOCKS = 30;    // 100ms × 30 = 3秒
  const MIN_BLOCKS_FOR_ESTIMATE = 5; // 0.5秒分の計測が貯まるまでは直前の補正量を維持する
  const SILENCE_GATE_LUFS = -60;     // 無音区間で利得を上げ続けないよう、これ以下のブロックは無視する
  // BS.1770の相対ゲート。窓内の平均より10LU以上小さいブロック（声の合間に残るBGMなど）を推定から外し、
  // 主に聞かせたい音（多くは声）のレベルに合わせる
  const RELATIVE_GATE_LU = -10;
  const SUDDEN_LOUD_LU = 3;          // 3秒窓が15秒窓よりこれ以上大きい時は3秒窓に合わせて素早く下げる
  const MAX_BOOST_DB = 15;
  const MAX_CUT_DB = -25;
  const MAX_VOLUME_COMPENSATION_DB = 30; // video.volume の減衰を打ち消す量の上限
  // コンプレッサーは突発的なピークを抑えるだけにする。閾値を目標ラウドネス付近に置くと
  // 波高率の大きい声のピークだけが潰され、波高率の小さいBGMが相対的に大きく聞こえる
  const COMPRESSOR_THRESHOLD_OFFSET_DB = 12;
  const TIME_CONSTANT_DOWN = 0.5;    // 大きくなった時は早めに下げる
  const TIME_CONSTANT_UP = 3.0;      // 小さくなった時はゆっくり上げる（ポンピング防止）
  // Analyserはステレオをモノラル平均にダウンミックスするため、BS.1770のチャンネル総和との差(+3dB)を補正する
  const LUFS_OFFSET = -0.691 + 3.01;

  // 声の強調。声は中央に定位し、BGMは左右に広がっていることが多いため、
  // サイド成分（L-R）を下げて相対的に声を前に出し、声の明瞭度に効く帯域を少し持ち上げる
  const VOICE_SIDE_GAIN = 0.6;        // サイド成分の倍率（約-4.4dB）
  const VOICE_PRESENCE_HZ = 2500;
  const VOICE_PRESENCE_DB = 3;
  const VOICE_LOW_SHELF_HZ = 180;     // BGMのベース・キックが声を覆い隠しやすい帯域
  const VOICE_LOW_SHELF_DB = -3;

  // 可視化オーバーレイ
  const OVERLAY_HISTORY_BLOCKS = 150; // グラフに表示する履歴（100ms × 150 = 15秒）
  const OVERLAY_MIN_LUFS = -50;
  const OVERLAY_MAX_LUFS = 0;
  const OVERLAY_WIDTH = 240;
  const OVERLAY_HEIGHT = 72;

  let settings = { enabled: false, targetLufs: -14, voiceEmphasis: true, showOverlay: false };
  let audioContext = null;
  const chains = new Map(); // HTMLVideoElement -> chain

  function readSettings() {
    try {
      const raw = document.documentElement.getAttribute(SETTINGS_ATTR);
      if (raw) {
        const parsed = JSON.parse(raw);
        settings = {
          enabled: !!parsed.enabled,
          targetLufs: Number.isFinite(parsed.targetLufs) ? parsed.targetLufs : -14,
          voiceEmphasis: parsed.voiceEmphasis !== false,
          showOverlay: !!parsed.showOverlay
        };
      }
    } catch (e) {
      console.log(`${LOG_PREFIX} 設定の読み込みに失敗しました`, e);
    }
  }

  function dbToGain(db) {
    return Math.pow(10, db / 20);
  }

  function gainToDb(gain) {
    return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
  }

  function getPlayer(video) {
    return video.closest('.html5-video-player');
  }

  // ユーザーが操作する音量スライダーの値(0〜1)。
  // video.volume にはYouTube自身のラウドネス正規化による減衰も掛かっているため、
  // スライダー値はプレイヤーAPIから取得する（取得できない場合は video.volume で代用）
  function getUserVolume(video) {
    const player = getPlayer(video);
    if (player && typeof player.getVolume === 'function') {
      return player.getVolume() / 100;
    }
    return video.volume;
  }

  function ensureAudioContext() {
    if (!audioContext) {
      audioContext = new AudioContext();
    }
    return audioContext;
  }

  function createKWeightedAnalyser(ctx) {
    // ITU-R BS.1770 のK特性を近似（低域カット＋高域シェルフ）
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 38;
    highpass.Q.value = 0.5;
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 1681;
    shelf.gain.value = 4;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    highpass.connect(shelf);
    shelf.connect(analyser);
    return { input: highpass, analyser };
  }

  // 声の強調段。input/output と、ON/OFFで切り替えるパラメータを返す
  function createVoiceEmphasis(ctx) {
    // モノラル素材を左右同じ信号に広げてからM/S処理する（そのままだと右チャンネルが無音扱いになり左右が崩れる）
    const input = ctx.createGain();
    input.channelCount = 2;
    input.channelCountMode = 'explicit';
    input.channelInterpretation = 'speakers';

    // L' = L·(1+k)/2 + R·(1-k)/2、R' = R·(1+k)/2 + L·(1-k)/2（k=サイド成分の倍率）
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const direct = [ctx.createGain(), ctx.createGain()];
    const cross = [ctx.createGain(), ctx.createGain()];
    input.connect(splitter);
    for (let ch = 0; ch < 2; ch++) {
      splitter.connect(direct[ch], ch);
      splitter.connect(cross[ch], ch);
      direct[ch].connect(merger, 0, ch);
      cross[ch].connect(merger, 0, 1 - ch);
    }

    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = VOICE_LOW_SHELF_HZ;
    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = VOICE_PRESENCE_HZ;
    presence.Q.value = 0.8;
    merger.connect(lowShelf);
    lowShelf.connect(presence);

    return {
      input,
      output: presence,
      apply(enabled) {
        const k = enabled ? VOICE_SIDE_GAIN : 1;
        const now = ctx.currentTime;
        direct.forEach(node => node.gain.setTargetAtTime((1 + k) / 2, now, 0.05));
        cross.forEach(node => node.gain.setTargetAtTime((1 - k) / 2, now, 0.05));
        lowShelf.gain.setTargetAtTime(enabled ? VOICE_LOW_SHELF_DB : 0, now, 0.05);
        presence.gain.setTargetAtTime(enabled ? VOICE_PRESENCE_DB : 0, now, 0.05);
      }
    };
  }

  function createChain(video) {
    const ctx = audioContext;
    const source = ctx.createMediaElementSource(video);

    // Chromeでは video.volume / muted がMediaElementSourceの出力に反映される（実測で線形）ため、
    // その減衰をここで打ち消し、以降の処理を常に素材そのもののレベルで行う
    const volumeCompensation = ctx.createGain();
    const voiceEmphasis = createVoiceEmphasis(ctx);
    const gain = ctx.createGain();

    // 補正Gainで持ち上げた後の突発的なピークを軽く抑える
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = settings.targetLufs + COMPRESSOR_THRESHOLD_OFFSET_DB;
    compressor.knee.value = 6;
    compressor.ratio.value = 2;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.2;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;

    // 声の強調の後で計測する（強調で変わったレベルも含めて目標に合わせるため）
    const inputMeter = createKWeightedAnalyser(ctx);
    // 補正後（スライダー音量を掛ける前）のレベル。目標ラウドネスに揃っているかの確認用
    const outputMeter = createKWeightedAnalyser(ctx);

    // スライダー音量はコンプレッサーより後段で掛ける。
    // 前段（video.volume）のままだとコンプレッサーに音量差を圧縮され、スライダーを下げても音が小さくならない
    const userVolume = ctx.createGain();
    userVolume.gain.value = getUserVolume(video);

    volumeCompensation.connect(voiceEmphasis.input);
    voiceEmphasis.output.connect(gain);
    voiceEmphasis.output.connect(inputMeter.input);
    gain.connect(compressor);
    compressor.connect(limiter);
    limiter.connect(userVolume);
    limiter.connect(outputMeter.input);
    userVolume.connect(ctx.destination);
    voiceEmphasis.apply(settings.voiceEmphasis);

    const chain = {
      video, source, volumeCompensation, voiceEmphasis, gain, compressor, limiter, userVolume,
      analyser: inputMeter.analyser,
      outputAnalyser: outputMeter.analyser,
      buffer: new Float32Array(inputMeter.analyser.fftSize),
      blocks: [],
      outputBlocks: [],
      // オーバーレイのグラフ用。無音・停止中は null を入れて線を途切れさせる
      inputHistory: [],
      outputHistory: [],
      overlay: null,
      routedThroughChain: null
    };

    // 動画が切り替わったら前の動画の計測値を捨てる
    // （playerResponseの trackAbsoluteLoudnessLkfs は実測とのズレが動画ごとに一定でないため初期推定には使わない）
    video.addEventListener('loadedmetadata', () => {
      chain.blocks = [];
      chain.outputBlocks = [];
      chain.inputHistory = [];
      chain.outputHistory = [];
    });
    // 補正Gainの追従（時定数）を待たず、スライダー操作を即座に反映する
    video.addEventListener('volumechange', () => updateVolumeNodes(chain));
    updateVolumeNodes(chain);
    applyRouting(chain);
    return chain;
  }

  // 設定OFF時は video → 出力 に直結し、元の音をそのまま流す
  // （MediaElementSourceは一度作ると元の出力経路に戻せないため、グラフ側で切り替える）
  function applyRouting(chain) {
    const useChain = settings.enabled;
    if (chain.routedThroughChain === useChain) {
      return;
    }
    if (chain.routedThroughChain !== null) {
      chain.source.disconnect(chain.routedThroughChain ? chain.volumeCompensation : audioContext.destination);
    }
    chain.source.connect(useChain ? chain.volumeCompensation : audioContext.destination);
    chain.routedThroughChain = useChain;
  }

  function updateVolumeNodes(chain) {
    const now = audioContext.currentTime;
    const compensationDb = Math.min(MAX_VOLUME_COMPENSATION_DB, -gainToDb(chain.video.volume));
    chain.volumeCompensation.gain.setTargetAtTime(dbToGain(compensationDb), now, 0.01);
    chain.userVolume.gain.setTargetAtTime(getUserVolume(chain.video), now, 0.01);
  }

  function measureAnalyser(analyser, buffer) {
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      sum += buffer[i] * buffer[i];
    }
    const meanSquare = sum / buffer.length;
    if (meanSquare <= 0) {
      return null;
    }
    const lufs = LUFS_OFFSET + 10 * Math.log10(meanSquare);
    return lufs > SILENCE_GATE_LUFS ? lufs : null;
  }

  // 平均はエネルギー領域で取る（dBの単純平均だと小さい区間に引きずられる）
  function energyMean(blocks) {
    let energy = 0;
    for (const lufs of blocks) {
      energy += Math.pow(10, lufs / 10);
    }
    return 10 * Math.log10(energy / blocks.length);
  }

  // 直近 windowBlocks 分のブロックから相対ゲート付きでラウドネスを求める
  function gatedLoudness(blocks, windowBlocks) {
    const recent = blocks.length > windowBlocks ? blocks.slice(-windowBlocks) : blocks;
    if (recent.length < MIN_BLOCKS_FOR_ESTIMATE) {
      return null;
    }
    const threshold = energyMean(recent) + RELATIVE_GATE_LU;
    return energyMean(recent.filter(lufs => lufs >= threshold));
  }

  function estimateLoudness(chain) {
    const longTerm = gatedLoudness(chain.blocks, LONG_WINDOW_BLOCKS);
    if (longTerm === null) {
      return null;
    }
    // 小さくなった方向は15秒窓に任せ（BGMだけの区間を持ち上げない）、大きくなった方向だけ3秒窓で素早く追う
    const shortTerm = gatedLoudness(chain.blocks, SHORT_WINDOW_BLOCKS);
    if (shortTerm !== null && shortTerm > longTerm + SUDDEN_LOUD_LU) {
      return shortTerm;
    }
    return longTerm;
  }

  function pushLimited(list, value, max) {
    list.push(value);
    if (list.length > max) {
      list.shift();
    }
  }

  function updateChain(chain) {
    const video = chain.video;
    if (!settings.enabled || video.paused || video.muted || video.volume === 0) {
      if (settings.enabled && settings.showOverlay && !video.paused) {
        // ミュート中は計測できないため、グラフの線を途切れさせて状態だけ表示する
        pushLimited(chain.inputHistory, null, OVERLAY_HISTORY_BLOCKS);
        pushLimited(chain.outputHistory, null, OVERLAY_HISTORY_BLOCKS);
      }
      updateOverlay(chain);
      return;
    }

    // 計測点は打ち消しGainの後なので、video.volume による減衰を除いた素材そのもののレベルになる
    const block = measureAnalyser(chain.analyser, chain.buffer);
    if (block !== null) {
      pushLimited(chain.blocks, block, LONG_WINDOW_BLOCKS);
    }
    if (settings.showOverlay) {
      const output = measureAnalyser(chain.outputAnalyser, chain.buffer);
      if (output !== null) {
        pushLimited(chain.outputBlocks, output, LONG_WINDOW_BLOCKS);
      }
      pushLimited(chain.inputHistory, block, OVERLAY_HISTORY_BLOCKS);
      pushLimited(chain.outputHistory, output, OVERLAY_HISTORY_BLOCKS);
    }

    applyCorrection(chain);
    updateOverlay(chain);
  }

  function applyCorrection(chain) {
    const loudness = estimateLoudness(chain);
    if (loudness === null) {
      return;
    }

    // コンプレッサー入力が目標ラウドネスになるよう補正する（スライダー音量は後段の userVolume で掛ける）
    const correctionDb = Math.min(MAX_BOOST_DB, Math.max(MAX_CUT_DB, settings.targetLufs - loudness));
    const target = dbToGain(correctionDb);
    // getVolume() はvolumechangeを伴わずに変わることがあるため、念のため毎回同期する
    updateVolumeNodes(chain);
    chain.compressor.threshold.value = settings.targetLufs + COMPRESSOR_THRESHOLD_OFFSET_DB;
    const current = chain.gain.gain.value;
    const timeConstant = target < current ? TIME_CONSTANT_DOWN : TIME_CONSTANT_UP;
    chain.gain.gain.setTargetAtTime(target, audioContext.currentTime, timeConstant);
  }

  // ===== 可視化オーバーレイ =====
  // 素材のレベル（補正前）と補正後のレベルを15秒分のグラフで重ね、目標ラウドネスとの差と補正量・圧縮量を数値で出す

  function formatDb(value, signed) {
    if (value === null || !Number.isFinite(value)) {
      return '--';
    }
    const text = value.toFixed(1);
    return signed && value > 0 ? `+${text}` : text;
  }

  function createOverlay() {
    const root = document.createElement('div');
    root.className = 'youtube-unwatched-opener-volume-overlay';

    const header = document.createElement('div');
    header.className = 'vo-header';
    const title = document.createElement('span');
    title.className = 'vo-title';
    title.textContent = '音量平滑化';
    const state = document.createElement('span');
    state.className = 'vo-state';
    header.append(title, state);

    const canvas = document.createElement('canvas');
    canvas.className = 'vo-graph';
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(OVERLAY_WIDTH * ratio);
    canvas.height = Math.round(OVERLAY_HEIGHT * ratio);
    canvas.style.width = `${OVERLAY_WIDTH}px`;
    canvas.style.height = `${OVERLAY_HEIGHT}px`;

    const stats = document.createElement('div');
    stats.className = 'vo-stats';
    const values = {};
    [
      ['input', '素材', 'LUFS'],
      ['output', '補正後', 'LUFS'],
      ['gain', '補正', 'dB'],
      ['reduction', '圧縮', 'dB']
    ].forEach(([key, label, unit]) => {
      const item = document.createElement('div');
      item.className = `vo-stat vo-stat-${key}`;
      const labelEl = document.createElement('span');
      labelEl.className = 'vo-label';
      labelEl.textContent = label;
      const valueEl = document.createElement('span');
      valueEl.className = 'vo-value';
      const unitEl = document.createElement('span');
      unitEl.className = 'vo-unit';
      unitEl.textContent = unit;
      item.append(labelEl, valueEl, unitEl);
      stats.append(item);
      values[key] = valueEl;
    });

    root.append(header, canvas, stats);
    return { root, canvas, ratio, state, values };
  }

  function lufsToY(lufs) {
    const clamped = Math.min(OVERLAY_MAX_LUFS, Math.max(OVERLAY_MIN_LUFS, lufs));
    return (OVERLAY_MAX_LUFS - clamped) / (OVERLAY_MAX_LUFS - OVERLAY_MIN_LUFS) * OVERLAY_HEIGHT;
  }

  function drawHistory(g, history, color) {
    const step = OVERLAY_WIDTH / (OVERLAY_HISTORY_BLOCKS - 1);
    // 新しい値を右端に揃える
    const offset = OVERLAY_HISTORY_BLOCKS - history.length;
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.beginPath();
    let drawing = false;
    history.forEach((lufs, i) => {
      if (lufs === null) {
        drawing = false;
        return;
      }
      const x = (offset + i) * step;
      const y = lufsToY(lufs);
      if (drawing) {
        g.lineTo(x, y);
      } else {
        g.moveTo(x, y);
        drawing = true;
      }
    });
    g.stroke();
  }

  function drawGraph(overlay, chain) {
    const g = overlay.canvas.getContext('2d');
    g.setTransform(overlay.ratio, 0, 0, overlay.ratio, 0, 0);
    g.clearRect(0, 0, OVERLAY_WIDTH, OVERLAY_HEIGHT);

    g.font = '9px monospace';
    g.textBaseline = 'middle';
    g.lineWidth = 1;
    for (let lufs = -10; lufs > OVERLAY_MIN_LUFS; lufs -= 10) {
      const y = Math.round(lufsToY(lufs)) + 0.5;
      g.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(OVERLAY_WIDTH, y);
      g.stroke();
      g.fillStyle = 'rgba(255, 255, 255, 0.35)';
      g.fillText(String(lufs), 2, y - 5);
    }

    const targetY = Math.round(lufsToY(settings.targetLufs)) + 0.5;
    g.strokeStyle = 'rgba(255, 64, 64, 0.9)';
    g.setLineDash([4, 3]);
    g.beginPath();
    g.moveTo(0, targetY);
    g.lineTo(OVERLAY_WIDTH, targetY);
    g.stroke();
    g.setLineDash([]);

    drawHistory(g, chain.inputHistory, 'rgba(200, 200, 200, 0.7)');
    drawHistory(g, chain.outputHistory, '#3ea6ff');
  }

  function removeOverlay(chain) {
    if (chain.overlay) {
      chain.overlay.root.remove();
      chain.overlay = null;
    }
  }

  function updateOverlay(chain) {
    const player = getPlayer(chain.video);
    // 一覧ページのホバー再生（インラインプレイヤー）には出さず、動画ページのプレイヤーだけに出す
    if (!settings.enabled || !settings.showOverlay || !player || player.id !== 'movie_player') {
      removeOverlay(chain);
      return;
    }
    if (document.hidden) {
      return;
    }
    if (!chain.overlay) {
      chain.overlay = createOverlay();
    }
    const overlay = chain.overlay;
    if (overlay.root.parentNode !== player) {
      player.appendChild(overlay.root);
    }

    const video = chain.video;
    const inputLufs = estimateLoudness(chain);
    let state = `目標 ${settings.targetLufs} LUFS`;
    if (video.paused) {
      state = '一時停止中';
    } else if (video.muted || video.volume === 0) {
      state = 'ミュート中';
    } else if (inputLufs === null) {
      state = '計測中…';
    }
    overlay.state.textContent = state;

    // 素材側と同じ15秒窓・相対ゲートで求め、目標ラウドネスと比べられる値にする
    const outputLufs = gatedLoudness(chain.outputBlocks, LONG_WINDOW_BLOCKS);
    const reduction = chain.compressor.reduction + chain.limiter.reduction;
    overlay.values.input.textContent = formatDb(inputLufs, false);
    overlay.values.output.textContent = formatDb(outputLufs, false);
    overlay.values.gain.textContent = formatDb(gainToDb(chain.gain.gain.value), true);
    overlay.values.reduction.textContent = formatDb(reduction < -0.05 ? reduction : 0, false);

    drawGraph(overlay, chain);
  }

  function attachVideo(video) {
    if (chains.has(video)) {
      return;
    }
    const ctx = ensureAudioContext();
    // 自動再生ポリシーでAudioContextが停止中のまま経路を差し替えると無音になるため、
    // 実行中になったことを確認してから MediaElementSource を作る
    if (ctx.state !== 'running') {
      ctx.resume().catch(() => {});
      return;
    }
    try {
      chains.set(video, createChain(video));
      console.log(`${LOG_PREFIX} 音量平滑化を開始しました（目標 ${settings.targetLufs} LUFS）`);
    } catch (e) {
      // 既に他の拡張機能等が MediaElementSource を作成済みの場合など
      chains.set(video, null);
      console.log(`${LOG_PREFIX} 音声経路の作成に失敗しました`, e);
    }
  }

  function scan() {
    if (!settings.enabled) {
      return;
    }
    document.querySelectorAll('video.html5-main-video').forEach(attachVideo);
  }

  function tick() {
    for (const chain of chains.values()) {
      if (chain) {
        updateChain(chain);
      }
    }
  }

  function onSettingsChanged() {
    readSettings();
    for (const chain of chains.values()) {
      if (chain) {
        applyRouting(chain);
        chain.voiceEmphasis.apply(settings.voiceEmphasis);
        updateOverlay(chain);
      }
    }
    scan();
  }

  // 自動再生が許可されずAudioContextが停止している場合、最初のユーザー操作で再開する
  function resumeOnGesture() {
    if (audioContext && audioContext.state !== 'running') {
      audioContext.resume().then(scan).catch(() => {});
    }
  }

  // コンソールからの動作確認用: __youtubeUnwatchedOpenerVolumeNormalizer.getStatus()
  window.__youtubeUnwatchedOpenerVolumeNormalizer = {
    getStatus: () => ({
      settings,
      contextState: audioContext ? audioContext.state : 'none',
      videos: [...chains.values()].filter(Boolean).map(chain => ({
        loudnessLufs: estimateLoudness(chain),
        measuredBlocks: chain.blocks.length,
        gainDb: gainToDb(chain.gain.gain.value),
        outputLufs: gatedLoudness(chain.outputBlocks, LONG_WINDOW_BLOCKS),
        reductionDb: chain.compressor.reduction + chain.limiter.reduction,
        routedThroughChain: chain.routedThroughChain
      }))
    })
  };

  readSettings();
  document.addEventListener(SETTINGS_EVENT, onSettingsChanged);
  document.addEventListener('pointerdown', resumeOnGesture, true);
  document.addEventListener('keydown', resumeOnGesture, true);
  document.addEventListener('play', scan, true); // video要素のplayはバブリングしないためキャプチャで拾う
  setInterval(scan, 1000);
  setInterval(tick, MEASURE_INTERVAL_MS);
  scan();
})();
