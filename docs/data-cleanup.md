# Data cleanup and operational recovery

An empty contact list does not mean every table should be empty. Page tags,
account configuration, Facebook identity bindings, memberships, credentials and
chatbot knowledge are operational setup. Preserve them when clearing activity.

Keep the following during an application-data reset:

- `users`, `pages`, `user_pages`, `businesses`, `business_users`, and all
  `tokko_*` account configuration and identity tables.
- Default Page tags and tags with a `system_key`. Clear contact assignments when
  removing contacts; retain their built-in definitions.
- Chatbot configuration, knowledge documents/chunks, linked Drive files/folders,
  media and pricing definitions.
- Schema migration records, maintenance configuration and runtime policies.

Do not clear scan cursors or advance Page checkpoints as part of repairing tag
definitions. Normal webhook and sync activity may add new contacts after a reset.
Historical imports are separate jobs; do not restart them merely to repair setup.

## Cleanup and Supabase quotas

A data reset removes activity rows; it does not reset monthly bandwidth, billed
usage or the billing-period average database size. Deleted PostgreSQL rows may
also leave reusable space until vacuuming. Check the exact exceeded meter before
choosing a remedy. See Supabase's [egress](https://supabase.com/docs/guides/platform/manage-your-usage/egress)
and [database-size](https://supabase.com/docs/guides/platform/database-size) guidance.
Do not run a full backup repeatedly to diagnose bandwidth usage: the exported
data itself consumes egress.

Verify the live app's project against the cleanup receipt before any deletion.
The historical cleanup receipts under `.vercel/contact-refresh` target
`vhtbmdizugnxkgocmruq`; the live TOKKO bundle inspected on 2026-11-04 referenced
`pnhzpeyzpwsmwcuafgpw`. Those receipts do not establish that the live project's
activity was cleared. Keep the existing live connection; never silently select
the reachable replacement project to get a successful cleanup result.

Run a small read-only inventory using settings for the intended project:

```powershell
node --env-file=<matching-local-env-file> scripts/audit-database-usage.mjs --expected-project pnhzpeyzpwsmwcuafgpw
```

The audit refuses mismatched API/SQL projects before connecting, uses a read-only
transaction, and reports relation sizes, estimated row/dead-row counts, connection
counts and schedules without exporting customer rows or cron command secrets.
Receipts stay under `.vercel/usage-audit`. If the project is quota-restricted or
unreachable, resolve access before applying a TOKKO-only cleanup. Shared contacts
and chatbot-owned data require checking their consumers before deletion.

The TOKKO admin REST client backs off after quota, rate-limit, network and service
failures. Quota responses wait at least five minutes; service failures start at
30 seconds and grow to five minutes. `Retry-After` is honored up to 24 hours. One
request per warm worker probes recovery, and writes are never replayed. This is
per worker, not a global billing cap; other apps sharing Supabase still contribute
usage. Normal authorization, row reads and auto-tagging remain fresh. Webhooks
still return failure for unprocessed events so Facebook can retry them.

## Repair a cleanup that removed setup

`migration_repair_default_page_tags.sql` installs a server-only, idempotent repair
function. It reuses matching tag IDs and their assignments, restores the protected
Paid / Availed Service and Unqualified definitions, and supports new Pages through
the existing Page-insert trigger. The auto-tag worker calls it only if a required
tag is missing. Failed repairs retain the inbox checkpoint for retry.

The account isolation finalizer also recreates its activation singleton when
absent, then verifies the complete existing access-isolation predicate.

For an already isolated deployment with missing setup records, run:

```powershell
node --env-file=.env.local scripts/repair-operational-setup.mjs --preflight
node --env-file=.env.local scripts/repair-operational-setup.mjs --apply
```

The preflight rolls back all repairs and fixtures. Apply commits only tag setup,
a missing account activation record and Facebook bindings already established
by stored user Facebook IDs. An existing disabled account flag is preserved.
It does not assign Pages, change credentials, import contacts, enable campaigns
or send messages. Backups and receipts stay under the ignored `.vercel` directory.

Verification exercises real stage-history transitions, older/duplicate events,
manual-stage protection, tag recreation, role isolation, sync leases and campaign
queue claims/completion in rolled-back fixtures. Live OAuth, webhook delivery and
actual message delivery still require separate validation.
