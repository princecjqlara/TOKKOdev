# TOKKO Supabase project switch

The approved destination, selected on 2026-11-04, is
`ucirfbweulbvjxmvtiox.supabase.co`. Local TOKKO settings now use this project.
The other chatbot application and the previous databases were not moved.

The destination originally had nine legacy tables, one account, one Page, one
Page assignment and 100 contacts. Its existing records were backed up before
upgrading. The current schema was installed through 48 reviewed migrations and
compatibility additions, after a rollback-only preflight. All 19 application
tables/views and 30 RPC names were verified. The account, assignment and all 100
contacts were retained; one unusable placeholder name was normalized to null.
Both required default Page tags were created.

The existing 22 uploaded attachments and their public URLs were preserved.
A legacy PUBLIC Storage mutation policy was removed. Photo headers, Messenger
media and conversation exports have private buckets with the application's
file-size and MIME restrictions. An authorized signed upload using the new
publishable/secret keys passed and its temporary file was removed.

Verification passed 37 bootstrap/functional checks, 164 account-isolation SQL
checks, the real Page/member selectors, and 30 API/Storage checks. The application
was built with the new local environment. Receipts and the original destination
backup are under the ignored `.vercel/database-switch-ucir` directory.

## Current production rollout ? 20 November 2026 PHT

Production is now Vercel project **tokk-odev** in **bigclicklara-2607s-projects**, serving **https://tokkobeta.vercel.app**. The maintained checkout is **C:/Users/Cj Lara/Downloads/tokkodev**. Its ignored Vercel link matches this project. Earlier references to another team/project and lack of CLI access describe historical deployment arrangements.

All eight database variables are installed and verified in Production, Preview and Development, using **ucirfbweulbvjxmvtiox**. The active app was rebuilt with those settings. The maintained ignored local environment matches production; the historical checkout under Downloads/sunobot no longer contains database credentials.

The later diagnostics migration is installed, and its schema-cache reads pass. The source dependency audit checks 20 tables, 38 RPC names and 68 migration-added columns with no missing checked dependencies. The original counts above describe the November bootstrap, not current live data.

Use [docs/environment.md](environment.md), config/deployment.json and the environment checker for current configuration. The ignored eight-key export remains private reference material; do not use historical exports from other projects. Run npm run env:check:vercel before deployment. An environment change requires a rebuild; an applied live SQL migration does not require redeploying unchanged app code.
