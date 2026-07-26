// Keel's relational memory. The profile stores the user generically: identity,
// contact details, links, work summary, durable preferences, learned answers,
// and per-domain memory. It exists so ANY it's-me-again surface (signup,
// checkout, registration, application) can be filled from the same source.
// Job-application material (resume, job descriptions, tailored resumes) is a
// separate document store layered on top, not the profile itself.

const PROFILE_KEY = "keelProfileV2";
const DOCS_KEY = "keelDocumentsV1";

export const PROFILE_FIELD_LABELS = {
  firstName: "First name",
  lastName: "Last name",
  fullName: "Full name",
  email: "Email",
  phone: "Phone",
  addressLine1: "Street address",
  addressLine2: "Address line 2",
  city: "City",
  state: "State or region",
  postalCode: "Postal code",
  country: "Country",
  dateOfBirth: "Date of birth",
  company: "Current company",
  jobTitle: "Current title",
  linkedin: "LinkedIn URL",
  github: "GitHub URL",
  portfolio: "Portfolio URL",
  workHistory: "Work history summary"
};

function emptyProfile() {
  return {
    identity: {},      // firstName, lastName, fullName, email, phone, address parts, dateOfBirth
    links: {},         // linkedin, github, portfolio, website
    work: {},          // company, jobTitle, workHistory
    preferences: {},   // durable cross-surface preferences, keyed by a normalized question
    answers: {},       // learned answers keyed by normalized question text
    domains: {},       // per-domain memory: { "example.com": { answers: {}, notes: [] } }
    updatedAt: null
  };
}

const IDENTITY_KEYS = new Set(["firstName", "lastName", "fullName", "email", "phone", "addressLine1", "addressLine2", "city", "state", "postalCode", "country", "dateOfBirth"]);
const LINK_KEYS = new Set(["linkedin", "github", "portfolio", "website"]);
const WORK_KEYS = new Set(["company", "jobTitle", "workHistory"]);

export function normalizeQuestion(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 160);
}

export async function loadProfile() {
  const stored = await chrome.storage.local.get([PROFILE_KEY, "profile"]);
  let profile = stored[PROFILE_KEY];
  if (!profile) {
    profile = emptyProfile();
    // Migrate the flat v0 profile if one exists.
    const legacy = stored.profile;
    if (legacy && typeof legacy === "object") {
      for (const [key, value] of Object.entries(legacy)) {
        if (!value) continue;
        if (key === "currentCompany") profile.work.company = value;
        else if (key === "currentTitle") profile.work.jobTitle = value;
        else if (IDENTITY_KEYS.has(key)) profile.identity[key] = value;
        else if (LINK_KEYS.has(key)) profile.links[key] = value;
        else if (WORK_KEYS.has(key)) profile.work[key] = value;
      }
      await chrome.storage.local.set({ [PROFILE_KEY]: profile });
    }
  }
  for (const key of ["identity", "links", "work", "preferences", "answers", "domains"]) {
    if (!profile[key] || typeof profile[key] !== "object") profile[key] = {};
  }
  return profile;
}

export async function saveProfile(profile) {
  profile.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [PROFILE_KEY]: profile });
}

// A flat view for field matching: identity + links + work under known keys.
export function flatProfile(profile) {
  const flat = { ...profile.identity, ...profile.links, ...profile.work };
  if (!flat.fullName && (flat.firstName || flat.lastName)) {
    flat.fullName = [flat.firstName, flat.lastName].filter(Boolean).join(" ");
  }
  if (!flat.firstName && flat.fullName) {
    const parts = String(flat.fullName).trim().split(/\s+/);
    if (parts.length >= 2) {
      flat.firstName = parts[0];
      flat.lastName = parts.slice(1).join(" ");
    }
  }
  return flat;
}

export function setProfileValue(profile, key, value) {
  const trimmed = String(value ?? "").trim();
  if (IDENTITY_KEYS.has(key)) profile.identity[key] = trimmed;
  else if (LINK_KEYS.has(key)) profile.links[key] = trimmed;
  else if (WORK_KEYS.has(key)) profile.work[key] = trimmed;
  else profile.preferences[key] = trimmed;
}

// Learning: when the user corrects or supplies an answer, persist it so the
// same question is pre-filled next time, on any site. Domain-specific answers
// shadow the global ones.
export function rememberAnswer(profile, questionText, value, domain = null) {
  const key = normalizeQuestion(questionText);
  if (!key || !String(value ?? "").trim()) return;
  const record = { value: String(value).trim(), learnedAt: new Date().toISOString() };
  if (domain) {
    profile.domains[domain] = profile.domains[domain] || { answers: {} };
    profile.domains[domain].answers = profile.domains[domain].answers || {};
    profile.domains[domain].answers[key] = record;
  } else {
    profile.answers[key] = record;
  }
}

export function lookupAnswer(profile, questionText, domain = null) {
  const key = normalizeQuestion(questionText);
  if (!key) return null;
  const domainAnswers = domain ? profile.domains?.[domain]?.answers : null;
  if (domainAnswers?.[key]) return { ...domainAnswers[key], scope: "site" };
  if (profile.answers?.[key]) return { ...profile.answers[key], scope: "global" };
  // Fuzzy pass: token containment against learned questions.
  const tokens = key.split(" ").filter((t) => t.length > 2);
  if (tokens.length < 2) return null;
  const pools = [
    [domainAnswers || {}, "site"],
    [profile.answers || {}, "global"]
  ];
  for (const [pool, scope] of pools) {
    for (const [candidate, record] of Object.entries(pool)) {
      const candidateTokens = new Set(candidate.split(" "));
      const hits = tokens.filter((t) => candidateTokens.has(t)).length;
      if (hits / tokens.length >= 0.75) return { ...record, scope, fuzzy: true };
    }
  }
  return null;
}

export function profileSummaryText(profile) {
  const flat = flatProfile(profile);
  const lines = [];
  for (const [key, label] of Object.entries(PROFILE_FIELD_LABELS)) {
    if (flat[key]) lines.push(`${label}: ${flat[key]}`);
  }
  const learned = Object.keys(profile.answers || {}).length;
  const prefs = Object.entries(profile.preferences || {});
  for (const [key, value] of prefs.slice(0, 20)) lines.push(`Preference (${key}): ${value}`);
  if (learned) lines.push(`Learned answers on file: ${learned}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Document store (resume and friends). Stored as base64 so saved files can be
// attached to real file inputs later.
// ---------------------------------------------------------------------------
export async function loadDocuments() {
  const stored = await chrome.storage.local.get(DOCS_KEY);
  return stored[DOCS_KEY] || {};
}

export async function saveDocument(kind, doc) {
  const docs = await loadDocuments();
  docs[kind] = { ...doc, savedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [DOCS_KEY]: docs });
  return docs[kind];
}

export async function getDocument(kind) {
  const docs = await loadDocuments();
  return docs[kind] || null;
}
