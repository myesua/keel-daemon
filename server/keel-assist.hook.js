// keel-assist: the language brain for the Keel browser extension.
// The extension ships with zero API keys; every generation request lands here.
// House rules: natural human tone, and generated text never contains em-dashes.
const b = request.body || {};
const task = String(b.task || "");

function scrub(text) {
  return String(text || "")
    .replace(/\s*\u2014\s*/g, ", ")
    .replace(/\s*\u2013\s*/g, " to ")
    .replace(/,\s*,/g, ",")
    .replace(/ {2,}/g, " ");
}

const STYLE = "Write like a thoughtful person: plain, warm, specific, no corporate filler, no robotic phrasing. Never use em-dashes anywhere in your output. Prefer short sentences. Use contractions where natural.";

async function gen(systemPrompt, userPrompt, model) {
  const result = await platform.generateText({
    systemPrompt: systemPrompt + "\n" + STYLE,
    userPrompt: userPrompt,
    model: model || "gpt-4o-mini"
  });
  return scrub(result && result.text ? result.text : "");
}

function clip(value, max) {
  return String(value || "").slice(0, max);
}

if (task === "agent_turn") {
  // Fallback brain for the extension's reasoning loop. The side panel calls the
  // vision model directly when it can; when that route is unavailable this hook
  // reasons over the same live page state, text only, and says so.
  const system = String(b.system || "You are Keel, a screen aware browser copilot. Reply with strict JSON only.");
  const raw = await platform.generateText({
    systemPrompt: system + "\n" + STYLE + "\nReply with strict JSON only, no prose, no code fences.",
    userPrompt: "Live state (no screenshot is available on this route, say so if asked what you can see):\n" + clip(JSON.stringify(b.state || {}), 60000),
    model: "gpt-4o"
  });
  const text = scrub(raw && raw.text ? raw.text : "");
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) { try { parsed = JSON.parse(match[0]); } catch (e2) { parsed = null; } }
  }
  respond(200, { ok: true, json: parsed, text: text });
} else if (task === "classify_intent") {
  const kinds = Array.isArray(b.kinds) && b.kinds.length ? b.kinds : ["job_application", "signup", "login", "checkout", "booking", "contact", "survey", "subscription", "profile_update", "form", "none"];
  const text = await gen(
    "You classify web pages into one 'it's-me-again' task category. Reply with ONLY a JSON object like {\"kind\":\"signup\"}. Pick exactly one kind from the allowed list. Use 'form' for a form that fits nothing else and 'none' when there is no form.",
    "Allowed kinds: " + kinds.join(", ") + "\nURL: " + clip(b.url, 300) + "\nTitle: " + clip(b.title, 200) + "\nHeadings: " + clip(JSON.stringify(b.headings || []), 800) + "\nField labels: " + clip(JSON.stringify(b.fieldLabels || []), 1500)
  );
  respond(200, { ok: true, text: text });
} else if (task === "draft_values") {
  const text = await gen(
    "You draft form field values for a user, from their saved profile. Reply with ONLY JSON: {\"values\":{\"<fieldId>\":{\"value\":\"...\",\"confidence\":0.0}}}. Rules: only propose a value when the profile clearly supports it or the field is a harmless preference with an obvious sensible answer. For fields with an options list you MUST pick one option verbatim from the list or omit the field. NEVER invent identity facts (names, emails, numbers, dates, addresses, ids). Personal-circumstance questions are identity facts too: visa or sponsorship status, work authorization, disability, veteran status, gender, race, salary expectations, notice period. Omit those unless the profile explicitly answers them. Omit any field you are unsure about. Confidence is 0 to 1 and should be honest.",
    "Task context: " + clip(b.intent, 60) + " on " + clip(b.host, 120) + " (" + clip(b.pageTitle, 150) + ")\n\nUser profile:\n" + clip(b.profileSummary, 3500) + "\n\nFields to draft:\n" + clip(JSON.stringify(b.fields || []), 6000)
  );
  respond(200, { ok: true, text: text });
} else if (task === "answer_question") {
  const limit = b.maxLength ? Number(b.maxLength) : null;
  const text = await gen(
    "You answer one open-ended application question in the applicant's own first-person voice. Ground every claim in the resume, profile, or job description provided. Never fabricate employers, dates, credentials, or metrics. Sound like a real person, not a cover-letter template. Aim for 60 to 160 words unless a character limit forces less." + (limit ? " Hard limit: the answer must be under " + limit + " characters." : ""),
    "Question: " + clip(b.question, 1000) + "\n\nResume:\n" + clip(b.resumeText, 15000) + "\n\nJob description:\n" + clip(b.jobDescription, 8000) + "\n\nProfile:\n" + clip(b.profileSummary, 3000)
  );
  respond(200, { ok: true, text: limit ? text.slice(0, limit) : text });
} else if (task === "tailor_resume") {
  const text = await gen(
    "You tailor a resume to a specific job description. STRICT honesty: you may reorder sections, reword bullets, emphasize relevant work, and trim noise, but you must NEVER invent employers, titles, dates, degrees, tools, or numbers that are not in the source resume. Keep the person's real name and contact block at top. Output clean plain text: name, contact line, SUMMARY, SKILLS, EXPERIENCE, EDUCATION. Use simple hyphen bullets. No markdown symbols other than plain text.",
    "Source resume:\n" + clip(b.resumeText, 20000) + "\n\nTarget job description:\n" + clip(b.jobDescription, 12000) + "\n\nExtra profile context:\n" + clip(b.profileSummary, 3000),
    "gpt-4o"
  );
  respond(200, { ok: true, text: text });
} else if (task === "extract_profile") {
  const text = await gen(
    "You extract stable identity facts from a resume. Reply with ONLY a JSON object using ONLY these keys when present in the text: " + clip(JSON.stringify(b.knownKeys || []), 800) + ". Values are plain strings. workHistory should be a compact 3 to 5 line summary of roles with company names and years. Omit keys you cannot support with the text. Never guess.",
    "Resume text:\n" + clip(b.resumeText, 16000)
  );
  respond(200, { ok: true, text: text });
} else if (task === "chat") {
  const text = await gen(
    "You are Keel, a voice-first browser copilot living in a Chrome side panel. Your job is the 'it's-me-again' task class: filling forms that ask who the user is (signups, checkouts, registrations, job applications) from their saved profile, with the user approving everything before it touches the page. You never submit anything yourself without approval and you never touch passwords or captchas. Reply with ONLY JSON: {\"reply\":\"what you say to the user\",\"action\":null}. Set action to \"propose_plan\" if the user wants you to start filling or drafting the page. Set action to \"set_intent\" plus an \"intent\" key (one of job_application, signup, login, checkout, booking, contact, survey, subscription, profile_update, form) if they are telling you what kind of page this is. Set action to \"remember\" plus \"key\" and \"value\" if they told you a durable personal fact or preference. Otherwise action is null. Keep replies to one to three sentences.",
    "Page context: " + clip(JSON.stringify(b.context || {}), 2500) + "\n\nUser profile:\n" + clip(b.profileSummary, 2500) + "\n\nUser says: " + clip(b.message, 2000)
  );
  respond(200, { ok: true, text: text });
} else {
  respond(400, { ok: false, error: "Unknown task: " + task });
}
