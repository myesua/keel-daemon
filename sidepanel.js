import { assist, humanizeText, parseLooseJson } from "./lib/assist.js";
import {
  loadProfile,
  saveProfile,
  flatProfile,
  setProfileValue,
  rememberAnswer,
  lookupAnswer,
  profileSummaryText,
  loadDocuments,
  saveDocument
} from "./lib/profile.js";
import { VoiceInput } from "./lib/voice.js";
import {
  fetchJobDescription,
  answerOpenQuestion,
  tailorResume,
  makeResumePdfBase64
} from "./lib/jobkit.js";

const SESSION_KEY = "keelConversationV3";
const WALKAWAY_KEY = "keelWalkawayV1";
const APP_ID = "workspace-387488";
const API_ORIGIN = "https://audos.com";
const MAX_HISTORY = 60;

const thread = document.querySelector("#thread");
const contextLine = document.querySelector("#context-line");
const composer = document.querySelector("#composer-input");
const sendButton = document.querySelector("#send-button");
const attachButton = document.querySelector("#attach-button");
const fileInput = document.querySelector("#file-input");
const micButton = document.querySelector("#mic-button");
const voiceHint = document.querySelector("#voice-hint");
const walkawayToggle = document.querySelector("#walkaway-toggle");

fileInput.accept = ".pdf,.docx,.txt,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

let profile;
let documents;
let activeTabId = null;
let snapshot = null;
let currentPlan = null;
let busy = false;

function freshSession() {
  return {
    version: 3,
    phase: "discovering",
    intent: null,
    resume: { uploaded: false, parsed: false, fileName: null, summary: null, text: null, error: null },
    jobDescription: { provided: false, source: null, text: null, title: null },
    openQuestionsDrafted: false,
    approvalToProceed: false,
    lastQuestionKey: null,
    processedInputs: [],
    history: [],
    page: null,
    updatedAt: null
  };
}

let session = freshSession();

function cleanText(value) {
  return humanizeText(String(value || "")).replace(/\s+$/g, "");
}

function inputKey(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 500);
}

function isAffirmative(text) {
  const value = inputKey(text);
  return /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|start|start now|do it|please do|move on|continue|proceed|fill it|fill the form|ready)( please)?$/.test(value)
    || /\b(go ahead|start now|do it|move on|stop asking and start|fill (it|the form)|proceed now)\b/.test(value);
}

function isNegative(text) {
  return /^(no|nope|not yet|wait|stop|cancel)$/i.test(String(text || "").trim());
}

function looksLikeJobDescription(text) {
  const value = String(text || "").trim();
  return value.length > 350 || /\b(job description|responsibilities|qualifications|requirements|about the role|what you will do)\b/i.test(value);
}

function looksLikeUrl(text) {
  try {
    const url = new URL(String(text || "").trim());
    return ["http:", "https:"].includes(url.protocol);
  } catch (_) {
    return false;
  }
}

async function persistSession() {
  session.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

function scrollThread() {
  requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
}

function recordMessage(role, text) {
  session.history.push({ role, text: cleanText(text), at: new Date().toISOString() });
  if (session.history.length > MAX_HISTORY) session.history = session.history.slice(-MAX_HISTORY);
}

function addMessage(text, role = "keel", kind = "") {
  const value = cleanText(text);
  if (!value) return null;
  const node = document.createElement("div");
  node.className = `msg ${role} ${kind}`.trim();
  node.textContent = value;
  thread.append(node);
  recordMessage(role === "user" ? "user" : "assistant", value);
  scrollThread();
  return node;
}

function addTimeline(text, buttonLabel = null, onClick = null) {
  const row = document.createElement("div");
  row.className = "timeline-entry";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.textContent = "•";
  const label = document.createElement("span");
  label.textContent = cleanText(text);
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

function renderStoredHistory() {
  thread.replaceChildren();
  for (const item of session.history || []) {
    const node = document.createElement("div");
    node.className = `msg ${item.role === "user" ? "user" : "keel"}`;
    node.textContent = cleanText(item.text);
    thread.append(node);
  }
  scrollThread();
}

async function notify(title, message) {
  if (!walkawayToggle.checked) return;
  const icon = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='128' height='128'><rect width='128' height='128' rx='30' fill='#102b24'/><text x='64' y='88' text-anchor='middle' font-family='Arial' font-size='72' font-weight='700' fill='#b8f36b'>K</text></svg>");
  try {
    await chrome.notifications.create({ type: "basic", iconUrl: icon, title, message: cleanText(message) });
  } catch (_) {
    document.title = `${title}: ${cleanText(message)}`;
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Open a normal web page so Keel can see it.");
  activeTabId = tab.id;
  return tab;
}

async function sendToPage(message, targetTabId = null) {
  const tab = targetTabId ? await chrome.tabs.get(targetTabId) : await activeTab();
  if (!tab?.id) throw new Error("The application tab is no longer open.");
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (error) {
      throw new Error("Keel cannot read this page. Refresh it once, then try again.");
    }
  }
}

function detectIntent(page) {
  const text = inputKey([page?.title, page?.headings?.join(" "), page?.bodyTextSample].join(" "));
  if (/\b(apply|application|resume|cv|candidate|career|job)\b/.test(text)) return "job_application";
  if (/\b(checkout|payment|billing|shipping|place order|cart)\b/.test(text)) return "checkout";
  if (/\b(sign up|create account|register|registration)\b/.test(text)) return "signup";
  return page?.fields?.length ? "form" : "page";
}

async function refreshContext({ announce = false } = {}) {
  try {
    const response = await sendToPage({ type: "KEEL_SNAPSHOT" });
    if (!response?.ok) throw new Error("The page did not answer.");
    snapshot = response.snapshot;
    session.page = { url: snapshot.url, title: snapshot.title, host: snapshot.host };
    const nextIntent = detectIntent(snapshot);
    session.intent = session.intent || nextIntent;
    contextLine.textContent = snapshot.title || snapshot.host || "Looking at this page";
    if (announce && !session.history.length) {
      const label = nextIntent === "job_application" ? "a job application" : nextIntent === "checkout" ? "a checkout" : nextIntent === "signup" ? "a signup" : snapshot.fields.length ? "a form" : "this page";
      addMessage(`I am looking at ${label}. I will keep track of what you share, preview every change, and never submit without your approval.`);
    }
    await persistSession();
    return snapshot;
  } catch (error) {
    contextLine.textContent = "Page connection needed";
    if (announce && !session.history.length) addMessage(error.message, "keel", "warning");
    return null;
  }
}

function missingSlots() {
  if (session.intent !== "job_application") return [];
  const missing = [];
  if (!session.resume.parsed) missing.push("your resume as a PDF, DOCX, or TXT file");
  if (!session.jobDescription.provided) missing.push("the job description as a link or pasted text");
  return missing;
}

async function askOnce(key, text) {
  if (session.lastQuestionKey === key) return false;
  session.lastQuestionKey = key;
  addMessage(text);
  await persistSession();
  return true;
}

function readinessSummary() {
  const parts = [];
  if (session.resume.parsed) parts.push(`your resume${session.resume.summary?.name ? ` for ${session.resume.summary.name}` : ""}`);
  if (session.jobDescription.provided) parts.push(session.jobDescription.title ? `the job description for ${session.jobDescription.title}` : "the job description");
  if (!parts.length) return "I have the current page";
  if (parts.length === 1) return `I have ${parts[0]}`;
  return `I have ${parts[0]} and ${parts[1]}`;
}

async function advanceConversation() {
  const missing = missingSlots();
  if (missing.length) {
    session.phase = "collecting_context";
    const list = missing.length === 2 ? `${missing[0]} and ${missing[1]}` : missing[0];
    await askOnce(`missing:${missing.join("|")}`, `To prepare this application, I still need ${list}. Send both together if that is easiest.`);
    return;
  }
  session.phase = "awaiting_start";
  await askOnce("ready-to-plan", `${readinessSummary()}. Ready for me to draft every field and show you a preview?`);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function dataUrlFor(file, base64) {
  return `data:${file.type || "application/octet-stream"};base64,${base64}`;
}

function decodeXmlText(xmlText) {
  const xml = new DOMParser().parseFromString(xmlText, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("The DOCX document XML is damaged.");
  const paragraphs = [...xml.getElementsByTagNameNS("*", "p")];
  return paragraphs.map((paragraph) => [...paragraph.getElementsByTagNameNS("*", "t")].map((node) => node.textContent || "").join("")).filter(Boolean).join("\n").trim();
}

async function extractDocxText(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This DOCX is not a valid ZIP document.");
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder("utf-8");
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("The DOCX directory is damaged.");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (name === "word/document.xml") {
      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("The DOCX content entry is damaged.");
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(start, start + compressedSize);
      let uncompressed;
      if (method === 0) uncompressed = compressed;
      else if (method === 8) {
        if (typeof DecompressionStream !== "function") throw new Error("This Chrome version cannot decompress DOCX files. Update Chrome or use PDF or TXT.");
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        uncompressed = new Uint8Array(await new Response(stream).arrayBuffer());
      } else throw new Error(`This DOCX uses unsupported compression method ${method}.`);
      const text = decodeXmlText(decoder.decode(uncompressed));
      if (!text) throw new Error("The DOCX contains no readable resume text.");
      return text;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("This DOCX has no readable word/document.xml entry.");
}

async function uploadForAnalysis(file, base64) {
  const response = await fetch(`${API_ORIGIN}/api/upload/image`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Id": APP_ID },
    body: JSON.stringify({ imageData: dataUrlFor(file, base64), fileName: file.name })
  });
  if (!response.ok) throw new Error(`Upload failed with status ${response.status}.`);
  const data = await response.json();
  const url = data.imageUrl || data.fileUrl || data.url;
  if (!url) throw new Error("The upload service did not return a document URL.");
  return url;
}

async function analyzePdf(file, base64) {
  const documentUrl = await uploadForAnalysis(file, base64);
  const analysisPrompt = "Read this resume accurately. Return strict JSON with keys fullText, name, mostRecentRole, skills (array of 2 to 6 factual skills), email, phone, linkedin, company. fullText must contain the resume text you actually read. Do not infer facts that are absent.";
  const response = await fetch(`${API_ORIGIN}/api/analyze-document`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Id": APP_ID },
    body: JSON.stringify({ documentUrl, analysisPrompt, documentType: "pdf" })
  });
  if (!response.ok) throw new Error(`PDF analysis failed with status ${response.status}.`);
  const data = await response.json();
  if (!data.success && !data.analysis) throw new Error(data.error || "The PDF analysis service returned no text.");
  const parsed = typeof data.analysis === "object" ? data.analysis : parseLooseJson(data.analysis);
  if (!parsed?.fullText || String(parsed.fullText).trim().length < 40) throw new Error("No readable resume text was found in this PDF. If it is a scan, export it as a searchable PDF, DOCX, or TXT file.");
  return { text: String(parsed.fullText).trim(), facts: parsed };
}

function fallbackResumeFacts(text) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const email = String(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
  const phone = String(text).match(/(?:\+?\d[\d ().-]{7,}\d)/)?.[0] || "";
  const name = lines[0] && lines[0].length < 70 && !/@|resume|curriculum/i.test(lines[0]) ? lines[0] : "";
  const roleLine = lines.find((line) => /\b(engineer|developer|designer|manager|analyst|director|consultant|specialist|lead|founder|product|marketing|sales|operations)\b/i.test(line)) || "";
  const skillWords = ["JavaScript", "TypeScript", "React", "Python", "Java", "SQL", "AWS", "Azure", "Figma", "Product management", "Machine learning", "Data analysis"];
  const skills = skillWords.filter((skill) => new RegExp(`\\b${skill.replace(" ", "\\s+")}\\b`, "i").test(text)).slice(0, 5);
  return { name, mostRecentRole: roleLine.slice(0, 100), skills, email, phone };
}

async function summarizeResume(text, suppliedFacts = null) {
  let facts = suppliedFacts;
  if (!facts) {
    const result = await assist("parse_resume", {
      resumeText: String(text).slice(0, 24000),
      instruction: "Return strict JSON with name, mostRecentRole, skills, email, phone, linkedin, company. Use only facts in the resume."
    }, { timeoutMs: 60000 });
    facts = result?.json || parseLooseJson(result?.text);
    if (!facts) {
      const response = await fetch(`${API_ORIGIN}/proxy/openai/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-App-Id": APP_ID },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Extract only facts present in this resume. Return strict JSON with name, mostRecentRole, skills, email, phone, linkedin, company. Never infer missing facts." },
            { role: "user", content: String(text).slice(0, 24000) }
          ],
          max_tokens: 800,
          temperature: 0,
          stream: false,
          response_format: { type: "json_object" }
        })
      });
      if (response.ok) {
        const data = await response.json();
        facts = parseLooseJson(data.choices?.[0]?.message?.content);
      }
    }
  }
  facts = { ...fallbackResumeFacts(text), ...(facts || {}) };
  if (!Array.isArray(facts.skills)) facts.skills = String(facts.skills || "").split(/,|\n/).map((item) => item.trim()).filter(Boolean);
  facts.skills = facts.skills.slice(0, 6);
  return facts;
}

async function mergeResumeIntoProfile(facts, text, fileName = null) {
  const updates = {};
  if (facts.name) updates.fullName = facts.name;
  if (facts.email) updates.email = facts.email;
  if (facts.phone) updates.phone = facts.phone;
  if (facts.linkedin) updates.linkedin = facts.linkedin;
  if (facts.mostRecentRole) updates.jobTitle = facts.mostRecentRole;
  if (facts.company) updates.company = facts.company;
  updates.workHistory = String(text).slice(0, 12000);
  for (const [key, value] of Object.entries(updates)) if (value) setProfileValue(profile, key, value);
  profile.documents = profile.documents || {};
  profile.documents.resume = {
    fileName: fileName || session.resume.fileName || null,
    text: String(text).slice(0, 24000),
    summary: facts,
    parsedAt: new Date().toISOString()
  };
  await saveProfile(profile);
}

function resumeProof(facts) {
  const pieces = [];
  if (facts.name) pieces.push(`Name: ${facts.name}`);
  if (facts.mostRecentRole) pieces.push(`Most recent role: ${facts.mostRecentRole}`);
  if (facts.skills?.length) pieces.push(`Skills: ${facts.skills.slice(0, 3).join(", ")}`);
  return pieces.length ? pieces.join("\n") : "I extracted the text and saved it to your profile, but the document did not clearly label a name, recent role, or skills.";
}

async function ingestResume(file) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!["pdf", "docx", "txt"].includes(extension)) throw new Error("Use a PDF, DOCX, or TXT resume.");
  if (file.size > 32 * 1024 * 1024) throw new Error("This file is over 32 MB. Use a smaller PDF, DOCX, or TXT resume.");
  const buffer = await file.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  let text;
  let suppliedFacts = null;
  if (extension === "txt") text = new TextDecoder("utf-8").decode(buffer).trim();
  else if (extension === "docx") text = await extractDocxText(buffer);
  else {
    const analyzed = await analyzePdf(file, base64);
    text = analyzed.text;
    suppliedFacts = analyzed.facts;
  }
  if (!text || text.length < 40) throw new Error(`The ${extension.toUpperCase()} file did not contain enough readable resume text.`);
  const facts = await summarizeResume(text, suppliedFacts);
  const doc = await saveDocument("resume", {
    name: file.name,
    mime: file.type || (extension === "pdf" ? "application/pdf" : extension === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain"),
    dataBase64: base64,
    text,
    summary: facts
  });
  documents.resume = doc;
  await mergeResumeIntoProfile(facts, text, file.name);
  session.resume = { uploaded: true, parsed: true, fileName: file.name, summary: facts, text, error: null };
  session.lastQuestionKey = null;
  await persistSession();
  addMessage(`I read ${file.name} and saved the parsed resume to your reusable profile.\n${resumeProof(facts)}`, "keel", "success");
  await advanceConversation();
}

async function storeJobDescription(input) {
  let text = String(input || "").trim();
  let source = "pasted";
  if (looksLikeUrl(text)) {
    source = text;
    addTimeline("Reading the job posting link");
    text = await fetchJobDescription(text);
  }
  const titleMatch = text.match(/(?:job title|position|role)\s*[:\-]\s*([^\n]{3,100})/i);
  const pageTitle = snapshot?.title?.replace(/\s*[|\-].*$/, "").trim();
  session.jobDescription = {
    provided: true,
    source,
    text: text.slice(0, 20000),
    title: titleMatch?.[1]?.trim() || (session.intent === "job_application" ? pageTitle : null)
  };
  session.lastQuestionKey = null;
  await persistSession();
  addMessage(`Got it. I saved the job description${session.jobDescription.title ? ` for ${session.jobDescription.title}` : ""}. I will not ask for it again.`);
  await advanceConversation();
}

function applyNaturalProfileUpdates(text) {
  const patterns = [
    ["fullName", /\b(?:my name is|i am called)\s+([^,.\n]{2,80})/i],
    ["email", /\b(?:my email is|email[: ]+)\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i],
    ["phone", /\b(?:my phone(?: number)? is|phone[: ]+)\s*([+\d][\d ().-]{7,})/i],
    ["linkedin", /(https?:\/\/(?:www\.)?linkedin\.com\/[^\s]+)/i],
    ["country", /\b(?:i live in|my country is)\s+([^,.\n]{2,60})/i],
    ["city", /\b(?:my city is|i am based in)\s+([^,.\n]{2,60})/i]
  ];
  const updates = {};
  for (const [key, pattern] of patterns) {
    const match = String(text).match(pattern);
    if (match?.[1]) updates[key] = match[1].trim();
  }
  return updates;
}

async function callControllerModel(payload) {
  const system = "You are Keel's conversation controller. Return strict JSON only with keys profileUpdates, jobDescriptionText, action, and reply. action must be one of start, preview, undo, tailor_resume, wait, answer, none. The supplied state is authoritative. Never ask for a slot marked present. A natural affirmation means start when phase is awaiting_start. Be concise, factual, human, and never use em dashes.";
  const response = await fetch(`${API_ORIGIN}/proxy/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Id": APP_ID },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(payload) }],
      max_tokens: 800,
      temperature: 0.1,
      stream: false,
      response_format: { type: "json_object" }
    })
  });
  if (!response.ok) return null;
  const data = await response.json();
  return parseLooseJson(data.choices?.[0]?.message?.content);
}

async function interpretWithModel(text) {
  const payload = {
    message: String(text).slice(0, 5000),
    state: {
      phase: session.phase,
      intent: session.intent,
      resume: { uploaded: session.resume.uploaded, parsed: session.resume.parsed, summary: session.resume.summary },
      jobDescription: { provided: session.jobDescription.provided, source: session.jobDescription.source, title: session.jobDescription.title },
      openQuestionsDrafted: session.openQuestionsDrafted,
      approvalToProceed: session.approvalToProceed,
      page: session.page
    },
    history: session.history.slice(-12)
  };
  const result = await assist("conversation_controller", {
    ...payload,
    instruction: "Return JSON only. Extract profileUpdates, jobDescriptionText, and one action from start, preview, undo, tailor_resume, wait, answer, none. Never request a slot already marked present. Treat natural affirmations as start when phase is awaiting_start. Never use em dashes."
  }, { timeoutMs: 45000 });
  return result?.json || parseLooseJson(result?.text) || await callControllerModel(payload);
}

async function applyProfileUpdates(updates) {
  let changed = false;
  for (const [key, value] of Object.entries(updates || {})) {
    if (value == null || String(value).trim() === "") continue;
    setProfileValue(profile, key, value);
    changed = true;
  }
  if (changed) await saveProfile(profile);
  return changed;
}

function matchProfileValue(field, flat) {
  const meta = inputKey(`${field.label} ${field.meta} ${field.autocomplete}`);
  const rules = [
    ["firstName", /\b(first name|given name|given-name)\b/],
    ["lastName", /\b(last name|family name|surname|family-name)\b/],
    ["fullName", /\b(full name|your name|legal name|name)\b/],
    ["email", /\b(email|e mail)\b/],
    ["phone", /\b(phone|mobile|telephone|tel)\b/],
    ["addressLine1", /\b(street|address line 1|address-line1|home address)\b/],
    ["addressLine2", /\b(address line 2|apartment|suite|unit)\b/],
    ["city", /\b(city|town|address-level2)\b/],
    ["state", /\b(state|province|region|address-level1)\b/],
    ["postalCode", /\b(postal|zip|postcode|postal-code)\b/],
    ["country", /\b(country|country-name)\b/],
    ["linkedin", /\blinkedin\b/],
    ["github", /\bgithub\b/],
    ["portfolio", /\b(portfolio|personal website)\b/],
    ["company", /\b(current company|employer|company)\b/],
    ["jobTitle", /\b(current title|job title|current role)\b/]
  ];
  for (const [key, regex] of rules) if (regex.test(meta) && flat[key]) return { value: flat[key], key };
  return null;
}

function optionValue(field, wanted) {
  if (!field.options?.length || wanted == null) return String(wanted || "");
  const target = inputKey(wanted);
  let best = field.options.find((option) => inputKey(option) === target);
  if (!best) best = field.options.find((option) => inputKey(option).includes(target) || target.includes(inputKey(option)));
  return best || "";
}

async function draftField(field, flat) {
  if (field.currentValue) return null;
  if (field.type === "password" || field.isOtp) return { field, value: "", confidence: "low", source: "Your input", selected: false, protected: true };
  if (field.type === "file") {
    if (documents.resume) return { field, value: documents.resume.name, confidence: "high", source: "Saved resume", selected: true, file: documents.resume };
    return { field, value: "", confidence: "low", source: "File needed", selected: false };
  }
  const known = matchProfileValue(field, flat);
  if (known) return { field, value: optionValue(field, known.value), confidence: "high", source: "Profile", selected: true, profileKey: known.key };
  const learned = lookupAnswer(profile, field.label, snapshot?.host);
  if (learned) return { field, value: optionValue(field, learned.value), confidence: learned.fuzzy ? "medium" : "high", source: learned.scope === "site" ? "This site" : "Learned", selected: true };
  const meta = inputKey(`${field.label} ${field.meta}`);
  if (field.type === "textarea" || /\b(why|describe|tell us|cover letter|motivation|experience|interested|anything else)\b/.test(meta)) {
    const answer = await answerOpenQuestion({
      question: field.label,
      resumeText: session.resume.text || documents.resume?.text || "",
      jobDescription: session.jobDescription.text || snapshot?.bodyTextSample || "",
      profileSummary: profileSummaryText(profile),
      maxLength: field.maxLength
    });
    if (answer) return { field, value: answer.slice(0, field.maxLength || 5000), confidence: "medium", source: "Drafted from resume", selected: true };
  }
  if (field.type === "checkbox") {
    const isConsent = /\b(terms|privacy|consent|agree|certify)\b/.test(meta);
    return { field, value: isConsent ? "No" : "No", confidence: "low", source: "Confirm", selected: false };
  }
  if (field.type === "radio" || field.type === "select") return { field, value: "", confidence: "low", source: "Choose", selected: false };
  return { field, value: "", confidence: "low", source: "Needed", selected: false };
}

function controlForPlanItem(item) {
  let control;
  if (item.field.type === "radio" || item.field.type === "select" || item.field.type === "checkbox") {
    control = document.createElement("select");
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "Choose an answer";
    control.append(empty);
    const options = item.field.type === "checkbox" ? ["Yes", "No"] : item.field.options;
    for (const option of options || []) {
      const node = document.createElement("option");
      node.value = option;
      node.textContent = option;
      control.append(node);
    }
    control.value = item.value || "";
  } else if (item.field.type === "textarea") {
    control = document.createElement("textarea");
    control.value = item.value || "";
  } else {
    control = document.createElement("input");
    control.type = "text";
    control.value = item.value || "";
    if (item.field.type === "file" || item.protected) control.readOnly = true;
  }
  control.addEventListener("input", () => {
    item.value = control.value;
    if (control.value && !item.protected) item.selected = true;
    item.checkbox.checked = item.selected;
    item.row.classList.toggle("excluded", !item.selected);
  });
  return control;
}

function renderPlan(plan) {
  const { card, body } = addCard("Review every field before Keel fills it", "PREVIEW");
  const note = document.createElement("p");
  note.className = "card-note";
  note.textContent = "Green is from your profile, amber is drafted, and red needs you. Nothing is submitted.";
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
    const conf = document.createElement("span");
    conf.className = `conf ${item.confidence}`;
    const name = document.createElement("span");
    name.textContent = item.field.label;
    const source = document.createElement("span");
    source.className = "row-source";
    source.textContent = item.source;
    label.append(conf, name, source);
    const control = controlForPlanItem(item);
    item.control = control;
    row.append(check, label, control);
    body.append(row);
  }
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const fill = document.createElement("button");
  fill.type = "button";
  fill.className = "primary";
  fill.textContent = "Fill approved fields";
  fill.addEventListener("click", async () => {
    fill.disabled = true;
    try { await applyPlan(plan); card.remove(); }
    catch (error) { addMessage(error.message, "keel", "warning"); fill.disabled = false; }
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary";
  cancel.textContent = "Not yet";
  cancel.addEventListener("click", () => { session.phase = "awaiting_start"; persistSession(); card.remove(); });
  actions.append(fill, cancel);
  card.append(actions);
}

async function preparePlan() {
  busy = true;
  session.approvalToProceed = true;
  session.phase = "drafting";
  session.lastQuestionKey = null;
  await persistSession();
  addTimeline("Scanning the active tab and drafting answers");
  try {
    const page = await refreshContext();
    if (!page) throw new Error("I cannot scan the active tab yet. Refresh the page once and try again.");
    const operationTabId = activeTabId;
    const response = await sendToPage({ type: "KEEL_SCAN" }, operationTabId);
    if (!response?.ok) throw new Error("The page scan failed.");
    const flat = flatProfile(profile);
    const items = [];
    for (const field of response.fields || []) {
      const item = await draftField(field, flat);
      if (item) items.push(item);
    }
    if (!items.length) {
      session.phase = "ready";
      addMessage("I did not find any empty fields on the active page.");
      await persistSession();
      return;
    }
    session.openQuestionsDrafted = items.some((item) => item.field.type === "textarea" && item.value);
    session.phase = "preview";
    currentPlan = { items, buttons: response.buttons || [], captchaPresent: response.captchaPresent, tabId: operationTabId };
    renderPlan(currentPlan);
    await persistSession();
    await notify("Keel preview is ready", `Review ${items.length} drafted fields before filling.`);
  } finally {
    busy = false;
  }
}

async function applyPlan(plan) {
  const chosen = plan.items.filter((item) => item.selected && String(item.value || "").trim());
  if (!chosen.length) throw new Error("Choose at least one field to fill.");
  const regular = chosen.filter((item) => item.field.type !== "file").map((item) => ({ fieldId: item.field.id, value: item.value }));
  const files = chosen.filter((item) => item.field.type === "file" && item.file);
  let undoId = null;
  let successes = 0;
  if (regular.length) {
    const result = await sendToPage({ type: "KEEL_APPLY", actions: regular }, plan.tabId);
    if (!result?.ok) throw new Error("The page rejected the fill operation.");
    undoId = result.undoId;
    for (const row of result.results || []) {
      if (row.ok) successes += 1;
      else addMessage(`${row.label || "A field"}: ${row.error}`, "keel", "warning");
    }
  }
  for (const item of files) {
    const result = await sendToPage({ type: "KEEL_ATTACH_FILE", fieldId: item.field.id, file: { name: item.file.name, mime: item.file.mime, dataBase64: item.file.dataBase64 } }, plan.tabId);
    if (result?.ok) successes += 1;
    else addMessage(result?.error || `Could not attach ${item.file.name}.`, "keel", "warning");
  }
  for (const item of chosen) {
    if (item.profileKey) setProfileValue(profile, item.profileKey, item.value);
    rememberAnswer(profile, item.field.label, item.value, snapshot?.host);
  }
  await saveProfile(profile);
  session.phase = "filled";
  await persistSession();
  addTimeline(`Filled ${successes} approved field${successes === 1 ? "" : "s"}`, undoId ? "Undo" : null, undoId ? undoLastFill : null);
  if (plan.captchaPresent) addMessage("A verification check is waiting on the page. Complete it yourself, then come back here.", "keel", "warning");
  const protectedItems = plan.items.filter((item) => item.protected);
  if (protectedItems.length) addMessage(`Your turn for: ${protectedItems.map((item) => item.field.label).join(", ")}. I do not guess passwords or verification codes.`);
  renderSubmitPreview(plan.buttons, plan.tabId);
  await notify("Keel finished filling", `${successes} fields are filled. Submission is still waiting for you.`);
}

async function undoLastFill() {
  try {
    const result = await sendToPage({ type: "KEEL_UNDO" }, currentPlan?.tabId || null);
    addMessage(result?.ok ? `Restored ${result.restored.length} field${result.restored.length === 1 ? "" : "s"}.` : result?.error || "There is nothing to undo.");
  } catch (error) {
    addMessage(error.message, "keel", "warning");
  }
}

function renderSubmitPreview(buttons = [], tabId = null) {
  const commit = buttons.find((button) => button.commits);
  if (!commit) {
    addMessage("The fields are filled. I did not find a final submit button, so review the page and continue when ready.");
    return;
  }
  const { card, body } = addCard("Final action stays with you", "SUBMIT PREVIEW");
  const note = document.createElement("p");
  note.className = "card-note";
  note.textContent = `Keel has not clicked “${commit.text || "Submit"}”. Review the page first.`;
  body.append(note);
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "danger";
  button.textContent = `Click ${commit.text || "Submit"}`;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const result = await sendToPage({ type: "KEEL_CLICK", fieldId: commit.id }, tabId);
      if (!result?.ok) throw new Error(result?.error || "The page rejected the click.");
      addTimeline(`Clicked ${result.label}. This happened only after your approval.`);
      card.remove();
    } catch (error) {
      addMessage(error.message, "keel", "warning");
      button.disabled = false;
    }
  });
  actions.append(button);
  card.append(actions);
}

async function makeTailoredResume() {
  if (!session.resume.parsed || !session.jobDescription.provided) {
    await advanceConversation();
    return;
  }
  addTimeline("Drafting a tailored resume from verified source material");
  const text = await tailorResume({
    resumeText: session.resume.text,
    jobDescription: session.jobDescription.text,
    profileSummary: profileSummaryText(profile)
  });
  if (!text) throw new Error("I could not draft the tailored resume right now. Your original resume is still saved.");
  const name = `${(session.resume.summary?.name || "resume").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}-tailored.pdf`;
  const doc = await saveDocument("tailoredResume", { name, mime: "application/pdf", dataBase64: makeResumePdfBase64("Tailored resume", text), text });
  documents.tailoredResume = doc;
  const { body } = addCard("Tailored resume draft", "DOCUMENT PREVIEW");
  const preview = document.createElement("div");
  preview.className = "doc-preview";
  preview.textContent = text;
  body.append(preview);
  addMessage("I saved this as a real PDF. It only rewords facts from your original resume and does not invent experience.");
}

async function handleUserMessage(rawText) {
  const text = String(rawText || "").trim();
  if (!text || busy) return;
  const key = inputKey(text);
  if (session.processedInputs.includes(key)) return;
  session.processedInputs.push(key);
  if (session.processedInputs.length > 100) session.processedInputs = session.processedInputs.slice(-100);
  addMessage(text, "user");
  await persistSession();
  busy = true;
  try {
    if (/\bundo\b/i.test(text)) { await undoLastFill(); return; }
    if (isNegative(text)) { session.approvalToProceed = false; session.phase = "waiting"; session.lastQuestionKey = null; addMessage("Okay. I will wait. Tell me when you want to continue."); await persistSession(); return; }

    const localUpdates = applyNaturalProfileUpdates(text);
    const model = await interpretWithModel(text);
    await applyProfileUpdates({ ...localUpdates, ...(model?.profileUpdates || {}) });

    const modelJobText = model?.jobDescriptionText;
    if (modelJobText && !session.jobDescription.provided) { await storeJobDescription(modelJobText); return; }
    if (looksLikeUrl(text) || (looksLikeJobDescription(text) && !isAffirmative(text))) { await storeJobDescription(text); return; }

    const action = model?.action || "none";
    if (/\b(tailor|rewrite|customize)\b.*\b(resume|cv)\b/i.test(text) || action === "tailor_resume") { await makeTailoredResume(); return; }
    if (isAffirmative(text) || action === "start" || action === "preview") {
      const missing = missingSlots();
      if (missing.length) { await advanceConversation(); return; }
      await preparePlan();
      return;
    }

    if (Object.keys(localUpdates).length || Object.keys(model?.profileUpdates || {}).length) {
      addMessage("Saved to your reusable profile. I will use it on this form and future forms.");
      await advanceConversation();
      return;
    }

    if (/\b(i already told you|stop asking|do not ask again|don't ask again)\b/i.test(text)) {
      const missing = missingSlots();
      if (!missing.length) {
        addMessage(`${readinessSummary()}. I will move straight to the preview.`);
        await preparePlan();
      } else {
        await advanceConversation();
      }
      return;
    }

    if (model?.reply) addMessage(model.reply);
    else await advanceConversation();
  } catch (error) {
    addMessage(error.message || "Something went wrong. I kept your saved information and did not change the page.", "keel", "warning");
    await notify("Keel needs you", error.message || "Open Keel to continue.");
  } finally {
    busy = false;
    await persistSession();
  }
}

async function handleFile(file) {
  if (!file || busy) return;
  busy = true;
  addMessage(`Uploaded ${file.name}`, "user");
  addTimeline("Reading the resume contents");
  try {
    await ingestResume(file);
  } catch (error) {
    session.resume = { uploaded: true, parsed: false, fileName: file.name, summary: null, text: null, error: error.message };
    await persistSession();
    addMessage(`I could not parse ${file.name}: ${error.message}`, "keel", "warning");
    await notify("Keel could not read the resume", error.message);
  } finally {
    busy = false;
    fileInput.value = "";
  }
}

function autoGrow() {
  composer.style.height = "auto";
  composer.style.height = `${Math.min(composer.scrollHeight, 120)}px`;
}

sendButton.addEventListener("click", () => {
  const text = composer.value;
  composer.value = "";
  autoGrow();
  handleUserMessage(text);
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

const voice = new VoiceInput({
  onPartial: (text) => { composer.value = text; autoGrow(); },
  onFinal: (text) => { composer.value = ""; autoGrow(); handleUserMessage(text); },
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

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  activeTabId = tabId;
  snapshot = null;
  if (!busy) await refreshContext();
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (tabId !== activeTabId || !changeInfo.url) return;
  snapshot = null;
  await refreshContext();
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "KEEL_EVENT") return;
  if (message.kind === "fields_changed") {
    addTimeline("The page changed. Keel will rescan the active tab before the next action.");
    snapshot = null;
  }
});

async function init() {
  const stored = await chrome.storage.local.get([SESSION_KEY, WALKAWAY_KEY]);
  session = stored[SESSION_KEY]?.version === 3 ? { ...freshSession(), ...stored[SESSION_KEY] } : freshSession();
  session.resume = { ...freshSession().resume, ...(session.resume || {}) };
  session.jobDescription = { ...freshSession().jobDescription, ...(session.jobDescription || {}) };
  session.history = Array.isArray(session.history) ? session.history : [];
  session.processedInputs = Array.isArray(session.processedInputs) ? session.processedInputs : [];
  walkawayToggle.checked = Boolean(stored[WALKAWAY_KEY]);
  [profile, documents] = await Promise.all([loadProfile(), loadDocuments()]);
  if (documents.resume?.text && !session.resume.parsed) {
    session.resume = { uploaded: true, parsed: true, fileName: documents.resume.name, summary: documents.resume.summary || fallbackResumeFacts(documents.resume.text), text: documents.resume.text, error: null };
  }
  renderStoredHistory();
  await refreshContext({ announce: true });
  if (!session.history.length) addMessage("Hi, I am Keel. Show me the form, share what is missing, and I will draft the work for your approval.");
  if (session.history.length <= 1 || session.phase === "discovering") await advanceConversation();
  await persistSession();
}

init().catch((error) => {
  console.error("Keel initialization failed", error);
  addMessage("Keel could not initialize. Reload the extension and try again.", "keel", "warning");
});
