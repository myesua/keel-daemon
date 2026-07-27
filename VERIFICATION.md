# Keel v0.4 verification record

Date: 2026-07-27 UTC. Chrome 148.0.7778.96 on Linux, extension loaded unpacked, live model calls, live DOM. Every line below comes from that run, not from a description of what the code should do.

## What was actually run

A real Chrome window with the unpacked extension installed, the fixture `test-form.html` served over http, and the real `sidepanel.html` document driven through its own composer. The run script is reproducible: it types into the panel, waits for the turn to finish, then reads the resulting DOM of both the panel and the page.

The fixture is deliberately hostile in the way the founder's real pages are: a search box in the header, the application form in the middle, and a newsletter signup in the footer.

Two consecutive full runs passed every check.

## The five required proofs

### a) "Can you see my screen?" returns the actual page

User: **can you see my screen?**

Keel:

> Yes, I can see your screen. You're on the 'Careers at Acme: Apply for Senior Engineer' page, focusing on the 'About you' section. There are fields like 'First name', 'Last name', and 'Email address'. Let me know what you'd like to do next.
>
> Careers at Acme: Apply for Senior Engineer at http://localhost:8137/test-form.html
> The part you are on: About you (job application, 17 fields, 17 still empty).
> Fields on screen right now: Search the site (search), First name * (text), Last name * (text), Email address * (email), Phone number (tel), LinkedIn URL (url), Street address (text), City (text), Country * (select).
> Also on the page, not what I am working on: Unnamed form (search), newsletter (newsletter signup).
> You are scrolled 0% down.

Checked automatically against the real page: the title and role match, and nine field labels in the answer are byte for byte the labels in the page's DOM. The panel strip read `19 fields | on About you | scrolled 0% | screen captured`, so the viewport image was captured and sent with that turn.

Screenshots: [side panel](https://storage.googleapis.com/audos-images/chat-attachments/e408a89e-aa51-456a-a94a-38b511fc1f18.png) - [the page it was looking at](https://storage.googleapis.com/audos-images/chat-attachments/f82fe765-a4a0-46ed-8e93-0455c117f52a.png)

Two extra checks of the same capability, both passed in the same run:

- The user scrolled to the footer and asked what is at the bottom. Keel: "At the bottom of the page, there's a section to subscribe to Acme's newsletter. It includes a field to enter your email and a 'Subscribe' button", with the readout reporting `You are scrolled 100% down`. [screenshot](https://storage.googleapis.com/audos-images/chat-attachments/8d2053b7-44a1-430a-927f-ff7651ea8710.png)
- The user switched to a different tab. Keel: "You're currently on the 'Example Domain' page", with the readout `Example Domain at https://example.com/`. It follows the active tab. [screenshot](https://storage.googleapis.com/audos-images/chat-attachments/3cc4f6b8-cb53-4bef-a08c-9f2fbc605e6b.png)

### b) The job description is given once and never asked for again

The job description was pasted once. Every assistant message after that point was scanned for a request for the job description, the posting, the role, or permission to start. There were none, across five later turns including a tab switch, a scroll, and a panel restart. [screenshot](https://storage.googleapis.com/audos-images/chat-attachments/e64bf2ae-dfc8-4f85-80c9-766be8929751.png)

This is enforced in code, not left to the model: `alreadyAnswered()` in `lib/memory.js` matches a proposed question against stored facts (with aliases, so "which role are you applying for" is caught by a stored job description) and against questions the user already answered. A blocked question is fed back to the model as a correction and it has to pick a real action instead.

### c) One "yes" advances the work

User: **yes**

Keel replied "Let's fill out the application with the details you've provided" and immediately rendered the preview card. No second permission question. The check asserts that the turn after a bare "yes" produces the plan card rather than another question. [screenshot](https://storage.googleapis.com/audos-images/chat-attachments/b3c5442a-36e5-4a64-9a01-be6be5c98a6a.png)

There is also a hard guard: if the model tries to ask permission when the user's last message was an affirmation, the question is dropped and the model is told to act.

### d) The right fields, in DOM order, and not the newsletter box

The preview listed, in exactly this order:

| Field | Value | Type |
| --- | --- | --- |
| First name * | Ada | text |
| Last name * | Okoye | text |
| Email address * | ada.okoye@example.com | email |
| Phone number | +234 802 555 0134 | tel |
| City | Lagos | text |
| Country * | Nigeria | select |
| Do you require visa sponsorship? * | No | radio |
| Years of relevant experience * | 6 to 9 years | select |
| I want to work remotely | Yes | checkbox |
| Why do you want to work at Acme? * | drafted from the resume and the job description | textarea |
| I agree to the terms and privacy policy * | Yes | checkbox |

Read back from the live page after the fill:

```json
{
  "first": "Ada", "last": "Okoye", "email": "ada.okoye@example.com",
  "phone": "+234 802 555 0134", "city": "Lagos", "country": "Nigeria",
  "sponsorship": "no", "experience": "6 to 9 years",
  "remote": true, "terms": true,
  "why": "I am excited to work at Acme because of its innovative approach ...",
  "password": "", "newsletter": "", "search": "", "submitted": false
}
```

Every field type is covered: text, email, tel, select, radio, checkbox, textarea. The preview order was checked against the real order of the elements in the page and matched. The footer newsletter email box and the header search box were both left empty, and "8 years of experience" was mapped to the "6 to 9 years" option rather than a wrong one. [panel](https://storage.googleapis.com/audos-images/chat-attachments/9fc8dcc1-079a-414c-9250-6714ca8dc056.png) - [page](https://storage.googleapis.com/audos-images/chat-attachments/455f1ed9-1f5b-4b00-a2f9-7910c41e96ea.png)

### e) A preview before anything is typed, and a review before any submit

Two gates, both observed in the run:

1. Before a single character reached the page, the preview card "Check this before I touch the page" listed all eleven values with editable controls and per field confidence, plus a line naming what was left alone and why (no LinkedIn URL provided, no street address provided, and so on).
2. After filling, the card "This is what would be submitted" read every field back from the live page, flagged the ones still empty, and offered two buttons: `Click Submit application` and `I will submit it myself`. Neither was pressed by Keel. The fixture's submit flag was `false` at the end of the run, and the password field was still empty.

[review card](https://storage.googleapis.com/audos-images/chat-attachments/df1154c8-14ed-457d-a314-74d7b59f3547.png) - [page after fill, submit untouched](https://storage.googleapis.com/audos-images/chat-attachments/ac803e1e-4a67-4f77-a3a8-3485add1f04e.png)

## Additional checks in the same run

- **Persistent memory.** The panel document was reloaded, which is what happens when the side panel closes and reopens. Asked "do you still have my details and the job description?", Keel answered yes and repeated the role, the stack, and the experience requirement back correctly, with no re-asking. [screenshot](https://storage.googleapis.com/audos-images/chat-attachments/c3188285-c226-4bf3-bdcd-baf6aa4c716f.png)
- **No console errors** were logged by the panel during the run.
- **Fallback brain.** The `keel-assist` workspace hook gained an `agent_turn` task so the loop still works if the direct model route is unavailable. Called live, it returned valid decision JSON in 1.2 seconds. It has no screenshot, and it is instructed to say so rather than pretend.

## The bug behind "the agent cannot see my screen"

Two things were wrong, and both are fixed.

1. The v0.3 panel never captured anything. There was no `captureVisibleTab` call anywhere in the extension, and the model was handed only the page URL, title, and host. It could not see the screen because nothing ever looked at it.
2. Even with the capture wired in, the first real run failed with `Either the '<all_urls>' or 'activeTab' permission is required`. Chrome does not accept `http://*/*` plus `https://*/*` as a substitute for `<all_urls>` for viewport capture. The manifest now requests `<all_urls>`, and capture succeeds on every turn.

## Honest limits of this run

- The fixture is the bundled `test-form.html` served locally, not a live employer site. It contains the same trap the founder reported, a footer newsletter box, plus a header search box.
- The panel was driven as its own extension document rather than through Chrome's docked side panel UI, because `chrome.sidePanel.open()` requires a genuine user gesture that automation cannot produce. It is the same `sidepanel.html`, the same code, the same extension context, and the same active tab resolution; only the window chrome around it differs.
- Model behaviour is not deterministic. Two consecutive full runs passed every check, and the guards that matter (never re-ask, never fill outside the target form, never touch a password, never submit) are enforced in code rather than by the prompt.
- Resume upload through the file picker was not exercised in this automated run. The PDF, DOCX, and TXT intake path is unchanged from v0.3, where it was verified against the live document service.
