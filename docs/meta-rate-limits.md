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
app throttles share a cooldown. User, Pages API, and custom errors stay local to
the saved Page connection instead of being broadened solely because an app-usage
header is also present. Recovery-estimate scope is kept separate from the scope
of the largest reported usage percentage.

The current coordination model does not persist the verified Facebook user or
Meta business object behind every saved Page token. Consequently it does not
fully aggregate a user/business quota across multiple related Pages. It must not
infer token ownership from the Tokko employee who pressed Send or from overlapping
Page memberships. Token metadata can identify the originating Facebook user when
that information is available. Unknown ownership remains scoped to the affected
Page connection, and further provider throttles are still honored.

Deploy the sender update to activate the corrected error/estimate interpretation.
This change needs no database migration and does not clear saved cooldowns.
