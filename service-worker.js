// Keel service worker. Kept deliberately small: the side panel is the brain
// and it owns tab tracking, so the worker only wires up the panel behavior.
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
