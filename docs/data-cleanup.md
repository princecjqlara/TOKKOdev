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
