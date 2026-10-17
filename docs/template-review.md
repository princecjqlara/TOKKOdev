# Short template review

The review catalog contains 2,880 distinct conversational templates, with `{{1}}` preserved and bodies at most 100 characters long. New wrappers use natural greetings, short lead-ins, and sign-offs rather than account/order update labels, notices, alerts, or status headings. Tones run casual, friendly, neutral, formal; shorter bodies appear first within each tone. Template names contain `_chat_` and end in `_v2` to distinguish this set from the earlier update-style experiments.

Candidates are separate from `UTILITY_TEMPLATES`. Connecting a page seeds at most six templates per tone (24 total), rather than submitting thousands during setup. A template POST without an explicit selection uses the same starter set. **Submit Missing** submits the shared library, while the review catalog remains separate. On the Templates page, choose a tone, search, and submit up to 25 visible candidates for review. Refresh statuses to see Facebook's decision. Campaign and contact pickers show approved page templates in tone order.

To generate the catalog and inspect connected page statuses without submitting anything:

```powershell
node scripts/template-review.mjs catalog
node scripts/template-review.mjs audit
```

To submit a representative batch across tones, explicitly choose a page by its database ID, Facebook ID, or exact unique name. Existing names and bodies are skipped, including rejected templates. Submission stops at the first error.

```powershell
node scripts/template-review.mjs submit --page "PAGE_ID" --limit 25
node scripts/template-review.mjs check --page "PAGE_ID"
```

Add `--tone casual`, `friendly`, `neutral`, or `formal` to submit a particular tone. All credentials come from the existing environment configuration. Reports in `outputs/template-review` exclude access tokens.

To review the full catalog in small batches:

```powershell
node scripts/template-review.mjs review --page "PAGE_ID"
```

Use `--wait --batch-size 5 --concurrency 1` to finish a review run while automatically waiting for page rate limits. Only limited entries are retried, with an increasing cooldown and progress messages every 30 seconds. Already completed entries are retained.

When reviewing on another connected page, `--unreviewed` skips candidates with a completed decision in the saved page reports. Promote with `--merge` to retain verified approvals from earlier pages and record which page approved each message. Each page still needs its own approval before sending.

The review command defaults to five templates per batch. Use `--batch-size` (1–10) and `--concurrency` (1–4) to adjust throughput. Larger review batches produced aborted requests in live testing. It resumes by skipping existing names and saves progress after every batch. Without `--wait`, rate limits stop the run; with it, limited entries wait and retry. Permission, authentication, and unknown request errors stop new batches while in-flight batches finish. Candidate-specific validation refusals are recorded as `INVALID` and excluded from the library. Individual Facebook server failures (`-1` or `960`) remain recorded for a later retry; three entirely failed batches also stop the run. It does not add candidates to the library. Run `check` and then `promote` to verify current decisions before updating the library.

Only after review, promote verified templates to the shared library:

```powershell
node scripts/template-review.mjs promote --page "PAGE_ID"
```

To reuse existing approved short text templates from a page, add `--existing`. This checks live approval and imports only bodies up to 70 characters with exactly one `{{1}}`, excluding names and bodies already in the library.

Promotion checks the live Facebook status (`APPROVED` or `ACTIVE`), `UTILITY` category, `en_US` language, exact candidate name and body, and a single BODY component. It writes `src/lib/facebook-templates-approved.json` and a dated approval report. A pending, rejected, modified, or recategorized template is excluded. An approval on one page does not imply approval on another: sending still checks the selected page.

`docs/template-review-results.json` records the latest promotion check, including each approved template's Facebook ID, status, category, language, and body hash. The catalog tests verify that every new short template in the shared library matches this evidence.

Review times vary. If a page token is invalid, reconnect the page before submitting or checking approvals.

The active library and message pickers exclude update-style templates. `ALL_UTILITY_TEMPLATES` retains historical parameter definitions so existing campaigns remain compatible. Selection labels show the full message text and placeholders; names stay internal as option values.

When Facebook reports a page rate limit, the runner stops. Completed decisions and the stopping reason remain in the progress report; leave unreviewed candidates in the catalog until the page can accept more requests. Only the separate live promotion check writes the shared library.
