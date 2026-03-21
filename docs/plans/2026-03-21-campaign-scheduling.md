# Campaign Scheduling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add scheduled one-time campaigns that can target either specific contacts or a dynamic audience resolved at send time, including newly matched contacts before the cron run.

**Architecture:** Keep manual one-off sends working as-is for fixed recipient lists, but store audience rules on scheduled campaigns so a cron-triggered route can resolve matching contacts right before send time. Extract shared campaign-send logic so manual sends and cron-triggered scheduled sends use the same delivery path and status updates.

**Tech Stack:** Next.js App Router, TypeScript, Supabase, Vitest, cronjob.org-triggered GET endpoints

---

### Task 1: Add failing tests for scheduled campaign creation

**Files:**
- Create: `src/app/api/campaigns/route.test.ts`
- Modify: `src/app/api/campaigns/route.ts`
- Modify: `src/types/index.ts`

**Step 1: Write the failing test**

Add tests that prove:
- creating a scheduled campaign with `audienceMode: 'dynamic'` stores `scheduled_at`
- dynamic campaigns save include-tag, exclude-tag, and start-date rules instead of requiring precomputed `contactIds`
- specific-recipient campaigns still create `campaign_recipients` immediately

**Step 2: Run test to verify it fails**

Run: `npm test -- src/app/api/campaigns/route.test.ts`

Expected: FAIL because scheduled audience fields and route behavior do not exist yet.

**Step 3: Write minimal implementation**

Update the campaign create route to accept a payload shaped like:

```ts
{
  pageId: string,
  name: string,
  messageText: string | null,
  scheduledAt?: string | null,
  audienceMode: 'specific' | 'dynamic',
  contactIds?: string[],
  audienceRules?: {
    startDate?: string | null,
    includeTagIds?: string[],
    excludeTagIds?: string[]
  }
}
```

Persist scheduled campaigns with `status: 'scheduled'` and fixed campaigns with `status: 'draft'` unless loop logic already overrides that.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/app/api/campaigns/route.test.ts`

Expected: PASS.

### Task 2: Add failing tests for dynamic audience resolution

**Files:**
- Create: `src/lib/__tests__/campaign-audience.test.ts`
- Create: `src/lib/campaign-audience.ts`
- Modify: `src/app/api/pages/[pageId]/contacts/route.ts`

**Step 1: Write the failing test**

Add tests for a helper that resolves contact IDs for a page using:
- `startDate`
- `includeTagIds`
- `excludeTagIds`
- sendable contacts only

Include a test proving contacts are resolved when they match at execution time, not creation time.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/__tests__/campaign-audience.test.ts`

Expected: FAIL because the helper does not exist.

**Step 3: Write minimal implementation**

Create a shared helper that returns matching contact IDs and reuse the same date/tag semantics already used by the contacts API.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/__tests__/campaign-audience.test.ts`

Expected: PASS.

### Task 3: Add failing tests for cron-triggered scheduled sends

**Files:**
- Create: `src/app/api/cron/campaign-scheduled/route.test.ts`
- Create: `src/app/api/cron/campaign-scheduled/route.ts`
- Create: `src/lib/campaign-send.ts`
- Modify: `src/app/api/campaigns/[campaignId]/send/route.ts`
- Modify: `vercel.json`

**Step 1: Write the failing test**

Add tests that prove the cron route:
- rejects invalid cron secrets
- fetches due scheduled campaigns
- resolves dynamic recipients right before send
- upserts `campaign_recipients`
- calls shared send logic

**Step 2: Run test to verify it fails**

Run: `npm test -- src/app/api/cron/campaign-scheduled/route.test.ts`

Expected: FAIL because the cron route and shared send helper do not exist.

**Step 3: Write minimal implementation**

Create a cron-authenticated GET route using the same `CRON_SECRET` pattern as `src/app/api/cron/sync/route.ts`. Move the reusable send workflow into a shared helper so both manual sends and scheduled sends go through the same code path.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/app/api/cron/campaign-scheduled/route.test.ts`

Expected: PASS.

### Task 4: Add schema support for scheduled audience rules

**Files:**
- Create: `database/migration_campaign_scheduled_audience.sql`
- Modify: `database/schema.sql`
- Modify: `database/migration_complete.sql`
- Modify: `src/types/index.ts`

**Step 1: Write the failing test**

Use the API tests from Tasks 1 and 3 as the failing proof for missing stored fields.

**Step 2: Write minimal implementation**

Add campaign columns for the scheduled audience rule set, for example:

```sql
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_mode TEXT DEFAULT 'specific';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_start_date DATE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_include_tag_ids JSONB DEFAULT '[]';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_exclude_tag_ids JSONB DEFAULT '[]';
```

Keep the stored format simple so the UI and cron route can read it without extra joins.

**Step 3: Run focused tests**

Run:
- `npm test -- src/app/api/campaigns/route.test.ts`
- `npm test -- src/app/api/cron/campaign-scheduled/route.test.ts`

Expected: PASS.

### Task 5: Add scheduling and audience controls to the campaigns UI

**Files:**
- Modify: `src/app/dashboard/campaigns/page.tsx`
- Modify: `src/types/index.ts`

**Step 1: Write the failing test**

If UI tests are not practical here, use API tests plus manual verification steps as the acceptance proof.

**Step 2: Write minimal implementation**

Update the create modal to support:
- `Send now` vs `Schedule`
- a `scheduledAt` date/time input for one-time scheduled campaigns
- `Specific contacts` vs `Dynamic audience`
- `Start date`, `Include tags`, and `Exclude tags` controls for dynamic audiences
- campaign cards that show scheduled send time and audience summary

Keep the loop-campaign path intact and hide the new scheduling controls when loop mode is enabled.

**Step 3: Verify behavior**

Manual checks:
- create a draft campaign with specific contacts
- create a scheduled campaign with dynamic rules
- confirm the campaign list shows the scheduled state and timing

### Task 6: Full verification

**Files:**
- Modify: `src/app/api/campaigns/route.test.ts`
- Modify: `src/app/api/cron/campaign-scheduled/route.test.ts`
- Modify: `src/lib/__tests__/campaign-audience.test.ts`

**Step 1: Run focused suite**

Run:

```bash
npm test -- src/app/api/campaigns/route.test.ts src/app/api/cron/campaign-scheduled/route.test.ts src/lib/__tests__/campaign-audience.test.ts
```

Expected: PASS.

**Step 2: Run full suite**

Run:

```bash
npm test
```

Expected: PASS with no new failures.

**Step 3: Commit**

```bash
git add docs/plans/2026-03-21-campaign-scheduling.md src/app/api/campaigns/route.ts src/app/api/campaigns/route.test.ts src/app/api/campaigns/[campaignId]/send/route.ts src/app/api/cron/campaign-scheduled/route.ts src/app/api/cron/campaign-scheduled/route.test.ts src/app/dashboard/campaigns/page.tsx src/lib/campaign-audience.ts src/lib/__tests__/campaign-audience.test.ts src/lib/campaign-send.ts src/types/index.ts database/migration_campaign_scheduled_audience.sql database/schema.sql database/migration_complete.sql vercel.json
git commit -m "feat: schedule campaigns with dynamic audience rules"
```
