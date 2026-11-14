# Tokko - Facebook Page Management

A Next.js application for managing Facebook Page contacts, tags, and messaging campaigns.

## Features

- 🔐 Facebook OAuth authentication
- 📱 Connect and manage multiple Facebook Pages
- 👥 Contact management with bulk operations
- 🏷️ Tag management for organizing contacts
- 📨 Campaign creation and bulk messaging
- 🔄 Automatic contact synchronization via webhooks
- 📊 Dashboard with statistics and insights

## Tech Stack

- **Framework:** Next.js 14.1.0 (App Router)
- **Authentication:** NextAuth.js
- **Database:** Supabase
- **Styling:** Tailwind CSS
- **Icons:** Lucide React

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn
- Supabase account
- Facebook App credentials

### Installation

1. Clone the repository:
```bash
git clone https://github.com/princecjqlara/TOKKOdev.git
cd TOKKOdev
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
Create a `.env.local` file in the root directory:
```env
# NextAuth
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your-secret-key

# Facebook OAuth
FACEBOOK_CLIENT_ID=your-facebook-app-id
FACEBOOK_CLIENT_SECRET=your-facebook-app-secret
FACEBOOK_APP_SECRET=your-facebook-app-secret

# Supabase
SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key

```

4. Set up the database:
Run the SQL schema from `database/schema.sql` in your Supabase SQL editor.
Then run `database/migration_database_retention.sql` to install bounded campaign-history retention and automatic database maintenance.
Run `database/migration_durable_contact_import.sql` after `migration_database_control_plane.sql` and `migration_contact_sync_load_control.sql`
before deploying resumable contact imports. It scans Inbox, Requests, Done, and
Spam and saves contacts with each cursor checkpoint in one transaction.
For production, also run `database/migration_database_control_plane.sql` to add schema-version tracking, database health snapshots, integrity constraints, and maintenance observability.
Run `database/migration_conversation_export_jobs.sql` to enable durable background conversation exports and the Exports download page.
Run `database/migration_page_worker_coordination.sql` before deploying the coordinated campaign and Messenger auto-tag workers. It adds Page-level sending leases, shared Meta rate-limit cooldowns, and stable auto-tag scan checkpoints. See `docs/ads-guard.md` for Ads Guard setup and decision rules.
Run `database/migration_repair_default_page_tags.sql` before deploying automatic recovery of missing Page tags. It restores only required tag definitions and preserves contact assignments and sync checkpoints. See [data cleanup and recovery](docs/data-cleanup.md) before resetting application data.
High-volume installations can then run `database/migration_compact_contact_interactions.sql` and its finalize migration to replace unbounded raw interaction events with compatible hourly counters.

For large campaigns, deploy the compact delivery queue in this exact order:

1. Run `database/migration_compact_campaign_delivery_prepare.sql`. It is additive and safe with the older sender.
2. Deploy the application code that uses atomic recipient claims and batch completion RPCs.
3. Confirm the new deployment is healthy, then run `database/migration_compact_campaign_delivery_finalize.sql` once. The finalizer preserves campaign totals and failures, removes completed one-time queue rows, and replaces the random recipient UUID with the `(campaign_id, contact_id)` primary key.
4. Run `database/migration_campaign_delivery_timeout_fix.sql` to make immediate claims and progress checks constant-time for fully materialized one-time campaigns.
5. Run `database/migration_campaign_delivery_recovery.sql` to pace delivery after Meta throttling and convert historical manual holds into resumable drafts.
6. Run `database/migration_campaign_delivery_throughput.sql` with the faster sender to raise healthy Page capacity to 25 parallel recipients. Pages recovering from throttles retain their smaller shared budgets and cooldowns.
7. Run `database/migration_campaign_delivery_parallel.sql` for the rolling sender. Healthy Pages can use up to 100 active recipient workers, while the application claims at most 500 rows at a time and saves completed results in groups of 50. Older senders retain their lower application limit.
8. Run `database/migration_campaign_delivery_adaptive.sql` before deploying the quota-aware sender. It persists learned concurrency and message spacing, shares application-wide cooldowns, and starts unknown Pages conservatively without resetting existing recipients or recovery windows.
9. After deploying the public campaign worker, run `database/migration_campaign_worker_schedule.sql` to continue saved campaigns automatically through the existing database scheduler. It installs `pg_net` and one minute job, dispatches only eligible queues on idle Pages, and needs no scheduler account or credentials. The migration targets the canonical `tokkobeta.vercel.app` deployment; update its URL before using it for a different installation. `node --env-file=.env.local scripts/configure-campaign-scheduler.mjs --preflight` verifies 24 dispatch and recovery checks with rolled-back fixtures; `--apply` backs up the previous named job and installs the verified schedule.
10. Run `database/migration_campaign_delivery_recovery_pace.sql` before deploying the recovery-aware sender. It retains conservative Page budgets for ten minutes after a saved cooldown, shares recovery pacing after app throttles, and returns the same absolute recovery deadline to later workers. It adds no tables or columns and preserves existing recipients, retry windows, and active leases. Verify its SQL locally with `node scripts/verify-campaign-recovery-pacing.mjs` using the optional PGlite tooling installed below.
11. Run `database/migration_campaign_delivery_idle_probe.sql` to let slow Pages probe from five workers and 100ms spacing when their feedback, last throttle, and cooldown have all been stale for thirty minutes. Active leases, provider cooldowns, and fresh recovery budgets remain enforced. Healthy learned speeds remain unchanged. Verify locally with `node scripts/verify-campaign-idle-probe.mjs`; `node --env-file=.env.local scripts/configure-campaign-idle-probe.mjs --preflight` checks the live function with rolled-back fixtures, and `--apply` backs up the existing definition before installing it.
12. Before deploying the shared-quota sender, run `node scripts/verify-campaign-shared-quotas.mjs`, then `node --env-file=.env.local scripts/configure-campaign-shared-quotas.mjs --preflight --refresh-identities` and the corresponding `--apply --refresh-identities` command. It installs `migration_campaign_shared_quotas.sql` and `migration_campaign_continuous_handoff.sql`, verifies token ownership through Meta, and keeps prior pacing definitions behind service-only wrappers. User and business cooldowns affect verified related Pages, while unrelated Pages continue independently. Productive slices queue a successor without waiting for the minute cron. Do not reapply older acquisition/feedback migrations over these wrappers. The worker URL defaults to the canonical `tokkobeta.vercel.app` deployment; configure `app_private.campaign_worker_configuration` for a different installation.

Do not run the finalizer before step 2. Older senders calculate progress from terminal queue rows that the finalizer intentionally removes.

5. Run the development server:
```bash
npm run dev
```

6. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Facebook Setup

See `FACEBOOK_SETUP.md` for detailed instructions on setting up Facebook OAuth and webhooks.

## Project Structure

```
src/
├── app/
│   ├── api/              # API routes
│   ├── dashboard/       # Dashboard pages
│   ├── error.tsx        # Error boundary
│   ├── global-error.tsx # Global error boundary
│   └── not-found.tsx   # 404 page
├── components/          # React components
├── lib/                 # Utility functions
└── types/               # TypeScript types
```

## Development

See [sync and sign-in recovery](docs/sync-and-signin-troubleshooting.md) for
worker scheduling, expired Page connections, and temporary account failures.

Contact imports also refresh Messenger lead-stage and order-created tags. See
[Messenger auto-tag behavior](docs/messaging-auto-tag.md) for event mappings,
history limits, Page settings, and retry behavior.

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run lint` - Run ESLint
- `npm test` - Run application tests

The `scripts/` directory contains supported TOKKO tools for account activation,
Page access verification, template review, database usage auditing, and recovery.
Generated exports and review progress belong in the ignored `outputs/` directory.
Keep local credentials, backups, and deployment receipts under the ignored
`.vercel/` directory. Client-specific analysis scripts and conversation dumps are
outside this application's source tree.

## Deployment

For the private administrator login, account overview, and subaccount password
resets, follow [private account administration](docs/system-admin.md). This uses
separate server credentials and requires `database/migration_system_admin.sql`.
Hosts without administrator environment variables can use the protected database
configuration in `database/migration_system_admin_login.sql` through that guide.
Apply `database/migration_system_admin_management.sql` before deploying admin
account deletion, status/lifetime controls, and the additional account filters.

For original Facebook parent users and their email/password team subaccounts, follow [the account rollout guide](docs/page-member-accounts.md). Subaccounts support overlapping multi-Page access and optional scheduled deletion. Apply the account migrations before application code, configure scheduled workers, and finalize shared-database isolation before enabling production subaccounts. Email delivery is optional for parent-created initial-password accounts.

### Vercel Deployment

1. Push your code to GitHub (already done)
2. Go to [Vercel](https://vercel.com) and sign in with GitHub
3. Click "New Project" and import your repository: `princecjqlara/TOKKOdev`
4. Configure environment variables in Vercel dashboard:
   - `NEXTAUTH_URL` - Your Vercel deployment URL (e.g., `https://your-app.vercel.app`)
   - `NEXTAUTH_SECRET` - Generate a random secret
   - `FACEBOOK_CLIENT_ID` - Your Facebook App ID
   - `FACEBOOK_CLIENT_SECRET` - Your Facebook App Secret
   - `FACEBOOK_APP_SECRET` - Your Facebook App Secret
   - `NEXT_PUBLIC_SUPABASE_URL` - Your Supabase project URL
   - `SUPABASE_URL` - The server's Supabase project URL; use the same project as the public URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Your Supabase anon key
   - `SUPABASE_SERVICE_ROLE_KEY` - Your Supabase service role key

5. Update Facebook App settings:
   - Add your Vercel URL to Facebook App redirect URIs:
     - `https://your-app.vercel.app/api/auth/callback/facebook`
   - Update webhook URL to:
     - `https://your-app.vercel.app/api/facebook/webhook`

6. Deploy! Vercel will automatically build and deploy your app.

### cron-jobs.org Setup

Vercel Cron is not used. With `migration_campaign_worker_schedule.sql` installed,
saved campaigns continue through the database's `tokko-campaign-delivery` minute
job even when the browser or external scheduler stops. It waits for Page leases,
retry windows, cooldowns, and scheduled recipient times. Existing cron-job.org
campaign calls can coexist through the same delivery leases, but are optional
for campaign continuation once the database job is enabled.

Enabled Messenger lead tags can also recover when the external scheduler stops.
After worker coordination and shared quotas, install
`database/migration_messaging_auto_tag_schedule.sql` using
`node --env-file=.env.local scripts/configure-messaging-auto-tag-scheduler.mjs --preflight`
and then `--apply`. The database fallback queues at most three standalone tag
workers per minute for Pages with no attempt for five minutes, respecting
leases, cooldowns, and the recent inbound window. It sends no Facebook messages.
See [Messenger auto-tag behavior](docs/messaging-auto-tag.md) for verification.

Saved contact imports and conversation exports also have a database fallback in
`database/migration_saved_data_worker_schedule.sql`. After durable imports and
shared quotas are installed, verify the deployed `/api/cron/sync` and
`/api/cron/exports` workers, then run
`node --env-file=.env.local scripts/configure-saved-data-workers.mjs --preflight`
and `--apply`. The named minute job queues at most one request for each worker
when a saved job has been idle for five minutes. It respects leases, retry
windows, import Meta cooldowns, and export expiry. Healthy primary polling
leaves it idle. This fallback does not send Facebook messages or run follow-ups.

Configure the other background jobs in [cron-job.org](https://cron-job.org) to call
the deployed API routes:

- Contact/name sync, every 30 minutes: `https://your-app.vercel.app/api/cron/sync`
  Each call advances a saved contact-import batch; the existing minute follow-up
  worker also advances imports between these runs.
- Scheduled campaigns, every minute: `https://your-app.vercel.app/api/cron/campaign-scheduled`
- Loop campaigns, every minute: `https://your-app.vercel.app/api/cron/campaign-loop`
- Follow-up automations, every minute: `https://your-app.vercel.app/api/cron/follow-up-automations`
- Conversation export worker, every minute: `https://your-app.vercel.app/api/cron/exports`

Use `GET` requests with the URL alone. All `/api/cron/*` endpoints are public:
no sign-in, Authorization header, random key, or `CRON_SECRET` environment variable
is required. Existing scheduler headers and an old `CRON_SECRET` value are ignored.
Deploy this version before switching an older installation to public workers.
Check each job's execution history and re-enable jobs disabled after repeated
failures. Periodic sync triggers, loop campaigns, and follow-ups still require
the external scheduler. Installed database fallback jobs keep saved campaigns,
imports, exports, and enabled Messenger tag scans moving.

Bulk sends save their background continuation before returning the prepared
campaign. Both sending screens retry temporary network failures, gateway
timeouts, and service errors automatically, and wait for Meta cooldowns before
continuing. They resume the same campaign and retain completed recipient
results. Stop still pauses delivery; Page authorization and template errors
remain visible when they require a repair. The minute database job or external
campaign scheduler is required to continue sending after the browser closes.

The sender learns each Page's available capacity, up to 100 active recipients.
See [Meta rate limits and pacing](docs/meta-rate-limits.md) for the distinction
between Facebook user, app, Page, business-use-case, and conversation limits.
It starts unknown Pages at five workers with 100ms message spacing, increases
speed after sustained clean responses, and reduces both concurrency and message
rate when Meta usage rises. It reads `X-App-Usage`, `X-Page-Usage`,
`X-Business-Use-Case-Usage`, and `Retry-After` when available. App-level throttles
share their cooldown across Pages; Page-level throttles stay local. The sender
continues at a conservative one message every five seconds when successful
responses report full usage, while actual throttles and explicit provider delays
still defer delivery. Normal slice deadlines hand off pending work without an
extra service-error cooldown. Started multipart recipients finish before that
handoff. Manually stopped campaigns display Paused. The learned pace survives
worker restarts. It refills each free worker slot and groups audit
writes into 250-message chunks after saving delivery results. During recovery,
workers retain the saved pace instead of ramping up again on the first clean
responses. Reporting the same throttle repeatedly does not extend its cooldown.
The recovery hold expires ten minutes after the saved cooldown; subsequent
clean responses can gradually increase speed again. Slow workers collect enough
clean responses to recover within short browser slices even without usage headers.
Recipient-specific rejections also supply quota feedback and capacity samples;
they remain failed recipients and are never counted as deliveries. Slow pacing
with no fresh feedback, throttle, or cooldown for thirty minutes starts the next
worker from conservative defaults instead of retaining an old five-second delay.
Recovery probes increase speed at most once every fifteen seconds after the hold,
avoiding a rapid return to the previous burst. Each fetch can supply five contacts
per worker even at one active worker, reducing database waits at low speeds.
Slow queues save available receipts and check Stop about every five seconds;
healthy queues retain their 50-recipient checkpoints. Prefetched contacts still pass
through the learned concurrency and message spacing. Browser requests
process as many recipients as fit in their 45-second slice instead of stopping
at 500. On Vercel, the campaign cron acknowledges the scheduler immediately and
keeps its delivery work alive for up to 210 seconds using `waitUntil`, within
the configured five-minute function lifetime. Other hosts keep the short
synchronous worker response. Up to four different Pages can make progress in
one cron run; a shared lease prevents overlapping senders for the same Page.
Productive slices save receipts and release their lease before queuing a successor
through the database. Dispatch skips Stop, future schedules, cooldowns, active
workers, and queues containing only fresh claims; repeated handoffs are deduplicated.
The minute scheduler remains a fallback. Normal worker contention does not save
an extra campaign retry delay or increase the browser's service-error backoff.
Recipient claims, manual Stop, and shared Meta
recovery windows still apply. A later scheduler tick resumes any remaining work.

Campaigns opens across all assigned Pages. Bulk send status and History link
directly to the saved campaign, bypassing Page, date, and pagination filters.
A failed status lookup displays a retry message instead of an empty list.

To verify a large queue without contacting Facebook or modifying production,
install the optional local test tool and run the SQL stress check:

```powershell
npm install --prefix outputs/campaign-scale-tools --no-save --package-lock=false --ignore-scripts @electric-sql/pglite
node scripts/verify-campaign-scale.mjs
node scripts/verify-campaign-throughput.mjs
```

The default fixture contains 2,000,005 contacts. It verifies bounded claims,
worker restart, expired claim recovery, recipient failures, exact counters, and
complete draining without duplicate completed recipients. It removes its local
database afterward. This checks queue correctness, not Facebook throughput or
delivery permission for every recipient.
The throughput check executes the new Page budget migration locally and checks
lease exclusivity, shared cooldowns, strike-based reduction, expired worker
recovery, and administrative function permissions. The sender tests also include
a synthetic latency benchmark for old pacing versus the faster batch path.

**Note:** The `vercel.json` file is configured with extended function timeouts (5 minutes) for sync operations, but does not define Vercel Cron schedules.

## License

Private project

## Repository

https://github.com/princecjqlara/TOKKOdev

