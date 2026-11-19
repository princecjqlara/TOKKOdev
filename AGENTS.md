# TOKKOdev environment and deployment

This maintained repository deploys to Vercel **tokk-odev** at **https://tokkobeta.vercel.app**. Read [docs/environment.md](docs/environment.md) and `config/deployment.json` before changing environment settings or deploying.

- The maintained local checkout is `C:/Users/Cj Lara/Downloads/tokkodev`. The similarly named checkout inside `Downloads/sunobot` is historical and is not an environment source.
- TOKKO uses Supabase **ucirfbweulbvjxmvtiox**. Never substitute the former shared database or Suno/Veo database settings.
- Run `npm run env:check` before local work and `npm run env:check:vercel` before deployment. Both report configuration status without printing secrets.
- Keep `.env.local`, `.vercel`, backups, raw database rows and credentials private. Commit only templates and non-secret deployment metadata.
- Administrator credentials come from the protected database; do not add partial local administrator overrides.
- Before deploying SQL-dependent code, check its migration ledger and apply only missing compatible migrations with backup and rollback preflight. Do not reapply older queue migrations over current functions.
- Preserve customer records, queued recipients, manual Stops, cooldowns and leases. Verify workers through normal scheduled runs; do not invoke a campaign sender merely to test configuration.

Current metadata supersedes historical deployment-access notes in older reports.
