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
worker authentication, expired Page connections, and temporary account failures.

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

For original Facebook parent users and their email/password team subaccounts, follow [the account rollout guide](docs/page-member-accounts.md). Subaccounts support overlapping multi-Page access and optional scheduled deletion. Apply the account migrations before application code, configure authenticated workers, and finalize shared-database isolation before enabling production subaccounts. Email delivery is optional for parent-created initial-password accounts.

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
   - `CRON_SECRET` - A private random secret shared only with your external scheduler

5. Update Facebook App settings:
   - Add your Vercel URL to Facebook App redirect URIs:
     - `https://your-app.vercel.app/api/auth/callback/facebook`
   - Update webhook URL to:
     - `https://your-app.vercel.app/api/facebook/webhook`

6. Deploy! Vercel will automatically build and deploy your app.

### cron-jobs.org Setup

Vercel Cron is not used. Configure cron jobs in [cron-jobs.org](https://cron-jobs.org) to call the deployed API routes:

- Contact/name sync, every 30 minutes: `https://your-app.vercel.app/api/cron/sync`
  Each call advances a saved contact-import batch; the existing minute follow-up
  worker also advances imports between these runs.
- Scheduled campaigns, every minute: `https://your-app.vercel.app/api/cron/campaign-scheduled`
- Loop campaigns, every minute: `https://your-app.vercel.app/api/cron/campaign-loop`
- Follow-up automations, every minute: `https://your-app.vercel.app/api/cron/follow-up-automations`
- Conversation export worker, every minute: `https://your-app.vercel.app/api/cron/exports`

Use `GET` requests and configure the HTTP header `Authorization: Bearer <CRON_SECRET>`
on every job, using the same secret as the deployed environment. Requests without
that header return `401`; missing server configuration returns `503`. Check each
job's execution history after changing deployment settings. A failed or disabled
scheduler stops background sync, campaign continuation, and follow-ups.

Bulk sends save their background continuation before returning the prepared
campaign. Both sending screens retry temporary network failures, gateway
timeouts, and service errors automatically, and wait for Meta cooldowns before
continuing. They resume the same campaign and retain completed recipient
results. Stop still pauses delivery; Page authorization and template errors
remain visible when they require a repair. The minute campaign scheduler is
required to continue sending after the browser closes.

The faster sender grows from 25 to 50 to 100 active recipients on healthy Pages,
refills each worker as soon as it finishes, uses no artificial delay between
healthy batches, and groups optional audit
writes into 250-message chunks after saving delivery results. Browser requests
process as many recipients as fit in their 45-second slice instead of stopping
at 500. On Vercel, the campaign cron acknowledges the scheduler immediately and
keeps its delivery work alive for up to 210 seconds using `waitUntil`, within
the configured five-minute function lifetime. Other hosts keep the short
synchronous worker response. Up to four different Pages can make progress in
one cron run; a shared lease prevents overlapping senders for the same Page.
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

