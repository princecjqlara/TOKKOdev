# Current TOKKO environment

Verified 20 November 2026 PHT. This is the current configuration reference. Older rollout reports describe historical states.

| Setting | Current value |
| --- | --- |
| Maintained local checkout | `C:/Users/Cj Lara/Downloads/tokkodev` |
| Git repository | `princecjqlara/TOKKOdev`, branch `main` |
| Vercel project | `tokk-odev` |
| Vercel project ID | `prj_Zc9SBnESJk8KHdvOJ6PwuAsMgXDt` |
| Vercel team | `bigclicklara-2607s-projects` |
| Live origin | `https://tokkobeta.vercel.app` |
| Supabase project | `ucirfbweulbvjxmvtiox` |

Non-secret identifiers live in `config/deployment.json`. The ignored `.vercel/project.json` must match them. The similarly named `Downloads/sunobot/tokkodev` checkout contains historical code and analysis; its obsolete database variables were removed after an encrypted backup. Do not source deployment settings from it or from Suno/Veo environments.

## Environment files

The maintained ignored `.env.local` is aligned with the 18 production settings in Vercel. Database variables also match Production, Preview and Development scopes. Local-only `NODE_ENV=development` is intentional. Session/cron values were copied from the existing production configuration rather than rotated. Debug logging is disabled.

Administrator email/hash overrides are unset locally and in production. Both use the enabled protected database configuration through the service-only `tokko_system_admin_credentials` RPC. Missing administrator environment variables do not mean administrator setup is missing.

`.env.example` documents the variables without credentials. It uses a localhost auth origin for a new development setup. The maintained diagnostics environment retains the production origin. For browser development, put a localhost `NEXTAUTH_URL` override in ignored `.env.development.local`; keep the registered Facebook callback in mind when testing OAuth. The checker permits a localhost auth origin and checks the hosted callback independently.

The approved eight-variable database export in `.vercel/database-switch-ucir/vercel-production.env` remains private and matches production. Historical `.vercel` exports and migration backups are evidence, not current configuration sources. Do not bulk-import them.

## Required database variables

- `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_URL` must both use `https://ucirfbweulbvjxmvtiox.supabase.co`.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_ANON_KEY` hold the matching publishable key.
- `SUPABASE_SERVICE_ROLE_KEY` holds the matching backend secret. Never expose it in client code.
- `DATABASE_URL`, `DATABASE_POOLER_URL_5432` and `DATABASE_POOLER_URL_6543` must identify the same project through their host or pooler username.

The server-only URL takes priority in current server clients. Updating only the public URL is insufficient. Public values are compiled into browser JavaScript, so changed hosted environment settings require a redeploy.

Existing OAuth, NVIDIA and webhook settings remain in place. Worker routes in the current application are intentionally public; the retained `CRON_SECRET` is not an authentication requirement for these workers. See [worker behavior](sync-and-signin-troubleshooting.md).

## Check before using or deploying

```powershell
npm run env:check
npm run env:check:vercel
```

The first checks effective local configuration and the Vercel link. The second also compares production values without printing them, checks all three database scopes, verifies the active deployment, and performs bounded read-only database/administrator checks. A failure names the check or key, never its secret value. Refresh an expired CLI session with `vercel whoami`, then rerun the checker.

Neither command invokes workers, sends messages, updates records or changes billing. Keep environment files, backup keys and raw exports ignored. Commit only templates, checker code and non-secret configuration.

## Database release state

The diagnostics migration `20261117_001` is installed, including `campaigns.failure_counts`, `campaigns.last_error_diagnostic`, `campaign_delivery_failures.diagnostic` and atomic completion metadata. PostgREST schema-cache reads passed. The latest audit found all 20 directly referenced tables, 38 RPC names and 68 checked migration-added columns. The repair passed 28 SQL checks and 129 focused sender/reporting tests, preserving saved campaign states, queues and provider cooldowns.

The operational repair receipts are in `Downloads/sunobot/outputs/tokk-odev-campaign-repair-2026-11-20`. They contain status/counts, not credentials. Meta rate limits remain provider cooldowns; do not clear them or manually replay recipients as a configuration repair.
