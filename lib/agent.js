// The reasoning loop.
//
// There is no script here. Keel does not have a fixed order of questions and it
// does not have phases. On every turn the model receives the live page (DOM and
// pixels), the conversation, and everything Keel already knows about the user,
// and it decides the single next thing to do. The only hard rules live in the
// guards below, and they exist to stop regressions the founder actually hit:
// re-asking answered questions, asking permission twice, filling a stray
// newsletter box, or touching a password.

import { alreadyAnswered } from "./memory.js";
import { humanizeText } from "./assist.js";

const API_ORIGIN = "https://audos.com";
const APP_ID = "workspace-387488";
const HOOK_URL = `${API_ORIGIN}/api/workspaces/387488/hooks/keel-assist/execute`;
const MODEL = "gpt-4o";

const SYSTEM_PROMPT = `You are Keel, a screen aware browser copilot. The person you are talking to is looking at a real web page right now, and you can see it: you are given the live DOM of their active tab and a screenshot of exactly what is in their viewport, both captured a second ago. Treat that state as the truth about the page. Never describe a page from memory or imagination.

You do the browser work. The human watches and approves.

How you decide what to do:
- Look at the page state, the conversation, and the known facts, then pick the single most useful next step.
- There is no fixed order of questions. You are not running a script.
- Only ask the user something when you genuinely cannot proceed without it and cannot infer it from the page, the conversation, or the known facts.
- Never ask for anything listed in knownFacts. Never ask a question the user already answered in the conversation. If you need to confirm something you already have, do not: act on it.
- If the user has said yes, go ahead, or anything that means approval, move the work forward. Do not ask for permission a second time.
- Work on the form the user is actually on. The page state marks it with isTheOneTheUserIsOn. Never fill a newsletter, subscribe, search, cookie, or footer box unless the user explicitly asked for that.
- Fill fields in the DOM order given to you, from the top of the form down. Cover every field in that form you can answer from what you know, not just the first section, and keep going to the bottom of it. Leave a field out only when you truly cannot answer it, and say which ones you left.
- A field with an empty currentValue still needs a value. A field that already has the right value should be left alone.
- Only reference field ids and button ids that exist in the page state.
- Never fill a field marked sensitive (passwords, one time codes). Hand those back to the user.
- Never choose an option that is not in a field's options list.
- Never invent identity facts. If a value is not in knownFacts, the profile, the resume, or the page, either leave it out or ask once.
- You never submit anything. A click on a submitting button is only ever proposed; the user approves it in the panel.
- If the user asks what you can see, prove it. Your reply must name the exact page title, what the page is for, the section they are scrolled to, and at least three real field labels copied from the state, plus anything else notable such as a newsletter box in the footer. A vague answer is a failure, and so is any detail that is not in the state. If the screenshot is missing, say so plainly and describe what you read from the DOM.
- The fills array must cover every empty field in the target form that you can answer, textareas included.
- Open ended questions, the textarea kind such as "why do you want to work here", are yours to draft. Write a short honest answer in the user's voice from their resume, the job description, and what they have told you. Never leave one empty just because the user did not dictate it, and never invent achievements. They can edit it in the preview.

Tone: talk like a competent person helping out. Short sentences, contractions, no filler, no corporate voice, no em dashes anywhere.

Reply with strict JSON only, in this shape:
{
  "say": "what you tell the user, plain text, may be empty if a card says it",
  "targetFormId": "the form id you are working on, or null",
  "next": "wait" | "ask" | "fill" | "click" | "scroll",
  "question": { "text": "the single question", "factKey": "short_key_for_the_answer" } or null,
  "fills": [ { "fieldId": "id from page state", "value": "value to type or the exact option text", "confidence": 0.0 to 1.0, "why": "where this value came from" } ],
  "click": { "buttonId": "id from page state", "reason": "why" } or null,
  "remember": [ { "key": "short_key", "label": "human label", "value": "what to store" } ],
  "tailorResume": true only if the user asked for a resume tailored to this role, otherwise false,
  "blocked": "if you cannot see or do something, say exactly what, else null"
}
Use "fill" whenever you have at least one value worth proposing. Use "ask" only for a real blocker, and ask one thing at a time: put the question in question.text and never repeat it inside say. Use "wait" for conversation that needs no page action.`;

function parseLooseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (_) { return null; }
}

async function callModel(messages, { timeoutMs = 60000, temperature = 0.2, maxTokens = 2500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_ORIGIN}/proxy/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Id": APP_ID },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
        response_format: { type: "json_object" }
      }),
      signal: controller.signal
    });
    if (!response.ok) return null;
    const data = await response.json();
    return parseLooseJson(data.choices?.[0]?.message?.content);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Fallback brain: the workspace hook. Text only, but it keeps Keel useful when
// the direct model route is unavailable.
async function callHook(payload, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(HOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "agent_turn", ...payload }),
      signal: controller.signal
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.json || parseLooseJson(data?.text);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildUserContent({ state, screenshotDataUrl }) {
  const parts = [{ type: "text", text: JSON.stringify(state) }];
  if (screenshotDataUrl) {
    parts.push({ type: "text", text: "Below is the screenshot of the user's viewport, captured just now. It shows exactly what they are looking at." });
    parts.push({ type: "image_url", image_url: { url: screenshotDataUrl, detail: "auto" } });
  } else {
    parts.push({ type: "text", text: "No screenshot is available this turn. Say so if the user asks what you can see, and work from the DOM state above." });
  }
  return parts;
}

export function buildState({ page, pageModelView, screenshot, facts, profileSummary, transcript, userMessage, notes = [] }) {
  return {
    now: new Date().toISOString(),
    userJustSaid: userMessage || null,
    conversation: transcript.slice(-16).map((item) => ({ role: item.role, text: item.text })),
    knownFacts: facts,
    savedProfile: profileSummary || "nothing saved yet",
    screenshotAvailable: Boolean(screenshot?.ok),
    screenshotProblem: screenshot?.ok ? null : screenshot?.error || null,
    livePage: pageModelView,
    pageReadAt: page?.capturedAt,
    guardNotes: notes
  };
}

// The drafting pass. Deciding what to do and writing good values are different
// jobs, and one prompt doing both is how fields at the bottom of a form get
// quietly dropped. So once Keel has decided to fill, it looks at every empty
// field in that form and writes a value for each one it can honestly answer.
const DRAFT_PROMPT = `You write form values for one person, from facts you are given about them.

Rules:
- One entry per field you can answer. Cover every field in the list you can, top to bottom.
- The facts come from three places and all three count: the stored facts, the saved profile, and what the person said in the conversation. Something they said once in chat is as good as a stored fact.
- Match the value to the field's own label. City goes in the city field, street address in the street field, and so on. A wrong-field value is worse than no value.
- For a field with options, copy one option exactly as written or leave the field out. When the options are ranges, pick the range that actually contains the person's number: 8 years of experience belongs in "6 to 9 years", not "10 or more years".
- For a checkbox, the value is Yes or No. Say Yes when the facts support it, for example someone who said they are happy to work remotely. For a terms or consent checkbox, propose Yes with confidence 0.4 and say in why that they are approving it in the preview.
- For open ended questions, write 2 to 3 sentences in the person's voice, grounded in their resume, the job description, and what they told you. Specific, warm, no filler, no invented achievements, no em dashes. Respect maxLength.
- Never write a value you cannot support from the facts. Put those in skipped with a short reason. The one exception is a field marked openEnded: every openEnded field must appear in values, because a first draft the person edits is more useful than a blank box.
- Never write a password, a one time code, or a payment number.
- confidence is 0.9 when the fact is explicit, 0.6 when you inferred it sensibly, 0.4 when it is a reasonable default.

Reply with strict JSON only:
{ "values": { "<fieldId>": { "value": "...", "confidence": 0.0, "why": "where it came from" } },
  "skipped": [ { "fieldId": "...", "reason": "..." } ] }`;

export async function draftValues({ facts, profileSummary, page, fields, userGoal, conversation = [] }) {
  if (!fields.length) return { values: {}, skipped: [] };
  const payload = {
    aboutThePerson: facts,
    savedProfile: profileSummary,
    whatTheyHaveSaid: conversation.slice(-12).map((item) => ({ role: item.role, text: item.text })),
    whatTheyAreDoing: userGoal || "filling this form",
    page: { title: page.title, url: page.url },
    fieldsToFill: fields.map((field) => ({
      fieldId: field.id,
      label: field.label,
      type: field.type,
      required: field.required,
      options: field.options?.length ? field.options : undefined,
      section: field.section || undefined,
      openEnded: field.type === "textarea" || undefined,
      placeholder: field.placeholder || undefined,
      maxLength: field.maxLength || undefined
    }))
  };
  const result = await callModel([
    { role: "system", content: DRAFT_PROMPT },
    { role: "user", content: JSON.stringify(payload) }
  ], { timeoutMs: 75000, temperature: 0, maxTokens: 4000 });
  if (!result || typeof result.values !== "object") {
    console.warn("Keel: the drafting pass returned nothing usable for", fields.length, "fields");
    return { values: {}, skipped: [] };
  }
  console.debug("Keel: drafted", Object.keys(result.values).length, "of", fields.length, "fields");
  return { values: result.values, skipped: Array.isArray(result.skipped) ? result.skipped : [] };
}

export async function decide({ state, screenshotDataUrl }) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserContent({ state, screenshotDataUrl }) }
  ];
  const direct = await callModel(messages);
  if (direct) return { decision: direct, via: screenshotDataUrl ? "model with screenshot" : "model, dom only" };

  const viaHook = await callHook({ system: SYSTEM_PROMPT, state });
  if (viaHook) return { decision: viaHook, via: "workspace hook, dom only" };

  return { decision: null, via: "unreachable" };
}

// ---------------------------------------------------------------------------
// Guards. The model proposes; these decide what the user actually sees.
// ---------------------------------------------------------------------------
const AFFIRMATIONS = /^(y|ye|yes|yeah|yep|yup|sure|ok|okay|k|please|please do|go|go ahead|go for it|do it|start|start now|proceed|continue|carry on|sounds good|fine|correct|right|absolutely|of course)\b/i;
const PERMISSION_QUESTION = /\b(can i|shall i|should i|may i|want me to|ready for me|would you like me|do you want me|is it ok(ay)? (if|for) me|permission|go ahead\?)\b/i;

export function isAffirmation(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  return AFFIRMATIONS.test(value) && value.length <= 40;
}

export function isPermissionQuestion(text) {
  return PERMISSION_QUESTION.test(String(text || ""));
}

export function applyGuards({ decision, page, memory, userMessage }) {
  const notes = [];
  const result = {
    say: humanizeText(decision?.say || ""),
    targetFormId: decision?.targetFormId || page?.primaryFormId || null,
    next: decision?.next || "wait",
    question: decision?.question || null,
    fills: [],
    click: decision?.click || null,
    remember: Array.isArray(decision?.remember) ? decision.remember : [],
    // Only the user gets to start a resume rewrite, not the model on a whim.
    tailorResume: decision?.tailorResume === true && /\b(resume|cv|tailor)\b/i.test(String(userMessage || "")),
    blocked: decision?.blocked || null,
    droppedFills: [],
    notes
  };

  const byId = new Map((page?.fields || []).map((field) => [field.id, field]));
  const buttonIds = new Set((page?.buttons || []).map((button) => button.id));

  // 1. Fills must point at fields that really exist, in the section the user is
  //    on, and never at a secret.
  const target = result.targetFormId;
  for (const fill of Array.isArray(decision?.fills) ? decision.fills : []) {
    const field = byId.get(fill.fieldId);
    if (!field) {
      result.droppedFills.push({ ...fill, reason: "that field is not on the page" });
      continue;
    }
    if (field.type === "password" || field.isOtp) {
      result.droppedFills.push({ ...fill, label: field.label, reason: "Keel never types passwords or one time codes" });
      continue;
    }
    if (target && field.formId !== target) {
      result.droppedFills.push({ ...fill, label: field.label, reason: `it belongs to a different part of the page (${field.region})` });
      continue;
    }
    const value = String(fill.value ?? "").trim();
    if (!value) continue;
    result.fills.push({
      fieldId: field.id,
      field,
      value,
      confidence: typeof fill.confidence === "number" ? fill.confidence : 0.6,
      why: humanizeText(fill.why || "")
    });
  }
  result.fills.sort((left, right) => left.field.index - right.field.index);

  // 2. A question the user already answered never reaches them.
  if (result.next === "ask" && result.question?.text) {
    const seen = alreadyAnswered(memory, result.question.text);
    if (seen) {
      notes.push(`You tried to ask "${result.question.text}" but ${seen.reason}. Use what you already have and get on with the work.`);
      result.question = null;
      result.next = result.fills.length ? "fill" : "wait";
      result.blockedQuestion = true;
    } else if (isPermissionQuestion(result.question.text) && isAffirmation(userMessage)) {
      notes.push("The user just approved. Do not ask permission again, act.");
      result.question = null;
      result.next = result.fills.length ? "fill" : "wait";
      result.blockedQuestion = true;
    }
  }

  // 3. A click is only ever a proposal, and only for a real button.
  if (result.click && !buttonIds.has(result.click.buttonId)) {
    notes.push("The button you named is not on the page.");
    result.click = null;
  }

  if (result.next === "fill" && !result.fills.length) result.next = result.question ? "ask" : "wait";
  return result;
}
