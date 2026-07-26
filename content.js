(() => {
  if (globalThis.__keelContentLoaded) return;
  globalThis.__keelContentLoaded = true;

  let activeRun = null;
  let pendingReply = null;
  let sequence = 0;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (value = "") => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  function emit(event) {
    chrome.runtime.sendMessage({ type: "KEEL_EVENT", ...event }).catch(() => {});
  }

  function makeRequestId() {
    sequence += 1;
    return `keel-${Date.now()}-${sequence}`;
  }

  function waitForHuman(payload) {
    const requestId = makeRequestId();
    emit({ ...payload, requestId });
    return new Promise((resolve) => {
      pendingReply = { requestId, resolve };
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "KEEL_PING") {
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "KEEL_REPLY") {
      if (pendingReply?.requestId === message.requestId) {
        const { resolve } = pendingReply;
        pendingReply = null;
        resolve({ action: message.action, value: message.value || "" });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "That prompt is no longer active." });
      }
      return;
    }

    if (message?.type === "KEEL_START") {
      if (activeRun) {
        sendResponse({ ok: false, error: "Keel is already working on this page." });
        return;
      }
      activeRun = runApplicationSkill(message.profile || {}, message.intent || "")
        .catch((error) => emit({ kind: "error", message: `I stopped safely: ${error.message}` }))
        .finally(() => {
          activeRun = null;
          pendingReply = null;
        });
      sendResponse({ ok: true });
    }
  });

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
    const directLabel = [...new Set(pieces.map((piece) => piece.trim()).filter(Boolean))].join(" · ");
    if (directLabel) return directLabel.replace(/\s+/g, " ").trim();
    const legend = element.closest("fieldset")?.querySelector("legend");
    return (legend?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function fieldName(field) {
    const element = field.element;
    if (field.type === "radio") {
      const group = element.closest("fieldset, [role='radiogroup']");
      const legend = group?.matches("fieldset") ? group.querySelector(":scope > legend") : null;
      const groupLabel = legend?.textContent || (group?.getAttribute("aria-labelledby") ? textFromIds(group.getAttribute("aria-labelledby")) : "");
      if (groupLabel.trim()) return groupLabel.replace(/\s+/g, " ").trim();
    }
    return getLabel(element) || element.placeholder || element.name || element.id || "Unlabeled field";
  }

  function isRequired(field) {
    if (field.elements) return field.elements.some((element) => element.required || element.getAttribute("aria-required") === "true");
    return field.element.required || field.element.getAttribute("aria-required") === "true";
  }

  function collectFields() {
    const controls = [...document.querySelectorAll("input, select, textarea")];
    const seenRadioGroups = new Set();
    const fields = [];

    for (const element of controls) {
      const type = (element.type || element.tagName).toLowerCase();
      if (element.disabled || element.readOnly || type === "hidden" || ["submit", "reset", "button", "image"].includes(type)) continue;
      if (!isVisible(element) && type !== "file") continue;

      if (type === "radio" && element.name) {
        if (seenRadioGroups.has(element.name)) continue;
        const group = controls.filter((candidate) => candidate.type === "radio" && candidate.name === element.name && !candidate.disabled);
        seenRadioGroups.add(element.name);
        fields.push({ element, elements: group, type: "radio" });
      } else {
        fields.push({ element, type });
      }
    }
    return fields;
  }

  function metadataFor(field) {
    const element = field.element;
    return normalize([
      getLabel(element),
      element.name,
      element.id,
      element.placeholder,
      element.getAttribute("aria-label"),
      element.autocomplete
    ].filter(Boolean).join(" "));
  }

  function profileMatch(field, profile) {
    const element = field.element;
    const autocomplete = normalize(element.autocomplete);
    const meta = metadataFor(field);
    const exactAutocomplete = {
      "given name": "firstName",
      "family name": "lastName",
      "name": "fullName",
      "email": "email",
      "tel": "phone",
      "address line1": "addressLine1",
      "address line2": "addressLine2",
      "address level2": "city",
      "address level1": "state",
      "postal code": "postalCode",
      "country name": "country",
      "country": "country"
    };

    let key = exactAutocomplete[autocomplete];
    if (!key) {
      const rules = [
        ["firstName", /\b(first name|given name|forename|fname)\b/],
        ["lastName", /\b(last name|family name|surname|lname)\b/],
        ["fullName", /\b(full name|your name|candidate name|applicant name)\b/],
        ["email", /\b(e mail|email|email address)\b/],
        ["phone", /\b(phone|phone number|mobile|telephone|cell)\b/],
        ["addressLine2", /\b(address line 2|address 2|apt|apartment|suite|unit)\b/],
        ["addressLine1", /\b(street address|address line 1|address 1|home address)\b/],
        ["city", /\b(city|town)\b/],
        ["state", /\b(state|province|region)\b/],
        ["postalCode", /\b(zip|zip code|postal|postal code|postcode)\b/],
        ["country", /\b(country|nation)\b/],
        ["linkedin", /\blinked ?in\b/],
        ["github", /\bgithub\b/],
        ["portfolio", /\b(portfolio|personal website|personal site|website url)\b/],
        ["currentCompany", /\b(current company|current employer|company name|employer name)\b/],
        ["currentTitle", /\b(current title|job title|current role|position title)\b/],
        ["workHistory", /\b(work history|employment history|experience summary|professional experience)\b/]
      ];
      key = rules.find(([, pattern]) => pattern.test(meta))?.[0];
      if (!key && ["name", "your name"].includes(meta)) key = "fullName";
    }

    if (!key) return null;
    let value = profile[key] || "";
    if (key === "fullName" && !value) value = [profile.firstName, profile.lastName].filter(Boolean).join(" ");
    return { source: "heuristic", key, value: String(value || "").trim() };
  }

  async function resolveField(field, profile) {
    const heuristic = profileMatch(field, profile);
    if (heuristic) return heuristic;

    // Future LLM resolver seam: return { source: "llm", key, value } only
    // when confidence is high. Returning null preserves the ask-before-guessing rule.
    return null;
  }

  function getDisplayTarget(field) {
    const element = field.element;
    if (isVisible(element)) return element;
    return element.labels?.[0] || element.closest("label") || element.parentElement || element;
  }

  async function highlight(field, label, color = "#f1a33c") {
    const target = getDisplayTarget(field);
    target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    await wait(350);

    const previous = {
      outline: target.style.outline,
      outlineOffset: target.style.outlineOffset,
      transition: target.style.transition
    };
    target.style.transition = "outline-color 160ms ease";
    target.style.outline = `4px solid ${color}`;
    target.style.outlineOffset = "3px";

    const badge = document.createElement("div");
    badge.setAttribute("data-keel-overlay", "true");
    badge.textContent = `Keel · ${label}`;
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
    await wait(650);

    return {
      update(text, nextColor = "#0d7355") {
        badge.textContent = `Keel · ${text}`;
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

  function dispatchValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.blur();
  }

  function optionNames(field) {
    if (field.type === "radio") {
      return field.elements.map((radio) => getLabel(radio) || radio.value).filter(Boolean);
    }
    if (field.element instanceof HTMLSelectElement) {
      return [...field.element.options].filter((option) => Boolean(option.value)).map((option) => option.textContent.trim());
    }
    if (field.type === "checkbox") return ["Yes", "No"];
    return [];
  }

  function currentValue(field) {
    if (field.type === "radio") return field.elements.some((radio) => radio.checked);
    if (field.type === "checkbox") return field.element.checked;
    if (field.type === "file") return field.element.files?.length > 0;
    return String(field.element.value || "").trim().length > 0;
  }

  function applyValue(field, rawValue) {
    const value = String(rawValue).trim();
    const normalizedValue = normalize(value);
    const element = field.element;

    if (field.type === "radio") {
      const match = field.elements.find((radio) => {
        const candidate = normalize(`${getLabel(radio)} ${radio.value}`);
        return candidate === normalizedValue || candidate.includes(normalizedValue) || normalizedValue.includes(candidate);
      });
      if (!match) return { ok: false, error: "That answer does not match one of the available choices." };
      if (!match.checked) match.click();
      if (!match.checkValidity()) return { ok: false, error: "That choice does not satisfy the page’s validation." };
      return { ok: true };
    }

    if (element instanceof HTMLSelectElement) {
      const match = [...element.options].filter((option) => Boolean(option.value)).find((option) => {
        const text = normalize(option.textContent);
        const optionValue = normalize(option.value);
        return text === normalizedValue || optionValue === normalizedValue;
      });
      if (!match) return { ok: false, error: "That answer does not exactly match an available choice." };
      element.value = match.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      if (!element.checkValidity()) return { ok: false, error: "That choice does not satisfy the page’s validation." };
      return { ok: true };
    }

    if (field.type === "checkbox") {
      const yes = ["yes", "true", "checked", "1", "agree"].includes(normalizedValue);
      const no = ["no", "false", "unchecked", "0", "disagree"].includes(normalizedValue);
      if (!yes && !no) return { ok: false, error: "Answer Yes or No for this checkbox." };
      if (element.checked !== yes) element.click();
      if (!element.checkValidity()) return { ok: false, error: "This required checkbox must be accepted to continue." };
      return { ok: true };
    }

    dispatchValue(element, value);
    if (!element.checkValidity()) return { ok: false, error: "That value does not satisfy the page’s validation." };
    return { ok: true };
  }

  async function askForField(field, reason = "I can’t confidently map this field, so I won’t guess.") {
    const name = fieldName(field);
    const optional = !isRequired(field);
    const options = optionNames(field);

    while (true) {
      const answer = await waitForHuman({
        kind: "ask",
        title: name,
        detail: `${reason}${options.length ? ` Available choices: ${options.join(", ")}.` : ""}`,
        message: `I need your answer for “${name}”${optional ? " (optional)" : " (required)"}.`,
        optional,
        options
      });
      if (answer.action === "skip" && optional) return { skipped: true };
      if (answer.action !== "answer") continue;

      const marker = await highlight(field, `About to fill: ${name}`);
      const result = applyValue(field, answer.value);
      if (result.ok) {
        marker.update("Filled with your answer");
        await wait(350);
        marker.clear();
        return { skipped: false };
      }
      marker.update("Answer did not match", "#b5472f");
      await wait(450);
      marker.clear();
      reason = result.error;
    }
  }

  async function pauseAtFriction(field, friction) {
    const name = fieldName(field);
    const optional = !isRequired(field);

    while (true) {
      const marker = await highlight(field, `Your turn: ${friction.action}`);
      const answer = await waitForHuman({
        kind: "pause",
        title: friction.title,
        detail: friction.detail,
        message: `Paused at “${name}.” ${friction.chat}`,
        optional
      });
      marker.clear();

      if (answer.action === "skip" && optional) return { skipped: true };
      if (answer.action !== "continue") continue;
      if (friction.isComplete()) return { skipped: false };
      emit({ kind: "progress", message: friction.incomplete });
    }
  }

  function findCaptcha() {
    const selectors = [
      'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]',
      ".g-recaptcha", ".h-captcha", "[data-sitekey]",
      '[class*="captcha" i]', '[id*="captcha" i]'
    ];
    return [...document.querySelectorAll(selectors.join(","))].find(isVisible) || null;
  }

  async function pauseForCaptcha(element) {
    const field = { element, type: "captcha" };
    const marker = await highlight(field, "Your turn: Complete verification");
    await waitForHuman({
      kind: "pause",
      title: "Complete the CAPTCHA",
      detail: "Keel will never solve or bypass a CAPTCHA. Complete it in the page, then continue.",
      message: "I found a CAPTCHA and paused for you to complete it.",
      optional: false
    });
    marker.clear();
  }

  async function runApplicationSkill(profile, intent) {
    emit({ kind: "progress", message: `Starting job-application skill for: “${intent}”.` });
    const fields = collectFields();
    if (!fields.length) throw new Error("I couldn’t find any visible form fields on this page.");
    emit({ kind: "progress", message: `Found ${fields.length} form field${fields.length === 1 ? "" : "s"}. I’ll work from top to bottom.` });

    let filled = 0;
    let skipped = 0;
    for (const field of fields) {
      if (!field.element.isConnected) continue;
      const name = fieldName(field);

      if (field.type === "password") {
        const result = await pauseAtFriction(field, {
          action: "Enter password",
          title: "Enter the password yourself",
          detail: "Keel never reads, stores, or types passwords. Enter it directly in the page, then continue.",
          chat: "Please enter the password directly in the page.",
          isComplete: () => Boolean(field.element.value),
          incomplete: "The password field still looks empty. Fill it in the page, then continue."
        });
        if (result.skipped) skipped += 1;
        continue;
      }

      if (field.type === "file") {
        const result = await pauseAtFriction(field, {
          action: "Upload file",
          title: "Upload your resume or file",
          detail: "Choose the correct file in the page yourself. Keel cannot access your filesystem or choose a resume for you.",
          chat: "Please choose the correct file yourself.",
          isComplete: () => (field.element.files?.length || 0) > 0,
          incomplete: "No file is selected yet. Choose a file in the page, then continue."
        });
        if (result.skipped) skipped += 1;
        continue;
      }

      if (currentValue(field)) {
        emit({ kind: "progress", message: `Kept your existing answer for “${name}”.` });
        continue;
      }

      const match = await resolveField(field, profile);
      if (!match || !match.value) {
        const result = await askForField(field, match ? "This matches your profile, but that profile value is empty." : undefined);
        if (result.skipped) skipped += 1;
        else filled += 1;
        continue;
      }

      const marker = await highlight(field, `About to fill: ${name}`);
      const result = applyValue(field, match.value);
      if (result.ok) {
        marker.update(`Filled from profile: ${match.key}`);
        filled += 1;
        await wait(350);
        marker.clear();
      } else {
        marker.update("Needs your answer", "#b5472f");
        await wait(350);
        marker.clear();
        const answer = await askForField(field, result.error);
        if (answer.skipped) skipped += 1;
        else filled += 1;
      }
    }

    const captcha = findCaptcha();
    if (captcha) await pauseForCaptcha(captcha);

    emit({
      kind: "done",
      message: `Finished this page: filled ${filled}, skipped ${skipped}. I did not click Submit. Review every answer and submit only when you’re ready.`
    });
  }
})();
