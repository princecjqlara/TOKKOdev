# Bulk delivery reports

The dashboard shows the latest started bulk send for the selected Page and
refreshes it every 15 seconds while the tab is visible. Campaign cards and
expanded Bulk History entries show the same chart, counts, percentages, and
failure reasons. Untouched drafts do not replace the dashboard's latest send.

Sent counts recipients whose full message sequence Meta accepted. It does not
confirm delivery or reading. Outcome percentages use the recipient total;
failure-reason percentages use the failed-recipient total. Loop campaigns use
cumulative attempts because the same audience can be contacted across cycles.
Queued or not-sent recipients are separate from failures, including after Stop.

Recipient-unavailable errors are labelled **possibly blocked**. They can also
reflect deactivated accounts or other unavailable recipients; they do not prove
blocking. Deleted/archived conversations, messaging policy, Page authorization
and template problems, Meta service failures, connection timeouts, and Tokkow
backend/database errors have separate explanations. Unknown errors remain
unclassified. Bare Meta code 10 and codes 200–299 are permission errors unless
more specific evidence identifies the cause. Provider codes and subcodes are
preserved even when their error messages are vague. See Meta's
[Graph API error handling](https://developers.facebook.com/docs/graph-api/guides/error-handling/)
and [Page Messages reference](https://developers.facebook.com/docs/graph-api/reference/page/messages/).

Page-wide interruptions pause sending and retain unsent recipients. Their latest
diagnosis appears separately from terminal recipient failures. Network failures
without provider evidence are identified as connection/timeout errors, without
claiming that either Meta or Tokkow caused them.

Apply `database/migration_campaign_delivery_diagnostics.sql` **before deploying
this application version**, after `migration_compact_campaign_delivery_prepare.sql`.
The migration replaces `finish_campaign_recipient_batch` while preserving atomic
claim validation and all-or-nothing completion. It accepts older results without
diagnostics and restricts administrative execution to postgres/service_role.
Failure-category counts update in the same transaction as sent/failed totals.
Rearming a recurring campaign clears the current cycle's categories. Retention
can delete individual failure rows without deleting campaign category totals.

The migration backfills only retained evidence. Failures whose details were
already removed appear as unclassified; missing history is never reported as
zero failures. Older single-recipient senders remain compatible, but their
unaggregated failures can appear as unclassified. Do not reapply the older compact
queue prepare migration over the new completion function.

Verification:

```powershell
npm test
npx tsc --noEmit --incremental false
npm run lint
npm run build
node scripts/verify-campaign-diagnostics.mjs
```

The SQL verification uses a disposable local PGlite database, sends no customer
messages, and makes no production writes. If needed, install its optional tool:

```powershell
npm install --prefix outputs/campaign-scale-tools --no-save --package-lock=false --ignore-scripts @electric-sql/pglite
```
