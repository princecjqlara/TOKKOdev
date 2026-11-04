# Follow-up delivery windows

The Follow-up Workflow editor previews the route for each step by adding its
delay to all preceding delays. Each interval can be up to 365 days. A step at
the seven-day boundary or later requires the user to select an approved utility
template and fill its parameters. The edge includes a one-minute safety margin.
Earlier steps can have an optional template fallback for delayed scheduler runs.
No template is picked automatically.
An optional **Always use this template** setting sends a selected template even
when a reply window is open.

At send time the worker checks `contacts.last_inbound_at`, never the Page's last
outbound activity. Within 24 hours it uses RESPONSE; from there until the safe
seven-day boundary it selects HUMAN_AGENT. Beyond that, or when the inbound
timestamp is unknown or invalid, it must use the selected utility template.
Human Agent access must be approved for the app and is intended for human-handled
support under Meta's messaging rules; the time check does not establish that a
particular message qualifies.

POST, PATCH, and enabling an older workflow all validate the cumulative delays
and selected templates on the authorized Page. The sender checks approval again
before using a template and personalizes each parameter. Supported templates
have a fixed or numbered-parameter body, optional fixed text/image/video header,
and no dynamic buttons. An image/video must match the chosen template's header;
the worker never appends free-form attachments outside the reply window.

Missing selections stop a due contact with `template_required`. A template that
is no longer approved, has missing parameter values, or has mismatched media
stops it with `template_unavailable`. Edit the workflow and explicitly reset
progress after fixing its configuration. Existing manual stop codes and reply
actions remain in effect.

Template name, language, and values are stored with each step in the existing
`workflow_automations.steps` JSONB column. Apply
`database/migration_follow_up_template_delays.sql` to raise the legacy first-delay
constraint from seven to 365 days. Run
`node --env-file=.env.local scripts/verify-follow-up-delivery.mjs --preflight`
for rollback-only database checks, then `--apply` to commit the constraint update.
Tests mock all outbound sends; verification must not message real contacts.
