// Job application module. This is the beachhead surface: one fully worked
// it's-me-again task built ON TOP of the generic engine and profile. Nothing
// in here is required for signups, checkouts, or other surfaces.

import { assist, humanizeText } from "./assist.js";

// Pull readable text out of a job posting URL. Extension pages may fetch any
// host we hold permissions for, so no server round trip is needed.
export async function fetchJobDescription(url) {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) throw new Error(`The page answered with status ${response.status}.`);
  const html = await response.text();
  const container = document.implementation.createHTMLDocument("jd");
  container.documentElement.innerHTML = html;
  container.querySelectorAll("script, style, noscript, svg, nav, footer, header").forEach((n) => n.remove());
  const text = (container.body?.textContent || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length < 200) throw new Error("The page did not contain readable text. Paste the job description instead.");
  return text.slice(0, 16000);
}

export async function tailorResume({ resumeText, jobDescription, profileSummary }) {
  const result = await assist("tailor_resume", {
    resumeText: String(resumeText || "").slice(0, 20000),
    jobDescription: String(jobDescription || "").slice(0, 12000),
    profileSummary: String(profileSummary || "").slice(0, 4000)
  }, { timeoutMs: 90000 });
  if (!result?.text) return null;
  return humanizeText(result.text);
}

export async function answerOpenQuestion({ question, resumeText, jobDescription, profileSummary, maxLength }) {
  const result = await assist("answer_question", {
    question: String(question || "").slice(0, 1000),
    resumeText: String(resumeText || "").slice(0, 16000),
    jobDescription: String(jobDescription || "").slice(0, 8000),
    profileSummary: String(profileSummary || "").slice(0, 4000),
    maxLength: maxLength || null
  }, { timeoutMs: 60000 });
  if (!result?.text) return null;
  return humanizeText(result.text);
}

// ---------------------------------------------------------------------------
// Minimal PDF writer. Produces a clean, ATS-friendly single-column text PDF
// with no dependencies, so a tailored resume can be attached to real file
// inputs as an actual document.
// ---------------------------------------------------------------------------
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const BODY_SIZE = 10;
const LEADING = 14;
const TITLE_SIZE = 16;

function toLatin1(text) {
  return String(text)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2022\u25CF\u25AA]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\x20-\x7E\n]/g, "?");
}

function escapePdfText(text) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapLine(line, maxChars) {
  if (line.length <= maxChars) return [line];
  const words = line.split(" ");
  const out = [];
  let current = "";
  for (const word of words) {
    if (!current.length) { current = word; continue; }
    if (current.length + 1 + word.length <= maxChars) current += ` ${word}`;
    else { out.push(current); current = word; }
  }
  if (current) out.push(current);
  return out;
}

export function makeResumePdfBase64(title, bodyText) {
  const maxChars = 96;
  const usableHeight = PAGE_HEIGHT - MARGIN * 2;
  const linesPerPage = Math.floor((usableHeight - TITLE_SIZE - 10) / LEADING);

  const rawLines = toLatin1(bodyText).split("\n");
  const lines = [];
  for (const raw of rawLines) {
    const trimmed = raw.replace(/\s+$/g, "");
    if (!trimmed) { lines.push(""); continue; }
    lines.push(...wrapLine(trimmed, maxChars));
  }

  const pages = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage));
  }
  if (!pages.length) pages.push([""]);

  const objects = [];
  const addObject = (body) => { objects.push(body); return objects.length; };

  const fontRegular = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const fontBold = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");

  const pageObjectIds = [];
  const contentObjectIds = [];
  for (let p = 0; p < pages.length; p += 1) {
    let stream = "BT\n";
    let y = PAGE_HEIGHT - MARGIN;
    if (p === 0 && title) {
      stream += `/F2 ${TITLE_SIZE} Tf\n1 0 0 1 ${MARGIN} ${y - TITLE_SIZE} Tm\n(${escapePdfText(toLatin1(title))}) Tj\n`;
      y -= TITLE_SIZE + 10;
    }
    stream += `/F1 ${BODY_SIZE} Tf\n${LEADING} TL\n1 0 0 1 ${MARGIN} ${y - BODY_SIZE} Tm\n`;
    for (const line of pages[p]) {
      stream += `(${escapePdfText(line)}) Tj\nT*\n`;
    }
    stream += "ET";
    contentObjectIds.push(addObject(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
    pageObjectIds.push(null); // reserve, filled after pages node id known
  }

  const pagesNodeId = objects.length + pages.length + 1;
  for (let p = 0; p < pages.length; p += 1) {
    pageObjectIds[p] = addObject(
      `<< /Type /Page /Parent ${pagesNodeId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentObjectIds[p]} 0 R >>`
    );
  }
  const kids = pageObjectIds.map((id) => `${id} 0 R`).join(" ");
  const actualPagesNodeId = addObject(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const catalogId = addObject(`<< /Type /Catalog /Pages ${actualPagesNodeId} 0 R >>`);

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return btoa(pdf);
}
