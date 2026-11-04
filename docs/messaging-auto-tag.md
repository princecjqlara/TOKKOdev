# Messenger lead and order tags

Contact sync checks Page-authored Messenger system records while importing
contact history. The background auto-tag worker and Page message echoes use the
same tag assignment code.

| Messenger record | Page tag |
| --- | --- |
| Lead stage set to Qualified | Paid / Availed Service |
| Lead stage set to Converted | Paid / Availed Service |
| Lead stage set to Unqualified or Not Qualified | Unqualified / existing Not Qualified |
| Order created or payment requested, with a Messenger invoice link | Paid / Availed Service |

Assignments preserve the existing cumulative history: a contact may have both
outcome tags if both events occurred. Manual and unrelated tags stay in place.
Repeated syncs use duplicate-safe assignments. Customer-authored text and ordinary
payment claims do not qualify. Order-created records indicate an order exists;
they do not independently verify payment. TOKKO reads these records and does not
create Messenger invoices or send messages during tag checks.

The Page's **Messaging lead auto-tag** switch controls all three paths. Missing
default tags are restored with `ensure_page_default_tags`. Manual and scheduled
contact imports check up to the 500 most recent messages per conversation; full
contact sync also checks events older than the background worker's checkpoint
within that history window. Group conversations with more than one customer are
skipped to avoid assigning one person's outcome to someone else.

Failed contact history or tag writes are reported as failed contacts. Manual sync
retains its previous checkpoint, including failures on earlier cursor pages, so
a later sync can retry. The Contacts screen reloads tags after sync and reports
unfinished work. The background worker keeps its own cursor and checkpoint on
failure and catches up on the next scheduler run.

The existing follow-up automation minute job runs the background tag worker.
The separate `/api/cron/messaging-auto-tag` endpoint requires the configured
`CRON_SECRET` bearer token. A Page token rejected by Facebook must be refreshed by
reconnecting that Page.
