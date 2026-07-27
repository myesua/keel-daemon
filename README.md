# Keel v0.4: the copilot that is actually looking at your screen

Keel is a screen aware, human in the loop browser copilot. You talk to it, it reads the page you are on, and it does the browser work while you watch and approve. Its beachhead is the task the web makes you repeat forever: introducing yourself. Signups, checkouts, registrations, intake forms, and job applications all ask for the same person.

## What changed in v0.4, and why

The v0.3 side panel had a hardcoded question script: ask for the resume, ask for the job description, ask permission to start, then fill. That script ran no matter what was on the page and no matter what you had already said, which is why it re-asked answered questions, ignored "yes", and drifted to whatever empty box it found. It also never looked at the page while it talked to you.

v0.4 deletes the script. Two things replace it.

**1. Perception on every turn.** Before Keel says anything, it re-reads the active tab and captures the viewport:

- The content script returns the live DOM: every visible, interactable field in document order with its label, role, options, current value, required flag, the section heading above it, which form it belongs to, whether it is on screen right now, and where it sits on the page. Forms are classified (job application, checkout, login, newsletter signup, search, cookie notice) and the one your viewport is on is marked.
- The service worker captures the visible tab with `chrome.tabs.captureVisibleTab` and the panel sends that image to the model inline with the DOM state. The screenshot is never uploaded to storage.
- Keel follows your active tab and your scroll position. Switch tabs and it re-reads the new one.
- Ask it what it can see and you get the real page: title, the section you are on, the fields actually in front of you, and the other forms it is deliberately ignoring. If a capture fails it says so instead of pretending.

**2. A model that decides, not a script.** Each turn the model gets the live page, the conversation, and everything Keel already knows about you, and it chooses one next step. There is no fixed sequence of questions. Guard rails sit around that decision, in code:

- A question that is already answered, in memory or earlier in the conversation, never reaches you. The model gets told it repeated itself and has to choose a real action instead.
- If you have just said yes, a second permission question is blocked outright.
- Fills are dropped unless they point at a field that exists, in the form you are on. Newsletter, search, and footer boxes are excluded by default.
- Passwords and one time codes are never typed by Keel.
- Everything is filled in real DOM order, top to bottom.
- Nothing is filled until you approve the preview, and nothing is submitted until you click the submit button in the review card.

Values are written by a second, focused pass over every empty field in the form you are on, which is what stops Keel filling the top of a form and abandoning the bottom.

## Other things it does

- **Memory that lasts.** Whatever you say once is stored in `chrome.storage.local` and reused this session, next session, and on other sites. The relational profile holds identity, contact details, links, work summary, learned answers, and per domain memory.
- **All field types.** Text, email, phone, URL, dropdowns, radio groups, checkboxes, and textareas. Open ended questions are drafted from your resume and the job description, in your voice, editable before anything lands.
- **Resume intake.** Upload a PDF, DOCX, or TXT once. PDFs go through the workspace document service, DOCX is unzipped and parsed in Chrome, TXT is read directly. Keel proves the parse with facts it actually read, and says exactly why if a file fails.
- **One tap undo** for every fill batch.
- **Voice input** with continuous dictation, automatic restarts, and a stall watchdog.
- **Walk away mode** with a desktop notification when Keel needs you.
- **A screen toggle.** Turn capture off and Keel works from the DOM alone and tells you that is what it is doing.
- **WebMCP progressive enhancement.** If a page exposes WebMCP tools, Keel detects them and can prefer structured tool calls over DOM actuation.

## Load it in Chrome

No build step, no package install, no API key, no daemon.

1. Clone or download this repository.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the folder that directly contains `manifest.json`. Chrome 114 or newer.
3. On the Keel card click **Details** and switch on **Allow access to file URLs** if you want to use the bundled `test-form.html`.
4. Click the Keel toolbar icon on any page to open the side panel.

A tab that was already open before you installed the extension has no content script in it. Keel injects one when it attaches, and tells you to refresh if it cannot.

## Fast, controlled test

`test-form.html` is a mock job application that exercises every field type and includes two decoys on purpose: a search box in the header and a newsletter signup in the footer. Keel should work the application form and leave both decoys alone.

1. Open `test-form.html` in Chrome and open Keel.
2. Ask **can you see my screen?** You should get your actual page back: title, the section you are on, and the real field names.
3. Paste the job description once. Tell it who you are. Say **yes** once.
4. A preview card appears with every value in page order. Edit or untick anything, then approve.
5. Watch the page fill top to bottom, then check the review card. The password is left to you, the newsletter box is untouched, and nothing is submitted until you click the submit button in that card.

## How it is put together

- `manifest.json` - MV3 permissions (`<all_urls>` is required for viewport capture), side panel, service worker, both content scripts
- `service-worker.js` - opens the side panel, captures the visible tab
- `sidepanel.html`, `sidepanel.css`, `sidepanel.js` - the thread, the "what Keel can see" strip, preview and review cards, composer, voice, uploads
- `lib/perception.js` - active tab resolution, DOM read, viewport capture, the page view the model receives
- `lib/agent.js` - the system prompt, the reasoning call, the drafting call, and the guards
- `lib/memory.js` - facts, questions, transcript, and the already-answered check
- `lib/profile.js` - the relational profile and per domain memory
- `lib/docs.js` - PDF, DOCX, and TXT intake
- `lib/jobkit.js` - job posting fetch, resume tailoring, dependency free PDF writer
- `lib/voice.js` - speech input
- `content.js` - DOM scanner with geometry, highlight overlay, apply and undo executor, WebMCP client, change watcher
- `webmcp-bridge.js` - main world probe for page exposed WebMCP tools
- `server/keel-assist.hook.js` - the workspace hook that backs the fallback brain, mirrored here for review
- `test-form.html` - local acceptance fixture

Keel ships with zero API keys. Model calls go to the workspace endpoints, which hold the keys server side. If they are unreachable, Keel degrades to describing the page from the DOM and asking you rather than guessing.

## Privacy

The viewport screenshot goes from Chrome straight to the model as an inline image for that one request. It is not uploaded to storage, not written to disk, and not kept after the turn. Turn the **Screen** toggle off and no capture happens at all. Uploaded resumes are the exception: a PDF is sent to the workspace document service to be read, which is the only way to extract its text.

## Known limits

- Cross origin iframes, closed shadow roots, and canvas rendered controls are not reachable. Keel says when it cannot see a form.
- Multi step forms work through the change watcher and a fresh read each turn, but Keel does not click Next without approval.
- Image only PDFs need to be exported as searchable PDF, DOCX, or TXT.
- Voice uses Chrome's speech service and needs a connection.
- CAPTCHA detection is best effort, and Keel never attempts to solve one.
- Broad host permissions are included for this unpacked proof of concept. A production release should add a site access onboarding flow.
