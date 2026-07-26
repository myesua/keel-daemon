// Keel side panel: a single-thread, voice-first chat that drives the engine.
// The panel is the brain; the content script is the hands and eyes.
import { assist, humanizeText, parseLooseJson } from "./lib/assist.js";
import {
  loadProfile, saveProfile, flatProfile, setProfileValue, rememberAnswer,
  lookupAnswer, profileSummaryText, PROFILE_FIELD_LABELS,
  loadDocuments, saveDocument, getDocument
} from "./lib/profile.js";
import { VoiceInput } from "./lib/voice.js";
import { fetchJobDescription, tailorResume, answerOpenQuestion, makeResumePdfBase64 } from "./lib/jobkit.js";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const thread = document.querySelector("#thread");
const contextLine = document.querySelector("#context-line");
const composerInput = document.querySelector("#composer-input");
const sendButton = document.querySelector("#send-button");
const micButton = document.querySelector("#mic-button");
const attachButton = document.querySelector("#attach-button");
const fileInput = document.querySelector("#file-input");
const voiceHint = document.querySelector("#voice-hint");
const walkawayToggle = document.querySelector("#walkaway-toggle");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let profile = null;
let documents = {};
let currentTab = null;           // { id, url, host, title }
let session = null;              // per-page working state
let walkAway = false;
let attachSequence = 0;          // guards stale async work after tab switches
let threadLog = [];              // persisted plain entries

const INTENT_LABELS = {
  job_application: "a job application",
  signup: "a signup form",
  login: "a login form",
  checkout: "a checkout",
  booking: "a booking form",
  contact: "a contact form",
  survey: "a survey or intake form",
  subscription: "a newsletter signup",
  profile_update: "an account or profile form",
  form: "a form",
  none: "a page without a form"
};

function newSession() {
  return {
    snapshot: null,
    intent: null,          // { kind, confidence, source }
    plan: null,            // array of plan rows
    planCard: null,
    fills: 0,
    jobDescription: null,
    proposedOnce: false,
    submitOffered: false
  };
}

// ---------------------------------------------------------------------------
// Thread rendering
// ---------------------------------------------------------------------------
function scrollToEnd() {
  requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
}

function persistThread() {
  chrome.storage.local.set({ keelThread: threadLog.slice(-120) }).catch(() => {});
}

function addMsg(text, tone = "keel", { persist = true } = {}) {
  const clean = humanizeText(text);
  const node = document.createElement("div");
  node.className = `msg ${tone}`;
  node.textContent = clean;
  thread.append(node);
  scrollToEnd();
  if (persist) {
    threadLog.push({ kind: "msg", tone, text: clean, at: Date.now() });
    persistThread();
  }
  return node;
}

function addTimeline(text, { undoable = false } = {}) {
  const clean = humanizeText(text);
  const entry = document.createElement("div");
  entry.className = "timeline-entry";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.textContent = "\u2022";
  const label = document.createElement("span");
  label.textContent = clean;
  entry.append(dot, label);
  if (undoable) {
    const undoButton = document.createElement("button");
    undoButton.type = "button";
    undoButton.textContent = "Undo";
    undoButton.addEventListener("click", async () => {
      undoButton.disabled = true;
      await undoLastFill();
    }, { once: true });
    entry.append(undoButton);
  }
  thread.append(entry);
  scrollToEnd();
  threadLog.push({ kind: "timeline", text: clean, at: Date.now() });
  persistThread();
  return entry;
}

function addCard({ eyebrow, title }) {
  const card = document.createElement("div");
  card.className = "card";
  const head = document.createElement("div");
  head.className = "card-head";
  const eyebrowNode = document.createElement("span");
  eyebrowNode.className = "eyebrow";
  eyebrowNode.textContent = eyebrow;
  const titleNode = document.createElement("strong");
  titleNode.textContent = humanizeText(title);
  head.append(eyebrowNode, titleNode);
  const body = document.createElement("div");
  body.className = "card-body";
  const actions = document.createElement("div");
  actions.className = "card-actions";
  card.append(head, body, actions);
  thread.append(card);
  scrollToEnd();
  return { card, body, actions, setTitle: (t) => { titleNode.textContent = humanizeText(t); } };
}

function makeButton(label, kind, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = kind;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

// ---------------------------------------------------------------------------
// Content script transport
// ---------------------------------------------------------------------------
async function ensureContentScript(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: "KEEL_PING" });
    if (reply?.ok && reply.version >= 2) return;
  } catch (_) { /* inject below */ }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["webmcp-bridge.js"], world: "MAIN" });
  } catch (_) { /* some pages refuse main-world scripts; WebMCP just stays off */ }
  const reply = await chrome.tabs.sendMessage(tabId, { type: "KEEL_PING" });
  if (!reply?.ok) throw new Error("Keel could not connect to this page.");
}

function sendToPage(message) {
  if (!currentTab?.id) return Promise.reject(new Error("No page attached."));
  return chrome.tabs.sendMessage(currentTab.id, message);
}

// ---------------------------------------------------------------------------
// Intent detection: surface-generic classification of it's-me-again pages
// ---------------------------------------------------------------------------
function classifyHeuristically(snapshot) {
  const corpus = [
    snapshot.url, snapshot.title, snapshot.metaDescription,
    snapshot.headings.join(" "), snapshot.bodyTextSample.slice(0, 700)
  ].join(" ").toLowerCase();
  const fields = snapshot.fields || [];
  const meta = fields.map((f) => f.meta).join(" ");
  const passwords = fields.filter((f) => f.type === "password").length;
  const emails = fields.filter((f) => f.type === "email" || /\bemail\b/.test(f.meta)).length;
  const cardFields = fields.filter((f) => /^cc-/.test(f.autocomplete) || /\b(card number|cvv|cvc|expir|security code)\b/.test(f.meta)).length;
  const resumeFiles = fields.filter((f) => f.type === "file" && /\b(resume|cv|cover letter)\b/.test(f.meta)).length;
  const addressFields = fields.filter((f) => /\b(address|city|zip|postal)\b/.test(f.meta)).length;
  const choiceFields = fields.filter((f) => ["radio", "select", "checkbox"].includes(f.type)).length;

  const scores = {};
  const bump = (kind, points) => { scores[kind] = (scores[kind] || 0) + points; };

  if (cardFields >= 2) bump("checkout", 6);
  if (/\b(checkout|payment|billing|shipping|order summary|cart|place order)\b/.test(corpus)) bump("checkout", 3);
  if (addressFields >= 3 && /\b(shipping|delivery)\b/.test(corpus)) bump("checkout", 2);

  if (resumeFiles) bump("job_application", 5);
  if (/\b(job|jobs|career|careers|apply|application|applicant|candidate|position|vacancy|recruit)\b/.test(corpus)) bump("job_application", 3);
  if (/greenhouse|lever\.co|workday|myworkday|ashby|smartrecruiters|icims|taleo|bamboohr|jobvite/.test(snapshot.url.toLowerCase())) bump("job_application", 5);
  if (/\b(resume|cv|cover letter|work authorization|sponsorship)\b/.test(`${corpus} ${meta}`)) bump("job_application", 2);

  if (passwords >= 2) bump("signup", 5);
  if (passwords >= 1 && /\b(sign up|signup|register|create (an |your )?account|join|get started)\b/.test(corpus)) bump("signup", 4);
  if (passwords === 1 && /\b(log in|login|sign in|signin|welcome back)\b/.test(corpus)) bump("login", 5);
  if (passwords === 1 && fields.length <= 4 && !scores.signup) bump("login", 2);

  if (/\b(book|booking|reservation|reserve|appointment|schedule a|check in|check out|guests|arrival|departure)\b/.test(corpus)) bump("booking", 4);
  if (/\b(contact us|get in touch|send us a message|inquiry|enquiry)\b/.test(corpus)) bump("contact", 4);
  if (choiceFields >= 5 && /\b(survey|questionnaire|feedback|intake|screening|assessment)\b/.test(corpus)) bump("survey", 4);
  else if (/\b(survey|questionnaire|intake form)\b/.test(corpus)) bump("survey", 3);
  if (emails === 1 && fields.length <= 2 && /\b(subscribe|newsletter|updates)\b/.test(corpus)) bump("subscription", 5);
  if (/\b(account settings|edit profile|profile settings|my account|preferences)\b/.test(corpus)) bump("profile_update", 4);

  let best = null;
  let bestScore = 0;
  for (const [kind, score] of Object.entries(scores)) {
    if (score > bestScore) { best = kind; bestScore = score; }
  }
  if (!fields.length) return { kind: "none", confidence: 0.9, source: "heuristic" };
  if (!best) return { kind: "form", confidence: 0.4, source: "heuristic" };
  return { kind: best, confidence: Math.min(0.95, 0.35 + bestScore * 0.08), source: "heuristic" };
}

async function classifyPage(snapshot) {
  const heuristic = classifyHeuristically(snapshot);
  // Remembered correction for this site wins.
  const remembered = profile.domains?.[snapshot.host]?.intent;
  if (remembered && INTENT_LABELS[remembered]) {
    return { kind: remembered, confidence: 0.97, source: "memory" };
  }
  if (heuristic.confidence >= 0.6 || heuristic.kind === "none") return heuristic;

  const refined = await assist("classify_intent", {
    url: snapshot.url,
    title: snapshot.title,
    headings: snapshot.headings,
    fieldLabels: (snapshot.fields || []).slice(0, 40).map((f) => `${f.label} (${f.type})`),
    kinds: Object.keys(INTENT_LABELS)
  }, { timeoutMs: 15000 });
  const parsed = refined?.text ? parseLooseJson(refined.text) : null;
  if (parsed?.kind && INTENT_LABELS[parsed.kind]) {
    return { kind: parsed.kind, confidence: Math.max(heuristic.confidence, 0.7), source: "model" };
  }
  return heuristic;
}

// ---------------------------------------------------------------------------
// Field matching: generic profile resolver (works on any surface)
// ---------------------------------------------------------------------------
const AUTOCOMPLETE_MAP = {
  "given-name": "firstName", "family-name": "lastName", "name": "fullName",
  "email": "email", "tel": "phone", "tel-national": "phone",
  "address-line1": "addressLine1", "address-line2": "addressLine2",
  "street-address": "addressLine1", "address-level2": "city",
  "address-level1": "state", "postal-code": "postalCode",
  "country-name": "country", "country": "country", "bday": "dateOfBirth",
  "organization": "company", "organization-title": "jobTitle", "url": "portfolio"
};

const LABEL_RULES = [
  ["firstName", /\b(first name|given name|forename|fname)\b/],
  ["lastName", /\b(last name|family name|surname|lname)\b/],
  ["fullName", /\b(full name|your name|candidate name|applicant name|name on card|cardholder name)\b/],
  ["email", /\b(e ?mail|email address)\b/],
  ["phone", /\b(phone|phone number|mobile|telephone|cell)\b/],
  ["addressLine2", /\b(address line 2|address 2|apt|apartment|suite|unit)\b/],
  ["addressLine1", /\b(street address|address line 1|address 1|home address|shipping address|billing address|address)\b/],
  ["city", /\b(city|town)\b/],
  ["state", /\b(state|province|region)\b/],
  ["postalCode", /\b(zip|zip code|postal|postal code|postcode)\b/],
  ["country", /\b(country|nation)\b/],
  ["dateOfBirth", /\b(date of birth|birth ?date|dob)\b/],
  ["linkedin", /\blinked ?in\b/],
  ["github", /\bgithub\b/],
  ["portfolio", /\b(portfolio|personal website|personal site|website url|web site)\b/],
  ["company", /\b(current company|current employer|company name|employer name|company|organization)\b/],
  ["jobTitle", /\b(current title|job title|current role|position title|occupation)\b/],
  ["workHistory", /\b(work history|employment history|experience summary|professional experience)\b/]
];

function matchProfileKey(field) {
  const autocomplete = (field.autocomplete || "").toLowerCase().replace(/^(shipping|billing)\s+/, "");
  if (AUTOCOMPLETE_MAP[autocomplete]) {
    return { key: AUTOCOMPLETE_MAP[autocomplete], confidence: 0.95 };
  }
  const meta = field.meta || "";
  for (const [key, pattern] of LABEL_RULES) {
    if (pattern.test(meta)) return { key, confidence: 0.8 };
  }
  return null;
}

function isOpenEndedQuestion(field) {
  if (field.type === "textarea") return true;
  if (field.maxLength && field.maxLength >= 200) return true;
  return /\b(why|describe|tell us|explain|what interests|cover letter|anything else|additional information)\b/.test(field.meta || "");
}

// ---------------------------------------------------------------------------
// Plan: propose everything, preview everything, apply only what is approved
// ---------------------------------------------------------------------------
async function buildPlan(sequenceAtStart) {
  const snapshot = session.snapshot;
  const flat = flatProfile(profile);
  const host = snapshot.host;
  const rows = [];
  const specials = [];
  const unresolved = [];

  for (const field of snapshot.fields) {
    if (field.type === "password") { specials.push({ field, kind: "password" }); continue; }
    if (field.isOtp) { specials.push({ field, kind: "otp" }); continue; }
    if (field.type === "file") { specials.push({ field, kind: "file" }); continue; }
    if (field.currentValue) {
      rows.push({ field, proposed: field.currentValue, source: "already on the page", confidence: 1, include: false, keep: true });
      continue;
    }

    const profileHit = matchProfileKey(field);
    if (profileHit && flat[profileHit.key]) {
      rows.push({ field, proposed: String(flat[profileHit.key]), source: "profile", confidence: profileHit.confidence, include: true, profileKey: profileHit.key });
      continue;
    }
    const learned = lookupAnswer(profile, field.label, host);
    if (learned) {
      rows.push({
        field, proposed: learned.value,
        source: learned.scope === "site" ? "remembered for this site" : "remembered answer",
        confidence: learned.fuzzy ? 0.65 : (learned.scope === "site" ? 0.9 : 0.8),
        include: true, learnedQuestion: field.label
      });
      continue;
    }
    if (profileHit) {
      rows.push({ field, proposed: "", source: "profile (empty)", confidence: 0.3, include: false, profileKey: profileHit.key, needsAnswer: true });
      continue;
    }
    unresolved.push(field);
  }

  // Consent decisions (terms, privacy, marketing opt-ins) are never drafted.
  // They stay in the preview for the user to decide.
  const isConsent = (field) => /\b(terms|privacy|consent|i agree|marketing|opt in|opt out)\b/.test(field.meta || "");

  // Draft the rest proactively instead of interrogating the user field by field.
  const draftCandidates = unresolved.filter((f) => !isConsent(f));
  const consentFields = unresolved.filter(isConsent);
  for (const field of consentFields) {
    rows.push({ field, proposed: "", source: "your decision", confidence: 0.2, include: false, needsAnswer: true, learnedQuestion: field.label });
  }
  if (draftCandidates.length && sequenceAtStart === attachSequence) {
    const drafted = await draftValues(draftCandidates, snapshot);
    for (const field of draftCandidates) {
      const draft = drafted?.[field.id];
      if (draft && draft.value) {
        rows.push({ field, proposed: String(draft.value), source: "drafted for you", confidence: Math.min(0.7, draft.confidence || 0.55), include: true, learnedQuestion: field.label, drafted: true });
      } else {
        rows.push({ field, proposed: "", source: "needs your answer", confidence: 0.2, include: false, needsAnswer: true, learnedQuestion: field.label });
      }
    }
  } else {
    for (const field of draftCandidates) {
      rows.push({ field, proposed: "", source: "needs your answer", confidence: 0.2, include: false, needsAnswer: true, learnedQuestion: field.label });
    }
  }

  // Preserve page order.
  const order = new Map(snapshot.fields.map((f, i) => [f.id, i]));
  rows.sort((a, b) => (order.get(a.field.id) ?? 0) - (order.get(b.field.id) ?? 0));
  return { rows, specials };
}

async function draftValues(fields, snapshot) {
  // Open-ended job questions get the tailored treatment later; only draft
  // short factual values here.
  const draftable = fields.filter((f) => !isOpenEndedQuestion(f)).slice(0, 25);
  if (!draftable.length) return {};
  const result = await assist("draft_values", {
    intent: session.intent?.kind || "form",
    pageTitle: snapshot.title,
    host: snapshot.host,
    profileSummary: profileSummaryText(profile),
    fields: draftable.map((f) => ({
      id: f.id, label: f.label, type: f.type, required: f.required,
      options: (f.options || []).slice(0, 30)
    }))
  }, { timeoutMs: 30000 });
  const parsed = result?.text ? parseLooseJson(result.text) : null;
  if (!parsed || typeof parsed !== "object") return {};
  const map = {};
  const values = parsed.values || parsed;
  for (const [id, value] of Object.entries(values)) {
    if (value == null || value === "" || value === "skip") continue;
    map[id] = typeof value === "object" ? value : { value, confidence: 0.55 };
  }
  return map;
}

function confidenceClass(confidence) {
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

function renderPlanCard(plan) {
  const intentLabel = INTENT_LABELS[session.intent?.kind] || "this form";
  const { card, body, actions } = addCard({ eyebrow: "Preview", title: `My plan for ${intentLabel}` });
  const editableRows = [];

  const note = document.createElement("p");
  note.className = "card-note";
  note.textContent = "Nothing touches the page until you approve it. Edit any value, untick what you want me to leave alone. Green means I am sure, amber means check me, red means I need you.";
  body.append(note);

  for (const row of plan.rows) {
    if (row.keep) continue;
    const rowNode = document.createElement("div");
    rowNode.className = "plan-row";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "row-check";
    check.checked = row.include && Boolean(row.proposed);

    const labelWrap = document.createElement("div");
    labelWrap.className = "row-label";
    const conf = document.createElement("span");
    conf.className = `conf ${confidenceClass(row.confidence)}`;
    conf.title = `Confidence: ${confidenceClass(row.confidence)}`;
    const labelText = document.createElement("span");
    const cleanLabel = row.field.label.replace(/\s*\*+\s*$/, "");
    labelText.textContent = cleanLabel + (row.field.required ? " *" : "");
    const source = document.createElement("span");
    source.className = "row-source";
    source.textContent = row.source;
    labelWrap.append(conf, labelText, source);

    let input;
    if (row.field.options?.length && ["select", "radio"].includes(row.field.type)) {
      input = document.createElement("select");
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "Choose...";
      input.append(blank);
      for (const option of row.field.options) {
        const node = document.createElement("option");
        node.value = option;
        node.textContent = option;
        input.append(node);
      }
      if (row.proposed) {
        const exact = row.field.options.find((o) => o.toLowerCase() === row.proposed.toLowerCase())
          || row.field.options.find((o) => o.toLowerCase().includes(row.proposed.toLowerCase()));
        if (exact) input.value = exact;
      }
    } else if (row.field.type === "checkbox") {
      input = document.createElement("select");
      for (const option of ["", "Yes", "No"]) {
        const node = document.createElement("option");
        node.value = option;
        node.textContent = option || "Choose...";
        input.append(node);
      }
      input.value = row.proposed || "";
    } else if (row.field.type === "textarea" || isOpenEndedQuestion(row.field)) {
      input = document.createElement("textarea");
      input.value = row.proposed || "";
      input.placeholder = "I can draft this. Say: draft the open questions";
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.value = row.proposed || "";
      input.placeholder = row.needsAnswer ? "Type the answer" : "";
    }
    input.addEventListener("input", () => {
      check.checked = Boolean(input.value || input.value === "0");
      rowNode.classList.toggle("excluded", !check.checked);
    });
    check.addEventListener("change", () => rowNode.classList.toggle("excluded", !check.checked));
    rowNode.classList.toggle("excluded", !check.checked);

    rowNode.append(check, labelWrap, input);
    // grid: checkbox spans, label row, input row
    body.append(rowNode);
    editableRows.push({ row, check, input });
  }

  const keptCount = plan.rows.filter((r) => r.keep).length;
  if (keptCount) {
    const kept = document.createElement("p");
    kept.className = "card-note";
    kept.textContent = `${keptCount} field${keptCount === 1 ? " already has" : "s already have"} an answer on the page. I will not touch those.`;
    body.append(kept);
  }

  const applyButton = makeButton("Fill the approved fields", "primary", async () => {
    applyButton.disabled = true;
    await applyPlan(editableRows, plan);
    applyButton.disabled = false;
  });
  const rescanButton = makeButton("Rescan page", "secondary", () => attachToTab(true));
  actions.append(applyButton, rescanButton);

  session.planCard = card;
  return editableRows;
}

async function applyPlan(editableRows, plan) {
  if (session?.plan !== plan) {
    addMsg("That plan belongs to a page you have left. Say \"go ahead\" and I will draft the page you are on now.", "warning");
    return;
  }
  const actions = [];
  const host = session.snapshot?.host;
  let learnedCount = 0;

  for (const { row, check, input } of editableRows) {
    const value = String(input.value || "").trim();
    if (!check.checked || !value) continue;
    actions.push({ fieldId: row.field.id, value });

    // Learning: user edits and fresh answers become durable memory.
    const wasEdited = value !== String(row.proposed || "").trim();
    if (row.profileKey && (wasEdited || row.needsAnswer)) {
      setProfileValue(profile, row.profileKey, value);
      learnedCount += 1;
    } else if (row.learnedQuestion && (wasEdited || row.needsAnswer || row.drafted)) {
      rememberAnswer(profile, row.learnedQuestion, value);
      if (host) rememberAnswer(profile, row.learnedQuestion, value, host);
      learnedCount += 1;
    }
  }

  if (!actions.length) {
    addMsg("Nothing is approved yet. Tick the fields you want me to fill, or give me the missing answers.", "warning");
    return;
  }

  if (learnedCount) await saveProfile(profile);

  addMsg(`Filling ${actions.length} field${actions.length === 1 ? "" : "s"} now. Watch the page, every target gets highlighted first.`);
  let reply;
  try {
    reply = await sendToPage({ type: "KEEL_APPLY", actions });
  } catch (error) {
    addMsg(`I lost the page connection: ${error.message}. Refresh the tab and I will rescan.`, "warning");
    return;
  }

  const okResults = (reply?.results || []).filter((r) => r.ok);
  const failed = (reply?.results || []).filter((r) => !r.ok);
  session.fills += okResults.length;

  if (okResults.length) {
    addTimeline(`Filled ${okResults.length} field${okResults.length === 1 ? "" : "s"}: ${okResults.map((r) => r.label).slice(0, 6).join(", ")}${okResults.length > 6 ? "..." : ""}`, { undoable: true });
  }
  for (const failure of failed) {
    addMsg(`"${failure.label}": ${failure.error} Tell me the right answer and I will fill it.`, "warning");
  }
  if (learnedCount) {
    addTimeline(`Remembered ${learnedCount} answer${learnedCount === 1 ? "" : "s"} for next time.`);
  }

  await afterFillFollowUps(plan);
}

async function undoLastFill() {
  try {
    const reply = await sendToPage({ type: "KEEL_UNDO" });
    if (reply?.ok) {
      addTimeline(`Undid the last fill (${reply.restored.length} field${reply.restored.length === 1 ? "" : "s"} restored).`);
    } else {
      addMsg(reply?.error || "There was nothing to undo.", "warning");
    }
  } catch (error) {
    addMsg(`I could not undo: ${error.message}`, "warning");
  }
}

// ---------------------------------------------------------------------------
// After the fill: files, captcha, submit preview, walk-away notification
// ---------------------------------------------------------------------------
async function afterFillFollowUps(plan) {
  for (const special of plan.specials) {
    if (special.kind === "file") await offerFileAttach(special.field);
    if (special.kind === "password") {
      addMsg(`"${special.field.label}" is a password field. I never read, store, or type passwords. Enter it directly on the page.`, "warning");
    }
    if (special.kind === "otp") {
      addMsg(`"${special.field.label}" looks like a verification code. Complete the check on your phone or email, type the code on the page, then tell me to continue.`, "warning");
    }
  }

  if (session.snapshot?.captchaPresent) {
    await handleCaptchaHandBack();
  }

  await offerSubmitPreview();

  if (walkAway) {
    const stuck = plan.rows.some((r) => r.needsAnswer && r.field.required);
    notify(
      stuck ? "Keel needs you" : "Keel finished this page",
      stuck
        ? `I filled what I could on ${session.snapshot.host} but some required answers need you.`
        : `Everything I could fill on ${session.snapshot.host} is done and previewed. Nothing was submitted.`
    );
  }
}

async function offerFileAttach(field) {
  const wantsResume = /\b(resume|cv)\b/.test(field.meta || "");
  const wantsCover = /\bcover letter\b/.test(field.meta || "");
  const tailored = await getDocument("tailoredResume");
  const resume = await getDocument("resume");
  const doc = wantsCover ? await getDocument("coverLetter") : (tailored || resume);

  if (!doc || (!wantsResume && !wantsCover)) {
    addMsg(`"${field.label}" needs a file. Upload one here with the paperclip and I will attach it, or choose it on the page yourself.`, "warning");
    return;
  }

  const { body, actions, card } = addCard({ eyebrow: "Your file", title: `Attach to "${field.label}"?` });
  const note = document.createElement("p");
  note.className = "card-note";
  note.textContent = `I have "${doc.name}" saved${doc === tailored ? " (tailored for this job)" : ""}. Want me to attach it?`;
  body.append(note);
  actions.append(
    makeButton(`Attach ${doc.name}`, "primary", async () => {
      const reply = await sendToPage({ type: "KEEL_ATTACH_FILE", fieldId: field.id, file: { name: doc.name, mime: doc.mime, dataBase64: doc.dataBase64 } });
      card.remove();
      if (reply?.ok) addTimeline(`Attached ${doc.name} to "${field.label}".`);
      else addMsg(reply?.error || "The page did not accept the file.", "warning");
    }),
    makeButton("I will handle it", "secondary", () => card.remove())
  );
}

async function handleCaptchaHandBack() {
  sendToPage({ type: "KEEL_HIGHLIGHT_CAPTCHA" }).catch(() => {});
  const { body, actions, card } = addCard({ eyebrow: "Your turn", title: "Human check on the page" });
  const note = document.createElement("p");
  note.className = "card-note";
  note.textContent = "There is a CAPTCHA or verification step. I never solve those. Do it on the page, then tap continue and I will pick up exactly where I left off.";
  body.append(note);
  await new Promise((resolve) => {
    actions.append(makeButton("Done, continue", "primary", () => { card.remove(); resolve(); }));
  });
  addTimeline("You handled the verification. Continuing.");
  await refreshSnapshot();
}

async function offerSubmitPreview() {
  if (session.submitOffered) return;
  const buttons = (session.snapshot?.buttons || []).filter((b) => b.commits);
  if (!buttons.length) return;
  session.submitOffered = true;

  const target = buttons[0];
  const { body, actions, card } = addCard({ eyebrow: "Final step", title: "Review, then decide" });
  const note = document.createElement("p");
  note.className = "card-note";
  note.textContent = `Everything I filled is on the page for you to review. I never press "${target.text}" on my own. When you are happy, press it yourself or ask me to.`;
  body.append(note);
  actions.append(
    makeButton(`Click "${target.text}" for me`, "primary", async () => {
      card.remove();
      const reply = await sendToPage({ type: "KEEL_CLICK", fieldId: target.id }).catch((error) => ({ ok: false, error: error.message }));
      if (reply?.ok) {
        addTimeline(`Clicked "${reply.label}" with your approval.`);
        if (walkAway) notify("Keel submitted with your approval", `"${reply.label}" was clicked on ${session.snapshot.host}.`);
      } else {
        addMsg(reply?.error || "I could not click that button.", "warning");
      }
    }),
    makeButton("I will review first", "secondary", () => { card.remove(); addTimeline("Left the final step to you."); })
  );
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: humanizeText(title),
      message: humanizeText(message)
    });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Attach to the active tab: snapshot, classify, propose
// ---------------------------------------------------------------------------
function describeIntentGuess(intent, snapshot) {
  const label = INTENT_LABELS[intent.kind] || "a form";
  if (intent.kind === "none") {
    return `I am watching ${snapshot.host}. I do not see a form here yet. When you land on one, I will size it up.`;
  }
  const opener = intent.source === "memory"
    ? `Back on ${snapshot.host}. Last time you told me this is ${label}, so I will treat it that way.`
    : `This looks like ${label} on ${snapshot.host}.`;
  return `${opener} Say "go ahead" and I will draft every field for your approval. If I guessed wrong, just tell me what this page really is.`;
}

function renderIntentChips() {
  const wrap = document.createElement("div");
  wrap.className = "intent-chips";
  const choices = ["job_application", "signup", "checkout", "booking", "contact", "survey", "form"];
  for (const kind of choices) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.textContent = INTENT_LABELS[kind];
    if (session.intent?.kind === kind) chip.classList.add("active");
    chip.addEventListener("click", () => correctIntent(kind));
    wrap.append(chip);
  }
  const container = document.createElement("div");
  container.className = "msg keel";
  container.textContent = "";
  container.append(wrap);
  thread.append(container);
  scrollToEnd();
}

async function correctIntent(kind) {
  if (!session?.snapshot) return;
  session.intent = { kind, confidence: 1, source: "user" };
  profile.domains[session.snapshot.host] = profile.domains[session.snapshot.host] || {};
  profile.domains[session.snapshot.host].intent = kind;
  await saveProfile(profile);
  addMsg(`Got it, treating this as ${INTENT_LABELS[kind]}. I will remember that for ${session.snapshot.host}.`);
  addTimeline(`Intent corrected to ${INTENT_LABELS[kind]}. Saved for this site.`);
  await proposePlan();
}

async function refreshSnapshot() {
  if (!currentTab?.id) return null;
  try {
    const reply = await sendToPage({ type: "KEEL_SNAPSHOT" });
    if (reply?.ok) {
      session.snapshot = reply.snapshot;
      return reply.snapshot;
    }
  } catch (_) {}
  return null;
}

async function attachToTab(force = false) {
  const sequence = ++attachSequence;
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) { return; }
  if (!tab?.id || !tab.url) return;

  const restricted = /^(chrome|edge|about|chrome-extension|devtools|view-source):/.test(tab.url) || /chrome\.google\.com\/webstore/.test(tab.url);
  if (restricted) {
    contextLine.textContent = "This page is off limits to extensions";
    return;
  }

  const host = (() => {
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname) return parsed.hostname;
      if (parsed.protocol === "file:") return parsed.pathname.split("/").pop() || "this local file";
      return tab.url;
    } catch (_) { return tab.url; }
  })();
  const samePage = currentTab?.id === tab.id && currentTab?.url === tab.url;
  if (samePage && !force) return;

  currentTab = { id: tab.id, url: tab.url, host, title: tab.title || "" };
  session = newSession();
  contextLine.textContent = host;

  try {
    await ensureContentScript(tab.id);
  } catch (error) {
    if (sequence === attachSequence) {
      addMsg(`I cannot see ${host} yet: ${error.message} Refresh the tab and I will try again.`, "warning");
    }
    return;
  }
  if (sequence !== attachSequence) return;

  const snapshot = await refreshSnapshot();
  if (!snapshot || sequence !== attachSequence) return;

  session.intent = await classifyPage(snapshot);
  if (sequence !== attachSequence) return;

  addTimeline(`Attached to ${host}${snapshot.webmcp?.available ? " (this page offers WebMCP tools, I will prefer them)" : ""}.`);
  addMsg(describeIntentGuess(session.intent, snapshot));
  if (session.intent.kind !== "none") {
    renderIntentChips();
    if (session.intent.kind === "job_application") await jobModuleOnboarding();
    if (walkAway) {
      addTimeline("Walk-away mode is on. Working through the page on my own.");
      await proposePlan({ autoApply: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Plan proposal entry point
// ---------------------------------------------------------------------------
async function proposePlan({ autoApply = false } = {}) {
  if (!session?.snapshot) {
    addMsg("I am not attached to a page yet. Open the form you want me to work on.", "warning");
    return;
  }
  const sequence = attachSequence;
  await refreshSnapshot();
  if (sequence !== attachSequence) return;

  if (!session.snapshot.fields.length) {
    addMsg("I do not see any fillable fields on this page.", "warning");
    return;
  }

  addTimeline(`Scanned ${session.snapshot.fields.length} fields (text, dropdowns, radios, checkboxes, files).`);
  const plan = await buildPlan(sequence);
  if (sequence !== attachSequence) return;
  session.plan = plan;

  // Job surface: draft open-ended questions from the resume and job description.
  if (session.intent?.kind === "job_application") {
    await draftOpenQuestions(plan, sequence);
    if (sequence !== attachSequence) return;
  }

  const editableRows = renderPlanCard(plan);

  if (autoApply) {
    // Walk-away: apply only what Keel is confident about, leave the rest previewed.
    for (const { row, check } of editableRows) {
      if (check.checked && row.confidence < 0.75) check.checked = false;
    }
    await applyPlan(editableRows, plan);
  }
}

// ---------------------------------------------------------------------------
// Job application module (the beachhead, layered on the generic engine)
// ---------------------------------------------------------------------------
async function jobModuleOnboarding() {
  const resume = await getDocument("resume");
  const missing = [];
  if (!resume) missing.push("your resume (upload it with the paperclip, or paste the text)");
  if (!session.jobDescription) missing.push("the job description (paste it, or share the posting link)");
  if (missing.length) {
    addMsg(`To do a proper job here I want ${missing.join(" and ")}. I can also start right away with what your profile already holds.`);
  } else {
    addMsg("I have your resume and the job description, so I can tailor answers to what this team is looking for.");
  }
}

async function draftOpenQuestions(plan, sequence) {
  const resume = await getDocument("resume");
  const resumeText = resume?.text || profile.work?.workHistory || "";
  if (!resumeText && !session.jobDescription) return;

  const openRows = plan.rows.filter((r) => !r.keep && !r.proposed && isOpenEndedQuestion(r.field));
  for (const row of openRows.slice(0, 6)) {
    const draft = await answerOpenQuestion({
      question: row.field.label,
      resumeText,
      jobDescription: session.jobDescription || "",
      profileSummary: profileSummaryText(profile),
      maxLength: row.field.maxLength
    });
    if (sequence !== attachSequence) return;
    if (draft) {
      row.proposed = draft;
      row.source = "drafted from your resume";
      row.confidence = 0.6;
      row.include = true;
      row.drafted = true;
      row.needsAnswer = false;
    }
  }
}

async function runTailorResume() {
  const resume = await getDocument("resume");
  if (!resume?.text) {
    addMsg("I need your resume text first. Upload it with the paperclip (a .txt or .md file works best) or paste it here after saying: here is my resume.", "warning");
    return;
  }
  if (!session?.jobDescription) {
    addMsg("Share the job description first: paste it, or send the posting link.", "warning");
    return;
  }
  addMsg("Tailoring your resume to this job. Give me a moment.");
  const tailored = await tailorResume({
    resumeText: resume.text,
    jobDescription: session.jobDescription,
    profileSummary: profileSummaryText(profile)
  });
  if (!tailored) {
    addMsg("I could not reach my writing engine just now. Try again in a minute.", "warning");
    return;
  }

  const { body, actions, card } = addCard({ eyebrow: "Tailored resume", title: "Read it before we use it" });
  const preview = document.createElement("div");
  preview.className = "doc-preview";
  preview.textContent = tailored;
  body.append(preview);
  actions.append(
    makeButton("Save as PDF for this application", "primary", async () => {
      const name = `${(flatProfile(profile).fullName || "Resume").replace(/[^A-Za-z0-9]+/g, "-")}-tailored.pdf`;
      const dataBase64 = makeResumePdfBase64(flatProfile(profile).fullName || "Resume", tailored);
      await saveDocument("tailoredResume", { name, mime: "application/pdf", dataBase64, text: tailored });
      card.remove();
      addTimeline(`Saved tailored resume as ${name}. I will offer it whenever this page asks for a resume.`);
      const fileField = session.snapshot?.fields.find((f) => f.type === "file" && /\b(resume|cv)\b/.test(f.meta));
      if (fileField) await offerFileAttach(fileField);
    }),
    makeButton("Discard", "secondary", () => { card.remove(); addTimeline("Discarded the tailored draft."); })
  );
}

async function ingestJobDescription(source) {
  let text = source;
  if (/^https?:\/\/\S+$/i.test(source.trim())) {
    addMsg("Fetching that job posting.");
    try {
      text = await fetchJobDescription(source.trim());
    } catch (error) {
      addMsg(`I could not read that link (${error.message}) Paste the description text instead.`, "warning");
      return;
    }
  }
  session.jobDescription = text;
  if (session.snapshot?.host) {
    profile.domains[session.snapshot.host] = profile.domains[session.snapshot.host] || {};
    await saveProfile(profile);
  }
  addTimeline("Job description saved for this session.");
  addMsg("Got the job description. Now I know what the recruiter is looking for. Say \"tailor my resume\" or \"go ahead\" to start filling.");
}

async function learnFromResumeText(text) {
  const result = await assist("extract_profile", {
    resumeText: text.slice(0, 16000),
    knownKeys: Object.keys(PROFILE_FIELD_LABELS)
  }, { timeoutMs: 30000 });
  const parsed = result?.text ? parseLooseJson(result.text) : null;
  if (!parsed || typeof parsed !== "object") return 0;
  let learned = 0;
  const flat = flatProfile(profile);
  for (const [key, value] of Object.entries(parsed)) {
    if (!PROFILE_FIELD_LABELS[key] || !value || flat[key]) continue;
    setProfileValue(profile, key, String(value));
    learned += 1;
  }
  if (learned) await saveProfile(profile);
  return learned;
}

// ---------------------------------------------------------------------------
// File uploads (paperclip)
// ---------------------------------------------------------------------------
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsText(file);
  });
}

async function handleUpload(file) {
  addMsg(`Uploaded ${file.name}`, "user");
  const isTexty = /\.(txt|md|markdown|text)$/i.test(file.name) || file.type.startsWith("text/");
  const looksResume = /resume|cv/i.test(file.name);
  const looksCover = /cover/i.test(file.name);
  const kind = looksCover ? "coverLetter" : "resume";

  const dataBase64 = await readFileAsBase64(file);
  let text = "";
  if (isTexty) {
    text = await readFileAsText(file);
  }

  await saveDocument(kind, { name: file.name, mime: file.type || "application/octet-stream", dataBase64, text });

  if (kind === "resume") {
    let reply = `Saved ${file.name} as your resume. I can attach it to any resume upload from now on.`;
    if (text) {
      const learned = await learnFromResumeText(text);
      if (learned) reply += ` I also learned ${learned} profile detail${learned === 1 ? "" : "s"} from it.`;
    } else {
      reply += " I cannot read text out of this file type, so paste the resume text here too and I will learn from it and use it for tailored answers.";
    }
    addMsg(reply, "success");
  } else {
    addMsg(`Saved ${file.name} as your cover letter.`, "success");
  }

  const fileField = session?.snapshot?.fields.find((f) => f.type === "file");
  if (fileField && (looksResume || looksCover)) await offerFileAttach(fileField);
}

// ---------------------------------------------------------------------------
// Chat: commands first, then the conversational brain
// ---------------------------------------------------------------------------
async function setWalkAway(enabled, { silent = false } = {}) {
  walkAway = enabled;
  walkawayToggle.checked = enabled;
  await chrome.storage.local.set({ keelWalkAway: enabled });
  if (silent) return;
  addMsg(enabled
    ? "Walk-away mode is on. I will keep working through pages on my own, fill what I am confident about, draft the rest, and send you a notification when I am done or stuck. I still never submit without your approval."
    : "Walk-away mode is off. I will wait for your go-ahead at each step.");
}

const INTENT_SYNONYMS = {
  "signup": "signup", "sign up": "signup", "registration": "signup", "register": "signup", "create account": "signup",
  "checkout": "checkout", "payment": "checkout", "purchase": "checkout", "order": "checkout",
  "job": "job_application", "job application": "job_application", "application": "job_application",
  "login": "login", "log in": "login", "sign in": "login",
  "booking": "booking", "reservation": "booking", "appointment": "booking",
  "contact": "contact", "contact form": "contact",
  "survey": "survey", "questionnaire": "survey", "intake": "survey",
  "newsletter": "subscription", "subscription": "subscription",
  "profile": "profile_update", "account settings": "profile_update",
  "form": "form"
};

async function handleCommand(text) {
  const lower = text.toLowerCase().trim();

  if (/^(undo|undo that|undo the last|undo last fill)\b/.test(lower)) { await undoLastFill(); return true; }
  if (/\b(rescan|scan again|look again|re-read the page)\b/.test(lower)) { await attachToTab(true); return true; }
  if (/^(go ahead|do it|fill( the form| it| everything)?|start|proceed|make the plan|draft the fields)\b/.test(lower)) { await proposePlan(); return true; }
  if (/\b(walk away|autopilot on|keep going without me)\b/.test(lower)) { await setWalkAway(true); return true; }
  if (/\b(i'?m back|autopilot off|stop autopilot|wait for me)\b/.test(lower)) { await setWalkAway(false); return true; }
  if (/\b(tailor|tailored resume|adapt my resume|customize my resume)\b/.test(lower)) { await runTailorResume(); return true; }
  if (/\b(draft the open questions|draft the questions|answer the open questions)\b/.test(lower)) { await proposePlan(); return true; }
  if (/\b(what do you know about me|show (my )?profile|show memory)\b/.test(lower)) {
    const summary = profileSummaryText(profile);
    addMsg(summary ? `Here is what I hold in your profile:\n${summary}` : "Your profile is empty so far. Tell me things like: my name is Ada Okoye, my email is ada@example.com. I also learn from every answer you approve.");
    return true;
  }
  if (/\b(continue|done|i did it|i handled it|resume)\b/.test(lower) && session?.snapshot?.captchaPresent) {
    await refreshSnapshot();
    addTimeline("Continuing after your turn.");
    await proposePlan();
    return true;
  }

  // Intent correction: "this is a signup", "it's a checkout", "no, checkout"
  const intentMatch = lower.match(/\b(?:this is|it'?s|its|treat (?:this|it) as|actually)\s+(?:a |an )?([a-z ]{3,25})/);
  if (intentMatch) {
    const guess = intentMatch[1].trim();
    for (const [phrase, kind] of Object.entries(INTENT_SYNONYMS)) {
      if (guess.startsWith(phrase) || phrase.startsWith(guess)) {
        await correctIntent(kind);
        return true;
      }
    }
  }

  // Memory writes: "remember my shirt size is large", "my email is x@y.z"
  const rememberMatch = text.match(/(?:remember (?:that )?)?my ([a-z0-9 /-]{2,40}) is (.{1,200})/i);
  if (rememberMatch && /(remember|my)/i.test(lower)) {
    const what = rememberMatch[1].trim();
    const value = rememberMatch[2].trim().replace(/[.!]+$/, "");
    const directKeys = { "name": "fullName", "full name": "fullName", "email": "email", "email address": "email", "phone": "phone", "phone number": "phone", "address": "addressLine1" };
    const keyHit = (directKeys[what.toLowerCase()] ? [directKeys[what.toLowerCase()]] : null)
      || Object.entries(PROFILE_FIELD_LABELS).find(([, label]) => label.toLowerCase() === what.toLowerCase())
      || LABEL_RULES.find(([, pattern]) => pattern.test(what.toLowerCase()));
    if (keyHit) {
      setProfileValue(profile, keyHit[0], value);
    } else {
      profile.preferences[what.toLowerCase()] = value;
    }
    await saveProfile(profile);
    addMsg(`Noted. Your ${what} is ${value}. I will use that anywhere it fits.`, "success");
    return true;
  }

  // Job description via link or explicit paste
  if (/^https?:\/\/\S+$/i.test(text.trim()) && session?.intent?.kind === "job_application") {
    await ingestJobDescription(text.trim());
    return true;
  }
  if (/^(here is|here'?s) the (job description|jd)/i.test(text) || (/job description[:\n]/i.test(text) && text.length > 300)) {
    await ingestJobDescription(text.replace(/^(here is|here'?s) the (job description|jd)[:,]?\s*/i, ""));
    return true;
  }
  if (/^(here is|here'?s) my resume/i.test(text) && text.length > 300) {
    const resumeText = text.replace(/^(here is|here'?s) my resume[:,]?\s*/i, "");
    await saveDocument("resume", { name: "resume.txt", mime: "text/plain", dataBase64: btoa(unescape(encodeURIComponent(resumeText))), text: resumeText });
    const learned = await learnFromResumeText(resumeText);
    addMsg(`Saved your resume text${learned ? ` and learned ${learned} profile detail${learned === 1 ? "" : "s"} from it` : ""}. I can now tailor it to a job and answer open questions from it.`, "success");
    return true;
  }

  return false;
}

async function handleChat(text) {
  const handled = await handleCommand(text);
  if (handled) return;

  // Fall through to the conversational brain with page context.
  const context = {
    host: session?.snapshot?.host || null,
    pageTitle: session?.snapshot?.title || null,
    intent: session?.intent?.kind || null,
    fieldLabels: (session?.snapshot?.fields || []).slice(0, 30).map((f) => f.label),
    hasResume: Boolean(await getDocument("resume")),
    hasJobDescription: Boolean(session?.jobDescription),
    walkAway
  };
  const result = await assist("chat", { message: text, context, profileSummary: profileSummaryText(profile) }, { timeoutMs: 30000 });
  if (result?.text) {
    const structured = parseLooseJson(result.text);
    if (structured?.reply) {
      addMsg(structured.reply);
      if (structured.action === "propose_plan") await proposePlan();
      if (structured.action === "set_intent" && INTENT_LABELS[structured.intent]) await correctIntent(structured.intent);
      if (structured.action === "remember" && structured.key && structured.value) {
        profile.preferences[String(structured.key).toLowerCase()] = String(structured.value);
        await saveProfile(profile);
        addTimeline(`Remembered: ${structured.key} is ${structured.value}.`);
      }
    } else {
      addMsg(result.text);
    }
    return;
  }

  // Offline fallback: stay useful without the language brain.
  addMsg("I am having trouble reaching my language engine, but the essentials still work. Say \"go ahead\" to draft this page, \"undo\" to roll back, or tell me facts like: my email is ada@example.com.");
}

// ---------------------------------------------------------------------------
// Composer, voice, upload wiring
// ---------------------------------------------------------------------------
function autoGrowComposer() {
  composerInput.style.height = "auto";
  composerInput.style.height = `${Math.min(composerInput.scrollHeight, 120)}px`;
}

async function submitComposer() {
  const text = composerInput.value.trim();
  if (!text) return;
  composerInput.value = "";
  autoGrowComposer();
  addMsg(text, "user");
  try {
    await handleChat(text);
  } catch (error) {
    addMsg(`Something went wrong: ${error.message}`, "warning");
  }
}

sendButton.addEventListener("click", submitComposer);
composerInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitComposer();
  }
});
composerInput.addEventListener("input", autoGrowComposer);

const voice = new VoiceInput({
  onPartial: (text) => { composerInput.value = text; autoGrowComposer(); },
  onFinal: (text) => {
    composerInput.value = text;
    autoGrowComposer();
    if (text.trim()) submitComposer();
  },
  onState: (state) => {
    micButton.classList.toggle("recording", state === "listening");
    voiceHint.hidden = state !== "listening";
  },
  onError: (message) => addMsg(message, "warning")
});

micButton.addEventListener("click", () => {
  if (micButton.classList.contains("recording")) voice.stop();
  else voice.start();
});

attachButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    addMsg("That file is over 8 MB, which is more than I can hold in memory. Use a smaller file.", "warning");
    return;
  }
  try {
    await handleUpload(file);
  } catch (error) {
    addMsg(`I could not process that file: ${error.message}`, "warning");
  }
});

walkawayToggle.addEventListener("change", () => setWalkAway(walkawayToggle.checked));

// ---------------------------------------------------------------------------
// Events from the page
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((event, sender) => {
  if (event?.type !== "KEEL_EVENT") return;
  if (!sender.tab?.id || sender.tab.id !== currentTab?.id) return;

  if (event.kind === "fields_changed") {
    addTimeline("The page changed its fields (a new step, most likely). Say \"rescan\" or \"go ahead\" and I will re-read it.");
    refreshSnapshot();
  }
});

// Follow the user's ACTIVE tab, always.
chrome.tabs.onActivated.addListener(() => attachToTab());
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) attachToTab(true);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function init() {
  profile = await loadProfile();
  documents = await loadDocuments();
  const stored = await chrome.storage.local.get(["keelThread", "keelWalkAway"]);
  threadLog = stored.keelThread || [];
  await setWalkAway(Boolean(stored.keelWalkAway), { silent: true });

  // Restore a light history so the thread feels continuous.
  for (const entry of threadLog.slice(-30)) {
    if (entry.kind === "msg") addMsg(entry.text, entry.tone, { persist: false });
    else if (entry.kind === "timeline") {
      const node = document.createElement("div");
      node.className = "timeline-entry";
      node.innerHTML = "";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.textContent = "\u2022";
      const label = document.createElement("span");
      label.textContent = entry.text;
      node.append(dot, label);
      thread.append(node);
    }
  }
  // De-duplicate persistence: entries above were already stored.
  threadLog = stored.keelThread || [];

  if (!threadLog.length) {
    addMsg("Hey, I am Keel. Any time a page asks you to introduce yourself again, that is my job: signups, checkouts, registrations, applications, all of it. I read the page you are on, draft every field from what I know about you, and show you everything before it touches the page. Talk to me, use the mic, or drop in a file. The more you correct me, the better I remember.");
  }
  await attachToTab(true);
})();
