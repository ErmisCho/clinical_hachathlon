# Two-minute jury demo — EHDS Health Data Access Body

Use https://health-data-access-compass.lovable.app. This is the script for issue #19; the one-click Demo panel will follow this order later.

## Recording setup

- Use the unchanged JSON files in the sibling `TRACK-3-ehds/requests/` directory. Ground truth below is from its `expected.json`, not the illustrative values in `docs/api.md`.
- Before recording, submit R02, R01, R08, R05 and R09 through the applicant request form so they are available in staff history. Keep the JSON ready to paste for the recorded submissions. Do not spend video time typing or loading files.
- Click paths below describe controls by function: applicant/staff switch → request form or staff history → request result. The frontend is in a separate repository; exact form/history labels have not been verified offline. No existing Demo panel or fixture picker is assumed. Rehearse these paths before recording; use the prepared history entries if submission would exceed a slot.
- Keep decision, cited articles, reason and result in the same frame. Prepare the eligibility annotation and metric card described below. Open browser developer tools → Network before recording if the Download error does not visibly include its HTTP status.

## Running order (0:00–2:00)

The quoted lines are the spoken script. The expected-result column is a checking aid, not extra narration. All request-result values shown below must match their named group in `expected.json`; leave the full result available on screen.

| Time | Scenario and click path | Point at / exact expected result | Say / what it proves for the jury |
|---|---|---|---|
| 0:00–0:07 | Applicant view → request form; introduce the app. | Purpose, definitions and requested format; synthetic-data context. | “This access body turns a health-data request into a reasoned decision, safe statistics, or a secure environment.” |
| 0:07–0:20 | **Prohibited purpose — R02.** Applicant → paste R02 JSON → submit → result. | Insurance-premium purpose; `decision: REJECT`, `articles: ["54"]`, `answer: null`. No numerical answer. | “Insurance pricing is rejected under Article 54, even though only statistics were requested. Purpose is checked before patient data is queried.” **Proves:** a prohibited use cannot bypass the gate by asking for aggregates. |
| 0:20–0:38 | **Statistics — R01.** Applicant → paste R01 → submit → result → Wien row. | `APPROVE_STATISTICAL`, articles `["53", "69"]`. Wien: `adults: 3247`, `type2_diabetes: 263`, `prevalence_pct: 8.1`. Keep numerator and denominator visible. | “Public-health research is approved under Articles 53 and 69. Vienna has 263 adults with type 2 diabetes among 3,247 eligible adults: 8.1 percent.” **Proves:** the definitions produce useful, checkable statistics with their denominator. |
| 0:38–0:50 | **Opt-outs — stay on R01.** Keep Wien visible and show the prepared eligibility annotation beside it. | Annotation: **20,000 total − 839 opted out = 19,161 eligible**. Actual result: Wien `adults: 3247`. Art. 71 is the opt-out basis; R01's expected article list remains `["53", "69"]`. | “All queries start from 19,161 eligible patients; 839 opt-outs are excluded from both numerators and denominators. Vienna's adult denominator is shown here.” **Proves:** exclusion applies before aggregation, including the population used for percentages. |
| 0:50–1:04 | **Small cells — R08.** Applicant → paste R08 → submit → result → Burgenland, then Niederösterreich. | `APPROVE_STATISTICAL`, articles `["53", "69"]`. Burgenland: `women_with_bmi: "<10"`, `mean_bmi: "suppressed"`. Niederösterreich: `women_with_bmi: 15`, `mean_bmi: 27.2`. | “Small groups remain visible, but their counts show ‘less than ten’ and their means are suppressed. Lower Austria safely reports 15 women, mean BMI 27.2.” **Proves:** useful groups survive while small cells and their derived means are protected. |
| 1:04–1:19 | **Secure environment — R05.** Applicant → paste R05 → submit → result. | `APPROVE_SPE`, articles `["53", "66", "68", "73"]`; `answer: {"cohort_size": 1152}`. Point at the provisioned environment indicator/schema (`spe_r05` in the API); no patient records in the browser. | “Model training justifies individual histories. Articles 53, 66, 68 and 73 allow a secure environment with exactly 1,152 patients.” **Proves:** justified record access provisions a restricted cohort and reports its size. |
| 1:19–1:31 | **Blocked download — R05.** On its result → **Download** → error; switch to staff → history → blocked-download log. | HTTP **403**; Art. 73 error below; R05 attempt in the log. This endpoint result is defined in `docs/api.md`, not `expected.json`; R05 retains its approval and cohort size. | “Download returns 403 under Article 73. Staff can see the blocked attempt in the audit history.” **Proves:** approving an SPE does not permit extraction, and attempts are traceable. |
| 1:31–1:45 | **Downgrade — R09.** Staff → history → R09 → result; show the saved request's requested format alongside it. | Requested: `health data access application`, `pseudonymised records`. Result: `APPROVE_STATISTICAL`, articles `["53", "66", "69"]`. Age `18-49`: `adults_with_hypertension: 359`, `ace_inhibitor_pct: 39.6`, `arb_pct: 33.4`. | “This application asks for records, but statistics suffice: Articles 53, 66 and 69. Ages 18–49: 359 patients, 39.6 percent ACE inhibitors, 33.4 percent ARBs.” **Proves:** the least detailed sufficient output wins over the applicant's requested format. |
| 1:45–1:53 | **Metric results.** Show the prepared metric card below. | All five measured results, with scope visible. | “Ten of ten decisions, six of six numeric answers, zero leaks; consistent across three runs, with the slowest under two seconds.” |
| 1:53–2:00 | **What works / what does not.** End on the app and a short limitations caption. | Synthetic-data prototype; rules parser; staff role switch. | “The benchmark works end to end. Language support is limited; staff access lacks production authentication.” |

## Showing opt-outs without overstating the screen

Prepare a clearly labelled **dataset eligibility** annotation: “20,000 synthetic patients · 839 opted out (Art. 71) · 19,161 eligible.” These totals come from the track's `data/README.md` and this repository's loading documentation; they are not a field in `expected.json` or the current request API. Use a video annotation beside R01 if the UI has no eligibility summary. The later Demo panel can display the same provenance-labelled summary.

The concrete application number to highlight is **R01 → Wien → adults = 3,247**, the eligible adult denominator for **263 / 3,247 × 100 = 8.1%**. It is a regional adult subset of the 19,161 eligible patients, not the overall eligible total. All statistical queries start from `public.eligible_patients`, which excludes opted-out patients before cohort filters, counts and percentage denominators; SPE selection uses the same eligible base. Neither a matching aggregate nor a caption alone proves source-level exclusion. The exclusion is supported by that query construction and the loaded dataset totals; do not claim that the result API exposes a separate opt-out audit count.

For the download shot, the actual deployed route is `GET /spe-download?id=R05` (or `POST /spe-download` with `{"id":"R05"}`), as documented in `api.md`. The architecture diagram's `/spe/{id}/download` is conceptual. The exact error is:

> Download blocked: data in a secure processing environment cannot be downloaded (EHDS Art. 73).

If the UI only shows this message, point at **403** in the Network response as well. Staff history contains request decisions and the download-attempt log; open a request's detail to show its answer, since the history overview itself has no answer numbers.

## Metric results card

Current measured values supplied for this presentation; not re-measured while writing this offline script. Show a saved evaluation result alongside the card when recording. These are results for the supplied ten-request benchmark, not a claim about arbitrary requests or production performance.

| Metric | Current measured result |
|---|---|
| Correct decisions and cited articles | **10/10** |
| Approved requests with all expected numeric values | **6/6** (R01, R03, R05, R07, R08, R09; includes the SPE cohort size) |
| Privacy leaks | **0** |
| Consistency | **10/10 requests consistent across 3 runs** |
| Slowest answer | **Under 2 s** |

Do not replace “under 2 s” with an invented decimal. Label the saved evaluation's mode: local/offline timings are pipeline/parse timings, not submission-to-answer HTTP latency. Aggregate leak checks alone cannot establish opt-out exclusion; use the eligibility explanation above for that claim.

## Closing: what works / what does not

Use the final seven-second line in the running order. If asked for detail: the supplied benchmark covers reasoned decisions, computed statistics, opt-out filtering, small-cell suppression, SPE cohort provisioning and blocked downloads with history. The parser and purpose checks are rules-based with limited supported wording; unsupported definitions return a staff-review result rather than a computed answer. The staff switch has no separate authentication, and an isolated Postgres schema is the prototype SPE, not a complete production research workspace.
