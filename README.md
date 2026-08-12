# Tokko - Facebook Page Management

A Next.js application for managing Facebook Page contacts, tags, and messaging campaigns.

<!-- Last updated for Vercel deployment - Redeploy trigger -->

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
Create a `.env` file in the root directory:
```env
# NextAuth
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your-secret-key

# Facebook OAuth
FACEBOOK_CLIENT_ID=your-facebook-app-id
FACEBOOK_CLIENT_SECRET=your-facebook-app-secret
FACEBOOK_APP_SECRET=your-facebook-app-secret

# Supabase
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key

```

4. Set up the database:
Run the SQL schema from `database/schema.sql` in your Supabase SQL editor.
Then run `database/migration_database_retention.sql` to install bounded campaign-history retention and automatic database maintenance.
For production, also run `database/migration_database_control_plane.sql` to add schema-version tracking, database health snapshots, integrity constraints, and maintenance observability.
High-volume installations can then run `database/migration_compact_contact_interactions.sql` and its finalize migration to replace unbounded raw interaction events with compatible hourly counters.

For large campaigns, deploy the compact delivery queue in this exact order:

1. Run `database/migration_compact_campaign_delivery_prepare.sql`. It is additive and safe with the older sender.
2. Deploy the application code that uses atomic recipient claims and batch completion RPCs.
3. Confirm the new deployment is healthy, then run `database/migration_compact_campaign_delivery_finalize.sql` once. The finalizer preserves campaign totals and failures, removes completed one-time queue rows, and replaces the random recipient UUID with the `(campaign_id, contact_id)` primary key.
4. Run `database/migration_campaign_delivery_timeout_fix.sql` to make immediate claims and progress checks constant-time for fully materialized one-time campaigns.

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

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run lint` - Run ESLint

## Deployment

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
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Your Supabase anon key
   - `SUPABASE_SERVICE_ROLE_KEY` - Your Supabase service role key

5. Update Facebook App settings:
   - Add your Vercel URL to Facebook App redirect URIs:
     - `https://your-app.vercel.app/api/auth/callback/facebook`
   - Update webhook URL to:
     - `https://your-app.vercel.app/api/facebook/webhook`

6. Deploy! Vercel will automatically build and deploy your app.

### cron-jobs.org Setup

Vercel Cron is not used. Configure cron jobs in [cron-jobs.org](https://cron-jobs.org) to call the deployed API routes:

- Contact/name sync, every 30 minutes: `https://your-app.vercel.app/api/cron/sync`
- Scheduled campaigns, every minute: `https://your-app.vercel.app/api/cron/campaign-scheduled`
- Loop campaigns, every minute: `https://your-app.vercel.app/api/cron/campaign-loop`
- Follow-up automations, every minute: `https://your-app.vercel.app/api/cron/follow-up-automations`

Use `GET` requests. The page sync and campaign cron routes do not require a cron secret.

**Note:** The `vercel.json` file is configured with extended function timeouts (5 minutes) for sync operations, but does not define Vercel Cron schedules.

## License

Private project

## Repository

https://github.com/princecjqlara/TOKKOdev

