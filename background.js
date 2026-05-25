// Service worker entry point. Imports the library of MAIN-world functions so
// `globalThis[request.funcName]` can resolve them from the message listener
// below — those functions don't run here, they're serialized and shipped to
// the active tab's MAIN world via chrome.scripting.executeScript.
importScripts('main-world.js');

// Only these functions may be invoked from the content script via execMain.
// Without an allowlist, any caller that reaches onMessage could ask the SW to
// ship arbitrary globals into the page MAIN world.
const EXEC_MAIN_ALLOWLIST = new Set([
  'readGameState',
  'readGameClues',
  'readGalaxiesData',
  'readGalaxiesState',
  'applyGalaxiesState',
  'readBinairoData',
  'readBinairoState',
  'applyBinairoState',
  'readShikakuData',
  'readShikakuState',
  'applyShikakuState',
  'readYinYangData',
  'readYinYangState',
  'applyYinYangState',
  'readSlitherlinkData',
  'readSlitherlinkState',
  'applySlitherlinkState',
  'readHashiData',
  'readHashiState',
  'applyHashiState',
  'readHeyawakeData',
  'readHeyawakeState',
  'applyHeyawakeState',
  'readHitoriData',
  'readHitoriState',
  'applyHitoriState',
  'readKakurasuData',
  'readKakurasuState',
  'applyKakurasuState',
  'applyGameState',
  'applyHintCells',
  'dumpPuzzleForBench',
]);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Reject messages from anything other than this extension's own content
  // scripts / pages. Without externally_connectable set, web pages can't
  // reach this listener today, but the check costs nothing and forecloses
  // a whole class of bugs the day someone adds it.
  if (sender.id !== chrome.runtime.id) return;

  if (request.action === 'execMain') {
    if (!EXEC_MAIN_ALLOWLIST.has(request.funcName)) {
      sendResponse(null);
      return;
    }
    const fn = globalThis[request.funcName];
    if (typeof fn !== 'function') {
      sendResponse(null);
      return;
    }
    // Target the sending tab, not the active one — the user may have switched
    // tabs between the content script firing this message and the SW handling
    // it, in which case the active query would deliver to the wrong page.
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse(null); return; }
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: fn,
      args: request.args || []
    }, (results) => {
      if (chrome.runtime.lastError || !results || !results[0]) {
        sendResponse(null);
      } else {
        sendResponse(results[0].result);
      }
    });
    return true;
  }
});

// With the popup removed, clicking the toolbar icon should still do something:
// ask the content script (if loaded on this tab) to expand the widget. Tabs
// outside the manifest's content_scripts.matches won't have the listener and
// the sendMessage error is swallowed.
chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { action: 'expandWidget' }, () => {
    void chrome.runtime.lastError;
  });
});
