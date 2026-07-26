// Assist client. Keel's language brain lives in an Audos workspace hook so the
// extension ships with zero API keys. Every call degrades gracefully: when the
// hook is unreachable the caller falls back to heuristics or asks the user.

const ASSIST_URL = "https://audos.com/api/workspaces/387488/hooks/keel-assist/execute";

// House style: generated text must never contain em-dashes and should read
// like a person wrote it.
export function humanizeText(text) {
  if (!text) return "";
  return String(text)
    .replace(/\s*\u2014\s*/g, ", ")
    .replace(/\s*\u2013\s*/g, " to ")
    .replace(/,\s*,/g, ",")
    .replace(/ {2,}/g, " ");
}

export async function assist(task, payload = {}, { timeoutMs = 45000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(ASSIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, ...payload }),
      signal: controller.signal
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || data.ok === false) return null;
    if (typeof data.text === "string") data.text = humanizeText(data.text);
    return data;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Lenient JSON extraction for model replies that wrap JSON in prose or fences.
export function parseLooseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const match = String(text).match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (_) { return null; }
}
