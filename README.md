# Keel v0.2: the "it's me again" copilot

Keel is a voice-first, screen-aware, human-in-the-loop browser copilot. Its job is the task the web makes you repeat forever: introducing yourself. Signups, checkouts, registrations, intake forms, and job applications all ask for the same person. Keel reads the page you are on, figures out which of those tasks it is, drafts every field from what it knows about you, and shows you everything for approval before anything touches the page. It never submits on its own.

The engine is surface-agnostic. Job applications are the first surface built end to end (resume intake, tailored resumes, open-question answers), but the same profile and the same engine fill a checkout or a signup just as well.

## What's in v0.2

- **Chat-only interface.** One thread: type, talk, or drop a file. Plans, previews, questions, and the action timeline all live inline in the same conversation.
- **Proactive intent detection.** On attach, Keel reads the active tab and guesses the task ("this looks like a checkout"). It follows your active tab as you switch, and you can correct it in one tap or one sentence; corrections are remembered per site.
- **A relational profile, not a job-application form.** Identity, contact details, links, work summary, durable preferences, learned answers, and per-domain memory, all in `chrome.storage.local`. Every answer you approve or correct makes the next form faster, on any site.
- **All field types.** Text, email, phone, dropdowns, radio groups, and checkboxes are recognized and filled. File inputs get your saved documents attached (with your approval). Passwords, CAPTCHAs, and one-time codes are always handed back to you.
- **Preview everything.** Every value appears in a plan card with a per-field confidence dot (green, amber, red) and stays editable until you approve it. Submit-style buttons are only ever clicked with your explicit approval.
- **One-tap undo.** Every fill batch gets an Undo button in the timeline that restores the previous values.
- **Voice input built for reliability.** Continuous dictation with automatic restarts, a stall watchdog, and a transcript buffer that survives network hiccups.
- **Job application module.** Upload your resume once (Keel learns your profile from it), share a job posting link or paste the description, ask for a tailored resume (honest rewording only, exported as a real PDF), and let Keel draft answers to open-ended questions in your voice.
- **Walk-away mode.** Flip the toggle and Keel keeps working through what it is confident about, drafts the rest, and sends a desktop notification when it is done or needs you. It still never submits without approval.
- **WebMCP progressive enhancement.** If the page exposes WebMCP tools, Keel detects them and prefers structured tool calls over raw DOM actuation. No WebMCP, no problem: the DOM engine is the default path.

## Load it in Chrome

There is no build step, package install, API key, daemon, debug port, or connection step. Chrome loads the extension straight from these files.

### 1. Get the files onto your computer

Either clone the repository:

```bash
git clone https://github.com/myesua/keel-extension.git
```

...or download the ZIP: on the repository page click the green **Code** button, then **Download ZIP**.

**ZIP gotcha:** unzipping a GitHub download produces a wrapper folder named `keel-extension-main`. The folder you point Chrome at is the one that directly contains `manifest.json` (that is the unzipped `keel-extension-main` folder itself, not its parent and not a subfolder). If you open a folder and see `manifest.json`, `content.js`, and `sidepanel.html` sitting there, you are in the right place.

### 2. Load it as an unpacked extension

1. Open Chrome and go to `chrome://extensions` (type it into the address bar).
2. Turn on **Developer mode** with the toggle in the top-right corner.
3. Click **Load unpacked** (top-left).
4. Select the folder containing `manifest.json` and confirm. Select the folder itself, not the file.
5. A **Keel: Browser Copilot** card appears. Requires Chrome 114 or newer.
6. Recommended: click the puzzle-piece Extensions icon in the toolbar and pin Keel.

### 3. Turn on file-URL access (needed for the bundled test form)

1. On `chrome://extensions`, click **Details** on the Keel card.
2. Switch on **Allow access to file URLs**.

### 4. Open it

Click the Keel toolbar icon on any normal page to open the side panel. The first time you use the mic, Chrome will ask for microphone permission.

**Important:** a tab that was already open before you installed the extension has no content script in it. Keel injects one automatically when it attaches, but if it reports it cannot see the page, refresh that tab once.

### Updating after a code change

Pull or re-download the files, then return to `chrome://extensions` and click the circular reload arrow on the Keel card. Refresh any page you want to run on afterwards.

## Fast, controlled test

The included `test-form.html` is a mock job application that exercises every field type, the password and file pauses, and a mock WebMCP tool surface.

1. Confirm **Allow access to file URLs** is on.
2. Open `test-form.html` in Chrome (drag the file into a window). The address bar shows a `file://` URL.
3. Open Keel from the toolbar. It should announce that the page looks like a job application and that the page offers WebMCP tools.
4. Teach it who you are, in chat: `my name is Ada Okoye`, `my email is ada@example.com`, or just upload a resume with the paperclip.
5. Say **go ahead**. A plan card appears with every field previewed, confidence dots, and editable values. Radios, dropdowns, and checkboxes are included.
6. Approve the plan. Watch the page: every target is highlighted before it is filled. Then try **undo**.
7. Keel asks you to handle the password and (if you have not saved a resume) the file upload yourself, offers the final **Submit application** click for your approval, and otherwise leaves submission to you.

For a real test, open any signup, checkout, or job application, open Keel, and say **go ahead**.

## How it is put together

- `manifest.json` - MV3 permissions, side panel, service worker, both content scripts (isolated engine + main-world WebMCP bridge), icons
- `service-worker.js` - opens the side panel from the toolbar icon
- `sidepanel.html`, `sidepanel.css`, `sidepanel.js` - the chat thread, plan cards, composer, voice, uploads, walk-away mode
- `lib/profile.js` - the relational profile and per-domain memory (chrome.storage.local)
- `lib/voice.js` - the reliability-hardened speech input wrapper
- `lib/jobkit.js` - the job application module: JD fetching, resume tailoring, open-question answers, and a dependency-free PDF writer
- `lib/assist.js` - client for Keel's server-side language brain (an Audos workspace hook), with the no-em-dash text hygiene
- `content.js` - DOM scanner, field registry, highlight overlay, apply/undo executor, WebMCP client, page-change watcher
- `webmcp-bridge.js` - main-world probe that detects and calls page-exposed WebMCP tools
- `test-form.html` - local manual acceptance fixture
- `icons/` - extension and notification icons

Keel ships with zero API keys. Generation tasks (intent refinement, drafting, tailored resumes, open-question answers, chat) call a workspace hook; when it is unreachable, Keel degrades to its local heuristics and simply asks you instead of guessing.

## Known limits

- Cross-origin iframes, closed shadow roots, and canvas-rendered controls are not reachable; Keel tells you when it cannot see a form.
- Multi-step forms are supported via the page-change watcher and rescan, but Keel does not click "Next" style buttons without your approval.
- Resume text extraction happens for text files (.txt, .md). For PDFs, Keel keeps the file for uploads and asks you to paste the text once so it can learn from it.
- Voice uses Chrome's speech service and needs an internet connection.
- CAPTCHA detection is best effort, and Keel never attempts to solve one.
- Broad host permissions are included for this unpacked proof of concept. A production release should narrow permissions and add a site-access onboarding flow.
