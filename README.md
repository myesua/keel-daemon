# Keel v0 — Job Application Copilot

A no-build, Manifest V3 Chrome extension that proves Keel can work inside the user's real browser session. It reads the active page's live DOM, highlights every target before acting, fills known profile data, asks instead of guessing, and pauses at passwords, CAPTCHAs, and file uploads.

## Load it in Chrome

There is no build step, package install, API key, daemon, debug port, or connection step. The extension is plain JavaScript that Chrome loads straight from these files.

### 1. Get the files onto your computer

Either clone the repository:

```bash
git clone https://github.com/myesua/keel-extension.git
```

…or download the ZIP and unzip it. On the repository page click the green **Code** button, then **Download ZIP**.

**ZIP gotcha:** unzipping a GitHub download produces a wrapper folder named `keel-extension-main`. The folder you point Chrome at is the one that directly contains `manifest.json` — that is the unzipped `keel-extension-main` folder itself, not its parent and not a subfolder. If you double-click into a folder and see `manifest.json`, `content.js`, and `sidepanel.html` sitting there, you are in the right place.

### 2. Load it as an unpacked extension

1. Open Chrome and go to `chrome://extensions` (type it into the address bar — it will not work as a link).
2. Turn on **Developer mode** using the toggle in the **top-right corner**. The **Load unpacked** button only appears after this is on.
3. Click **Load unpacked** (top-left).
4. In the folder picker, select the folder containing `manifest.json` and confirm. Select the *folder itself* — do not open it and select `manifest.json`.
5. A **Keel — Job Application Copilot** card appears in the list. Requires Chrome 114 or newer.
6. Optional but recommended: click the puzzle-piece **Extensions** icon in the toolbar and pin Keel so its icon is always visible.

### 3. Turn on file-URL access (needed for the bundled test form)

Chrome blocks extensions from `file://` pages by default, so this step is required before you can test against the included `test-form.html`.

1. Still on `chrome://extensions`, click **Details** on the Keel card.
2. Scroll to **Allow access to file URLs** and switch it **on**.

### 4. Open it

Click the Keel toolbar icon on any normal page to open Chrome's side panel.

**Important:** a tab that was already open *before* you installed the extension has no content script in it. Refresh that tab (or open a new one) before starting a run, or Keel will not be able to see the page.

### Updating after a code change

Pull or re-download the files, then return to `chrome://extensions` and click the circular **reload** arrow on the Keel card. Refresh any page you want to run on afterwards.

## Fast, controlled test

The included `test-form.html` exercises known fields, an ambiguous required question, checkbox/radio clicking, and the resume pause.

1. Confirm **Allow access to file URLs** is on (step 3 above). Without it Keel cannot see the test page.
2. Open `test-form.html` directly in Chrome — drag the file into a Chrome window, or use **File → Open File**. The address bar will show a URL beginning with `file://`.
3. Click Keel's toolbar icon to open the side panel.
4. Enter at least first name, last name, email, phone, address, city, state, postal code, country, current company, title, and LinkedIn in **Your profile**. Profile changes are stored automatically in `chrome.storage.local`.
5. Leave the instruction as **Apply to this job** and click **Start on this page**.
6. Watch the page: Keel scrolls to and outlines every target before filling it.
7. Answer the required sponsorship and referral questions in the side panel. Keel will click/select only the answer you gave.
8. At **Resume**, choose a file manually on the page, then click **I've handled it — continue**.
9. Review the result. Keel deliberately does not click **Submit application**.

For a real test, navigate to a job application form, refresh the tab if it was open before the extension was installed, open Keel, populate the profile, and start the same instruction.

## What works in v0

- Manifest V3 with `chrome.sidePanel`; operates in normal signed-in `http`, `https`, and permitted `file` tabs.
- Reads visible `input`, `select`, and `textarea` controls in DOM order.
- Maps common English labels, names, placeholders, ARIA labels, and `autocomplete` values to the local profile.
- Highlights and labels a target before every fill or click.
- Preserves existing answers.
- Asks for ambiguous or missing values; required fields cannot be skipped.
- Selects dropdown choices and clicks radio/checkbox controls only from explicit profile/user answers.
- Pauses for password fields, file uploads, and detected CAPTCHAs.
- Never solves CAPTCHAs, accesses files, types passwords, advances pages, or submits an application.
- `profileMatch()` in `content.js` is the zero-key heuristic resolver. It is the seam where a future LLM-backed ambiguity resolver can be added without changing the execution/highlight loop.

## Known limits

- This pass handles the fields currently present in the top-level document. It does not automatically click **Next** on multi-step applications or rescan fields added later.
- Cross-origin iframes, closed shadow roots, canvas-rendered controls, and browser-internal pages are not accessible.
- Matching is intentionally conservative and English-first; unfamiliar fields trigger a question.
- Exact dropdown matching is required after normalization. Keel re-asks rather than choosing a near match.
- CAPTCHA detection is best-effort; Keel never attempts to bypass one.
- Broad page access is included for this unpacked proof-of-concept. A production release should narrow permissions and add an explicit site-access onboarding flow.

## Files

- `manifest.json` — MV3 permissions, side panel, service worker, and content script registration
- `service-worker.js` — opens the side panel from the extension action
- `sidepanel.html`, `sidepanel.css`, `sidepanel.js` — instruction/chat UI and local profile memory
- `content.js` — DOM scanner, heuristic resolver, highlight overlay, executor, and human-turn pauses
- `test-form.html` — local manual acceptance fixture
