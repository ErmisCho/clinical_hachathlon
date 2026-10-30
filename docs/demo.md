# Two-minute jury demo — EHDS Access Desk

Site: https://health-data-access-compass.lovable.app. **Recording link: TODO — insert a video of at most two minutes.**
First half: the applicant. Second half: staff. Rehearse once; every click below names the control as it is labelled today (English UI).

## Before recording (5 minutes)

1. Open the site in a fresh window, 1280 px wide or more. In the first-visit dialog choose **EN**, **Austria**, **Applicant**.
2. Keep this text in the clipboard for the quick-test (step 0:30). It is three of the ten official requests, R01, R08 and R05, from `TRACK-3-ehds/requests/`. Paste them as one JSON array: `[ <R01.json contents>, <R08.json contents>, <R05.json contents> ]`.
3. Staff account: create it with `scripts/create-staff-user.ts` (see `docs/running.md`) and sign in once to be sure it works. The staff half needs at least one request **waiting for you**; the curated demo data has twelve (for example `AT20260420`). Do not approve them during the rehearsal.
4. Try **Draft my request** once with the sentence from 0:08, so the AI model is warm and you know how it looks.
5. Mute notifications. Open nothing else.

## Running order (0:00–2:00)

The quoted lines are the spoken script. Expected values are from the official `expected.json`; today's live eval reproduces all of them (10/10, 6/6).

| Time | Clicks | Point at | Say |
|---|---|---|---|
| 0:00–0:08 | Landing page. | Headline; the three promises (legal basis cited, no patient data leaves, same answer every time). | "Under the EHDS every request for health data needs a lawful decision. This desk gives it in seconds and explains it in plain words." |
| 0:08–0:18 | **Submit a request** → box **Or describe your request in your own words** → type: *For a regional diabetes prevention programme, I need the number of adults and of adults with type 2 diabetes in each region, and the prevalence.* → **Draft my request**. | The fields fill in (about 4 s, cut the wait) and the note "Draft filled in below. Please review and edit the fields." Do not dwell on its outcome. | "Applicants can just describe what they need. AI drafts the request, the applicant checks it, and the rules decide." **Proves:** the AI helps, visibly, and never decides. |
| 0:18–0:30 | **Load a sample** → *R02 — private health insurance premiums*. Do not submit. | Right panel **Likely outcome**: "Likely: rejected", then the reason "insurance premiums … prohibited (Art. 54)". | "Before submitting, they already see the likely outcome: insurance pricing is a prohibited purpose under Article 54, even though only statistics were asked for." **Proves:** the purpose gate runs before any data is touched. |
| 0:30–0:50 | Role button → **Demo**. Paste the array into **Request JSON** → **Run all**. | The table fills row by row: R01 *Approved – statistics* (Art. 53, 69), R08 *Approved – statistics*, R05 *Approved – secure environment* (Art. 53, 66, 68, 73); each under three seconds. | "Judges can drop their own requests here. Three official ones: two get anonymised statistics, the model-training request gets a secure environment with exactly 1,152 patients and no records in the browser." **Proves:** end to end on new requests, correct form of access. |
| 0:50–1:05 | R08 row → **Open letter**. Scroll to **Results**. | Headline "Yes — approved for anonymised statistics"; Burgenland: women with BMI **<10**, mean BMI **suppressed**; Niederösterreich: **15**, mean BMI **27.2**. The deadline line and the law quoted word for word. | "Every letter starts with a plain yes or no, quotes the regulation verbatim and shows the legal deadline. Small groups stay visible but their counts show 'under ten' and their means are hidden. Opted-out patients were removed before any count." **Proves:** small-cell rule, opt-outs, understandable decision. |
| 1:05–1:17 | **Back to desk** → role button → **Staff** → sign in. | The role button shows the number waiting; the page opens with **Waiting for you (N)**, oldest first, each with its due date. | "Staff sign in and see what waits for them: requests the rules could not decide with confidence, with the legal deadline." **Proves:** humans decide where the law leaves room; nothing is silently approved. |
| 1:17–1:35 | First waiting request (`AT20260420`) → template **Approve: permitted purpose** → **Approve**. | The reason fills in and stays editable; after approving, the request leaves the list and the history shows the decision with your e-mail. | "One click fills a legal reason, the reviewer can edit it or override the rules, and every decision is recorded under their own identity." **Proves:** audit trail with a real login; the tool supports, never replaces, the access body. |
| 1:35–1:45 | History → the R05 row → **Download**. | Message "Download blocked … (EHDS Art. 73)" with **403**; the attempt appears in the blocked-download log. | "Data in the secure environment cannot leave it. The attempt itself is logged." **Proves:** download block and traceability. |
| 1:45–2:00 | Landing page, **Tested before the next request** tile. | 10/10 · 6/6 · 0 leaks · 57 jury requests, 0 wrong. | "Ten of ten official requests correct, zero leaks, fifty-seven unseen requests without a wrong decision. Rules decide; people stay responsible." |

## Still frames for the cut

Two 1920×1080 frames in this folder: `decision-gates-1080p.png` (the five gates) and `decision-flow-1080p.png` (the process view). Suggested use: show `decision-gates-1080p.png` full-frame for 5 s at the hand-over from the applicant half to the staff half (around 1:05) with the line "Five gates: rules decide, AI only advises, a person has the final say." The deck slide 4 uses the same picture.

## If a slot runs long

Skip the gates still or shorten the demo run to two requests. Never skip 0:08–0:30 or 1:17–1:35: they carry the AI moment and the two scoring points "can an applicant understand the decision" and "would an access body use it".

## Numbers you may say

| Claim | Value | Source |
|---|---|---|
| Vienna, R01 | 263 adults with type 2 diabetes of 3,247 adults = 8.1 % | `expected.json`, live eval 6/6 |
| Burgenland / Niederösterreich, R08 | <10 and suppressed / 15 and 27.2 | `expected.json` |
| R05 cohort | 1,152 patients in the secure environment | `expected.json` |
| Eligible population | 19,161 of 20,000 synthetic patients (839 opted out, Art. 71) | track `data/README.md`; never shown by the app |
| Tests | 10/10 decisions, 6/6 numbers, 0 leaks, 3 consistent runs; 57 jury requests, 0 wrong, 0 leaks | measured 30 Oct 2026, README |

Do not quote an opt-out count from the screen (the app never shows one) and do not invent a latency figure; "under three seconds" is what was measured with AI screening on.

## What works / what does not (if asked)

Works: deterministic decisions with the rule id and version, verbatim legal quotes checked against EUR-Lex, opt-out filtering, small-cell and secondary suppression, secure-environment cohorts with blocked downloads, staff login with audit log, legal deadlines, EN/DE, public transparency register, per-access-body rules (AT, DE).
Live AI (Mistral Small 3.2 on the hackathon's A5000 GPU, EU, token-checked proxy), advisory only: rewords unclear definitions, second opinion on doubtful purposes, staff memo on held requests with verified quotes, free-text intake; everything it touches is held for a person. Does not, yet: staff accounts are created by script, not self-service; the secure environment is an isolated Postgres schema, not a full research workspace; synthetic data only.
