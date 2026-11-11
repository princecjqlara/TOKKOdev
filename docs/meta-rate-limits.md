# Meta rate limits and Tokko pacing

Checked against Meta's documentation on November 11, 2026:

- [Graph API rate limits](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/)
- [Messenger Platform rate limits](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview/rate-limiting/)
- [Token metadata](https://developers.facebook.com/docs/graph-api/reference/debug_token/)

Meta limits several different resources. A Tokko login is not a separate Meta
quota. Team members sending through the same saved Page token share its limits.

| Resource | Documented behavior |
| --- | --- |
| Facebook user access token | Usage is attributed to the Facebook user. Other apps can also contribute to that user's quota. Meta does not publish each user's exact allowance. |
| App | App limits are separate from user limits. An actual app throttle can affect multiple Pages. |
| Page and business use case | Page-token requests can use business-use-case limits. Headers identify business objects, use-case types, usage percentages, and estimated recovery times. |
| Messenger activity | The rolling 24-hour allowance depends on the business's engaged Messenger audience. It is not a fixed allowance for every Tokko user. |
| Endpoint and content | Messenger lists a two-request-per-second Conversations API limit per Page, a 300-request-per-second Send API ceiling for text/link/reaction/sticker messages, and ten per second for audio/video messages. |
| Conversation | Excessive sending within one conversation can trigger an additional throttle. |

These endpoint ceilings do not establish a safe sending speed for a particular
campaign. Rolling quotas, CPU/time usage, content, custom throttles, and live
responses also matter. Meta separately describes reduced Page Inbox availability
under high message volume; exceeding a documented Send API ceiling is not the
only way messaging or conversation reads can be affected.

## Error interpretation

- Code `4` identifies an app-level limit.
- Code `17` identifies a Facebook user limit, not an app-wide limit.
- Code `32` concerns the user or app used for a Pages API request.
- Code `613` identifies a custom limit whose meaning depends on the API.

Tokko retains one learned pace and one active campaign sender per Page. Confirmed
app throttles share a cooldown. Code `17` shares a cooldown only across Pages with
the same verified Facebook token owner. Business-use-case recovery is shared only
across Pages whose own Meta responses identified the same object and use-case type.
Recovery-estimate scope is kept separate from the scope of the largest reported
usage percentage, and simultaneous limits retain independent provider deadlines.

Token ownership is verified at connection time or through Meta's token debugger,
and bound to a SHA-256 fingerprint of the saved token. Rotating that token makes
the old owner proof inapplicable. Tokko never infers ownership from the employee
who pressed Send or from overlapping memberships. Business observations expire
after 24 hours. Unverified connections retain local Page cooldowns.

During a shared recovery hold, only one related Page probes that quota at a time;
unrelated Pages continue independently. The system shares cooldown and recovery
budgets, not a guessed fixed messages-per-second allowance for each Facebook user.
Live provider feedback remains authoritative. Other operations or external apps
may also contribute to those quotas.

At the actual Send API boundary, text starts are spaced by at least four
milliseconds and audio/video starts by at least 100 milliseconds. This prevents
fast responses from turning concurrency into bursts above the documented endpoint
ceilings. This gate is local to the runtime; the campaign Page lease prevents
overlapping campaign senders in different runtimes. Provider quota feedback can
require a slower pace. Pacing waits remain inside the request's send deadline.

Apply `migration_campaign_shared_quotas.sql` and
`migration_campaign_continuous_handoff.sql` before deploying the matching sender.
Use `node scripts/verify-campaign-shared-quotas.mjs` for local SQL verification,
then `node --env-file=.env.local scripts/configure-campaign-shared-quotas.mjs
--preflight --refresh-identities` and the corresponding `--apply` command to install
the functions and verify existing token owners. The installer backs up the prior
definitions and rolls back isolated fixtures without sending customer messages.

Productive slices queue a successor after saving receipts and releasing their
lease. Dispatch is deduplicated and requires eligible pending or expired-claim
work. Manual Stop, schedules, retries, and provider cooldowns remain enforced.
The minute scheduler remains a fallback if a handoff cannot be queued. A busy
worker wait is not saved as a campaign retry delay or escalated into exponential
browser backoff.
On Vercel, an in-progress browser send is registered with `waitUntil` so receipt
saves and its successor handoff can finish after the browser disconnects.
