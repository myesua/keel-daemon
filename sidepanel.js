// Keel side panel.
//
// One rule shapes this file: every turn starts by looking at the user's screen,
// and the model decides what happens next. There is no question script, no
// phase machine, and no fixed order of prompts. The panel's job is to perceive,
// ask the model, guard the answer, and show the user everything before anything
// touches the page.

import { perceive, pageForModel, factualSummary, resolveTargetTab } from "./lib/perception.js";
import {
  loadMemory,
  saveMemory,
  recordFact,
  recordMessage,
  recordQuestion,
  answerOpenQuestions,
  factsForModel,
  getFact
} from "./lib/memory.js";
import { buildState, decide, applyGuards, draftValues } from "./lib/agent.js";
import { humanizeText } from "./lib/assist.js";
import {
  loadProfile,
  saveProfile,
  setProfileValue,
  profileSummaryText,
  loadDocuments,
  saveDocument,
  rememberAnswer
} from "./lib/profile.js";
import { readDocument } from "./lib/docs.js";
import { fetchJobDescription, tailorResume, makeResumePdfBase64 } from "./lib/jobkit.js";
import { VoiceInput } from "./lib/voice.js";

const WALKAWAY_KEY = "keelWalkawayV1";
const CAPTURE_KEY = "keelScreenCaptureV1";

const thread = document.querySelector("#thread");
const contextLine = document.querySelector("#context-line");
const composer = document.querySelector("#composer-input");
const sendButton = document.querySelector("#send-button");
const attachButton = document.querySelector("#attach-button");
const fileInput = document.querySelector("#file-input");
const micButton = document.querySelector("#mic-button");
const voiceHint = document.querySelector("#voice-hint");
const walkawayToggle = document.querySelector("#walkaway-toggle");
const visionShot = document.querySelector("#vision-shot");
const visionTitle = document.querySelector("#vision-title");
const visionDetail = document.querySelector("#vision-detail");
const visionToggle = document.querySelector("#vision-toggle");

fileInput.accept = ".pdf,.docx,.txt,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let memory;
let profile;
let documents;
let captureEnabled = true;
let currentTabId = null;
let lastPerception = null;
let busy = false;

// ---------------------------------------------------------------------------
// Thread rendering
// ---------------------------------------------------------------------------
function scrollThread() {
  requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
}

function addMessage(text, role = "keel", kind = "") {
  const value = humanizeText(String(text || "")).trim();
  if (!value) return null;
  const node = document.createElement("div");
  node.className = `msg ${role} ${kind}`.trim();
  node.textContent = value;
  thread.append(node);
  scrollThread();
  return node;
}

function addTimeline(text, buttonLabel = null, onClick = null) {
  const row = document.createElement("div");
  row.className = "timeline-entry";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.textContent = "\u2022";
  const label = document.createElement("span");
  label.textContent = humanizeText(text);
  row.append(dot, label);
  if (buttonLabel && onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = buttonLabel;
    button.addEventListener("click", onClick, { once: true });
    row.append(button);
  }
  thread.append(row);
  scrollThread();
  return row;
}

function addCard(title, eyebrow = "KEEL") {
  const card = document.createElement("section");
  card.className = "card";
  const head = document.createElement("div");
  head.className = "card-head";
  const tag = document.createElement("span");
  tag.className = "eyebrow";
  tag.textContent = eyebrow;
  const strong = document.createElement("strong");
  strong.textContent = title;
  head.append(tag, strong);
  const body = document.createElement("div");
  body.className = "card-body";
  card.append(head, body);
  thread.append(card);
  scrollThread();
  return { card, body };
}

function renderStoredTranscript() {
  thread.replaceChildren();
  for (const item of memory.transcript || []) {
    const node = document.createElement("div");
    node.className = `msg ${item.role === "user" ? "user" : "keel"}`;
    node.textContent = item.text;
    thread.append(node);
  }
  scrollThread();
}

async function notify(title, message) {
  if (!walkawayToggle.checked) return;
  const icon = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='128' height='128'><rect width='128' height='128' rx='30' fill='#102b24'/><text x='64' y='88' text-anchor='middle' font-family='Arial' font-size='72' font-weight='700' fill='#b8f36b'>K</text></svg>");
  try {
    await chrome.notifications.create({ type: "basic", iconUrl: icon, title, message: humanizeText(message) });
  } catch (_) {
    document.title = `${title}: ${humanizeText(message)}`;
  }
}

// ---------------------------------------------------------------------------
// The "what Keel can see" strip. It is deliberately literal: it only ever
// shows what was actually read from the active tab a moment ago.
// ---------------------------------------------------------------------------
function renderVision(perception) {
  if (!perception?.ok) {
    visionShot.hidden = true;
    visionTitle.textContent = "I cannot read that tab";
    visionDetail.textContent = perception?.error || "Open a normal web page.";
    contextLine.textContent = "No page in view";
    return;
  }
  const page = perception.page;
  const primary = (page.forms || []).find((form) => form.id === page.primaryFormId);
  visionTitle.textContent = page.title || page.host || "Untitled page";
  const bits = [];
  bits.push(`${page.fields.length} field${page.fields.length === 1 ? "" : "s"}`);
  if (primary) bits.push(`on ${primary.label}`);
  bits.push(`scrolled ${page.scroll.percent}%`);
  bits.push(perception.screenshot?.ok ? "screen captured" : "no screenshot");
  visionDetail.textContent = bits.join(" \u00b7 ");
  contextLine.textContent = page.title || page.host || "Looking at this page";
  if (perception.screenshot?.ok) {
    visionShot.src = perception.screenshot.dataUrl;
    visionShot.hidden = false;
  } else {
    visionShot.hidden = true;
  }
}

function setBusy(state, label = "") {
  busy = state;
  sendButton.disabled = state;
  if (state && label) visionDetail.textContent = label;
}

// ---------------------------------------------------------------------------
// Page operations
// ---------------------------------------------------------------------------
async function sendToPage(message, tabId) {
  const id = tabId ?? currentTabId ?? (await resolveTargetTab()).id;
  return chrome.tabs.sendMessage(id, message);
}

function confidenceClass(score) {
  if (score >= 0.8) return "high";
  if (score >= 0.5) return "medium";
  return "low";
}

function controlFor(item) {
  const field = item.field;
  let control;
  if (["radio", "select", "checkbox"].includes(field.type)) {
    control = document.createElement("select");
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "Choose an answer";
    control.append(empty);
    const options = field.type === "checkbox" ? ["Yes", "No"] : field.options || [];
    for (const option of options) {
      const node = document.createElement("option");
      node.value = option;
      node.textContent = option;
      control.append(node);
    }
    control.value = item.value || "";
  } else if (field.type === "textarea") {
    control = document.createElement("textarea");
    control.value = item.value || "";
  } else {
    control = document.createElement("input");
    control.type = "text";
    control.value = item.value || "";
  }
  control.addEventListener("input", () => {
    item.value = control.value;
    item.selected = Boolean(control.value);
    item.checkbox.checked = item.selected;
    item.row.classList.toggle("excluded", !item.selected);
  });
  return control;
}

// Field ids belong to one scan of the page. As soon as Keel looks again, any
// older preview is out of date, so it stops being clickable instead of quietly
// failing against ids that no longer exist.
function retireOpenPlans(reason = "This preview is out of date because I looked at the page again.") {
  for (const card of thread.querySelectorAll(".card[data-plan='open']")) {
    card.dataset.plan = "stale";
    card.querySelectorAll(".card-actions button, .plan-row input, .plan-row select, .plan-row textarea").forEach((node) => {
      node.disabled = true;
    });
    const note = document.createElement("p");
    note.className = "card-note";
    note.textContent = reason;
    card.querySelector(".card-body")?.append(note);
  }
}

function renderPlan(plan) {
  retireOpenPlans();
  const { card, body } = addCard("Check this before I touch the page", "PREVIEW");
  card.dataset.plan = "open";
  const note = document.createElement("p");
  note.className = "card-note";
  note.textContent = `${plan.items.length} field${plan.items.length === 1 ? "" : "s"} on ${plan.formLabel}, in the order they appear on the page. Edit anything, untick anything. Nothing is submitted.`;
  body.append(note);

  for (const item of plan.items) {
    const row = document.createElement("label");
    row.className = `plan-row${item.selected ? "" : " excluded"}`;
    item.row = row;
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "row-check";
    check.checked = item.selected;
    item.checkbox = check;
    check.addEventListener("change", () => {
      item.selected = check.checked;
      row.classList.toggle("excluded", !item.selected);
    });
    const label = document.createElement("div");
    label.className = "row-label";
    const dot = document.createElement("span");
    dot.className = `conf ${confidenceClass(item.confidence)}`;
    const name = document.createElement("span");
    name.textContent = item.field.label;
    const source = document.createElement("span");
    source.className = "row-source";
    source.textContent = item.why || item.field.type;
    label.append(dot, name, source);
    row.append(check, label, controlFor(item));
    body.append(row);
  }

  if (plan.skipped.length) {
    const skipped = document.createElement("p");
    skipped.className = "card-note";
    skipped.textContent = `Left alone: ${plan.skipped.map((item) => `${item.label || item.fieldId} (${item.reason})`).join("; ")}.`;
    body.append(skipped);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const fill = document.createElement("button");
  fill.type = "button";
  fill.className = "primary";
  fill.textContent = "Fill these fields";
  fill.addEventListener("click", async () => {
    fill.disabled = true;
    try {
      await applyPlan(plan);
      card.dataset.plan = "done";
      card.remove();
    } catch (error) {
      addMessage(error.message, "keel", "warning");
      fill.disabled = false;
    }
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary";
  cancel.textContent = "Not yet";
  cancel.addEventListener("click", () => {
    card.remove();
    addMessage("Fine, nothing filled. Tell me what to change.");
  });
  actions.append(fill, cancel);
  card.append(actions);
}

async function applyPlan(plan) {
  const chosen = plan.items.filter((item) => item.selected && String(item.value || "").trim());
  if (!chosen.length) throw new Error("Tick at least one field first.");
  const result = await sendToPage({
    type: "KEEL_APPLY",
    actions: chosen.map((item) => ({ fieldId: item.fieldId, value: item.value }))
  }, plan.tabId);
  if (!result?.ok) throw new Error("The page refused the fill.");

  let filled = 0;
  for (const row of result.results || []) {
    if (row.ok) filled += 1;
    else addMessage(`${row.label || "A field"}: ${row.error}`, "keel", "warning");
  }

  for (const item of chosen) {
    rememberAnswer(profile, item.field.label, item.value, plan.host);
  }
  await saveProfile(profile);

  addTimeline(
    `Filled ${filled} field${filled === 1 ? "" : "s"} on ${plan.formLabel}`,
    result.undoId ? "Undo" : null,
    result.undoId ? () => undoLast(plan.tabId) : null
  );
  await notify("Keel filled the form", `${filled} fields are ready for your review.`);
  await showSubmitReview(plan);
}

async function undoLast(tabId) {
  try {
    const result = await sendToPage({ type: "KEEL_UNDO" }, tabId);
    addMessage(result?.ok
      ? `Put back ${result.restored.length} field${result.restored.length === 1 ? "" : "s"}.`
      : result?.error || "There is nothing to undo.");
  } catch (error) {
    addMessage(error.message, "keel", "warning");
  }
}

// The last gate. Keel shows exactly what is in the form right now, read back
// from the live page, and the submit click only happens if the user asks for it.
async function showSubmitReview(plan) {
  const perception = await perceive({ preferredTabId: plan.tabId, withScreenshot: captureEnabled });
  if (!perception.ok) return;
  lastPerception = perception;
  renderVision(perception);

  const page = perception.page;
  const formId = plan.formId && page.forms.some((form) => form.id === plan.formId) ? plan.formId : page.primaryFormId;
  const fields = page.fields.filter((field) => field.formId === formId);
  const submit = page.buttons.find((button) => button.commits && button.formId === formId)
    || page.buttons.find((button) => button.commits);

  const { card, body } = addCard("This is what would be submitted", "REVIEW BEFORE SUBMIT");
  const list = document.createElement("div");
  list.className = "doc-preview";
  list.textContent = fields
    .map((field) => `${field.label}: ${field.currentValue || (field.type === "password" ? "(yours to type)" : "(empty)")}`)
    .join("\n");
  body.append(list);

  const note = document.createElement("p");
  note.className = "card-note";
  const pending = fields.filter((field) => field.required && !field.currentValue);
  note.textContent = pending.length
    ? `Still empty and required: ${pending.map((field) => field.label).join(", ")}. I have not clicked anything.`
    : "Everything required is filled. I have not clicked anything.";
  body.append(note);

  if (page.captchaPresent) {
    const captcha = document.createElement("p");
    captcha.className = "card-note";
    captcha.textContent = "There is a verification check on the page. That one is yours, I never touch a captcha.";
    body.append(captcha);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";
  if (submit) {
    const click = document.createElement("button");
    click.type = "button";
    click.className = "danger";
    click.textContent = `Click ${submit.text || "Submit"}`;
    click.addEventListener("click", async () => {
      click.disabled = true;
      try {
        const result = await sendToPage({ type: "KEEL_CLICK", fieldId: submit.id }, plan.tabId);
        if (!result?.ok) throw new Error(result?.error || "The page refused the click.");
        addTimeline(`Clicked ${result.label} because you approved it`);
        card.remove();
      } catch (error) {
        addMessage(error.message, "keel", "warning");
        click.disabled = false;
      }
    });
    actions.append(click);
  }
  const done = document.createElement("button");
  done.type = "button";
  done.className = "secondary";
  done.textContent = submit ? "I will submit it myself" : "Got it";
  done.addEventListener("click", () => card.remove());
  actions.append(done);
  card.append(actions);
}

function renderClickProposal(guarded, page, tabId) {
  const button = page.buttons.find((item) => item.id === guarded.click.buttonId);
  if (!button) return;
  const { card, body } = addCard(`Keel wants to click "${button.text}"`, "YOUR CALL");
  const note = document.createElement("p");
  note.className = "card-note";
  note.textContent = humanizeText(guarded.click.reason || "This moves the flow forward.");
  body.append(note);
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const go = document.createElement("button");
  go.type = "button";
  go.className = button.commits ? "danger" : "primary";
  go.textContent = `Click ${button.text}`;
  go.addEventListener("click", async () => {
    go.disabled = true;
    try {
      const result = await sendToPage({ type: "KEEL_CLICK", fieldId: button.id }, tabId);
      if (!result?.ok) throw new Error(result?.error || "The page refused the click.");
      addTimeline(`Clicked ${result.label} because you approved it`);
      card.remove();
    } catch (error) {
      addMessage(error.message, "keel", "warning");
      go.disabled = false;
    }
  });
  const no = document.createElement("button");
  no.type = "button";
  no.className = "secondary";
  no.textContent = "No";
  no.addEventListener("click", () => card.remove());
  actions.append(go, no);
  card.append(actions);
}

const SCREEN_QUESTION = /\b(see (my|the|this) (screen|page|tab|form)|what (page|tab|form|site) (am i|is this)|what (do|can) you see|are you (looking at|seeing)|what is (on|at) (the|this) (page|screen|bottom|top)|read (this|the) page)\b/i;

function asksAboutTheScreen(text) {
  return SCREEN_QUESTION.test(String(text || ""));
}

// A link the user shares is content, not chatter. Keel reads it once and keeps
// it, so the user never has to paste the same posting twice.
async function absorbLinks(text) {
  const urls = String(text || "").match(/https?:\/\/[^\s<>"')]+/g) || [];
  for (const url of urls.slice(0, 2)) {
    const key = `linkedPage:${url}`;
    if (getFact(memory, key)) continue;
    try {
      addTimeline(`Reading ${url}`);
      const content = await fetchJobDescription(url);
      recordFact(memory, key, content, { label: `Content of the link you shared (${url})`, source: url });
      await saveMemory(memory);
    } catch (error) {
      addTimeline(`I could not read ${url}: ${error.message}`);
    }
  }
}

async function makeTailoredResume() {
  const resume = getFact(memory, "resume")?.value || documents.resume?.text;
  if (!resume) {
    addMessage("I do not have your resume yet. Send it with the paperclip and I will handle the rest.");
    return;
  }
  const jobFact = Object.values(memory.facts).find((fact) => /job|role|position|link/i.test(fact.label));
  addTimeline("Drafting a tailored resume from your real experience");
  const text = await tailorResume({
    resumeText: resume,
    jobDescription: jobFact?.value || "",
    profileSummary: profileSummaryText(profile)
  });
  if (!text) {
    addMessage("The draft did not come back. Your original resume is still saved.", "keel", "warning");
    return;
  }
  const name = `${(profile.identity?.fullName || "resume").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-tailored.pdf`;
  documents.tailoredResume = await saveDocument("tailoredResume", {
    name,
    mime: "application/pdf",
    dataBase64: makeResumePdfBase64("Tailored resume", text),
    text
  });
  const { body } = addCard("Tailored resume draft", "DOCUMENT PREVIEW");
  const preview = document.createElement("div");
  preview.className = "doc-preview";
  preview.textContent = text;
  body.append(preview);
  addMessage("Saved as a real PDF. It only rewords what is already in your resume, nothing invented.");
}

// ---------------------------------------------------------------------------
// The turn: perceive, reason, guard, show
// ---------------------------------------------------------------------------
async function runTurn(userMessage, { silentUser = false } = {}) {
  if (busy) return;
  setBusy(true, "Reading your screen");

  try {
    if (userMessage && !silentUser) {
      addMessage(userMessage, "user");
      recordMessage(memory, "user", userMessage);
      answerOpenQuestions(memory, userMessage);
      await saveMemory(memory);
    }
    if (userMessage) await absorbLinks(userMessage);

    const perception = await perceive({ preferredTabId: currentTabId, withScreenshot: captureEnabled });
    lastPerception = perception;
    renderVision(perception);

    if (!perception.ok) {
      const line = perception.error;
      addMessage(line, "keel", "warning");
      recordMessage(memory, "assistant", line);
      await saveMemory(memory);
      return;
    }

    currentTabId = perception.tab.id;
    const page = perception.page;
    const baseState = {
      page,
      pageModelView: pageForModel(page),
      screenshot: perception.screenshot,
      facts: factsForModel(memory),
      profileSummary: profileSummaryText(profile),
      transcript: memory.transcript,
      userMessage
    };

    let attempt = await decide({
      state: buildState(baseState),
      screenshotDataUrl: perception.screenshot?.ok ? perception.screenshot.dataUrl : null
    });

    if (!attempt.decision) {
      const honest = `My model call did not come back, so I will not guess. Here is what I can actually see right now:\n${factualSummary(page, perception.screenshot)}`;
      addMessage(honest, "keel", "warning");
      recordMessage(memory, "assistant", honest);
      await saveMemory(memory);
      return;
    }

    let guarded = applyGuards({ decision: attempt.decision, page, memory, userMessage });

    // A blocked question means the model tried to repeat itself. Give it the
    // correction and let it choose a real action instead of asking again.
    if (guarded.blockedQuestion) {
      const retry = await decide({
        state: buildState({ ...baseState, notes: guarded.notes }),
        screenshotDataUrl: perception.screenshot?.ok ? perception.screenshot.dataUrl : null
      });
      if (retry.decision) {
        const second = applyGuards({ decision: retry.decision, page, memory, userMessage });
        if (!second.blockedQuestion) guarded = second;
        else guarded = { ...second, question: null, next: second.fills.length ? "fill" : "wait" };
      }
    }

    for (const item of guarded.remember || []) {
      if (!item?.key || item.value == null || item.value === "") continue;
      recordFact(memory, item.key, item.value, { label: item.label || item.key, source: "conversation" });
      if (["fullName", "email", "phone", "linkedin", "github", "portfolio", "city", "country", "company", "jobTitle"].includes(item.key)) {
        setProfileValue(profile, item.key, item.value);
      }
    }
    if (guarded.remember?.length) await saveProfile(profile);

    if (guarded.say) {
      addMessage(guarded.say);
      recordMessage(memory, "assistant", guarded.say);
    }

    // When the question is about what Keel can see, the model's answer is
    // backed by the literal read of the page, straight from this turn's
    // capture. No paraphrase, no chance of a confident invention.
    if (asksAboutTheScreen(userMessage)) {
      const readout = factualSummary(page, perception.screenshot);
      addMessage(readout, "keel", "success");
      recordMessage(memory, "assistant", readout);
    }
    if (guarded.blocked) {
      addMessage(guarded.blocked, "keel", "warning");
      recordMessage(memory, "assistant", guarded.blocked);
    }

    if (guarded.next === "ask" && guarded.question?.text) {
      const question = humanizeText(guarded.question.text);
      // If the spoken line already asked, do not ask twice in the same breath.
      const alreadySpoken = guarded.say.includes(question) || guarded.say.includes("?");
      if (!alreadySpoken) {
        addMessage(question);
        recordMessage(memory, "assistant", question);
      }
      recordQuestion(memory, question, guarded.question.factKey || null);
    }

    // Completeness pass. Deciding to fill and writing good values are separate
    // jobs: this one looks at every empty field in the form the user is on and
    // drafts them all, which is what stops Keel filling the top of a form and
    // abandoning the bottom of it. Its values win over the ones the reasoning
    // pass sketched, because it sees each field's options and limits.
    if (guarded.next === "fill" || guarded.fills.length) {
      const remaining = page.fields.filter((field) =>
        field.formId === guarded.targetFormId
        && !field.currentValue
        && field.type !== "password"
        && field.type !== "file"
        && !field.isOtp);
      if (remaining.length) {
        setBusy(true, `Drafting ${remaining.length} more field${remaining.length === 1 ? "" : "s"}`);
        const draft = await draftValues({
          facts: factsForModel(memory),
          profileSummary: profileSummaryText(profile),
          page,
          fields: remaining,
          conversation: memory.transcript,
          userGoal: userMessage || memory.transcript.slice(-1)[0]?.text
        });
        for (const [fieldId, entry] of Object.entries(draft.values || {})) {
          const field = page.fields.find((item) => item.id === fieldId);
          if (!field || !entry || !String(entry.value ?? "").trim()) continue;
          const existing = guarded.fills.findIndex((fill) => fill.fieldId === fieldId);
          if (existing >= 0) guarded.fills.splice(existing, 1);
          guarded.fills.push({
            fieldId,
            field,
            value: String(entry.value).trim(),
            confidence: typeof entry.confidence === "number" ? entry.confidence : 0.6,
            why: humanizeText(entry.why || "drafted for you")
          });
        }
        for (const item of draft.skipped || []) {
          const field = page.fields.find((entry) => entry.id === item.fieldId);
          if (field) guarded.droppedFills.push({ fieldId: item.fieldId, label: field.label, reason: item.reason || "not enough to go on" });
        }
        guarded.fills.sort((left, right) => left.field.index - right.field.index);
      }
    }

    if (guarded.fills.length) {
      const form = page.forms.find((item) => item.id === guarded.targetFormId);
      renderPlan({
        items: guarded.fills.map((fill) => ({
          fieldId: fill.fieldId,
          field: fill.field,
          value: fill.value,
          confidence: fill.confidence,
          why: fill.why,
          selected: true
        })),
        skipped: guarded.droppedFills,
        formId: guarded.targetFormId,
        formLabel: form?.label || "this page",
        tabId: currentTabId,
        host: page.host
      });
      await notify("Keel drafted the form", "Open the panel to review before anything is filled.");
    } else if (guarded.droppedFills.length) {
      addTimeline(`Left alone: ${guarded.droppedFills.map((item) => `${item.label || item.fieldId} (${item.reason})`).join("; ")}`);
    }

    if (guarded.click) renderClickProposal(guarded, page, currentTabId);
    if (guarded.tailorResume) await makeTailoredResume();

    await saveMemory(memory);
  } catch (error) {
    addMessage(error.message || "Something went wrong, and I did not touch the page.", "keel", "warning");
  } finally {
    setBusy(false);
    if (lastPerception) renderVision(lastPerception);
  }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
async function handleFile(file) {
  if (!file || busy) return;
  addMessage(`Sent you ${file.name}`, "user");
  recordMessage(memory, "user", `I uploaded a file: ${file.name}`);
  setBusy(true, `Reading ${file.name}`);
  try {
    const { text, facts, base64, mime } = await readDocument(file);
    const kind = /resume|cv/i.test(file.name) || facts.mostRecentRole ? "resume" : "document";
    documents[kind] = await saveDocument(kind, { name: file.name, mime, dataBase64: base64, text, summary: facts });
    recordFact(memory, kind, text, { label: kind === "resume" ? "Resume text" : `File: ${file.name}`, source: file.name });
    if (facts.name) setProfileValue(profile, "fullName", facts.name);
    if (facts.email) setProfileValue(profile, "email", facts.email);
    if (facts.phone) setProfileValue(profile, "phone", facts.phone);
    if (facts.linkedin) setProfileValue(profile, "linkedin", facts.linkedin);
    if (facts.mostRecentRole) setProfileValue(profile, "jobTitle", facts.mostRecentRole);
    setProfileValue(profile, "workHistory", text.slice(0, 12000));
    await saveProfile(profile);
    await saveMemory(memory);

    const proof = [
      facts.name ? `Name: ${facts.name}` : null,
      facts.mostRecentRole ? `Most recent role: ${facts.mostRecentRole}` : null,
      facts.skills?.length ? `Skills: ${facts.skills.slice(0, 4).join(", ")}` : null
    ].filter(Boolean).join("\n");
    const line = proof
      ? `Read ${file.name} and saved it.\n${proof}`
      : `Read ${file.name} and saved the text, though it did not clearly state a name or role.`;
    addMessage(line, "keel", "success");
    recordMessage(memory, "assistant", line);
    await saveMemory(memory);
  } catch (error) {
    const line = `I could not read ${file.name}: ${error.message}`;
    addMessage(line, "keel", "warning");
    recordMessage(memory, "assistant", line);
    await saveMemory(memory);
  } finally {
    setBusy(false);
    fileInput.value = "";
  }
  await runTurn(`I just gave you ${file.name}.`, { silentUser: true });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function autoGrow() {
  composer.style.height = "auto";
  composer.style.height = `${Math.min(composer.scrollHeight, 120)}px`;
}

sendButton.addEventListener("click", () => {
  const text = composer.value.trim();
  if (!text) return;
  composer.value = "";
  autoGrow();
  runTurn(text);
});
composer.addEventListener("input", autoGrow);
composer.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendButton.click();
  }
});
attachButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => handleFile(fileInput.files?.[0]));
walkawayToggle.addEventListener("change", () => chrome.storage.local.set({ [WALKAWAY_KEY]: walkawayToggle.checked }));

visionToggle.addEventListener("click", async () => {
  captureEnabled = !captureEnabled;
  visionToggle.textContent = `Screen: ${captureEnabled ? "on" : "off"}`;
  await chrome.storage.local.set({ [CAPTURE_KEY]: captureEnabled });
  await refreshVision();
});

const voice = new VoiceInput({
  onPartial: (text) => { composer.value = text; autoGrow(); },
  onFinal: (text) => { composer.value = ""; autoGrow(); runTurn(text); },
  onState: (state) => {
    const listening = state === "listening";
    micButton.classList.toggle("recording", listening);
    voiceHint.hidden = !listening;
  },
  onError: (message) => addMessage(message, "keel", "warning")
});
micButton.addEventListener("click", () => {
  if (voice.wantListening) voice.stop();
  else voice.start();
});

// Keel follows the user around the browser. Switching tabs or scrolling
// refreshes what it sees without spending a model call.
async function refreshVision() {
  if (busy) return;
  try {
    const perception = await perceive({ preferredTabId: null, withScreenshot: captureEnabled });
    lastPerception = perception;
    if (perception.ok) currentTabId = perception.tab.id;
    renderVision(perception);
    return perception;
  } catch (error) {
    renderVision({ ok: false, error: error.message });
    return null;
  }
}

chrome.tabs.onActivated.addListener(() => { refreshVision(); });
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url) refreshVision();
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "KEEL_EVENT") return;
  if (message.kind === "fields_changed" || message.kind === "scrolled") refreshVision();
});

async function init() {
  const stored = await chrome.storage.local.get([WALKAWAY_KEY, CAPTURE_KEY]);
  walkawayToggle.checked = Boolean(stored[WALKAWAY_KEY]);
  captureEnabled = stored[CAPTURE_KEY] !== false;
  visionToggle.textContent = `Screen: ${captureEnabled ? "on" : "off"}`;

  [memory, profile, documents] = await Promise.all([loadMemory(), loadProfile(), loadDocuments()]);
  if (documents.resume?.text && !getFact(memory, "resume")) {
    recordFact(memory, "resume", documents.resume.text, { label: "Resume text", source: documents.resume.name });
    await saveMemory(memory);
  }
  renderStoredTranscript();

  const perception = await refreshVision();
  if (!memory.transcript.length) {
    const known = Object.values(memory.facts || {}).map((fact) => fact.label);
    const lines = ["Hi, I am Keel. I can see the tab you are on and I will do the browser work while you watch."];
    if (perception?.ok) {
      const primary = perception.page.forms.find((form) => form.id === perception.page.primaryFormId);
      lines.push(`Right now I am looking at ${perception.page.title || perception.page.host}${primary ? `, on ${primary.label}` : ""}.`);
    }
    if (known.length) lines.push(`I still have ${known.join(", ")} from last time, so you do not need to send them again.`);
    lines.push("Tell me what you want done here.");
    const greeting = lines.join(" ");
    addMessage(greeting);
    recordMessage(memory, "assistant", greeting);
    await saveMemory(memory);
  }
}

init().catch((error) => {
  console.error("Keel failed to start", error);
  addMessage("Keel could not start. Reload the extension and try again.", "keel", "warning");
});
