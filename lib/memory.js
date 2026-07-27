// Session memory. Anything the user tells Keel is written down once and reused
// forever: this session, the next session, and every other site. Asking again
// for something the user already gave is treated as a bug, so this module also
// owns the check that blocks a repeat question before it reaches the user.

const MEMORY_KEY = "keelMemoryV1";
const MAX_TRANSCRIPT = 60;

export function normalizeText(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function emptyMemory() {
  return {
    version: 1,
    facts: {},        // durable things the user told us, keyed by a stable name
    questions: [],    // every question Keel has put to the user, with answers
    transcript: [],   // the conversation itself
    updatedAt: null
  };
}

export async function loadMemory() {
  const stored = await chrome.storage.local.get(MEMORY_KEY);
  const memory = stored[MEMORY_KEY] && stored[MEMORY_KEY].version === 1 ? stored[MEMORY_KEY] : emptyMemory();
  memory.facts = memory.facts && typeof memory.facts === "object" ? memory.facts : {};
  memory.questions = Array.isArray(memory.questions) ? memory.questions : [];
  memory.transcript = Array.isArray(memory.transcript) ? memory.transcript : [];
  return memory;
}

export async function saveMemory(memory) {
  memory.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [MEMORY_KEY]: memory });
}

export async function clearMemory() {
  await chrome.storage.local.remove(MEMORY_KEY);
}

// Phrases that mean the same thing as a stored fact. Without these, a model
// that asks "what role are you applying for?" would slip past a stored
// jobDescription and the user would have to repeat themselves.
const FACT_ALIASES = {
  jobDescription: [
    "job description", "jd", "job posting", "job post", "the posting", "role description",
    "description of the role", "job details", "what the job is", "which role", "what role",
    "the position", "link to the job", "job link", "job ad"
  ],
  resume: ["resume", "cv", "curriculum vitae", "your resume file", "upload your resume"],
  coverLetter: ["cover letter", "letter of motivation"],
  fullName: ["full name", "your name", "legal name"],
  email: ["email", "email address", "e mail"],
  phone: ["phone", "phone number", "mobile", "telephone"],
  location: ["location", "where you live", "city", "country", "address"],
  salary: ["salary", "compensation", "pay expectation", "expected salary"],
  startDate: ["start date", "notice period", "when you can start", "availability"],
  workAuthorization: ["work authorization", "visa", "sponsorship", "right to work"],
  linkedin: ["linkedin"],
  portfolio: ["portfolio", "website", "personal site"],
  github: ["github"]
};

function tokens(value) {
  return normalizeText(value).split(" ").filter((token) => token.length > 2);
}

function overlap(left, right) {
  const a = tokens(left);
  const b = new Set(tokens(right));
  if (!a.length) return 0;
  return a.filter((token) => b.has(token)).length / a.length;
}

export function recordFact(memory, key, value, { label = null, source = "user" } = {}) {
  const name = String(key || "").trim();
  const text = typeof value === "string" ? value.trim() : value;
  if (!name || text == null || text === "") return memory;
  memory.facts[name] = {
    key: name,
    label: label || name,
    value: text,
    source,
    at: new Date().toISOString()
  };
  return memory;
}

export function getFact(memory, key) {
  return memory.facts?.[key] || null;
}

export function recordMessage(memory, role, text) {
  const value = String(text || "").trim();
  if (!value) return memory;
  memory.transcript.push({ role, text: value, at: new Date().toISOString() });
  if (memory.transcript.length > MAX_TRANSCRIPT) memory.transcript = memory.transcript.slice(-MAX_TRANSCRIPT);
  return memory;
}

export function recordQuestion(memory, question, factKey = null) {
  memory.questions.push({
    question: String(question || "").trim(),
    normalized: normalizeText(question),
    factKey,
    at: new Date().toISOString(),
    answeredAt: null
  });
  if (memory.questions.length > 40) memory.questions = memory.questions.slice(-40);
  return memory;
}

export function answerOpenQuestions(memory, answerText) {
  const at = new Date().toISOString();
  for (const item of memory.questions) {
    if (!item.answeredAt) {
      item.answeredAt = at;
      item.answer = String(answerText || "").slice(0, 2000);
    }
  }
  return memory;
}

// Is this question already answered? Returns the reason it should not be asked
// again, or null when the question is genuinely new.
export function alreadyAnswered(memory, question) {
  const asked = normalizeText(question);
  if (!asked) return null;

  for (const [key, fact] of Object.entries(memory.facts || {})) {
    const aliases = FACT_ALIASES[key] || [];
    const hit = aliases.some((alias) => asked.includes(normalizeText(alias)))
      || overlap(fact.label, asked) >= 0.6
      || overlap(asked, `${key} ${fact.label}`) >= 0.6;
    if (hit) return { key, fact, reason: `already stored as ${fact.label}` };
  }

  for (const item of memory.questions) {
    if (!item.answeredAt) continue;
    if (item.normalized === asked || overlap(item.normalized, asked) >= 0.7) {
      return { key: item.factKey, answer: item.answer, reason: "the user already answered this question" };
    }
  }
  return null;
}

// What the model is allowed to treat as known. Long values are summarized by
// length so a whole job description does not eat the context window.
export function factsForModel(memory) {
  const out = {};
  for (const [key, fact] of Object.entries(memory.facts || {})) {
    const value = typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value);
    out[key] = {
      label: fact.label,
      value: value.length > 700 ? `${value.slice(0, 700)} ... (${value.length} characters stored in full)` : value,
      knownSince: fact.at
    };
  }
  return out;
}

export function factSummaryLine(memory) {
  const names = Object.values(memory.facts || {}).map((fact) => fact.label);
  if (!names.length) return "";
  return `Already known: ${names.join(", ")}.`;
}
