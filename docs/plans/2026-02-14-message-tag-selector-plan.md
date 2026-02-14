# Message Tag Selector Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a manual message tag selector for bulk sends and campaigns, persisting the tag on campaigns and passing it through to the Messenger payload.

**Architecture:** Introduce a small message-tag utility with validation/defaulting, add a payload builder to `sendMessage`, update APIs to accept/persist/use the tag, and add minimal UI dropdowns for selection.

**Tech Stack:** Next.js API routes, Supabase, TypeScript, Vitest.

---

### Task 1: Message Tag Utility

**Files:**
- Create: `src/lib/message-tags.ts`
- Test: `src/lib/__tests__/message-tags.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { normalizeMessageTag, isMessageTag } from '../message-tags';

describe('message tags', () => {
  it('accepts valid tags', () => {
    expect(isMessageTag('ACCOUNT_UPDATE')).toBe(true);
    expect(isMessageTag('CONFIRMED_EVENT_UPDATE')).toBe(true);
  });

  it('defaults invalid or missing tags', () => {
    expect(normalizeMessageTag(undefined)).toBe('ACCOUNT_UPDATE');
    expect(normalizeMessageTag('NOPE')).toBe('ACCOUNT_UPDATE');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/__tests__/message-tags.test.ts`
Expected: FAIL (module not found)

**Step 3: Write minimal implementation**

```ts
export const MESSAGE_TAGS = ['ACCOUNT_UPDATE', 'CONFIRMED_EVENT_UPDATE'] as const;
export type MessageTag = typeof MESSAGE_TAGS[number];
export const DEFAULT_MESSAGE_TAG: MessageTag = 'ACCOUNT_UPDATE';

export function isMessageTag(value: string | null | undefined): value is MessageTag {
  return MESSAGE_TAGS.includes(value as MessageTag);
}

export function normalizeMessageTag(value?: string | null): MessageTag {
  return isMessageTag(value) ? value : DEFAULT_MESSAGE_TAG;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/__tests__/message-tags.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/message-tags.ts src/lib/__tests__/message-tags.test.ts
git commit -m "feat: add message tag helpers"
```

### Task 2: Message Payload Builder + Tag Support

**Files:**
- Modify: `src/lib/facebook.ts`
- Test: `src/lib/__tests__/facebook-message-payload.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { buildTaggedMessagePayload } from '../facebook';

describe('buildTaggedMessagePayload', () => {
  it('uses the provided tag', () => {
    const payload = buildTaggedMessagePayload('psid', 'hello', 'CONFIRMED_EVENT_UPDATE');
    expect(payload.tag).toBe('CONFIRMED_EVENT_UPDATE');
  });

  it('defaults to ACCOUNT_UPDATE', () => {
    const payload = buildTaggedMessagePayload('psid', 'hello');
    expect(payload.tag).toBe('ACCOUNT_UPDATE');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/__tests__/facebook-message-payload.test.ts`
Expected: FAIL (export not found)

**Step 3: Write minimal implementation**

```ts
export function buildTaggedMessagePayload(
  recipientPsid: string,
  messageText: string,
  messageTag?: MessageTag
) {
  const tag = normalizeMessageTag(messageTag);
  return {
    recipient: { id: recipientPsid },
    message: { text: messageText },
    messaging_type: 'MESSAGE_TAG',
    tag
  };
}
```

Update `sendMessage` to accept `messageTag?: MessageTag` and use the builder.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/__tests__/facebook-message-payload.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/facebook.ts src/lib/__tests__/facebook-message-payload.test.ts
git commit -m "feat: add message tag payload builder"
```

### Task 3: Bulk Send API Tag Support

**Files:**
- Modify: `src/app/api/facebook/messages/send/route.ts`

**Step 1: Write the failing test**

No direct API test. Rely on `normalizeMessageTag` tests from Task 1.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/__tests__/message-tags.test.ts`
Expected: PASS (already covered)

**Step 3: Write minimal implementation**

- Accept `messageTag` from request body.
- If provided and invalid, return 400.
- Pass `messageTag` to `sendMessage`.

**Step 4: Run tests**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add src/app/api/facebook/messages/send/route.ts
git commit -m "feat: accept message tag in bulk send"
```

### Task 4: Campaign Tag Support (API + Types)

**Files:**
- Modify: `src/app/api/campaigns/route.ts`
- Modify: `src/app/api/campaigns/[campaignId]/send/route.ts`
- Modify: `src/app/api/cron/campaign-loop/route.ts`
- Modify: `src/types/index.ts`

**Step 1: Write the failing test**

No direct API test. Use existing unit tests for message tag normalization.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/__tests__/message-tags.test.ts`
Expected: PASS (already covered)

**Step 3: Write minimal implementation**

- Accept `messageTag` in campaign creation and persist to `campaigns.message_tag`.
- When sending or looping, read `campaign.message_tag` and pass to `sendMessage`.
- Update `Campaign` type to include `message_tag: MessageTag`.

**Step 4: Run tests**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add src/app/api/campaigns/route.ts src/app/api/campaigns/[campaignId]/send/route.ts src/app/api/cron/campaign-loop/route.ts src/types/index.ts
git commit -m "feat: persist message tag on campaigns"
```

### Task 5: Database Schema Updates

**Files:**
- Create: `supabase/migrations/002_add_campaign_message_tag.sql`
- Modify: `database/schema.sql`

**Step 1: Write the failing test**

No automated test for DB schema. This change is validated by runtime usage.

**Step 2: Create migration**

```sql
ALTER TABLE campaigns
  ADD COLUMN message_tag text NOT NULL DEFAULT 'ACCOUNT_UPDATE';
```

**Step 3: Update schema.sql**

Add `message_tag` to the `campaigns` table definition with the same default.

**Step 4: Run tests**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add supabase/migrations/002_add_campaign_message_tag.sql database/schema.sql
git commit -m "feat: add message_tag to campaigns"
```

### Task 6: UI Tag Selector (Bulk + Campaigns)

**Files:**
- Modify: `src/app/dashboard/contacts/page.tsx`
- Modify: `src/app/dashboard/campaigns/page.tsx`

**Step 1: Write the failing test**

No UI tests available. Manual verification only.

**Step 2: Implement minimal UI changes**

- Add a dropdown in the bulk send modal to select tag.
- Add a dropdown in the campaign creation modal to select tag.
- Include `messageTag` in the respective API payloads.
- Default to `ACCOUNT_UPDATE`.

**Step 3: Manual check**

- Open bulk send modal: ensure selector appears and default is `ACCOUNT_UPDATE`.
- Create campaign: ensure selector appears and is saved.

**Step 4: Run tests**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add src/app/dashboard/contacts/page.tsx src/app/dashboard/campaigns/page.tsx
git commit -m "feat: add message tag selectors"
```

### Task 7: Final Verification

**Step 1: Run full test suite**

Run: `npm test`
Expected: PASS

**Step 2: Manual send validation**

- Send a test message with each tag and verify the tag is passed in the payload logs.

**Step 3: Commit (if needed)**

```bash
git status -sb
```

---
