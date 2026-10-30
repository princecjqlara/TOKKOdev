# Facebook parents and team subaccounts

Original Tokko users admitted through Facebook Developer app invitations are **parent users**. They continue signing in with Facebook. A parent creates email/password **subaccounts** for their team and assigns the Tokko Pages those accounts may operate. Subaccounts do not need Facebook Developer invitations and cannot create accounts, assign access, or become parents by linking a Facebook identity.

Page assignments are many-to-many: one subaccount may have multiple Pages, and several subaccounts may share a Page. Repeating the same assignment does not duplicate the membership. Email/password sign-in keeps a unique email identity; assigning an existing email account preserves its password and other assignments.

## Parent and member workflows

1. An original user chooses **Continue with Facebook**, then opens **Team Subaccounts**.
2. Choose one or more Pages already available in that parent's Tokko account. Meta `MANAGE` permission is not a prerequisite for entering Tokko or administering these existing assignments. Connecting or reconnecting a Facebook Page still requires the relevant Meta permission.
3. Enter a name and email and choose **Set an initial password**, **Send a password setup email**, or **Assign an existing account**. Password creation is the default. Fields include Show/Hide controls and password confirmation.
4. An initial-password subaccount can sign in immediately using its email and password. Share its initial password privately. A parent may also complete their own pending invitation this way; prior setup links are invalidated. The transaction cannot replace an active account's password or another parent's pending credentials.
5. The member uses contacts, Page tags, bulk tagging, campaigns, templates, messages, exports, history, welcome messages, and follow-ups for its assigned Pages. Personal tags keep their existing privacy rules. Ads Guard still requires separate Facebook advertising credentials.
6. Members can change an existing password in Settings by entering their current password, or use email recovery when a sender is configured. Saving a password invalidates existing sessions and setup/reset links. Parent users keep their original Facebook sign-in.

Account creation, Page grants, optional lifetime, audit records, and any invitation delivery are transactional. Repeated submissions use an idempotency key. Password fingerprints use the server secret, rather than a stored plain password or an unkeyed password verifier. Stored passwords are never returned to the browser.

Only the creator of a subaccount controls its account-wide lifetime. Another parent can assign one of their Pages to an existing account without taking over that account's credentials or deletion schedule. **Revoke this Page** removes that delegated Page membership while preserving other assignments.

## Permanent and temporary subaccounts

New subaccounts are permanent by default. To create a temporary account, enable **Make this a temporary subaccount**, enter a whole number of days (1–3,650) or an exact local deadline, and leave **Delete this subaccount automatically at its deadline** selected. The server calculates day-based deadlines once, when the initial transaction runs. Retries preserve that deadline and cannot overwrite a later extension.

The parent can extend the lifetime or make the account permanent before cleanup deletes it. Clearing the automatic-deletion option instead retains an expired account for later renewal. An already deleted account is not resurrected by a stale session or request replay; creating another account requires a new request.

Access stops at the deadline on subsequent authenticated requests, including requests from already signed-in sessions. A bounded database cleanup runs every minute and deletes eligible expired subaccounts. Parent users, independent Facebook identities, permanent accounts, and other teammates are excluded. Large backlogs are cleared over successive batches.

Deletion removes the subaccount's credentials, memberships, private personal tags, setup/reset tokens, and queued mail. Shared Pages, contacts, campaigns, Page-owned tags, and history remain. Exports are retained by the parent; chatbot audit records use a non-login deleted-member marker. Previously authorized work, downloaded data, and already issued expiring file capabilities cannot be recalled retroactively.

## Original Facebook login compatibility

Facebook app admission and Meta Page-management tasks are separate. The original Facebook-only Tokko version stored many users by provider email without saving their Facebook subject. The updated server-only identity resolver restores those original, active, credential-free legacy records from the trusted Facebook OAuth callback. It preserves their user IDs and all Page assignments, including users with no Pages or no `MANAGE` task. No invitation email, email/password login, or additional Page proof is required.

Existing provider bindings take precedence over profile email. Legacy no-email Facebook accounts use their original `fb_<subject>@facebook.local` identity. A Facebook identity whose profile email matches a protected team password account receives a separate parent identity; it cannot claim that subaccount's password or Page memberships. Team-created identities remain subaccounts and cannot attach a Facebook binding to escape temporary deletion.

Successful OAuth returns through `/facebook-signin` to the requested workspace screen. Stale pending Facebook sessions are no longer routed into email verification. An explicit **Sign in to a team subaccount** link permits choosing email login without bouncing back into Facebook. Database failures and inactive accounts remain denied instead of silently creating broader access.

## Deployment and activation

Use the existing canonical live application URL, `https://tokkobeta.vercel.app`. The live Vercel project is `tokkobeta` in `sircjdigiworks-4427s-projects`. The locally linked `tokkodev` project in `bigclicklara-2607s-projects` is a different project; do not deploy there or change the Facebook callback URL to bypass missing live-team access.

Required server configuration is `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, existing Facebook/Supabase server credentials, and `CRON_SECRET` for HTTP workers. Initial-password creation and assigning an existing account do not require an email sender. Email invitations and password recovery require `RESEND_API_KEY` and `TOKKO_ACCOUNT_EMAIL_FROM`.

Apply migrations in this order, in transactions:

1. `database/migration_page_member_accounts.sql` (the preparation migration).
2. `database/migration_team_account_expiry.sql`.
3. `database/migration_facebook_signin_recovery.sql` (historical compatibility helper).
4. `database/migration_account_password_options.sql`.
5. `database/migration_original_facebook_access.sql` (the current authoritative Facebook resolver and parent identity guard).
6. `database/migration_parent_subaccounts.sql`.
7. `database/migration_subaccount_cleanup_schedule.sql`.

The scheduler migration installs `tokko-expired-subaccounts` in `pg_cron` when that extension is available. Otherwise configure an authenticated `GET /api/cron/subaccounts` every minute with `Authorization: Bearer <CRON_SECRET>`. This worker is independent of account email delivery. Inspect its `deleted` and `failed` counts and private access-audit records if cleanup fails.

Password subaccounts remain disabled until database isolation is finalized. Review all consumers of this shared Supabase database, including the separate chatbot. They must use authorized server handlers/service credentials rather than direct anonymous or authenticated reads of Page data. Keep the media/export buckets private. Then run `database/migration_page_member_isolation.sql` and verify `SELECT public.tokko_accounts_ready();` returns true. Do not bypass this guard or activate passwords by editing user flags manually.

### Applied database updates, 2026-10-31

The configured database now has the additive account/lifetime/password migrations and the corrected original Facebook resolver. All 42 existing users and 158 Page assignments were preserved. Function-definition backups are in the ignored `.vercel/backups` directory. The temporary-subaccount cleanup job is scheduled every minute.

The login compatibility fix does not depend on password-subaccount activation. The activation flag remains false: the database audit found 13 public-schema tables without RLS and 17 tables/views still granting direct end-user access. Shared chatbot compatibility must be checked before final isolation. The connected Vercel CLI account only has access to `bigclicklara-2607s-projects`; deployment to the live team and live environment settings cannot currently be verified. A Git push is not proof of a production deployment.

## Verification

Run the Node suite with `node node_modules/vitest/vitest.mjs run --maxWorkers=2 --minWorkers=1`, type checking with `node node_modules/typescript/bin/tsc --noEmit`, and a production build with `node node_modules/next/dist/bin/next build`.

`node --env-file=.env.local scripts/verify-page-member-accounts.mjs` exercises the real SQL in a fresh temporary schema, within one transaction that is rolled back. It does not install production cron jobs or modify production user rows. Checks cover original Facebook restoration, parent/subaccount authority, multi-Page overlapping assignments, password protection, retry-safe lifetimes, expiry denial, deletion, shared-data preservation, and anonymous access denial.

Before enabling broadly, test a real original Facebook user re-login, create two team subaccounts sharing a Page with one account also assigned another Page, operate tags/campaigns as a member, and verify a temporary account's deletion leaves the other account and Page data intact. Live Facebook OAuth and actual mail delivery require hands-on verification.
