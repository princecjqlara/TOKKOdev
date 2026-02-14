# Message Tag Selector Design

## Goal
Add a manual tag selector for bulk sends and campaigns so the user explicitly chooses `ACCOUNT_UPDATE` or `CONFIRMED_EVENT_UPDATE` per send. The selected tag should be used in the Messenger payload and stored on campaigns for later sends.

## Context
Facebook allows message tags outside the 24-hour window only when the content matches the allowed use case. The system already uses `MESSAGE_TAG` with `ACCOUNT_UPDATE`; failures indicate content non-compliance, not missing tags. We will not implement automatic tag fallback.

## Decisions
- Manual selector only (no automatic detection or fallback).
- Default to `ACCOUNT_UPDATE` for backward compatibility.
- No extra warning copy in the UI (minimal changes requested).

## Data Model
- Add `campaigns.message_tag` with default `ACCOUNT_UPDATE`.
- Update `Campaign` type to include `message_tag`.

## API Changes
- `POST /api/facebook/messages/send`: accept optional `messageTag` and validate against allowed values; default to `ACCOUNT_UPDATE`.
- `POST /api/campaigns`: accept `messageTag` and persist to `campaigns.message_tag`.
- `POST /api/campaigns/[campaignId]/send` and `POST /api/cron/campaign-loop`: read `campaign.message_tag` and pass through to send.
- `sendMessage` helper: accept `messageTag` param and set `tag` in the Messenger payload.

## UI Changes
- Bulk send modal in `src/app/dashboard/contacts/page.tsx`: add dropdown for `ACCOUNT_UPDATE` or `CONFIRMED_EVENT_UPDATE`, defaulted to `ACCOUNT_UPDATE`.
- Campaign create modal in `src/app/dashboard/campaigns/page.tsx`: add dropdown and store selection with the campaign.

## Error Handling
- Invalid tag values return a 400 error in bulk send API.
- If tag is missing in older campaigns, fall back to `ACCOUNT_UPDATE`.
- Facebook policy errors remain surfaced as send failures.

## Testing
- Unit tests for tag validation/defaulting.
- Unit test for `sendMessage` payload uses selected tag.

## Out of Scope
- Automated compliance checks of message content.
- Sponsored Messages or OTN implementation.
