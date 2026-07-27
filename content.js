// Keel content script: the page-side sensor and actuator.
//
// Sensor: on every agent turn the side panel asks this script for a fresh read
// of the live DOM, including geometry, so the model always reasons about the
// page the user is actually looking at right now, at the scroll position they
// are actually at.
//
// Actuator: it performs only the operations the user approved in the panel. It
// never decides anything and it never clicks a committing button on its own.
(() => {
  if (globalThis.__keelContentLoaded) return;
  globalThis.__keelContentLoaded = true;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (value = "") => String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tidy = (value = "") => String(value).replace(/\s+/g, " ").trim();

  let registry = new Map();
  let idCounter = 0;
  const idsByElement = new WeakMap();
  const undoStack = [];

  // Ids stay attached to the same element for as long as it lives on the page.
  // A preview the user is reading therefore stays valid while Keel keeps
  // looking at the page.
  function stableId(element, prefix) {
    let id = idsByElement.get(element);
    if (!id) {
      idCounter += 1;
      id = `${prefix}${idCounter}`;
      idsByElement.set(element, id);
    }
    return id;
  }

  function emit(event) {
    try {
      chrome.runtime.sendMessage({ type: "KEEL_EVENT", ...event }).catch(() => {});
    } catch (_) { /* the extension context went away */ }
  }

  // ---------------------------------------------------------------------------
  // Visibility, labels, geometry
  // ---------------------------------------------------------------------------
  function isVisible(element) {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function boxOf(element) {
    const rect = element.getBoundingClientRect();
    return {
      top: Math.round(rect.top + window.scrollY),
      bottom: Math.round(rect.bottom + window.scrollY),
      left: Math.round(rect.left + window.scrollX),
      height: Math.round(rect.height),
      inViewport: rect.bottom > 0 && rect.top < window.innerHeight
    };
  }

  function textFromIds(ids) {
    return ids.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
  }

  function cleanLabelText(label) {
    const clone = label.cloneNode(true);
    clone.querySelectorAll("input, select, textarea, button").forEach((control) => control.remove());
    return tidy(clone.textContent || "");
  }

  function getLabel(element) {
    const pieces = [];
    if (element.labels?.length) pieces.push(...[...element.labels].map(cleanLabelText));
    if (element.getAttribute("aria-labelledby")) pieces.push(textFromIds(element.getAttribute("aria-labelledby")));
    pieces.push(element.getAttribute("aria-label") || "");
    const wrappingLabel = element.closest("label");
    if (wrappingLabel) pieces.push(cleanLabelText(wrappingLabel));
    const direct = [...new Set(pieces.map((piece) => piece.trim()).filter(Boolean))].join(" | ");
    if (direct) return tidy(direct);
    const legend = element.closest("fieldset")?.querySelector("legend");
    if (legend?.textContent?.trim()) return tidy(legend.textContent);
    const container = element.closest("div, p, li, td, section");
    if (container) {
      const clone = container.cloneNode(true);
      clone.querySelectorAll("input, select, textarea, button, script, style").forEach((node) => node.remove());
      const text = tidy(clone.textContent || "");
      if (text && text.length <= 140) return text;
    }
    return "";
  }

  function groupLabelFor(element) {
    const group = element.closest("fieldset, [role='radiogroup'], [role='group']");
    if (!group) return "";
    const legend = group.matches("fieldset") ? group.querySelector(":scope > legend") : null;
    if (legend?.textContent?.trim()) return tidy(legend.textContent);
    const labelledBy = group.getAttribute("aria-labelledby");
    if (labelledBy) return textFromIds(labelledBy);
    return group.getAttribute("aria-label") || "";
  }

  function fieldNameOf(entry) {
    const element = entry.element;
    if (entry.type === "radio") {
      const label = groupLabelFor(element);
      if (label) return label;
    }
    return getLabel(element) || element.placeholder || element.name || element.id || "Unlabeled field";
  }

  function isRequiredEntry(entry) {
    const list = entry.elements || [entry.element];
    return list.some((element) => element.required || element.getAttribute("aria-required") === "true");
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
    if (normalize(entry.element.autocomplete || "") === "one time code") return true;
    return /\b(one time (code|password)|verification code|security code|2fa|two factor|authenticator code|otp)\b/.test(metaOf(entry));
  }

  function nearestHeadingFor(element) {
    let node = element;
    while (node && node !== document.body) {
      let sibling = node.previousElementSibling;
      while (sibling) {
        if (/^(H1|H2|H3|H4|LEGEND)$/.test(sibling.tagName) && sibling.textContent.trim()) {
          return tidy(sibling.textContent).slice(0, 120);
        }
        const nested = sibling.querySelector?.("h1, h2, h3, h4, legend");
        if (nested?.textContent?.trim()) return tidy(nested.textContent).slice(0, 120);
        sibling = sibling.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
  }

  // Where on the page an element lives. Footer and aside content is exactly
  // where stray newsletter boxes hide, so the model gets told plainly.
  function regionOf(element) {
    if (element.closest("footer, [role='contentinfo'], .footer, #footer")) return "footer";
    if (element.closest("header, [role='banner'], nav, [role='navigation']")) return "header";
    if (element.closest("aside, [role='complementary'], .sidebar")) return "aside";
    if (element.closest("[role='dialog'], dialog, .modal")) return "dialog";
    const box = boxOf(element);
    const documentHeight = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0, 1);
    if (box.top / documentHeight > 0.85) return "page bottom";
    return "main";
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
        const group = controls.filter((candidate) => candidate.type === "radio" && candidate.name === element.name && !candidate.disabled);
        entries.push({ element, elements: group, type: "radio" });
      } else if (element instanceof HTMLSelectElement) {
        entries.push({ element, type: "select" });
      } else if (type === "checkbox") {
        entries.push({ element, type: "checkbox" });
      } else if (element instanceof HTMLTextAreaElement) {
        entries.push({ element, type: "textarea" });
      } else {
        entries.push({ element, type });
      }
    }
    return entries;
  }

  function optionsOf(entry) {
    if (entry.type === "radio") {
      return entry.elements.map((radio) => tidy(getLabel(radio) || radio.value)).filter(Boolean);
    }
    if (entry.type === "select") {
      return [...entry.element.options]
        .filter((option) => Boolean(option.value) || Boolean(option.textContent.trim()))
        .map((option) => tidy(option.textContent))
        .filter(Boolean);
    }
    if (entry.type === "checkbox") return ["Yes", "No"];
    return [];
  }

  function currentValueOf(entry) {
    if (entry.type === "radio") {
      const checked = entry.elements.find((radio) => radio.checked);
      return checked ? tidy(getLabel(checked) || checked.value) : "";
    }
    if (entry.type === "checkbox") return entry.element.checked ? "Yes" : "";
    if (entry.type === "select") {
      const option = entry.element.selectedOptions?.[0];
      if (!option || !option.value) return "";
      return tidy(option.textContent);
    }
    if (entry.type === "file") {
      return entry.element.files?.length ? [...entry.element.files].map((file) => file.name).join(", ") : "";
    }
    return tidy(entry.element.value || "");
  }

  function formKeyOf(element) {
    const form = element.closest("form");
    if (form) {
      if (!form.__keelKey) form.__keelKey = `form-${Math.random().toString(36).slice(2, 8)}`;
      return { key: form.__keelKey, node: form };
    }
    const section = element.closest("section, article, main, aside, footer, dialog, [role='dialog']");
    if (section) {
      if (!section.__keelKey) section.__keelKey = `group-${Math.random().toString(36).slice(2, 8)}`;
      return { key: section.__keelKey, node: section };
    }
    return { key: "loose", node: document.body };
  }

  function formLabelFor(node) {
    if (!node || node === document.body) return "Fields outside any form";
    const heading = node.querySelector("h1, h2, h3, legend");
    if (heading?.textContent?.trim()) return tidy(heading.textContent).slice(0, 120);
    const aria = node.getAttribute?.("aria-label") || node.getAttribute?.("name") || node.id;
    if (aria) return tidy(aria).slice(0, 120);
    const before = nearestHeadingFor(node);
    return before || "Unnamed form";
  }

  // A blunt, honest classification so the model can tell an application form
  // apart from the newsletter box in the footer.
  function purposeOf(node, fields) {
    const text = normalize([node?.textContent?.slice(0, 400), fields.map((field) => field.label).join(" ")].join(" "));
    const emailOnly = fields.length <= 2 && fields.every((field) => ["email", "text"].includes(field.type));
    if (/\b(newsletter|subscribe|subscription|stay in the loop|sign up for updates|mailing list)\b/.test(text) && emailOnly) return "newsletter signup";
    if (/\b(search)\b/.test(text) && fields.length <= 2) return "search";
    if (/\b(cookie|consent banner)\b/.test(text)) return "cookie notice";
    if (/\b(sign in|log in|login|password)\b/.test(text) && fields.length <= 3) return "login";
    if (/\b(apply|application|resume|cv|cover letter)\b/.test(text)) return "job application";
    if (/\b(checkout|payment|billing|shipping|card number)\b/.test(text)) return "checkout";
    if (/\b(create account|register|sign up)\b/.test(text)) return "account signup";
    return fields.length > 3 ? "multi field form" : "small form";
  }

  function describeEntry(entry, id, index) {
    const box = boxOf(entry.element);
    return {
      id,
      index,
      label: fieldNameOf(entry),
      type: entry.type,
      required: isRequiredEntry(entry),
      options: optionsOf(entry),
      currentValue: currentValueOf(entry),
      placeholder: entry.element.placeholder || "",
      autocomplete: entry.element.autocomplete || "",
      meta: metaOf(entry),
      isOtp: looksLikeOtp(entry),
      maxLength: entry.element.maxLength > 0 ? entry.element.maxLength : null,
      section: nearestHeadingFor(entry.element),
      region: regionOf(entry.element),
      top: box.top,
      inViewport: box.inViewport,
      formId: null
    };
  }

  function scanFields() {
    registry = new Map();
    const entries = collectEntries();
    const fields = [];
    const forms = new Map();

    entries.forEach((entry, index) => {
      const id = stableId(entry.element, "f");
      registry.set(id, entry);
      const field = describeEntry(entry, id, index);
      const { key, node } = formKeyOf(entry.element);
      field.formId = key;
      if (!forms.has(key)) forms.set(key, { id: key, node, fieldIds: [], fields: [] });
      forms.get(key).fieldIds.push(id);
      forms.get(key).fields.push(field);
      fields.push(field);
    });

    const formList = [...forms.values()].map((form) => {
      const box = boxOf(form.node === document.body ? document.body : form.node);
      return {
        id: form.id,
        label: formLabelFor(form.node),
        purpose: purposeOf(form.node, form.fields),
        region: form.node === document.body ? "main" : regionOf(form.node),
        fieldCount: form.fieldIds.length,
        emptyFieldCount: form.fields.filter((field) => !field.currentValue).length,
        fieldIds: form.fieldIds,
        top: box.top,
        inViewport: form.fields.some((field) => field.inViewport)
      };
    });

    return { fields, forms: formList };
  }

  // The form the user is actually working on: the one their viewport is on,
  // weighted by how much of a real form it is. Geometry, not guesswork.
  function pickPrimaryForm(forms) {
    if (!forms.length) return null;
    const viewportCenter = window.scrollY + window.innerHeight / 2;
    let best = null;
    let bestScore = -Infinity;
    for (const form of forms) {
      let score = 0;
      if (form.inViewport) score += 60;
      score -= Math.min(50, Math.abs(form.top - viewportCenter) / Math.max(1, window.innerHeight) * 12);
      score += Math.min(30, form.fieldCount * 4);
      if (["newsletter signup", "search", "cookie notice"].includes(form.purpose)) score -= 70;
      if (["footer", "page bottom", "header"].includes(form.region)) score -= 25;
      if (score > bestScore) { bestScore = score; best = form; }
    }
    return best?.id || null;
  }

  function collectButtons() {
    const candidates = [...document.querySelectorAll("button, input[type='submit'], [role='button'], a.button")].filter(isVisible);
    const results = [];
    for (const element of candidates) {
      const text = normalize(element.textContent || element.value || element.getAttribute("aria-label") || "");
      const isSubmitType = element.matches("input[type='submit']") || element.getAttribute("type") === "submit";
      const looksSubmit = /\b(submit|apply|place order|pay now|pay|complete purchase|checkout|sign up|subscribe|register|create account|confirm|book now|send|continue|next|finish|complete|save)\b/.test(text);
      if (!isSubmitType && !looksSubmit) continue;
      const id = stableId(element, "b");
      registry.set(id, { element, type: "button" });
      const box = boxOf(element);
      results.push({
        id,
        text: tidy(element.textContent || element.value || element.getAttribute("aria-label") || ""),
        formId: formKeyOf(element).key,
        region: regionOf(element),
        inViewport: box.inViewport,
        top: box.top,
        commits: isSubmitType || /\b(submit|apply|place order|pay now|pay|complete purchase|sign up|subscribe|register|create account|confirm|book now|send|finish|complete)\b/.test(text)
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

  function outlineOf() {
    return [...document.querySelectorAll("h1, h2, h3, legend")]
      .filter(isVisible)
      .slice(0, 20)
      .map((heading) => {
        const box = boxOf(heading);
        return { tag: heading.tagName.toLowerCase(), text: tidy(heading.textContent).slice(0, 140), top: box.top, inViewport: box.inViewport };
      })
      .filter((item) => item.text);
  }

  function visibleText() {
    // What the user can actually see right now, not the whole document.
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    const parts = [];
    let node = walker.nextNode();
    while (node && parts.join(" ").length < 1200) {
      const text = tidy(node.nodeValue || "");
      if (text.length > 1 && node.parentElement && isVisible(node.parentElement)) {
        const rect = node.parentElement.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < window.innerHeight) parts.push(text);
      }
      node = walker.nextNode();
    }
    return parts.join(" ").slice(0, 1200);
  }

  function perceive() {
    const { fields, forms } = scanFields();
    const buttons = collectButtons();
    const documentHeight = Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0, 1);
    const maxScroll = Math.max(0, documentHeight - window.innerHeight);
    return {
      capturedAt: new Date().toISOString(),
      url: location.href,
      host: location.hostname || (location.protocol === "file:" ? (location.pathname.split("/").pop() || "local file") : ""),
      title: document.title || "",
      metaDescription: tidy(document.querySelector("meta[name='description']")?.content || "").slice(0, 300),
      scroll: {
        y: Math.round(window.scrollY),
        percent: maxScroll ? Math.round((window.scrollY / maxScroll) * 100) : 0,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        documentHeight
      },
      outline: outlineOf(),
      visibleText: visibleText(),
      fields,
      forms,
      primaryFormId: pickPrimaryForm(forms),
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
    await wait(220);

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
    await wait(260);

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
  // Applying values
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
    return (wantedTokens.filter((token) => candidateTokens.has(token)).length / wantedTokens.length) * 0.7;
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
      const checked = entry.elements.find((radio) => radio.checked);
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
        const checked = entry.elements.find((radio) => radio.checked);
        if (checked) {
          checked.checked = false;
          checked.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else {
        const target = entry.elements.find((radio) => radio.value === state.checkedValue);
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
      if (!item || score < 0.6) return { ok: false, error: `"${value}" does not match one of the available choices.` };
      if (!item.checked) item.click();
      return { ok: true, applied: tidy(getLabel(item) || item.value), matchScore: score };
    }

    if (entry.type === "select") {
      const options = [...element.options].filter((option) => Boolean(option.value) || Boolean(option.textContent.trim()));
      const { item, score } = bestMatch(options, (option) => `${option.textContent} ${option.value}`, value);
      if (!item || score < 0.6) return { ok: false, error: `"${value}" does not match one of the dropdown choices.` };
      element.value = item.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, applied: tidy(item.textContent), matchScore: score };
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
    if (!element.checkValidity()) return { ok: false, error: "That value does not satisfy the page's validation." };
    return { ok: true, applied: value, matchScore: 1 };
  }

  // ---------------------------------------------------------------------------
  // WebMCP progressive enhancement
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
  // Page-change watcher. Multi-step forms swap fields in place; the panel
  // rescans before its next action rather than acting on a stale read.
  // ---------------------------------------------------------------------------
  let mutateTimer = null;
  let lastFieldCount = null;
  const observer = new MutationObserver(() => {
    clearTimeout(mutateTimer);
    mutateTimer = setTimeout(() => {
      try {
        const count = collectEntries().length;
        if (lastFieldCount !== null && count !== lastFieldCount) emit({ kind: "fields_changed", fieldCount: count });
        lastFieldCount = count;
      } catch (_) {}
    }, 900);
  });
  try {
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: false });
  } catch (_) {}

  let scrollTimer = null;
  window.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => emit({ kind: "scrolled", y: Math.round(window.scrollY) }), 500);
  }, { passive: true });

  // ---------------------------------------------------------------------------
  // Operations
  // ---------------------------------------------------------------------------
  async function handleApply(message) {
    // Always act in real DOM order, whatever order the caller listed.
    const actions = [...(message.actions || [])].sort((a, b) => {
      const left = registry.get(a.fieldId)?.element;
      const right = registry.get(b.fieldId)?.element;
      if (!left || !right) return 0;
      const position = left.compareDocumentPosition(right);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    const results = [];
    const batch = { id: `undo-${Date.now()}`, items: [] };

    for (const action of actions) {
      const entry = registry.get(action.fieldId);
      if (!entry || !entry.element.isConnected) {
        results.push({ fieldId: action.fieldId, ok: false, error: "That field is no longer on the page." });
        continue;
      }
      const name = fieldNameOf(entry);
      const marker = await highlight(entry, `Filling: ${name}`);
      const before = snapshotEntryState(entry);
      const result = applyValue(entry, action.value);
      if (result.ok) {
        batch.items.push({ entry, before, label: name });
        marker.update(`Filled: ${result.applied}`);
        emit({ kind: "action", action: "fill", label: name, value: result.applied });
        await wait(200);
      } else {
        marker.update("Needs your answer", "#b5472f");
        await wait(260);
      }
      marker.clear();
      results.push({ fieldId: action.fieldId, ok: result.ok, applied: result.applied, error: result.error, label: name });
    }

    if (batch.items.length) {
      undoStack.push(batch);
      if (undoStack.length > 20) undoStack.shift();
    }
    return { ok: true, results, undoId: batch.items.length ? batch.id : null };
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
      await wait(180);
      marker.clear();
      restored.push(item.label);
    }
    emit({ kind: "action", action: "undo", labels: restored });
    return { ok: true, restored };
  }

  async function handleAttachFile(message) {
    const entry = registry.get(message.fieldId);
    if (!entry || entry.type !== "file" || !entry.element.isConnected) {
      return { ok: false, error: "That file field is no longer on the page." };
    }
    try {
      const binary = atob(message.file.dataBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const file = new File([bytes], message.file.name, { type: message.file.mime || "application/octet-stream" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const marker = await highlight(entry, `Attaching: ${message.file.name}`);
      entry.element.files = transfer.files;
      entry.element.dispatchEvent(new Event("input", { bubbles: true }));
      entry.element.dispatchEvent(new Event("change", { bubbles: true }));
      const attached = entry.element.files?.length > 0;
      marker.update(attached ? "Attached" : "The page rejected the file", attached ? "#0d7355" : "#b5472f");
      await wait(260);
      marker.clear();
      if (!attached) return { ok: false, error: "The page did not accept the file. Choose it manually." };
      emit({ kind: "action", action: "attach", label: fieldNameOf(entry), value: message.file.name });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `Could not attach the file: ${error.message}` };
    }
  }

  async function handleClick(message) {
    const entry = registry.get(message.fieldId);
    if (!entry || !entry.element.isConnected) return { ok: false, error: "That button is no longer on the page." };
    const label = tidy(entry.element.textContent || entry.element.value || "button");
    const marker = await highlight(entry, `Clicking: ${label}`, "#0d7355");
    await wait(300);
    entry.element.click();
    marker.clear();
    emit({ kind: "action", action: "click", label });
    return { ok: true, label };
  }

  async function handleFocusForm(message) {
    const field = registry.get(message.fieldId);
    if (!field || !field.element.isConnected) return { ok: false, error: "That part of the page is gone." };
    const marker = await highlight(field, message.label || "Working here", "#3b7ddd");
    setTimeout(() => marker.clear(), 2500);
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;

    if (message.type === "KEEL_PING") {
      sendResponse({ ok: true, version: 4 });
      return;
    }
    if (message.type === "KEEL_PERCEIVE") {
      (async () => {
        const page = perceive();
        if (message.includeWebmcp !== false) {
          const mcp = await webmcpRequest("detect", {}, 600);
          page.webmcp = mcp.ok ? mcp : { ok: false, available: false };
        }
        sendResponse({ ok: true, page });
      })();
      return true;
    }
    if (message.type === "KEEL_APPLY") { handleApply(message).then(sendResponse); return true; }
    if (message.type === "KEEL_UNDO") { handleUndo().then(sendResponse); return true; }
    if (message.type === "KEEL_ATTACH_FILE") { handleAttachFile(message).then(sendResponse); return true; }
    if (message.type === "KEEL_CLICK") { handleClick(message).then(sendResponse); return true; }
    if (message.type === "KEEL_FOCUS") { handleFocusForm(message).then(sendResponse); return true; }
    if (message.type === "KEEL_FIELD_STATE") {
      const entry = registry.get(message.fieldId);
      if (!entry || !entry.element.isConnected) { sendResponse({ ok: false, error: "gone" }); return; }
      sendResponse({ ok: true, currentValue: currentValueOf(entry) });
      return;
    }
    if (message.type === "KEEL_WEBMCP_CALL") {
      webmcpRequest("call", { tool: message.tool, args: message.args }, 15000).then(sendResponse);
      return true;
    }
  });
})();
