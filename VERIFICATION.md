# Keel v0.3 verification record

Date: 2026-07-27 UTC

## Root causes verified in the previous extension source

1. The conversation router in `sidepanel.js` recognized only a hardcoded command regex: `go ahead`, `do it`, `fill`, `start`, `proceed`, `make the plan`, and `draft the fields`. Plain `yes` was not recognized. It fell through to a generic `assist("chat")` call whose reply could be rendered without changing a phase or approval state. The controller had booleans in an ephemeral context but no authoritative phase, answered-slot registry, idempotency key, or approval transition. This is why an affirmation could produce the same prompt again.
2. Job onboarding independently emitted resume and job-description prompts whenever it ran. There was no ask-once key tied to slot state.
3. Upload handling classified only TXT/Markdown as readable. PDF and DOCX files were stored as base64 with an empty `text` value, followed by the literal message that Keel could not read the file and the user must paste its text.
4. The page actuator already supported text, radio, select, checkbox, file attachment, undo, and commit-button detection. The failure to act was in the conversation router: `yes` never dispatched `proposePlan()`.

## Changes in this draft

- Replaced the old command/chat router with an explicit persisted v3 session: parsed resume, job description and source, open-question drafting, approval, current phase, ask-once key, processed-input idempotency, page, and history.
- Added an LLM conversation-controller call with authoritative state and a direct platform LLM fallback. Local safety gates still reject requests for slots that are already present.
- Added natural affirmation and directive handling. `yes`, `yeah`, `go ahead`, `start`, `do it`, `move on`, and `stop asking` advance instead of repeating a question.
- Added real PDF analysis through the workspace document-analysis endpoint, native DOCX ZIP/XML extraction in Chrome, and direct TXT extraction. Parse success is proved with factual name, recent-role, and skill details. Parsed text and facts are saved both in the reusable relational profile and the document store.
- Kept preview-before-fill, per-field confidence, editable values, one-tap undo, and explicit final-submit approval. Each operation is pinned to the tab that was active when scanning so walk-away work does not jump to another tab.

## Browser evidence produced

### PDF extraction

A real generated PDF containing:

```text
Ada Okoye
Senior Software Engineer at Northwind Labs
Skills: React, TypeScript, Python
Built accessible web applications and led frontend delivery.
ada.okoye@example.com
```

was uploaded to the production document endpoint and analyzed. Upload status: `200`. Analysis status: `200`. Returned facts:

```json
{
  "name": "Ada Okoye",
  "mostRecentRole": "Senior Software Engineer at Northwind Labs",
  "skills": ["React", "TypeScript", "Python"]
}
```

### Conversation-controller transcript

State before turn: resume parsed, job description provided for Senior Engineer, phase `awaiting_start`.

```text
Keel: I have your resume and the job description for Senior Engineer. Ready for me to draft every field and show you a preview?
User: yes
Controller: { "action": "start", "reply": "" }
```

The same live controller returned `action: "start"` for `go ahead` and `I already told you, stop asking and start`. It did not request the job description again.

### Live DOM form execution

The real browser fixture detected text, email, telephone, URL, select, radio, checkbox, textarea, file, and password fields. It applied and read back:

```json
{
  "text": "Ada",
  "select": "Nigeria",
  "radio": "no",
  "checkbox": true,
  "textarea": "I want to build accessible products with a strong engineering team.",
  "submitWasClicked": false
}
```

The scanner separately identified `Submit application` as a committing action. It was not clicked. Browser console: `0` errors and `0` warnings.

## Remaining external acceptance step

The Audos bridge can edit this workspace draft but cannot check out or push `myesua/keel-daemon`, and the browser runner cannot load an unpacked extension directly from unpublished Audos source. Therefore the final integrated unpacked-extension run, captured side-panel transcript, Git commit, push to the `extension` branch, commit SHA, and Download ZIP link still require a repository-connected run. The evidence above covers the live platform PDF path, live LLM transition, and live DOM actuator, but it must not be represented as the unavailable full extension end-to-end run.
