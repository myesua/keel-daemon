// Keel content script: the page-side engine.
// It is a sensor and an actuator. It reads the live DOM, describes it to the
// side panel, and performs only the actions the user approved there.
// It never decides to submit anything on its own.
(() => {
  if (globalThis.__keelContentLoaded) return;
  globalThis.__keelContentLoaded = true;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (value = "") => String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  // ---------------------------------------------------------------------------
  // Field registry. Fields get stable ids for one scan generation so the panel
  // can reference them across messages.
  // ---------------------------------------------------------------------------
  let fieldRegistry = new Map();
  let scanGeneration = 0;
  const undoStack = [];

  function emit(event) {
    try {
      chrome.runtime.sendMessage({ type: "KEEL_EVENT", ...event }).catch(() => {});
    } catch (_) { /* extension context gone */ }
  }

  // ---------------------------------------------------------------------------
  // Visibility and labeling helpers
  // ---------------------------------------------------------------------------
  function isVisible(element) {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function textFromIds(ids) {
    return ids.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
  }

  function cleanLabelText(label) {
    const clone = label.cloneNode(true);
    clone.querySelectorAll("input, select, textarea, button").forEach((control) => control.remove());
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  }

  function getLabel(element) {
    const pieces = [];
    if (element.labels?.length) pieces.push(...[...element.labels].map(cleanLabelText));
    if (element.getAttribute("aria-labelledby")) pieces.push(textFromIds(element.getAttribute("aria-labelledby")));
    pieces.push(element.getAttribute("aria-label") || "");
    const wrappingLabel = element.closest("label");
    if (wrappingLabel) pieces.push(cleanLabelText(wrappingLabel));
    const directLabel = [...new Set(pieces.map((piece) => piece.trim()).filter(Boolean))].join(" | ");
    if (directLabel) return directLabel.replace(/\s+/g, " ").trim();
    const legend = element.closest("fieldset")?.querySelector("legend");
    if (legend?.textContent?.trim()) return legend.textContent.replace(/\s+/g, " ").trim();
    // Last resort: nearest preceding text node heading.
    const container = element.closest("div, p, li, td, section");
    if (container) {
      const clone = container.cloneNode(true);
      clone.querySelectorAll("input, select, textarea, button, script, style").forEach((n) => n.remove());
      const text = (clone.textContent || "").replace(/\s+/g, " ").trim();
      if (text && text.length <= 140) return text;
    }
    return "";
  }

  function groupLabelFor(element) {
    const group = element.closest("fieldset, [role='radiogroup'], [role='group']");
    if (!group) return "";
    const legend = group.matches("fieldset") ? group.querySelector(":scope > legend") : null;
    if (legend?.textContent?.trim()) return legend.textContent.replace(/\s+/g, " ").trim();
    const labelledBy = group.getAttribute("aria-labelledby");
    if (labelledBy) return textFromIds(labelledBy);
    return group.getAttribute("aria-label") || "";
  }

  function fieldNameOf(entry) {
    const element = entry.element;
    if (entry.type === "radio" || entry.type === "checkboxGroup") {
      const label = groupLabelFor(element);
      if (label) return label;
    }
    return getLabel(element) || element.placeholder || element.name || element.id || "Unlabeled field";
  }

  function isRequiredEntry(entry) {
    const list = entry.elements || [entry.element];
    return list.some((el) => el.required || el.getAttribute("aria-required") === "true");
  }

  function metaOf(entry) {
    const element = entry.element;
    return normalize([
      fieldNameOf(entry),
      element.name,
      element.id,
      element.placeholder,
      element.getAttribute("aria-label"),
      element.autocomplete
    ].filter(Boolean).join(" "));
  }

  function looksLikeOtp(entry) {
    const auto = normalize(entry.element.autocomplete || "");
    if (auto === "one time code") return true;
    return /\b(one time (code|password)|verification code|security code|2fa|two factor|authenticator code|otp)\b/.test(metaOf(entry));
  }

  // ---------------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------------
  function collectEntries() {
    const controls = [...document.querySelectorAll("input, select, textarea")];
    const seenRadioGroups = new Set();
    const entries = [];

    for (const element of controls) {
      const type = (element.type || element.tagName).toLowerCase();
      if (element.disabled || element.readOnly) continue;
      if (type === "hidden" || ["submit", "reset", "button", "image"].includes(type)) continue;
      if (!isVisible(element) && type !== "file") continue;

      if (type === "radio" && element.name) {
        if (seenRadioGroups.has(element.name)) continue;
        seenRadioGroups.add(element.name);
        const group = controls.filter((c) => c.type === "radio" && c.name === element.name && !c.disabled);
        entries.push({ element, elements: group, type: "radio" });
      } else if (element instanceof HTMLSelectElement) {
        entries.push({ element, type: "select" });
      } else if (type === "checkbox") {
        entries.push({ element, type: "checkbox" });
      } else if (type === "textarea" || element instanceof HTMLTextAreaElement) {
        entries.push({ element, type: "textarea" });
      } else {
        entries.push({ element, type });
      }
    }
    return entries;
  }

  function optionsOf(entry) {
    if (entry.type === "radio") {
      return entry.elements.map((radio) => (getLabel(radio) || radio.value || "").trim()).filter(Boolean);
    }
    if (entry.type === "select") {
      return [...entry.element.options]
        .filter((option) => Boolean(option.value) || Boolean(option.textContent.trim()))
        .map((option) => option.textContent.trim())
        .filter(Boolean);
    }
    if (entry.type === "checkbox") return ["Yes", "No"];
    return [];
  }

  function currentValueOf(entry) {
    if (entry.type === "radio") {
      const checked = entry.elements.find((r) => r.checked);
      return checked ? (getLabel(checked) || checked.value) : "";
    }
    if (entry.type === "checkbox") return entry.element.checked ? "Yes" : "";
    if (entry.type === "select") {
      const option = entry.element.selectedOptions?.[0];
      if (!option || !option.value) return "";
      return option.textContent.trim();
    }
    if (entry.type === "file") {
      return entry.element.files?.length ? [...entry.element.files].map((f) => f.name).join(", ") : "";
    }
    return String(entry.element.value || "").trim();
  }

  function describeEntry(entry, id) {
    return {
      id,
      label: fieldNameOf(entry),
      type: entry.type,
      required: isRequiredEntry(entry),
      options: optionsOf(entry),
      currentValue: currentValueOf(entry),
      autocomplete: entry.element.autocomplete || "",
      meta: metaOf(entry),
      isOtp: looksLikeOtp(entry),
      maxLength: entry.element.maxLength > 0 ? entry.element.maxLength : null
    };
  }

  function scanFields() {
    scanGeneration += 1;
    fieldRegistry = new Map();
    const entries = collectEntries();
    const fields = entries.map((entry, index) => {
      const id = `f${scanGeneration}-${index}`;
      fieldRegistry.set(id, entry);
      return describeEntry(entry, id);
    });
    return fields;
  }

  function collectSubmitButtons() {
    const candidates = [
      ...document.querySelectorAll("button, input[type='submit'], [role='button']")
    ].filter(isVisible);
    const results = [];
    for (const el of candidates) {
      const text = normalize(el.textContent || el.value || el.getAttribute("aria-label") || "");
      const isSubmitType = el.matches("input[type='submit']") || el.getAttribute("type") === "submit";
      const looksSubmit = /\b(submit|apply|place order|pay now|pay|complete purchase|checkout|sign up|register|create account|confirm|book now|send|continue|next|finish|complete)\b/.test(text);
      if (!isSubmitType && !looksSubmit) continue;
      const id = `b${scanGeneration}-${results.length}`;
      fieldRegistry.set(id, { element: el, type: "button" });
      results.push({
        id,
        text: (el.textContent || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(),
        isSubmitType,
        // Buttons that advance or finish a flow are the ones we must never
        // press without explicit approval.
        commits: isSubmitType || /\b(submit|apply|place order|pay now|pay|complete purchase|sign up|register|create account|confirm|book now|send|finish|complete)\b/.test(text)
      });
    }
    return results;
  }

  function findCaptcha() {
    const selectors = [
      'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="turnstile"]',
      ".g-recaptcha", ".h-captcha", ".cf-turnstile", "[data-sitekey]",
      '[class*="captcha" i]', '[id*="captcha" i]'
    ];
    return [...document.querySelectorAll(selectors.join(","))].find(isVisible) || null;
  }

  function pageSnapshot() {
    const headings = [...document.querySelectorAll("h1, h2, legend")]
      .filter(isVisible)
      .slice(0, 12)
      .map((h) => h.textContent.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const metaDescription = document.querySelector("meta[name='description']")?.content || "";
    const fields = scanFields();
    const buttons = collectSubmitButtons();
    const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 1500);
    return {
      url: location.href,
      host: location.hostname || (location.protocol === "file:" ? (location.pathname.split("/").pop() || "local file") : location.href.slice(0, 60)),
      title: document.title || "",
      metaDescription: metaDescription.slice(0, 300),
      headings,
      bodyTextSample: bodyText,
      fields,
      buttons,
      captchaPresent: Boolean(findCaptcha()),
      frameCount: window.frames.length
    };
  }

  // ---------------------------------------------------------------------------
  // Highlight overlay
  // ---------------------------------------------------------------------------
  function displayTargetOf(entry) {
    const element = entry.element;
    if (isVisible(element)) return element;
    return element.labels?.[0] || element.closest("label") || element.parentElement || element;
  }

  async function highlight(entry, label, color = "#f1a33c") {
    const target = displayTargetOf(entry);
    try { target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" }); } catch (_) {}
    await wait(260);

    const previous = {
      outline: target.style.outline,
      outlineOffset: target.style.outlineOffset,
      transition: target.style.transition
    };
    target.style.transition = "outline-color 160ms ease";
    target.style.outline = `3px solid ${color}`;
    target.style.outlineOffset = "3px";

    const badge = document.createElement("div");
    badge.setAttribute("data-keel-overlay", "true");
    badge.textContent = `Keel: ${label}`;
    Object.assign(badge.style, {
      position: "fixed",
      zIndex: "2147483647",
      maxWidth: "min(360px, calc(100vw - 24px))",
      padding: "7px 10px",
      borderRadius: "7px",
      color: "white",
      background: color,
      boxShadow: "0 5px 18px rgba(0,0,0,.24)",
      font: "700 12px/1.25 system-ui, sans-serif",
      pointerEvents: "none"
    });
    document.documentElement.append(badge);

    const position = () => {
      if (!target.isConnected) return;
      const rect = target.getBoundingClientRect();
      const top = rect.top > 48 ? rect.top - 38 : Math.min(window.innerHeight - 40, rect.bottom + 8);
      badge.style.top = `${Math.max(8, top)}px`;
      badge.style.left = `${Math.max(8, Math.min(window.innerWidth - badge.offsetWidth - 8, rect.left))}px`;
    };
    position();
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    await wait(320);

    return {
      update(text, nextColor = "#0d7355") {
        badge.textContent = `Keel: ${text}`;
        badge.style.background = nextColor;
        target.style.outlineColor = nextColor;
        position();
      },
      clear() {
        window.removeEventListener("scroll", position, true);
        window.removeEventListener("resize", position);
        badge.remove();
        target.style.outline = previous.outline;
        target.style.outlineOffset = previous.outlineOffset;
        target.style.transition = previous.transition;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Value application, with option matching for radio, select, and checkbox
  // ---------------------------------------------------------------------------
  function dispatchValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.blur();
  }

  function scoreOption(candidateText, wantedText) {
    const candidate = normalize(candidateText);
    const wanted = normalize(wantedText);
    if (!candidate || !wanted) return 0;
    if (candidate === wanted) return 1;
    if (candidate.startsWith(wanted) || wanted.startsWith(candidate)) return 0.9;
    if (candidate.includes(wanted) || wanted.includes(candidate)) return 0.8;
    const candidateTokens = new Set(candidate.split(" "));
    const wantedTokens = wanted.split(" ").filter(Boolean);
    if (!wantedTokens.length) return 0;
    const hits = wantedTokens.filter((t) => candidateTokens.has(t)).length;
    return (hits / wantedTokens.length) * 0.7;
  }

  function bestMatch(items, textOf, wanted) {
    let best = null;
    let bestScore = 0;
    for (const item of items) {
      const score = scoreOption(textOf(item), wanted);
      if (score > bestScore) { best = item; bestScore = score; }
    }
    return { item: best, score: bestScore };
  }

  function snapshotEntryState(entry) {
    if (entry.type === "radio") {
      const checked = entry.elements.find((r) => r.checked);
      return { kind: "radio", checkedValue: checked ? checked.value : null };
    }
    if (entry.type === "checkbox") return { kind: "checkbox", checked: entry.element.checked };
    if (entry.type === "select") return { kind: "select", value: entry.element.value };
    return { kind: "value", value: entry.element.value };
  }

  function restoreEntryState(entry, state) {
    if (!state) return;
    if (state.kind === "radio") {
      if (state.checkedValue == null) {
        const checked = entry.elements.find((r) => r.checked);
        if (checked) {
          checked.checked = false;
          checked.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else {
        const target = entry.elements.find((r) => r.value === state.checkedValue);
        if (target && !target.checked) target.click();
      }
      return;
    }
    if (state.kind === "checkbox") {
      if (entry.element.checked !== state.checked) entry.element.click();
      return;
    }
    if (state.kind === "select") {
      entry.element.value = state.value;
      entry.element.dispatchEvent(new Event("input", { bubbles: true }));
      entry.element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    dispatchValue(entry.element, state.value || "");
  }

  function applyValue(entry, rawValue) {
    const value = String(rawValue ?? "").trim();
    const element = entry.element;

    if (entry.type === "radio") {
      const { item, score } = bestMatch(entry.elements, (radio) => `${getLabel(radio)} ${radio.value}`, value);
      if (!item || score < 0.6) {
        return { ok: false, error: `"${value}" does not match one of the available choices.` };
      }
      if (!item.checked) item.click();
      const chosen = getLabel(item) || item.value;
      return { ok: true, applied: chosen, matchScore: score };
    }

    if (entry.type === "select") {
      const options = [...element.options].filter((o) => Boolean(o.value) || Boolean(o.textContent.trim()));
      const { item, score } = bestMatch(options, (o) => `${o.textContent} ${o.value}`, value);
      if (!item || score < 0.6) {
        return { ok: false, error: `"${value}" does not match one of the dropdown choices.` };
      }
      element.value = item.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, applied: item.textContent.trim(), matchScore: score };
    }

    if (entry.type === "checkbox") {
      const normalized = normalize(value);
      const yes = ["yes", "true", "checked", "1", "agree", "accept", "on"].includes(normalized);
      const no = ["no", "false", "unchecked", "0", "disagree", "decline", "off"].includes(normalized);
      if (!yes && !no) return { ok: false, error: "Answer Yes or No for this checkbox." };
      if (element.checked !== yes) element.click();
      return { ok: true, applied: yes ? "Checked" : "Unchecked", matchScore: 1 };
    }

    dispatchValue(element, value);
    if (!element.checkValidity()) {
      return { ok: false, error: "That value does not satisfy the page's validation." };
    }
    return { ok: true, applied: value, matchScore: 1 };
  }

  // ---------------------------------------------------------------------------
  // WebMCP progressive enhancement. A bridge script in the page's main world
  // answers over window.postMessage. If the page exposes structured tools we
  // report them to the panel, which may prefer them over raw DOM actuation.
  // ---------------------------------------------------------------------------
  let webmcpCounter = 0;
  function webmcpRequest(op, payload, timeoutMs) {
    return new Promise((resolve) => {
      const id = `keel-mcp-${Date.now()}-${webmcpCounter += 1}`;
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve({ ok: false, error: "timeout" });
      }, timeoutMs);
      function onMessage(event) {
        const data = event.data;
        if (!data || data.source !== "keel-webmcp-bridge" || data.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(data.result || { ok: false, error: "empty bridge reply" });
      }
      window.addEventListener("message", onMessage);
      window.postMessage({ source: "keel-content", id, op, payload }, "*");
    });
  }

  // ---------------------------------------------------------------------------
  // Change watcher: multi-step forms often swap fields in place. Tell the panel
  // so it can rescan instead of going stale.
  // ---------------------------------------------------------------------------
  let mutateTimer = null;
  let lastFieldCount = null;
  const observer = new MutationObserver(() => {
    clearTimeout(mutateTimer);
    mutateTimer = setTimeout(() => {
      try {
        const count = collectEntries().length;
        if (lastFieldCount !== null && count !== lastFieldCount) {
          emit({ kind: "fields_changed", fieldCount: count });
        }
        lastFieldCount = count;
      } catch (_) {}
    }, 900);
  });
  try {
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: false });
  } catch (_) {}

  // ---------------------------------------------------------------------------
  // Message handlers
  // ---------------------------------------------------------------------------
  async function handleApply(message) {
    const actions = message.actions || [];
    const results = [];
    const undoBatch = { id: `undo-${Date.now()}`, items: [] };

    for (const action of actions) {
      const entry = fieldRegistry.get(action.fieldId);
      if (!entry || !entry.element.isConnected) {
        results.push({ fieldId: action.fieldId, ok: false, error: "The field is no longer on the page." });
        continue;
      }
      const name = fieldNameOf(entry);
      const marker = await highlight(entry, `Filling: ${name}`);
      const before = snapshotEntryState(entry);
      const result = applyValue(entry, action.value);
      if (result.ok) {
        undoBatch.items.push({ entry, before, label: name });
        marker.update(`Filled: ${result.applied}`);
        emit({ kind: "action", action: "fill", label: name, value: result.applied });
        await wait(240);
      } else {
        marker.update("Needs your answer", "#b5472f");
        await wait(300);
      }
      marker.clear();
      results.push({ fieldId: action.fieldId, ok: result.ok, applied: result.applied, error: result.error, matchScore: result.matchScore, label: name });
    }

    if (undoBatch.items.length) {
      undoStack.push(undoBatch);
      if (undoStack.length > 20) undoStack.shift();
    }
    return { ok: true, results, undoId: undoBatch.items.length ? undoBatch.id : null };
  }

  async function handleUndo() {
    const batch = undoStack.pop();
    if (!batch) return { ok: false, error: "There is nothing to undo." };
    const restored = [];
    for (const item of [...batch.items].reverse()) {
      if (!item.entry.element.isConnected) continue;
      const marker = await highlight(item.entry, `Undoing: ${item.label}`, "#5b6770");
      restoreEntryState(item.entry, item.before);
      marker.update("Restored", "#5b6770");
      await wait(200);
      marker.clear();
      restored.push(item.label);
    }
    emit({ kind: "action", action: "undo", labels: restored });
    return { ok: true, restored };
  }

  async function handleAttachFile(message) {
    const entry = fieldRegistry.get(message.fieldId);
    if (!entry || entry.type !== "file" || !entry.element.isConnected) {
      return { ok: false, error: "That file field is no longer on the page." };
    }
    try {
      const binary = atob(message.file.dataBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], message.file.name, { type: message.file.mime || "application/octet-stream" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const marker = await highlight(entry, `Attaching: ${message.file.name}`);
      entry.element.files = transfer.files;
      entry.element.dispatchEvent(new Event("input", { bubbles: true }));
      entry.element.dispatchEvent(new Event("change", { bubbles: true }));
      const attached = entry.element.files?.length > 0;
      marker.update(attached ? "Attached" : "The page rejected the file", attached ? "#0d7355" : "#b5472f");
      await wait(300);
      marker.clear();
      if (!attached) return { ok: false, error: "The page did not accept the file. Choose it manually." };
      emit({ kind: "action", action: "attach", label: fieldNameOf(entry), value: message.file.name });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `Could not attach the file: ${error.message}` };
    }
  }

  async function handleClick(message) {
    const entry = fieldRegistry.get(message.fieldId);
    if (!entry || !entry.element.isConnected) {
      return { ok: false, error: "That button is no longer on the page." };
    }
    const label = (entry.element.textContent || entry.element.value || "button").replace(/\s+/g, " ").trim();
    const marker = await highlight(entry, `Clicking: ${label}`, "#0d7355");
    await wait(350);
    entry.element.click();
    marker.clear();
    emit({ kind: "action", action: "click", label });
    return { ok: true, label };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;

    if (message.type === "KEEL_PING") {
      sendResponse({ ok: true, version: 2 });
      return;
    }
    if (message.type === "KEEL_SNAPSHOT") {
      (async () => {
        const snapshot = pageSnapshot();
        const mcp = await webmcpRequest("detect", {}, 700);
        snapshot.webmcp = mcp.ok ? mcp : { ok: false, available: false };
        sendResponse({ ok: true, snapshot });
      })();
      return true;
    }
    if (message.type === "KEEL_SCAN") {
      sendResponse({ ok: true, fields: scanFields(), buttons: collectSubmitButtons(), captchaPresent: Boolean(findCaptcha()) });
      return;
    }
    if (message.type === "KEEL_APPLY") {
      handleApply(message).then(sendResponse);
      return true;
    }
    if (message.type === "KEEL_UNDO") {
      handleUndo().then(sendResponse);
      return true;
    }
    if (message.type === "KEEL_ATTACH_FILE") {
      handleAttachFile(message).then(sendResponse);
      return true;
    }
    if (message.type === "KEEL_CLICK") {
      handleClick(message).then(sendResponse);
      return true;
    }
    if (message.type === "KEEL_FIELD_STATE") {
      const entry = fieldRegistry.get(message.fieldId);
      if (!entry || !entry.element.isConnected) {
        sendResponse({ ok: false, error: "gone" });
        return;
      }
      sendResponse({ ok: true, currentValue: currentValueOf(entry), hasValue: Boolean(currentValueOf(entry)) });
      return;
    }
    if (message.type === "KEEL_WEBMCP_CALL") {
      webmcpRequest("call", { tool: message.tool, args: message.args }, 15000).then(sendResponse);
      return true;
    }
    if (message.type === "KEEL_HIGHLIGHT_CAPTCHA") {
      (async () => {
        const captcha = findCaptcha();
        if (!captcha) { sendResponse({ ok: false, error: "No captcha is visible." }); return; }
        const marker = await highlight({ element: captcha, type: "captcha" }, "Your turn: complete this check", "#b5472f");
        setTimeout(() => marker.clear(), 4000);
        sendResponse({ ok: true });
      })();
      return true;
    }
  });
})();
