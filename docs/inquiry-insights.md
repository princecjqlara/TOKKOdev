# New and returning inquiry insights

Open **Inquiry Insights** in the existing dashboard navigation. Reports are scoped to an assigned Page, Philippine inquiry date, inquiry type and a 24-hour or seven-day observation window. They use recorded messages from activation onward. Historical imported contacts and old message archives are not backfilled as new inquiries.

## Inquiry episodes

- A valid customer message opens the first tracked episode. A contact created by that message is **New**. For already-authorized history scans, a contact record added after activation has a New first episode when a post-activation inbound message is observed. Contact records predating activation are **Returning** on their first tracked inbound message. New means new to the tracked CRM, not proof of the person's first-ever Messenger inquiry.
- A nullable contact origin-message marker retains the New classification across webhook retries when the first metadata capture failed. Existing contacts are not assigned fabricated origin messages.
- Further customer messages stay in the same episode until the configured inactivity gap. The default is **30 days since the previous customer message**, not since a Page reply. Page administrators can set 1–365 days and a response target of 1–1440 minutes.
- A customer response after the gap opens a returning episode on the same contact; it never duplicates the contact or changes existing customer controls.
- Provider message IDs deduplicate retries. Episodes are derived from event time, so late messages can correct the current grouping. Each received message saves its returning-gap policy, preserving rules on already captured messages when settings change.
- Read/delivery receipts, referrals, postbacks, administrative stage notices and Page sends do not open inquiries. Missing IDs, invalid/future source times and pre-activation history cannot fabricate inquiry events.

## Reported measures

The report shows episode and distinct-contact counts; new versus returning inquiries; observed Qualified, Order Created and CRM Converted events; mature qualification/conversion rates; first observed Page response; attributed manual and automation/welcome responses; median/P90 completed reply time; response-target attainment; unanswered mature episodes; source timestamps and rejected-capture counts; and legacy first-interaction field coverage. Up to 50 latest episodes are listed; totals include the full eligible range.

Rates use complete observation windows. Immature episodes remain provisional. When a returning episode starts before the previous observation window finishes, the earlier episode is shown as censored and excluded from mature-rate denominators. Zero denominators return unavailable. Missing stage transitions are not inferred from the current tag list. CRM Converted does not verify a payment, a sale or service completion.

Known bulk campaigns are excluded from response-time statistics. Manual/human attribution requires the existing source event and actor ID. Unknown Page echoes remain unknown; Page access does not prove which staff member replied. Accepted-send timestamps can support an observed response time, but they do not prove delivery or reading. Completed reply times are shown alongside the unanswered share, not as a measure of every inquiry's eventual response.

## Collection and privacy

The signed Facebook webhook captures inbound messages and Page reply/stage echoes after contact resolution. Collection errors participate in the existing retry response; provider IDs make retries idempotent. Existing import/auto-tag scans also publish metadata from the messages they already read, without additional Meta requests. They are bounded sources, not a complete historical scan. Their post-activation message timestamps determine episode dates; older messages do not seed inquiries. An additive database trigger captures accepted outbound metadata from the existing source-attribution table. Bulk sends to the historical audience without a tracked inbound inquiry bypass that trigger's collection call. No sender or chatbot reply rule is changed.

The Meta app's callback currently targets the shared Veo partner route, which returned HTTP 410 during activation checks. Its routing was not changed by this feature. Saved-history collection can advance through the existing enabled scans; webhook latency/freshness still depends on repairing that shared integration separately. Reports disclose captured-event coverage and do not claim complete history. No callback used by another app is overwritten.

The event store keeps Page/contact IDs, provider message IDs, source type, actor ID when known, stage and timestamps. It does not store message text, attachments, PSIDs in event rows, inferred demographics or financial claims. Contact/Page deletion cascades to these events. New tables/views and RPCs are unavailable to anonymous and ordinary authenticated database roles; the server uses service access and the report function checks the actor's active Page membership. Settings additionally require existing Page-manager authority.

Last event time is an observation, not proof of collector health: a quiet Page can legitimately have no new events. The existing first-interaction field coverage describes legacy records separately from tracked inquiry cohorts. No verified revenue, profit, cash or purchase forecast is inferred from these events.

## Installation and verification

Apply the additive SQL before deploying the collector/UI:

```powershell
node scripts/verify-inquiry-insights.mjs
node scripts/configure-inquiry-insights.mjs --preflight
node scripts/configure-inquiry-insights.mjs --apply
npm run env:check:vercel
npm run test:release
npm run build
```

The standalone SQL verifier uses the optional existing PGlite install under ignored `outputs/campaign-scale-tools`. The preflight rolls back; apply requires the exact preflighted SQL hash, protects a metadata backup, verifies zero writes to existing business tables by the migration transaction, and preserves existing function definitions/grants. Other worker connections may continue normal activity. No sender is manually dispatched by either command. The schema cache reload is transactional.

Vercel runs the complete unit regression gate with production credentials removed from the test subprocess before compiling the production app. `env:check:vercel` also checks the new storage/view columns, so an omitted insight migration blocks future verification instead of being mistaken for an empty report.

API: `GET /api/pages/{pageId}/insights?from=YYYY-MM-DD&to=YYYY-MM-DD&kind=all&horizon=24`. `kind` may be `new_contact` or `returning_contact`; horizon may be 24 or 168 hours. Page managers can PATCH the same endpoint with `returning_after_days` and `response_sla_minutes`. Reports use the versioned `tokko-inquiry-v1` definition and expose their as-of time and filters. Cross-Page access, cross-origin writes and malformed filters are rejected.
