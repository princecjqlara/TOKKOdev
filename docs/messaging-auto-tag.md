# Messenger lead and order tags

Contact imports, Page message echoes, and background polling use the same tagger.
Only contacts with a real inbound message in the last seven days are eligible.
Outbound events never create a contact or extend that window.

| Page-authored Messenger record | Page tag |
| --- | --- |
| Lead stage set to Qualified | Qualified |
| Lead stage set to Converted | Converted |
| Lead stage set to Unqualified or Not Qualified | Not Qualified |
| Lead stage set to Lost | Lost |
| Order created or payment requested, with a Messenger invoice link | Converted |

Tags accumulate: a contact can have multiple stage and custom tags. No existing
assignment is removed, and repeated events cannot create duplicate assignments.
Customer-authored stage text and ordinary payment claims are ignored. An order
record is not a payment confirmation. Tag checks do not send messages or create
Messenger invoices.

The Page's **Messaging lead auto-tag** switch in Settings controls imports,
automatic sync, echoes, and polling. The Contacts **Auto-tag** checkbox can also
skip tagging for one manual sync; that choice persists across its continuation
requests. It cannot override a disabled Page setting.

The existing cron-jobs.org minute job calls
`/api/cron/follow-up-automations`. That same authenticated invocation starts
auto-tag polling alongside follow-ups; no additional scheduler job or request
to `/api/cron/messaging-auto-tag` is needed. Follow-up failures cannot skip the
tag worker, and individual Page failures do not stop other Pages. The response
includes `messagingAutoTag.pages`, `conversations`, `tagged`, and `errors` for
checking progress. Campaign continuation starts alongside follow-ups through
the shared campaign worker. Slow or failed follow-ups cannot skip campaign
recovery, and no nested HTTP request is needed to resume saved recipients.

The scheduler claims each enabled Page at most once a minute and skips
Pages with no eligible contacts. Each slice reads at most ten recently updated
conversations and checks the contacts' inbound window before reading message
history, with at most three history requests in flight. Its history cutoff is
the later of the last checkpoint and seven days ago. Leases prevent overlapping
pollers. A failed history or tag write preserves the checkpoint for retry.

Manual imports reuse up to 500 messages already fetched for names and contact
timing. Automatic imports fetch tag history only for recently updated threads.
Group conversations are skipped. Contacts refresh from the shared database;
opening Contacts does not start another Facebook import. All Page members see
the same contacts and Page tags; private personal tags retain their access rules.

Contacts reads use the shared database, including the tags saved by the
scheduler, message echoes, and imports. They do not dispatch Meta scans or need
the Contacts screen left open. The Contacts screen refreshes saved contacts and
tags every 15 seconds while visible. Disabled Pages do not fetch tag history.

Every tag relation is read using bounded contact-ID batches and database
pagination, preserving multiple tags on large result sets. A tag lookup failure
fails the contact refresh so the UI keeps its previous data instead of clearing
tags. A Messenger scan failure keeps its checkpoint for the next scheduler
invocation. Contact responses are private and not cached.

Apply `database/migration_messaging_lead_stage_tags.sql` after worker coordination
and default-tag repair. It renames Paid / Availed Service to Converted and
Unqualified to Not Qualified, preserving their IDs and existing assignments.
Those legacy positive assignments cannot distinguish past Qualified events from
orders; the recent window is scanned again to add the correctly named tags.
Missing tags are repaired with `ensure_page_default_tags`.

`node --env-file=.env.local scripts/repair-operational-setup.mjs --preflight`
verifies the migration and rolls back fixtures. `--apply` backs up definitions
and metadata before committing the repair. The optional standalone diagnostic
endpoint `/api/cron/messaging-auto-tag` requires the configured CRON_SECRET
bearer token. Regular polling uses the existing follow-up scheduler instead.
Rejected Facebook Page tokens require reconnecting the affected Page.
