const DEFAULT_SETTINGS = {
  shortcutKey: 'ctrl+enter',
  videoCount: 5,
  enabled: true,
  highlightEnabled: true,
  highlightToggleKey: 'ctrl+shift+h',
  watchLaterKey: 'r',
  showPlaylistPanel: true,
  debugMode: false,
  historyMaxCount: 10000,
  includeShorts: true
};

// ========== DOM 参照 ==========
const el = {
  enabled:               document.getElementById('enabled'),
  shortcutKey:           document.getElementById('shortcutKey'),
  videoCount:            document.getElementById('videoCount'),
  highlightEnabled:      document.getElementById('highlightEnabled'),
  watchLaterKey:         document.getElementById('watchLaterKey'),
  showPlaylistPanel:     document.getElementById('showPlaylistPanel'),
  debugMode:             document.getElementById('debugMode'),
  historyMaxCount:       document.getElementById('historyMaxCount'),
  includeShorts:         document.getElementById('includeShorts'),
  statusDot:             document.getElementById('status-dot'),
  status:                document.getElementById('status'),
  toggleLabel:           document.getElementById('toggle-label'),
  videoCountError:      document.getElementById('videoCountError'),
  historyMaxCountError: document.getElementById('historyMaxCountError')
};

// ========== バリデーション ==========
const validators = [
  { input: el.videoCount,    errorEl: el.videoCountError,    min: 1,  max: 50    },
  { input: el.historyMaxCount, errorEl: el.historyMaxCountError, min: 50, max: 10000 }
];

function validateRange(value, min, max) {
  const num = parseInt(value);
  if (isNaN(num) || num < min || num > max) {
    return `${min}–${max} の値を入力してください`;
  }
  return null;
}

// ========== 設定の読み書き ==========
function getSettingsFromDOM() {
  return {
    enabled:               el.enabled.checked,
    shortcutKey:           el.shortcutKey.value,
    videoCount:            parseInt(el.videoCount.value),
    highlightEnabled:      el.highlightEnabled.checked,
    watchLaterKey:         el.watchLaterKey.value,
    showPlaylistPanel:     el.showPlaylistPanel.checked,
    debugMode:             el.debugMode.checked,
    historyMaxCount:       parseInt(el.historyMaxCount.value),
    includeShorts:         el.includeShorts.checked
  };
}

function saveSettings() {
  for (const { input, errorEl, min, max } of validators) {
    const error = validateRange(input.value, min, max);
    errorEl.textContent = error || '';
    if (error) return;
  }

  browserAPI.storage.sync.set(getSettingsFromDOM()).then(() => {
    updateStatus('設定を保存しました', 'active');
    setTimeout(updateCurrentStatus, 1000);
  }).catch((err) => {
    console.error('設定の保存エラー:', err);
    updateStatus('設定の保存に失敗しました', 'warn');
  });
}

function loadSettings() {
  browserAPI.storage.sync.get(DEFAULT_SETTINGS).then((settings) => {
    el.enabled.checked               = settings.enabled;
    el.shortcutKey.value             = settings.shortcutKey;
    el.videoCount.value              = settings.videoCount;
    el.highlightEnabled.checked      = settings.highlightEnabled;
    el.watchLaterKey.value           = settings.watchLaterKey;
    el.showPlaylistPanel.checked     = settings.showPlaylistPanel;
    el.debugMode.checked             = settings.debugMode;
    el.historyMaxCount.value         = settings.historyMaxCount;
    el.includeShorts.checked         = settings.includeShorts;

    el.toggleLabel.textContent = settings.enabled ? 'ON' : 'OFF';

    updateCurrentStatus();
  }).catch((err) => {
    console.error('設定の読み込みエラー:', err);
    updateStatus('設定の読み込みに失敗しました', 'warn');
  });
}

// ========== ステータス表示 ==========
function updateStatus(message, type = 'idle') {
  el.status.textContent = message;
  el.statusDot.className = 'dot' + (type === 'active' ? ' active' : type === 'warn' ? ' warn' : '');
}

function updateCurrentStatus() {
  browserAPI.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const tab = tabs[0];
    if (!tab.url.includes('youtube.com/feed/subscriptions')) {
      updateStatus('登録チャンネルページで使用してください');
      return;
    }

    browserAPI.tabs.sendMessage(tab.id, { action: 'getUnwatchedCount' }).then((response) => {
      if (response && typeof response.count === 'number') {
        const { enabled, shortcutKey } = getSettingsFromDOM();
        const shortcut = enabled ? ` | ${shortcutKey.toUpperCase()}` : ' | 無効';
        updateStatus(`未視聴動画: ${response.count}本${shortcut}`, 'active');
      } else {
        updateStatus('未視聴動画を検出できませんでした');
      }
    }).catch(() => {
      updateStatus('ページの読み込みを待っています...');
    });
  });
}

// ========== イベント: メイントグル ==========
el.enabled.addEventListener('change', () => {
  el.toggleLabel.textContent = el.enabled.checked ? 'ON' : 'OFF';
  saveSettings();
});

// ========== イベント: その他のトグル・セレクト ==========
[
  el.shortcutKey, el.highlightEnabled, el.watchLaterKey,
  el.showPlaylistPanel, el.debugMode, el.includeShorts
].forEach(input => input.addEventListener('change', saveSettings));

// ========== イベント: 数値入力 ==========
validators.forEach(({ input, errorEl, min, max }) => {
  input.addEventListener('input', () => {
    const error = validateRange(input.value, min, max);
    errorEl.textContent = error || '';
    if (!error) saveSettings();
  });
});

// ========== 初期化 ==========
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  setInterval(updateCurrentStatus, 3000);
});
