// Perception. Every agent turn starts here.
//
// Keel is only useful if it is looking at the page the user is looking at, at
// the moment they say something. So each turn re-reads the live DOM of the
// active tab and captures the pixels of the current viewport. Nothing is
// cached across turns except as an explicit fallback, and any failure is
// reported honestly instead of being papered over.

const EXTENSION_PAGE = /^(chrome-extension|moz-extension):/i;
const BLOCKED_PAGE = /^(chrome|edge|about|devtools|chrome-untrusted):/i;

export function isBlockedUrl(url = "") {
  return BLOCKED_PAGE.test(url) || EXTENSION_PAGE.test(url);
}

// The user's active tab, tracked live. The side panel normally shares a window
// with the page, but Keel also runs correctly when its page is open in a tab of
// its own, so the panel is never mistaken for the page under discussion.
export async function resolveTargetTab(preferredTabId = null) {
  const usable = (tab) => tab?.id != null && tab.url && !isBlockedUrl(tab.url);

  if (preferredTabId != null) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (usable(tab) && tab.active) return tab;
    } catch (_) { /* the tab closed */ }
  }

  const queries = [
    { active: true, currentWindow: true },
    { active: true, lastFocusedWindow: true },
    { active: true }
  ];
  for (const query of queries) {
    const tabs = await chrome.tabs.query(query);
    const match = tabs.find(usable);
    if (match) return match;
  }

  const all = await chrome.tabs.query({});
  const fallback = all
    .filter(usable)
    .sort((left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0))[0];
  if (fallback) return fallback;

  throw new Error("Keel cannot see a normal web page right now. Open the page you want to work on, then talk to me.");
}

export async function ensureContentScript(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: "KEEL_PING" });
    if (reply?.ok) return true;
  } catch (_) { /* not injected yet */ }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  const reply = await chrome.tabs.sendMessage(tabId, { type: "KEEL_PING" });
  return Boolean(reply?.ok);
}

export async function readPage(tabId) {
  const response = await chrome.tabs.sendMessage(tabId, { type: "KEEL_PERCEIVE" });
  if (!response?.ok) throw new Error("The page did not answer Keel's read request.");
  return response.page;
}

export async function captureViewport(windowId) {
  try {
    const result = await chrome.runtime.sendMessage({ type: "KEEL_CAPTURE", windowId });
    if (!result?.ok) return { ok: false, error: result?.error || "Chrome refused the screenshot." };
    return result;
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

// One perception pass: DOM plus pixels, both from the tab the user is on now.
export async function perceive({ preferredTabId = null, withScreenshot = true } = {}) {
  const tab = await resolveTargetTab(preferredTabId);
  const connected = await ensureContentScript(tab.id).catch(() => false);
  if (!connected) {
    return {
      ok: false,
      tab,
      error: `Keel cannot read ${tab.title || tab.url} yet. Refresh that tab once and I will be able to see it.`
    };
  }

  const page = await readPage(tab.id);
  const perception = { ok: true, tab, page, screenshot: { ok: false, error: "Screen capture is turned off." } };

  if (withScreenshot) {
    const capture = await captureViewport(tab.windowId);
    // The screenshot goes straight from Chrome to the model as an inline image.
    // It is never uploaded to storage and never written to disk.
    perception.screenshot = capture.ok
      ? { ok: true, dataUrl: capture.dataUrl, capturedAt: capture.capturedAt, reused: Boolean(capture.reused) }
      : { ok: false, error: capture.error };
  }

  return perception;
}

// A compact but complete view of the page for the model. Field ids are the
// only handles Keel can act through, so they always travel with the state.
export function pageForModel(page) {
  if (!page) return null;
  return {
    url: page.url,
    title: page.title,
    description: page.metaDescription,
    scrolledPercent: page.scroll?.percent,
    viewport: `${page.scroll?.viewportWidth}x${page.scroll?.viewportHeight} of a ${page.scroll?.documentHeight}px page`,
    headingsInOrder: (page.outline || []).map((item) => `${item.text}${item.inViewport ? " (on screen now)" : ""}`),
    textOnScreenNow: page.visibleText,
    forms: (page.forms || []).map((form) => ({
      id: form.id,
      label: form.label,
      purpose: form.purpose,
      region: form.region,
      fields: form.fieldCount,
      empty: form.emptyFieldCount,
      onScreenNow: form.inViewport,
      isTheOneTheUserIsOn: form.id === page.primaryFormId
    })),
    fieldsInDomOrder: (page.fields || []).map((field) => ({
      id: field.id,
      order: field.index,
      form: field.formId,
      label: field.label,
      type: field.type,
      required: field.required,
      options: field.options?.length ? field.options : undefined,
      currentValue: field.currentValue || "",
      section: field.section || undefined,
      region: field.region,
      onScreenNow: field.inViewport,
      sensitive: field.type === "password" || field.isOtp ? true : undefined,
      maxLength: field.maxLength || undefined
    })),
    buttons: (page.buttons || []).map((button) => ({
      id: button.id,
      text: button.text,
      form: button.formId,
      submits: button.commits,
      region: button.region
    })),
    captchaPresent: page.captchaPresent,
    webmcpTools: page.webmcp?.available ? page.webmcp.tools?.map((tool) => tool.name) : undefined
  };
}

// A factual description built purely from what was just read. Used when the
// user asks what Keel can see and the model is unreachable, so the answer is
// still the real page rather than an invention.
export function factualSummary(page, screenshot) {
  if (!page) return "I could not read the page just now.";
  const lines = [];
  lines.push(`${page.title || "Untitled page"} at ${page.url}`);
  const primary = (page.forms || []).find((form) => form.id === page.primaryFormId);
  if (primary) lines.push(`The part you are on: ${primary.label} (${primary.purpose}, ${primary.fieldCount} fields, ${primary.emptyFieldCount} still empty).`);
  const onScreen = (page.fields || []).filter((field) => field.inViewport).slice(0, 12);
  if (onScreen.length) lines.push(`Fields on screen right now: ${onScreen.map((field) => `${field.label} (${field.type})`).join(", ")}.`);
  const others = (page.forms || []).filter((form) => form.id !== page.primaryFormId);
  if (others.length) lines.push(`Also on the page, not what I am working on: ${others.map((form) => `${form.label} (${form.purpose})`).join(", ")}.`);
  lines.push(`You are scrolled ${page.scroll?.percent ?? 0}% down.`);
  if (screenshot && !screenshot.ok) lines.push(`I read the page structure but could not capture the pixels: ${screenshot.error}`);
  return lines.join("\n");
}
