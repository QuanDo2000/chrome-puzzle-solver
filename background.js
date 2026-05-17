// Service worker entry point. Imports the library of MAIN-world functions so
// `globalThis[request.funcName]` can resolve them from the message listener
// below — those functions don't run here, they're serialized and shipped to
// the active tab's MAIN world via chrome.scripting.executeScript.
importScripts('main-world.js');

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'execMain') {
    const fn = globalThis[request.funcName];
    if (typeof fn !== 'function') {
      sendResponse(null);
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) { sendResponse(null); return; }
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
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
    });
    return true;
  }

  if (request.action === 'sendToContent') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) {
        sendResponse({ success: false, error: 'No active tab' });
        return;
      }
      chrome.tabs.sendMessage(tab.id, request.payload, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      });
    });
    return true;
  }
});
