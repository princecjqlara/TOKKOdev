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
