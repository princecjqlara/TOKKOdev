# Sync and sign-in recovery

Automatic sync depends on the external scheduler. Configure every `/api/cron/*`
job with `Authorization: Bearer <CRON_SECRET>`, matching the secret on the live
deployment. `401` means the supplied header was rejected; `503` can mean the
deployment has no worker secret. Check job execution history and whether the
scheduler disabled a failing job. Never remove worker authentication to restore
sync. The existing follow-up job also advances Messenger tag scans and campaigns.

Use the deployment that actually serves the live domain when inspecting settings.
A local `.vercel/project.json` can point to a different project, and `.env.local`
can contain an older secret. Updating an environment variable requires a new
deployment before existing functions receive its value. Coordinate changes with
the scheduler so both use the same secret.

Facebook error code `190` indicates that the saved Page connection needs to be
renewed. A Page manager should use **Connect Pages → Reconnect**. Keep the existing
Page and its assignments; deleting it is unnecessary. Reconnecting the shared
token restores access for its members. A healthy Tokko login does not establish
that its saved Facebook Page token is still valid.

Manual contact imports use bounded requests and continue through Facebook
cursors. Keep the browser open until completion. A stalled request is cancelled
and retried using the same run and continuation. A response marked partial must
include a continuation; otherwise the import reports an error. Database and tag
failures retain the previous successful sync checkpoint for a later retry.

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
