# Sync and sign-in recovery

Automatic sync depends on the external scheduler. Configure every `/api/cron/*`
job as a `GET` request to its URL. Worker endpoints are intentionally public and
require no sign-in, Authorization header, random key, or `CRON_SECRET` environment
variable. Existing scheduler headers and an old environment value are ignored.
Deploy this version to activate public workers; an older deployment may still
reject requests with `401`. Verify the deployment without running a worker by
sending `OPTIONS /api/cron/campaign-scheduled`, which should return `204` without
credentials. Check job execution history and re-enable jobs disabled after
repeated failures. The existing follow-up job also advances Messenger tag scans
and campaigns.

Campaign delivery can continue independently through the existing database
scheduler. Apply `database/migration_campaign_worker_schedule.sql` after deploying
the public worker. The `tokko-campaign-delivery` job checks every minute and
dispatches the campaign worker only when eligible work has an idle Page. It
respects manual Stop, recipient schedules, retry windows, and shared Meta
cooldowns. This requires no extra account connection or worker credentials.
External campaign scheduler calls are optional once this job is enabled; their
Page leases still prevent overlapping delivery if both schedulers run.

Run `node --env-file=.env.local scripts/configure-campaign-scheduler.mjs --preflight`
to verify installation and dispatch rules with rolled-back fixtures. `--apply`
backs up the existing named job and commits the verified schedule. Inspect
`cron.job_run_details` for job execution and `net._http_response` for HTTP results.
A successful cron SQL result means a request was queued; verify its HTTP status
and actual campaign counters too. A run with zero rows means no Page was eligible
at that tick, such as during another worker's lease or a Meta cooldown.

Campaign continuation runs independently of follow-ups in that scheduler
invocation. It calls the same worker as `/api/cron/campaign-scheduled` directly,
so a follow-up failure or nested HTTP timeout cannot prevent queued campaigns
from resuming. A failed scheduled or best-time lookup does not block a healthy
immediate campaign; partial discovery failures appear in `discoveryErrors`.
Recipient claims and durable delivery counts preserve progress across requests.
Receipt writes also change the campaign's update timestamp. When a browser and
scheduler overlap, a rejected conditional update rechecks the saved state:
an active campaign stays queued for automatic retry, a completed campaign returns
its latest totals, and a manual Stop or cancellation remains stopped. A progress
update from another worker must not be reported as a manual Stop. This behavior
requires deploying the updated sender and needs no database migration.
Completed recipients are skipped, expired claims can be recovered, and Meta
rate-limit cooldowns remain in effect. Manually stopped campaigns stay stopped
until **Continue Unsent** is selected. Deploy the updated application to activate
this recovery change. The faster delivery upgrade also uses
`database/migration_campaign_delivery_throughput.sql`; the existing minute
campaign job stays in place. The rolling 100-worker upgrade uses
`database/migration_campaign_delivery_parallel.sql`. Check the deployed
`acquire_page_campaign_delivery` function as well as application code: an older
database budget of five recipients still constrains a newer sender. Applying
the new budget does not clear an active lease, reset recipients, or bypass a
Page cooldown. On Vercel its HTTP response acknowledges that a
background run was accepted, while actual progress is recorded on the campaign.
Check campaign counts and `last_error` as well as scheduler history: a successful
acknowledgment alone does not establish that every recipient was delivered.

For automatic speed adjustment, apply `database/migration_campaign_delivery_adaptive.sql`
and deploy the matching sender. Concurrency alone does not bound requests per
second: fast responses and multi-part messages can still exhaust a Page or app
quota. The controller spaces individual message starts, backs off as usage rises,
honors provider recovery times, and saves the learned pace on the Page. Missing
usage headers trigger gradual probing rather than another immediate large burst.
Without a provider recovery estimate, repeated throttles use increasing retry
windows. Existing future cooldowns and manual Stop remain in effect.

Successful responses reporting full quota usage slow sending to one message
every five seconds instead of manufacturing a rate-limit error and escalating
shared cooldowns. Explicit provider recovery estimates and rejected rate-limited
requests still pause and retry automatically. A normal worker deadline releases
unstarted recipients and returns a resumable slice immediately; it does not add
a service-error backoff. An already-started multipart recipient finishes across
that soft deadline so a later slice does not replay its completed first part.
Manually stopped campaigns are displayed as Paused and require an explicit
resume; they are not mistaken for drafts that have never sent.

For Pages that repeatedly burst after recovering, apply
`database/migration_campaign_delivery_recovery_pace.sql` and deploy the matching
sender. Page feedback includes an absolute `growth_after` time, ten minutes after
the saved cooldown. During this hold, the database rejects optimistic speed
increases and workers retain their slower budgets even when replies are clean.
App-level throttles share conservative pacing across Pages. Repeated reports from
one worker retain the original saved recovery window instead of sliding it
forward. The migration changes only feedback behavior and preserves recipient
queues, existing cooldowns, and Page leases. Run
`node scripts/verify-campaign-recovery-pacing.mjs` for local SQL checks with no
customer records or outbound requests.

Deploy the updated sender to recover speed within short browser slices when Meta
omits usage headers. The clean-response target scales with message spacing instead
of requiring 25 successful replies before every worker restart. After the saved
recovery hold, speed increases at most once every fifteen seconds. Slow Pages
prefetch up to five recipients per active worker while preserving message spacing,
and checkpoint available results and check Stop about every five seconds.
Small checkpoints refresh pacing feedback at most once every thirty seconds
unless Meta limits delivery; full 50-recipient checkpoints and final handoffs
still save feedback immediately. This avoids adding a feedback round trip to
every slow receipt checkpoint.
Slice planning uses the observed cost per recipient, so one paced prefetch does not cause
the next slice to end early. This sender update requires no additional migration.

For campaigns that start slowly hours after an app-wide cooldown, apply
`database/migration_campaign_delivery_idle_probe.sql`. When feedback, the last
throttle, and the saved cooldown have all been stale for thirty minutes, a slow
Page can start its next worker with five workers and 100ms message spacing.
Active leases, future cooldowns, and fresh recovery budgets still take precedence.
The migration installs only acquisition behavior; it does not resume campaigns,
reset recipients, or change existing Page rows. Validate it with
`node scripts/verify-campaign-idle-probe.mjs` and install through
`node --env-file=.env.local scripts/configure-campaign-idle-probe.mjs --preflight`
followed by `--apply`. The matching sender also learns from recipient rejections,
such as unavailable accounts, while honoring their quota headers. Those recipients
remain failed; their responses are capacity evidence rather than delivery evidence.

Temporary worker failures, timeouts, expired recipient claims, and unrecognized
infrastructure interruptions keep campaigns queued for automatic retry after
one minute. Facebook rate limits keep their shared Page cooldown instead.
The sender saves continuation before slow Facebook/template checks, so a killed
request can be recovered after its claims expire. Permanent connection,
template, permission, and database-schema errors keep recipients saved while
waiting for repair. Conditional state updates prevent recovery from undoing a
manual Stop, including when Stop overlaps a failing worker.

Each send allows two immediate retries for temporary errors when the slice has
time left, followed by further background attempts while the campaign remains
queued. Slow timeouts defer to another invocation, and rate limits wait for
their Page cooldown. Saving an accepted batch retries up to three times for
returned database errors, transport exceptions, or request deadlines. Those save
retries reuse the same claim and results without issuing another Facebook send.
If a checkpoint or pacing-feedback write fails while other sends are in flight,
the worker drains those sends and attempts to save every remaining accepted
receipt before returning a retryable error. A feedback failure must not discard
delivery receipts that would otherwise become eligible again after claim expiry.
Manual Stop is rechecked before an immediate send retry begins.

Use the deployment that actually serves the live domain when inspecting settings.
A local `.vercel/project.json` can point to a different project. Deploy the
updated worker middleware to the live project; editing a local environment file
or changing the scheduler's headers cannot update older deployed code.

Facebook error code `190` indicates that the saved Page connection needs to be
renewed. A Page manager should use **Connect Pages → Reconnect**. Keep the existing
Page and its assignments; deleting it is unnecessary. Reconnecting the shared
token restores access for its members. A healthy Tokko login does not establish
that its saved Facebook Page token is still valid.

Contact imports scan **Inbox, Requests, Done, and Spam**. Install
`database/migration_durable_contact_import.sql` after the database control-plane and sync-lease migrations
before deploying this importer. Each bounded slice saves its contacts and the
next folder/cursor atomically. Failed saves retain the current batch. Retrying
Sync, including after reopening the browser, attaches to an unfinished Page import; the regular
sync and existing minute follow-up workers also continue saved imports. Their
scheduler jobs still need to be enabled and call the live deployment.

The importer reads conversation participants first. It no longer fetches a
separate profile and up to 500 historical messages for every contact before
advancing to the next Page of contacts. Existing profile pictures, timing
statistics, and newer inbound/activity timestamps survive reimports. Optional
auto-tagging uses the recent messages included in a conversation response after
the contacts and checkpoint are saved; the existing tag worker scans longer
recent histories separately. Tag failures cannot discard a batch of contacts.

For an operational recovery using the same application worker, run:

```powershell
node --env-file=.env.local scripts/recover-contacts.mjs --apply --all-pages
```

Use `--page-id <UUID>` instead of `--all-pages` to recover one Page. `--with-tags`
also processes the recent embedded messages. This writes imported contacts and
checkpoints and never invokes an outbound sender. Summary counts are saved in
`outputs/contact-import-recovery.json`; `--resume` keeps that report's original
before-counts and skips completed Pages when restarting the recovery command.
Verify the migration first with
`node --env-file=.env.local scripts/verify-contact-import.mjs`; those SQL fixtures
and schema changes are rolled back.

Temporary account-service failures show an account-check retry and deny workspace
access until the check succeeds. They do not establish that an account was
revoked or that its password was incorrect. Email login distinguishes a temporary
service outage, too many attempts, and rejected credentials. For individual login
failures, record the exact displayed message and the selected sign-in provider.

Run `node --env-file=.env.local scripts/verify-page-access.mjs` for a read-only
audit of Page assignments and the queries used by members. This does not exercise
live OAuth, submitted passwords, scheduler execution, or message delivery.

`node --env-file=.env.local scripts/verify-live-signin.mjs` checks the live login
entry points, CSRF response, and Facebook callback URL without approving OAuth or
using a person's password. Add `--reject-invalid-credentials` to also check that
a new nonexistent address is rejected. This creates rate-limit records, never a
user account. A successful result does not verify a valid user's final login.

`node --env-file=.env.local scripts/verify-campaign-delivery.mjs` checks the
deployed queue functions with 10,005 synthetic recipients in a temporary schema.
It verifies complete audience materialization, Page isolation, disjoint claims,
stale-claim recovery, delivery counters, scheduled eligibility, filters, and Page
cooldowns. All schema changes and fixtures are rolled back; no Facebook messages
are sent. It requires the SQL connection used by the account verification script.

`node --env-file=.env.local scripts/verify-campaign-concurrency.mjs` checks real
row locking with three independent PostgreSQL sessions and 1,000 synthetic
recipients. It commits only a randomly named isolated fixture schema so all three
sessions can see it, denies end-user schema access, and removes that exact schema
in cleanup. It verifies simultaneous disjoint claims, recovery after transaction
rollback, and lossless counter updates while workers finish in parallel. It does
not send messages or write customer records.

The sender saves recipient completion before optional message attribution. Queue
operations and attribution have database deadlines, and Facebook send deadlines
include response bodies. A failed campaign-state write is reported instead of
being treated as success. A temporary session-service failure returns `503` from
campaign and tracked-bulk endpoints and preserves the login recovery flow.

Large audiences progress through bounded slices; they are not unlimited single
requests. Delivery still requires working scheduler credentials, usable Page
tokens, approved templates where configured, and Meta availability. The queue
prevents completed recipient rows from being reclaimed. An uncertain network
acknowledgment from an external messaging service cannot establish exactly-once
delivery; verify the conversation before manually restarting an uncertain send.
