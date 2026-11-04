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

The minute scheduler claims each enabled Page at most once a minute and skips
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

Apply `database/migration_messaging_lead_stage_tags.sql` after worker coordination
and default-tag repair. It renames Paid / Availed Service to Converted and
Unqualified to Not Qualified, preserving their IDs and existing assignments.
Those legacy positive assignments cannot distinguish past Qualified events from
orders; the recent window is scanned again to add the correctly named tags.
Missing tags are repaired with `ensure_page_default_tags`.

`node --env-file=.env.local scripts/repair-operational-setup.mjs --preflight`
verifies the migration and rolls back fixtures. `--apply` backs up definitions
and metadata before committing the repair. The standalone polling endpoint
`/api/cron/messaging-auto-tag` requires the configured CRON_SECRET bearer token.
Rejected Facebook Page tokens require reconnecting the affected Page.
