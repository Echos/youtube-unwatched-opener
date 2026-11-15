// 再生音量の平滑化（どの動画でも指定したラウドネス(LUFS)に揃える）
//
// .html5-video-player の getVolume() は
// YouTube本体がメインワールドでDOM要素に生やしたメソッドのため、
// このファイルも quality-enforcer.js と同様に <script> 注入でメインワールドで実行する。
// 設定は content.js が <html data-youtube-unwatched-opener-volume> にJSONで書き込み、
// 'youtube-unwatched-opener:volume-settings' イベントで変更を通知する。
//
// 信号経路: video → [video.volume打ち消しGain] → [ラウドネス補正Gain] → [コンプレッサー] → [リミッター]
//                → [スライダー音量Gain] → 出力
//          video → [K特性近似フィルタ] → Analyser（計測用の分岐、出力には流さない）
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
  const COMPRESSOR_THRESHOLD_OFFSET_DB = 8;
  const TIME_CONSTANT_DOWN = 0.5;    // 大きくなった時は早めに下げる
  const TIME_CONSTANT_UP = 3.0;      // 小さくなった時はゆっくり上げる（ポンピング防止）
  // Analyserはステレオをモノラル平均にダウンミックスするため、BS.1770のチャンネル総和との差(+3dB)を補正する
  const LUFS_OFFSET = -0.691 + 3.01;

  let settings = { enabled: false, targetLufs: -14 };
  let audioContext = null;
  const chains = new Map(); // HTMLVideoElement -> chain

  function readSettings() {
    try {
      const raw = document.documentElement.getAttribute(SETTINGS_ATTR);
      if (raw) {
        const parsed = JSON.parse(raw);
        settings = {
          enabled: !!parsed.enabled,
          targetLufs: Number.isFinite(parsed.targetLufs) ? parsed.targetLufs : -14
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

  function createChain(video) {
    const ctx = audioContext;
    const source = ctx.createMediaElementSource(video);

    // Chromeでは video.volume / muted がMediaElementSourceの出力に反映される（実測で線形）ため、
    // その減衰をここで打ち消し、以降の処理を常に素材そのもののレベルで行う
    const volumeCompensation = ctx.createGain();
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

    // スライダー音量はコンプレッサーより後段で掛ける。
    // 前段（video.volume）のままだとコンプレッサーに音量差を圧縮され、スライダーを下げても音が小さくならない
    const userVolume = ctx.createGain();
    userVolume.gain.value = getUserVolume(video);

    volumeCompensation.connect(gain);
    gain.connect(compressor);
    compressor.connect(limiter);
    limiter.connect(userVolume);
    userVolume.connect(ctx.destination);
    source.connect(highpass);
    highpass.connect(shelf);
    shelf.connect(analyser);

    const chain = {
      video, source, volumeCompensation, gain, compressor, userVolume, analyser,
      buffer: new Float32Array(analyser.fftSize),
      blocks: [],
      routedThroughChain: null
    };

    // 動画が切り替わったら前の動画の計測値を捨てる
    // （playerResponseの trackAbsoluteLoudnessLkfs は実測とのズレが動画ごとに一定でないため初期推定には使わない）
    video.addEventListener('loadedmetadata', () => {
      chain.blocks = [];
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

  // 現在のブロックのラウドネス（video.volume による減衰を除いた素材そのものの値）
  function measureBlock(chain) {
    chain.analyser.getFloatTimeDomainData(chain.buffer);
    let sum = 0;
    for (let i = 0; i < chain.buffer.length; i++) {
      sum += chain.buffer[i] * chain.buffer[i];
    }
    const meanSquare = sum / chain.buffer.length;
    if (meanSquare <= 0) {
      return null;
    }
    // 計測分岐は volumeCompensation より前から取っているため、video.volume の分をここで戻す
    return LUFS_OFFSET + 10 * Math.log10(meanSquare) - gainToDb(chain.video.volume);
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

  function updateChain(chain) {
    const video = chain.video;
    if (!settings.enabled || video.paused || video.muted || video.volume === 0) {
      return;
    }

    const block = measureBlock(chain);
    if (block !== null && block > SILENCE_GATE_LUFS) {
      chain.blocks.push(block);
      if (chain.blocks.length > LONG_WINDOW_BLOCKS) {
        chain.blocks.shift();
      }
    }

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
