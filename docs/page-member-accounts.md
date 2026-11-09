# Facebook parents and team subaccounts

Original Tokko users admitted through Facebook Developer app invitations are **parent users**. They continue signing in with Facebook. A parent creates email/password **subaccounts** for their team and assigns the Tokko Pages those accounts may operate. Subaccounts do not need Facebook Developer invitations and cannot create accounts, assign access, or become parents by linking a Facebook identity.

Page assignments are many-to-many: one subaccount may have multiple Pages, and several subaccounts may share a Page. Repeating the same assignment does not duplicate the membership. Email/password sign-in keeps a unique email identity; assigning an existing email account preserves its password and other assignments.

Facebook connection status does not remove Tokko Page access. An assigned Page stays available when its saved Facebook token expires or permissions need renewal, so existing users can still open stored contacts, tags, campaigns, and history. The workspace marks the Page as needing reconnection; a Facebook manager uses **Connect Pages → Refresh Permissions** and reconnects it to restore syncing and messaging. Actual membership revocation, account deactivation, and temporary-account deadlines still control access.

## Parent and member workflows

1. An original user chooses **Continue with Facebook**, then opens **Team Subaccounts**.
2. Choose one or more Pages already available in that parent's Tokko account. Meta `MANAGE` permission is not a prerequisite for entering Tokko or administering these existing assignments. Connecting or reconnecting a Facebook Page still requires the relevant Meta permission.
3. Enter a name and email and choose **Set an initial password**, **Send a password setup email**, or **Assign an existing account**. Password creation is the default. Fields include Show/Hide controls and password confirmation.
4. An initial-password subaccount can sign in immediately using its email and password. Share its initial password privately. A parent may also complete their own pending invitation this way; prior setup links are invalidated. The transaction cannot replace an active account's password or another parent's pending credentials.
5. The member uses contacts, Page tags, bulk tagging, campaigns, templates, messages, exports, history, welcome messages, and follow-ups for its assigned Pages. Personal tags keep their existing privacy rules. Ads Guard still requires separate Facebook advertising credentials.
6. Members can change an existing password in Settings by entering their current password, or use email recovery when a sender is configured. Saving a password invalidates existing sessions and setup/reset links. Parent users keep their original Facebook sign-in.

## First sign-in for new subaccounts

New team subaccounts confirm their name and phone number at `/complete-profile` after signing in and before entering the workspace. The parent-supplied name is prefilled. Phone numbers are stored with a country code; Philippine mobile numbers beginning with `09` are normalized to `+63`. This is format validation, not SMS verification. The number is available only through the member's own authenticated profile endpoint and is not included in public session data or Page member lists.

This step is required once. An incomplete account has a valid authenticated session for onboarding but receives no operational user ID, so Page APIs deny requests until completion. Saving uses the signed-in user's ID and current session version, rechecks account activity/expiry, and cannot change permissions or another user's details. Completion refreshes the session by returning to the workspace. Retries preserve the first saved details.

Original Facebook parent accounts never receive this prompt. Existing active accounts keep their current access; existing pending invitations and newly created subaccounts complete it on their first sign-in. Apply `database/migration_subaccount_first_login_profile.sql` after the existing account migrations and before deploying the updated app. It adds only profile fields, a new-subaccount trigger, and a service-only save function; it preserves Page grants, passwords, sessions, and the account activation flag.

The profile migration was applied to the configured database on 2026-10-31. The apply check preserved all 45 users and 158 Page assignments present at that time, verified new-parent exclusion and new-subaccount completion with rolled-back fixtures, and confirmed that team-account readiness remains true. The first-login screen and workspace gate take effect when the updated application is deployed.

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

Authentication database requests have an eight-second deadline and cancel stalled HTTP requests. The completion screen uses a full navigation once the session is verified. If session loading or navigation takes fifteen seconds, it offers an account-check retry or a direct workspace link for an already verified session. OAuth errors show recovery controls immediately; a stalled Facebook retry also stops disabling the button after fifteen seconds. These changes require deploying the app, with no new database migration or connection changes. A database outage still denies access and must be resolved separately.

If Facebook callbacks and webhook Page lookups fail together, check the deployed Supabase project first. OAuth account resolution and webhook Page lookup failures log the configured database hostname, HTTP status, safe error code and a fallback explanation, including for gateway errors without a `message`. Raw errors, gateway bodies, credentials and OAuth metadata are omitted. Webhook Page lookups also have an eight-second deadline. Failed lookups, missing Page records and contact-write failures return a non-success response so Facebook can retry; do not acknowledge an event that was not processed or reconnect Pages to a different database to mask an outage.

## Deployment and activation

Use the existing canonical live application URL, `https://tokkobeta.vercel.app`. The live Vercel project is `tokkobeta` in `sircjdigiworks-4427s-projects`. The locally linked `tokkodev` project in `bigclicklara-2607s-projects` is a different project; do not deploy there or change the Facebook callback URL to bypass missing live-team access.

Required server configuration is `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, and existing Facebook/Supabase server credentials. HTTP workers are public and require no scheduler secret or Authorization header. Initial-password creation and assigning an existing account do not require an email sender. Email invitations and password recovery require `RESEND_API_KEY` and `TOKKO_ACCOUNT_EMAIL_FROM`.

Apply migrations in this order, in transactions:

1. `database/migration_page_member_accounts.sql` (the preparation migration).
2. `database/migration_team_account_expiry.sql`.
3. `database/migration_facebook_signin_recovery.sql` (historical compatibility helper).
4. `database/migration_account_password_options.sql`.
5. `database/migration_original_facebook_access.sql` (the current authoritative Facebook resolver and parent identity guard).
6. `database/migration_parent_subaccounts.sql`.
7. `database/migration_subaccount_cleanup_schedule.sql`.
8. `database/migration_subaccount_first_login_profile.sql`.
9. `database/migration_facebook_messaging_access.sql` (records the historical messaging-access rule).
10. `database/migration_parent_connected_page_assignment.sql` (allows original parents to assign every connected Page, including messaging connections).

The scheduler migration installs `tokko-expired-subaccounts` in `pg_cron` when that extension is available. Otherwise configure a plain `GET /api/cron/subaccounts` every minute, with no credentials. This worker is independent of account email delivery. Inspect its `deleted` and `failed` counts and private access-audit records if cleanup fails.

For a new deployment, password subaccounts remain disabled until database isolation is finalized. Review all consumers of the shared Supabase database, including the separate chatbot. They must use authorized server handlers/service credentials rather than direct anonymous or authenticated reads of Page data. Keep the media/export buckets private. After that review, run `node --env-file=.env.local scripts/enable-team-accounts.mjs`. It backs up permissions under the ignored `.vercel/backups` directory, applies `database/migration_page_member_isolation.sql` in one transaction, verifies readiness and service-role access, exercises account creation/assignment with rolled-back fixtures, and preserves existing users and memberships. Any pre-commit failure rolls back activation. Do not bypass readiness or activate passwords by editing user flags manually.

### Applied database updates, 2026-10-31

The configured database now has the additive account/lifetime/password migrations and the corrected original Facebook resolver. All 42 existing users and 158 Page assignments were preserved. Function-definition backups are in the ignored `.vercel/backups` directory. The temporary-subaccount cleanup job is scheduled every minute.

Team accounts are now enabled in the configured production database: `tokko_accounts_ready()` returns true through PostgREST. The finalizer enabled RLS on the remaining 13 tables and removed direct end-user access from the remaining 17 tables and 14 administrative functions. The chatbot-specific tables were already restricted to server access; the finalizer preserves service-role access throughout. Private buckets and the scheduled expiry cleanup remain intact.

All 42 original users and 158 memberships were preserved. Activation passed 29 checks against the installed production functions, including Facebook parent recovery, initial-password creation, assigning an existing account, two overlapping multi-Page subaccounts, permanent/temporary lifetimes, revoking one Page, and denying end-user database access. All fixture accounts and Pages were rolled back before activation committed. Permission metadata is backed up under `.vercel/backups`. Retired historical seed credentials are disabled by the finalizer.

An already open Team screen must refresh Page access to reload readiness and enable **Create account / assign access**. Creating with an initial password and assigning existing accounts work without an email sender; email invitation and recovery depend on sender configuration. Live Facebook OAuth and mail delivery still require hands-on verification. The connected Vercel CLI account only has access to `bigclicklara-2607s-projects`; deployment to the live team and live environment settings cannot currently be verified. This activation is a database change and does not require redeploying the Team screen.

The Team screen shows password creation and existing-account assignment without an email-setup banner. The optional email-invitation method and resend action appear when the sender is configured. If mail becomes unavailable during a Page-access refresh, the form returns to initial-password setup. A parent can also set an initial password for their own pending invitation without sending email; other parents cannot overwrite that pending account's credentials. These interface changes require deploying the current application code.

## Verification

`node --env-file=.env.local scripts/verify-page-access.mjs` runs read-only PostgREST checks across every stored Page and account. It exercises the application's member/team/history relationship queries and assigned-Page selectors, verifies all memberships without truncating paginated results, and checks bounded reads of contacts, Page tags, campaigns, history, and manager records. Its output contains counts and error codes rather than emails or access tokens. This checks database queries and assignment integrity; live OAuth, credential login, and outbound delivery still need separate verification.

Run the Node suite with `node node_modules/vitest/vitest.mjs run --maxWorkers=2 --minWorkers=1`, type checking with `node node_modules/typescript/bin/tsc --noEmit`, and a production build with `node node_modules/next/dist/bin/next build`.

`node --env-file=.env.local scripts/verify-page-member-accounts.mjs` exercises the real SQL in a fresh temporary schema, within one transaction that is rolled back. It does not install production cron jobs or modify production user rows. Checks cover original Facebook restoration, parent/subaccount authority, multi-Page overlapping assignments, password protection, retry-safe lifetimes, expiry denial, deletion, shared-data preservation, and anonymous access denial.

Before enabling broadly, test a real original Facebook user re-login, create two team subaccounts sharing a Page with one account also assigned another Page, operate tags/campaigns as a member, and verify a temporary account's deletion leaves the other account and Page data intact. Live Facebook OAuth and actual mail delivery require hands-on verification.

## Invited users and reconnecting Pages

A Tokko team invitation grants access through `user_pages`. The member should
sign in with the account that was assigned, open **Connect Pages → Your assigned
Pages**, and choose **Open contacts**. No Facebook role check, new Page token,
webhook refresh, or repeated import is needed. Contacts opens the requested Page
only after verifying it is among the user's assignments. A Facebook login is a
separate identity from a team email account; Tokko never merges them by matching
email alone. Assign the intended existing account in Team Access if necessary.

Explicitly refreshing the shared Facebook token still requires a
Facebook-verified manager. The check recognizes `MANAGE`,
`PROFILE_PLUS_MANAGE`, and `PROFILE_PLUS_FULL_CONTROL`, including the New Pages
Experience task names in [Meta's Page SDK](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/page.py).
Messaging-only access does not grant connection administration. Original Tokko
parents can assign any of their connected Pages to subaccounts, including Pages
connected through messaging access. Subaccounts cannot administer assignments.

A Facebook app tester/developer invitation is separate from a Page invitation
or a Tokko assignment. For a Facebook Page invitation, accept it in Facebook and
refresh Tokko's Facebook permissions to select the Page. For a Tokko invitation,
use the assigned account and shared connection. If Facebook has revoked or
expired the stored Page token, its verified manager reconnects it once for the
whole team; stored contacts and tags remain accessible to assigned members.

This fix changes application authorization and navigation. It does not grant
new Page memberships or require a database migration. Opening Contacts no longer
automatically calls the manager-only webhook refresh endpoint; subscriptions
are established during connection, reconnect, and contact sync.

## Direct Facebook sign-in

Facebook login is a complete account path; it does not require a Tokko email
invitation. When that account has no Page memberships, the initial `/api/pages`
load verifies the signed Facebook identity and its current management or
messaging tasks. Connect Pages also discovers additional shared Pages for users
who already have a membership. Matching Pages already connected to Tokko are
linked using duplicate-safe inserts. Existing contacts and tags appear without
another import. Email matching is never used for this.

Recovery does not create Pages, replace shared tokens, reset sync progress,
change existing grants, or enroll users based only on an app tester invitation,
analytics, moderation, or general Facebook access tasks. Normal membership
polling stays database-only. A Page not yet connected to Tokko can be connected
using a server-verified Facebook Page token and management or messaging access.
Messaging users reuse a shared connection without replacing its token or
requesting another import; a concurrent first connection uses a duplicate-safe
insert. New messaging connections attempt webhook setup and report a permission
warning if Facebook requires a Page manager to complete it. They do not seed
templates automatically. Page/token consent failures show permission-refresh
actions. Existing assigned Pages remain visible during discovery failures.

Management grants use `grant_source='facebook'`. Messaging grants use
`facebook_messaging`. Original Facebook parents can assign either kind of
connected Page through Team Subaccounts. The application and database require
an active parent identity, an existing membership on every selected Page, and
a fresh identity-bound authority record. Team-created accounts remain
subaccounts even if they have a messaging connection. Apply
`database/migration_parent_connected_page_assignment.sql` after the messaging
access migration and deploy the app together; updating only the choices leaves
the old database rule rejecting assignments. Existing memberships and shared
tokens are preserved. Refreshing a shared token still requires Facebook
management. These memberships follow Tokko's existing assignment lifecycle and are not temporary
Facebook permission leases. Removing Page access in Tokko revokes workspace
access through the existing membership checks.
