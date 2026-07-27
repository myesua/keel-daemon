// Document intake. A resume is the one file that unlocks every other form, so
// Keel reads it for real: PDFs go through the workspace document service, DOCX
// is unzipped and parsed in Chrome, TXT is read directly. If a file cannot be
// read, Keel says exactly why and never pretends it read it.

const API_ORIGIN = "https://audos.com";
const APP_ID = "workspace-387488";

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function parseLooseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (_) { return null; }
}

function decodeXmlText(xmlText) {
  const xml = new DOMParser().parseFromString(xmlText, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("The DOCX document XML is damaged.");
  const paragraphs = [...xml.getElementsByTagNameNS("*", "p")];
  return paragraphs
    .map((paragraph) => [...paragraph.getElementsByTagNameNS("*", "t")].map((node) => node.textContent || "").join(""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

export async function extractDocxText(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) { eocd = index; break; }
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
        if (typeof DecompressionStream !== "function") throw new Error("This Chrome version cannot decompress DOCX files. Use PDF or TXT.");
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        uncompressed = new Uint8Array(await new Response(stream).arrayBuffer());
      } else throw new Error(`This DOCX uses unsupported compression method ${method}.`);
      const text = decodeXmlText(decoder.decode(uncompressed));
      if (!text) throw new Error("The DOCX contains no readable text.");
      return text;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("This DOCX has no readable word/document.xml entry.");
}

async function uploadDocument(file, base64) {
  const response = await fetch(`${API_ORIGIN}/api/upload/image`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Id": APP_ID },
    body: JSON.stringify({ imageData: `data:${file.type || "application/pdf"};base64,${base64}`, fileName: file.name })
  });
  if (!response.ok) throw new Error(`Upload failed with status ${response.status}.`);
  const data = await response.json();
  const url = data.imageUrl || data.url;
  if (!url) throw new Error("The upload service returned no document URL.");
  return url;
}

export async function analyzePdf(file, base64) {
  const documentUrl = await uploadDocument(file, base64);
  const analysisPrompt = "Read this document accurately. Return strict JSON with keys fullText, name, mostRecentRole, skills (2 to 6 factual skills), email, phone, linkedin, company. fullText must contain the text you actually read. Do not infer anything that is not there.";
  const response = await fetch(`${API_ORIGIN}/api/analyze-document`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Id": APP_ID },
    body: JSON.stringify({ documentUrl, analysisPrompt, documentType: "pdf" })
  });
  if (!response.ok) throw new Error(`PDF analysis failed with status ${response.status}.`);
  const data = await response.json();
  const parsed = typeof data.analysis === "object" ? data.analysis : parseLooseJson(data.analysis);
  if (!parsed?.fullText || String(parsed.fullText).trim().length < 40) {
    throw new Error("No readable text was found in this PDF. If it is a scan, export it as a searchable PDF, DOCX, or TXT.");
  }
  return { text: String(parsed.fullText).trim(), facts: parsed };
}

export function fallbackFacts(text) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const email = String(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
  const phone = String(text).match(/(?:\+?\d[\d ().-]{7,}\d)/)?.[0] || "";
  const name = lines[0] && lines[0].length < 70 && !/@|resume|curriculum/i.test(lines[0]) ? lines[0] : "";
  const roleLine = lines.find((line) => /\b(engineer|developer|designer|manager|analyst|director|consultant|specialist|lead|founder|product|marketing|sales|operations)\b/i.test(line)) || "";
  const skillWords = ["JavaScript", "TypeScript", "React", "Python", "Java", "SQL", "AWS", "Azure", "Figma", "Product management", "Machine learning", "Data analysis"];
  const skills = skillWords.filter((skill) => new RegExp(`\\b${skill.replace(" ", "\\s+")}\\b`, "i").test(text)).slice(0, 5);
  return { name, mostRecentRole: roleLine.slice(0, 100), skills, email, phone };
}

// Read a resume or similar document and return { text, facts, base64, mime }.
export async function readDocument(file) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!["pdf", "docx", "txt", "md"].includes(extension)) throw new Error("Use a PDF, DOCX, or TXT file.");
  if (file.size > 32 * 1024 * 1024) throw new Error("That file is over 32 MB. Use a smaller PDF, DOCX, or TXT.");

  const buffer = await file.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  let text;
  let facts = null;

  if (extension === "pdf") {
    const analyzed = await analyzePdf(file, base64);
    text = analyzed.text;
    facts = analyzed.facts;
  } else if (extension === "docx") {
    text = await extractDocxText(buffer);
  } else {
    text = new TextDecoder("utf-8").decode(buffer).trim();
  }

  if (!text || text.length < 40) throw new Error(`The ${extension.toUpperCase()} file did not contain enough readable text.`);
  facts = { ...fallbackFacts(text), ...(facts || {}) };
  if (!Array.isArray(facts.skills)) {
    facts.skills = String(facts.skills || "").split(/,|\n/).map((item) => item.trim()).filter(Boolean);
  }
  facts.skills = facts.skills.slice(0, 6);

  const mime = file.type || (extension === "pdf"
    ? "application/pdf"
    : extension === "docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "text/plain");

  return { text, facts, base64, mime };
}
