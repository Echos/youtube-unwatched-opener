/**
 * Browser API Polyfill
 * Chrome/Firefox両対応のための抽象化レイヤー
 *
 * Firefoxはネイティブのbrowser APIを使用
 * ChromeはコールバックベースAPIをPromiseにラップ
 */

globalThis.browserAPI = (() => {
  // Firefoxの場合はネイティブのbrowser APIを使用
  if (typeof browser !== 'undefined') {
    return browser;
  }

  // Chrome用のPromiseラッパー
  const chromeWrapper = {
    runtime: {
      sendMessage: (...args) => {
        return new Promise((resolve) => {
          chrome.runtime.sendMessage(...args, (response) => {
            if (chrome.runtime.lastError) {
              console.warn('runtime.sendMessage error:', chrome.runtime.lastError);
            }
            resolve(response);
          });
        });
      },
      getURL: (path) => {
        return chrome.runtime.getURL(path);
      },
      onMessage: chrome.runtime.onMessage,
      onInstalled: chrome.runtime.onInstalled,
      lastError: chrome.runtime.lastError
    },
    storage: {
      sync: {
        get: (keys) => {
          return new Promise((resolve) => {
            chrome.storage.sync.get(keys, (result) => {
              if (chrome.runtime.lastError) {
                console.error('storage.sync.get error:', chrome.runtime.lastError);
              }
              resolve(result);
            });
          });
        },
        set: (items) => {
          return new Promise((resolve) => {
            chrome.storage.sync.set(items, () => {
              if (chrome.runtime.lastError) {
                console.error('storage.sync.set error:', chrome.runtime.lastError);
              }
              resolve();
            });
          });
        }
      },
      onChanged: chrome.storage.onChanged
    },
    tabs: {
      create: (createProperties) => {
        return new Promise((resolve) => {
          chrome.tabs.create(createProperties, (tab) => {
            if (chrome.runtime.lastError) {
              console.error('tabs.create error:', chrome.runtime.lastError);
            }
            resolve(tab);
          });
        });
      },
      query: (queryInfo) => {
        return new Promise((resolve) => {
          chrome.tabs.query(queryInfo, (tabs) => {
            if (chrome.runtime.lastError) {
              console.error('tabs.query error:', chrome.runtime.lastError);
            }
            resolve(tabs);
          });
        });
      },
      sendMessage: (tabId, message) => {
        return new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
              console.warn('tabs.sendMessage error:', chrome.runtime.lastError);
            }
            resolve(response);
          });
        });
      }
    }
  };

  return chromeWrapper;
})();
