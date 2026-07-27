// Keel service worker.
// Two jobs: open the side panel from the toolbar icon, and capture the pixels
// of the user's current viewport when the panel asks. Screenshot capture has to
// happen here (or in another extension page) because content scripts cannot
// take screenshots.

async function configureSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.error("Keel could not configure the side panel", error);
  }
}

chrome.runtime.onInstalled.addListener(configureSidePanel);
chrome.runtime.onStartup.addListener(configureSidePanel);
configureSidePanel();

// captureVisibleTab is rate limited by Chrome, so a capture that lands within
// the limit window is served from the last frame instead of failing the turn.
let lastCapture = { windowId: null, dataUrl: null, at: 0 };

async function captureViewport(windowId) {
  const now = Date.now();
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 60 });
    if (!dataUrl) throw new Error("Chrome returned an empty capture.");
    lastCapture = { windowId, dataUrl, at: now };
    return { ok: true, dataUrl, capturedAt: new Date(now).toISOString(), reused: false };
  } catch (error) {
    const message = String(error?.message || error);
    if (lastCapture.dataUrl && lastCapture.windowId === windowId && now - lastCapture.at < 4000) {
      return { ok: true, dataUrl: lastCapture.dataUrl, capturedAt: new Date(lastCapture.at).toISOString(), reused: true };
    }
    // Being honest about a failed capture matters more than looking capable.
    return { ok: false, error: message };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "KEEL_CAPTURE") return;
  (async () => {
    let windowId = message.windowId;
    if (typeof windowId !== "number") {
      try {
        const current = await chrome.windows.getLastFocused();
        windowId = current?.id;
      } catch (_) { windowId = undefined; }
    }
    sendResponse(await captureViewport(windowId));
  })();
  return true;
});
