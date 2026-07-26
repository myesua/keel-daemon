const profileForm = document.querySelector("#profile-form");
const intentInput = document.querySelector("#intent");
const runButton = document.querySelector("#run");
const messages = document.querySelector("#messages");
const statusBadge = document.querySelector("#status");
const saveState = document.querySelector("#save-state");
const humanTurn = document.querySelector("#human-turn");
const turnTitle = document.querySelector("#turn-title");
const turnDetail = document.querySelector("#turn-detail");
const turnAnswer = document.querySelector("#turn-answer");
const turnOptions = document.querySelector("#turn-options");
const answerButton = document.querySelector("#answer");
const continueButton = document.querySelector("#continue");
const skipButton = document.querySelector("#skip");

let activeTabId = null;
let pendingRequest = null;
let saveTimer = null;

function addMessage(text, tone = "keel") {
  const message = document.createElement("div");
  message.className = `message ${tone}`;
  message.textContent = text;
  messages.append(message);
  messages.scrollTop = messages.scrollHeight;
}

function setStatus(text, running = false) {
  statusBadge.textContent = text;
  statusBadge.classList.toggle("running", running);
}

function getProfile() {
  const values = Object.fromEntries(new FormData(profileForm).entries());
  if (!values.fullName) {
    values.fullName = [values.firstName, values.lastName].filter(Boolean).join(" ");
  }
  return values;
}

async function saveProfile(showConfirmation = false) {
  await chrome.storage.local.set({ profile: getProfile() });
  saveState.textContent = showConfirmation ? "Saved" : "Saved locally";
  if (showConfirmation) setTimeout(() => { saveState.textContent = "Saved locally"; }, 1200);
}

async function loadProfile() {
  const { profile = {} } = await chrome.storage.local.get("profile");
  for (const [key, value] of Object.entries(profile)) {
    const field = profileForm.elements.namedItem(key);
    if (field) field.value = value || "";
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active browser tab was found.");
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: "KEEL_PING" });
    if (reply?.ok) return;
  } catch (_) {
    // The page may have been open before installation; inject below.
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  const reply = await chrome.tabs.sendMessage(tabId, { type: "KEEL_PING" });
  if (!reply?.ok) throw new Error("Keel could not connect to this page.");
}

function resetHumanTurn() {
  pendingRequest = null;
  humanTurn.hidden = true;
  turnAnswer.value = "";
  turnAnswer.removeAttribute("list");
  turnOptions.replaceChildren();
}

function showHumanTurn(event) {
  pendingRequest = event;
  humanTurn.hidden = false;
  turnTitle.textContent = event.title || "Keel needs your help";
  turnDetail.textContent = event.detail || "";

  const isQuestion = event.kind === "ask";
  turnAnswer.hidden = !isQuestion;
  answerButton.hidden = !isQuestion;
  continueButton.hidden = isQuestion;
  skipButton.hidden = !event.optional;

  if (isQuestion) {
    const options = event.options || [];
    turnOptions.replaceChildren(...options.map((option) => {
      const item = document.createElement("option");
      item.value = option;
      return item;
    }));
    if (options.length) turnAnswer.setAttribute("list", "turn-options");
    turnAnswer.placeholder = options.length ? "Choose or type an answer" : "Type the exact answer";
    turnAnswer.focus();
  }
  setStatus("Your turn", true);
}

async function replyToRun(action, value = "") {
  if (!pendingRequest || !activeTabId) return;
  const request = pendingRequest;
  await chrome.tabs.sendMessage(activeTabId, {
    type: "KEEL_REPLY",
    requestId: request.requestId,
    action,
    value
  });
  addMessage(
    action === "skip" ? `Skipped optional field: ${request.title}` :
    request.kind === "pause" ? "Done — continue." : value,
    "user"
  );
  resetHumanTurn();
  setStatus("Running", true);
}

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveProfile(true);
});

profileForm.addEventListener("input", () => {
  saveState.textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveProfile(false), 350);
});

runButton.addEventListener("click", async () => {
  const intent = intentInput.value.trim();
  if (!intent) {
    intentInput.focus();
    addMessage("Tell me what you want to do on this page first.", "warning");
    return;
  }

  runButton.disabled = true;
  resetHumanTurn();
  setStatus("Connecting", true);
  addMessage(intent, "user");

  try {
    await saveProfile(false);
    const tab = await getActiveTab();
    activeTabId = tab.id;
    await ensureContentScript(tab.id);
    const reply = await chrome.tabs.sendMessage(tab.id, {
      type: "KEEL_START",
      intent,
      profile: getProfile()
    });
    if (!reply?.ok) throw new Error(reply?.error || "The page did not start the run.");
    addMessage("I’m reading the visible form in page order. I’ll highlight each target before I act.");
    setStatus("Running", true);
  } catch (error) {
    const restricted = /Cannot access|chrome:\/\/|edge:\/\/|extensions page/i.test(error.message || "");
    addMessage(
      restricted
        ? "Chrome blocks extensions on this page. Open the actual job application page (http, https, or an allowed file URL) and try again."
        : `I couldn’t start: ${error.message}`,
      "warning"
    );
    setStatus("Ready");
    runButton.disabled = false;
  }
});

answerButton.addEventListener("click", async () => {
  const value = turnAnswer.value.trim();
  if (!value) {
    turnAnswer.focus();
    return;
  }
  await replyToRun("answer", value);
});

turnAnswer.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    answerButton.click();
  }
});

continueButton.addEventListener("click", () => replyToRun("continue"));
skipButton.addEventListener("click", () => replyToRun("skip"));

document.querySelector("#clear-chat").addEventListener("click", () => {
  messages.replaceChildren();
  addMessage("Ready when you are. Open a job application, then tell me to apply.");
});

chrome.runtime.onMessage.addListener((event) => {
  if (event?.type !== "KEEL_EVENT") return;
  if (activeTabId && event.tabId && event.tabId !== activeTabId) return;

  if (event.kind === "progress") addMessage(event.message);
  if (event.kind === "ask" || event.kind === "pause") {
    addMessage(event.message, "warning");
    showHumanTurn(event);
  }
  if (event.kind === "done") {
    addMessage(event.message, "keel success");
    resetHumanTurn();
    setStatus("Ready");
    runButton.disabled = false;
  }
  if (event.kind === "error") {
    addMessage(event.message, "warning");
    resetHumanTurn();
    setStatus("Ready");
    runButton.disabled = false;
  }
});

(async function init() {
  await loadProfile();
  const { lastIntent } = await chrome.storage.local.get("lastIntent");
  intentInput.value = lastIntent || "Apply to this job";
  intentInput.addEventListener("input", () => chrome.storage.local.set({ lastIntent: intentInput.value }));
  addMessage("Open a job application and say “Apply to this job.” I’ll fill what I know, show every move, and stop whenever you need to take over.");
})();
