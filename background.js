// Service Worker環境でpolyfillを読み込む
try {
  importScripts('browser-polyfill.js');
} catch (e) {
  console.error('Failed to load browser-polyfill.js:', e);
}

browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'openTab') {
    browserAPI.tabs.query({active: true, currentWindow: true}).then((tabs) => {
      const currentTab = tabs[0];
      browserAPI.tabs.create({
        url: request.url,
        active: false,
        index: currentTab.index + 1
      });
    });
  }
});

browserAPI.runtime.onInstalled.addListener(() => {
  console.log('YouTube未視聴動画オープナーがインストールされました');
});