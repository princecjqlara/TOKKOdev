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

## Production rollout

The live application remains `https://tokkobeta.vercel.app`, project `tokkobeta`
in `sircjdigiworks-4427s-projects`. The currently authenticated CLI account cannot
access that team. Do not deploy to the separately linked `tokkodev` project or
change Facebook callback URLs to work around that missing access.

An owner of the live project must import
`.vercel/database-switch-ucir/vercel-production.env` into its **Production**
environment, replacing the existing values, then redeploy. That ignored file
contains only the eight database-related settings. It contains credentials and
must remain private; do not commit it. Existing OAuth/session/worker settings
remain in the live project. `NEXT_PUBLIC_SUPABASE_ANON_KEY` holds the new
publishable key; `SUPABASE_SERVICE_ROLE_KEY` holds the new backend secret key.
Those legacy variable names are supported by the current application and SDK.

A redeploy is required because the browser's Supabase URL and publishable key
are compiled into its JavaScript. Confirm the deployed client references
`ucirfbweulbvjxmvtiox`, then test a real Facebook sign-in and Page selection.
The database setup and local switch are complete; production environment changes
have not been applied by this CLI account.
