# Page member accounts

Tokko supports Facebook sign-in and email/password sign-in. Original Facebook users can create another person's account and change assignments for their existing Pages. An original assignment is a server-stored `legacy` or `facebook` Page connection, used with a signed Facebook identity. Delegated membership alone does not permit account administration. A delegated user with independent Facebook `MANAGE` permission can still verify that authority. Assigned email users have operational access to their assigned Pages, including pre-existing Page tags, tag creation/editing, bulk tagging, contact filters, campaigns, templates, messages, exports, history, welcome messages, and follow-ups. Facebook reconnection continues to require live Facebook management verification.

## Configure before enabling

Required application environment variables:

- `NEXTAUTH_URL`: the canonical HTTPS Tokko address used for sign-in, invitation links, and same-origin checks.
- `NEXTAUTH_SECRET`: a strong secret. It also encrypts pending email payloads; rotating it invalidates queued invitations and old sessions. Resend invitations after rotation.
- Existing Facebook and Supabase server credentials.
- `RESEND_API_KEY`: a Resend sending key.
- `TOKKO_ACCOUNT_EMAIL_FROM`: a verified sender, for example `Tokko <accounts@yourdomain.com>`.
- `CRON_SECRET`: a dedicated random secret for internal workers.

Account provisioning refuses to write accounts/invitations when the sender is not configured. Email sign-in refuses to run until database isolation is finalized. Password recovery supports activated email accounts only; it never creates accounts or attaches a password to a Facebook identity.

Configure every external cron job to send `Authorization: Bearer <CRON_SECRET>`. Existing cron URLs now require this header. The follow-up worker forwards the secret to its campaign continuation. Add `/api/cron/account-mail` every minute to deliver queued invitations and password resets. Setup emails also attempt delivery immediately after the account transaction commits.

## Deployment order

1. Back up and rehearse against a staging copy. Audit normalized duplicate emails/Facebook identities; the preparation migration rejects collisions instead of merging users.
2. Run `database/migration_page_member_accounts.sql` in a transaction. It adds account state, provider identity binding, invitation/outbox tables, audit records, rate limits, and transactional functions. New account entry points remain disabled.
3. Run `database/migration_team_account_expiry.sql` and `database/migration_facebook_signin_recovery.sql` in a transaction before deploying this version. They preserve existing unlimited account lifetimes, add original Facebook assignment authority, install transactional optional expiry, and allow eligible original Facebook accounts to recover their provider binding. Configure the environment and authenticated cron callers. Deploy the application code. Verify existing Facebook sign-in, Page features, signed Messenger media uploads, and workers. Contact updates now use authorized API refresh rather than anonymous database realtime.
4. Review **all consumers of the shared Supabase database**, including the separate chatbot service. They must use authorized server handlers/service credentials, not anonymous direct reads of Page data. The finalizer locks down every public-schema application table and administrative RPC, including chatbot tables. Keep all four existing media/export buckets private and remove broad end-user storage policies; the readiness guard rejects public buckets or storage policies that could bypass Page checks.
5. Run `database/migration_page_member_isolation.sql` in a transaction. It enables RLS, revokes direct anonymous/authenticated table and view access and administrative RPC execution, retires the known default admin password, and enables the account feature. It preserves existing users, memberships, contacts, tags, and campaigns.
6. Verify database readiness with `SELECT public.tokko_accounts_ready();`, then test manager provisioning and a separate assigned email user before opening access more widely.

Do not deploy the new authentication code before the preparation migration; session validation depends on its columns and functions. Do not activate password accounts by editing flags manually. Invite the real recipient and let them choose their own password.

## Manager and member flows

- An original Facebook user signs in with Facebook and opens **Team Access**. Tokko validates their provider identity and original Page assignments. Independently verified Facebook managers can also administer their assigned Pages. The screen provides refresh, reconnect, and Page connection actions; a failed lookup is shown separately from an empty Page list.
- Enter the person's name/email and select explicit Pages. The account, memberships, audit rows, and encrypted invitation delivery are saved in one transaction. Repeat network submissions use an idempotency key.
- New recipients follow an expiring setup link and choose a password of at least 12 characters. The link is held in the URL fragment and removed from browser history once read. It is never returned to the manager or written to logs.
- Existing accounts keep their password, identity, and other Page assignments. Their existing sign-in method continues to work; matching email alone never links Facebook and password identities.
- Members sign in with email, use assigned Pages normally, and cannot provision accounts or assign access. An account with no assignments sees a no-Pages screen.
- Pending members can be reinvited from their Page's member list. Reissuing the same Page context expires the prior link. Delivery retries do not recreate the account or restore revoked grants.
- **Revoke this Page** removes only delegated access for that Page. Other assignments and account credentials remain unchanged. Independent Facebook-derived access is not removable through a delegated-member endpoint.

## Optional account expiry

Account creation defaults to **no expiry**. Enable **Set an expiry date** to choose a local date/time or use the 7/30/90-day shortcuts. The browser sends an absolute timestamp, and the account and expiry are committed in one transaction. Omitting expiry when assigning an existing account or resending an invitation preserves its existing deadline.

Only an email account's creator can change its account-wide expiry, while they still administer one of its assigned Pages. Another Page manager cannot expire someone else's entire account; independent Facebook identities are also protected. The member list shows active, awaiting setup, or expired status and the local expiry time. **Edit expiry** / **Renew account** can extend the deadline or remove it. Turning expiry off and saving removes the deadline without changing passwords or assignments.

Expired accounts cannot sign in or authorize subsequent requests from existing sessions. Password setup/reset does not remove expiry. A renewal restores access subject to the existing account activation, session-version, and Page-membership checks. No expiry cron job is required. Previously authorized in-flight work and previously downloaded data remain outside this revocation boundary.

Existing installations must apply `migration_team_account_expiry.sql` before deploying the new session validation code. The migration does not enable account readiness or bypass email/isolation prerequisites.

Newly issued sessions validate current account status/session version on protected requests. Page membership is read from the database on each operation, so revocation is effective for subsequent API requests. The workspace refreshes memberships periodically and on focus, remounting when assignments change. Requests already authorized/in flight, previously downloaded data, and already issued expiring file capabilities cannot be retroactively recalled.

## Tag rules

Page-owned tags are team resources, regardless of who originally created them. Members can create, edit/recolor, delete ordinary Page tags, add/remove contact tags in bulk, filter contacts, and use include/exclude tags for audiences. The existing protected default tags remain protected for managers and members alike.

Personal tags retain their privacy and explicit sharing rules. Assignment to a Page does not expose a teammate's private personal tags. Shared personal tag definitions remain editable by their creator; permitted recipients can use them. Business membership never follows automatically from Page assignment, and business-wide tags cannot be used to operate unrelated Pages. Prefer Page-owned tags for team workflows.

## Facebook identity compatibility

Provider identity is keyed by Facebook subject. Existing signed Facebook sessions can bind a legacy account that lacks `facebook_id` through that same verified subject. Older versions created many Facebook users with email only; a fresh Facebook login can now recover an eligible legacy account when the server independently verifies Facebook `MANAGE` permission for **every** existing Page assignment. The recovery transaction requires an active, unexpired original legacy account with at least one Page, no password/email-login credentials, no creator/invitation, and no existing provider binding. It rejects delegated assignments, partial Page proof, already bound identities, and email-only matches. It preserves the existing account ID and Page memberships and does not depend on email-account feature activation.

Legacy Facebook sign-ins without an email used a reserved `fb_<subject>@facebook.local` address. These can recover through the exact authenticated Facebook subject, including accounts with no Pages. Another subject cannot claim that reserved address; the same account-state and credential protections apply.

**Continue with Facebook** returns to `/facebook-signin`, which checks the resulting session and returns the user to the requested workspace screen. OAuth errors remain on a Facebook retry screen. Dashboard guards route incomplete Facebook sessions to this screen instead of email sign-in. A database error is shown as a service problem; inactive/expired accounts remain denied. A narrowly scoped compatibility check permits existing sign-ins when only the optional `expires_at` column is not installed yet; other database failures still deny access.

If independent Page proof cannot establish a legacy binding, the session has **no account or Page access** and proceeds to the dedicated `/verify-facebook` confirmation screen. This offers an explicit one-time verification link sent to the existing account's email, rather than requesting an email password. The person must redeem it in the same browser while the matching recent Facebook sign-in is present, then sign in through Facebook again. This preserves the existing user ID, password, and memberships. The link expires after 15 minutes and cannot set/reset a password or be redeemed by a different Facebook subject. Already bound or inactive accounts cannot be linked through this path. Never resolve a collision by overwriting another account's password or provider identity.

## Operational limits

Ads Guard still requires the individual's Facebook ad-account permission. Delegated ad credential storage and cross-account ad reporting are deliberately not enabled by a Page assignment. Email users can use the other Page features; Ads Guard returns a clear separate-permission message.

Invitation/reset links are single-use. Setup links expire after 24 hours; reset links after 30 minutes. Password changes invalidate old sessions. Outbox delivery is retried up to five attempts with a five-minute delay; expired/cancelled/exhausted payloads are cleared. Resend a setup invitation if delivery is exhausted. Email send acceptance is not a guarantee of inbox delivery.

To pause the new feature, set `tokko_account_config.enabled=FALSE`. This disables password sign-in and account provisioning without deleting credentials or memberships; existing Facebook users retain authorized Page operations. Do not restore anonymous database access to roll back the feature.

## Verification

Run `npm test`, `npx tsc --noEmit`, and `npm run build`.

Run SQL lifecycle checks with `node --env-file=.env.local scripts/verify-page-member-accounts.mjs`, or set `TOKKO_TEST_DATABASE_URL` for a staging database. This creates a fresh temporary schema in one transaction, exercises the real functions and finalizer, and rolls back all schema/fixture changes even on failure. It does not modify production user rows or table grants.

Required hands-on checks: manager creates an account and assigns Manawari only; recipient activates and uses tags/campaigns; attempts to access Loki IDs fail; an email member cannot create another account; revoking Manawari removes access without affecting a second independent assignment. Verify actual invitation delivery, authenticated cron jobs, and shared chatbot service compatibility before finalizing production isolation.

### Local validation, 2026-10-26

- The full automated suite passed: 445 tests across 75 files. After adding bounded Facebook Page lookups, all 26 affected tests passed, including two additional pagination failure/loop cases.
- TypeScript and the production build passed. The build reports existing React hook and image optimization warnings.
- The SQL verification script passed 37 lifecycle, identity-linking, grant/revocation, and database isolation checks. Its temporary schema and fixture changes were rolled back.
- Automatic approval review blocked starting the local HTTP test server with the reason "blocked by policy". Browser interaction, actual email delivery, and production activation have not been verified.
- At the time of these local checks, neither migration had been applied to production. See the rollout status below for subsequent changes.

### Rollout status, 2026-10-27

The additive preparation migration (`20261026_002`) has been applied to the configured production database in a transaction. All 41 users and 158 Page memberships were preserved, and a local backup of the original account/membership rows and columns was saved under the ignored `.vercel/backups` directory. The finalizer has not run, and account readiness remains false.

The live project is `tokkobeta` under `sircjdigiworks-4427s-projects`, serving `https://tokkobeta.vercel.app`. The locally linked `tokkodev` project under `bigclicklara-2607s-projects` is a different project. Do not deploy to that substitute project or change the Facebook callback/canonical URL to work around missing access. Sign the Vercel CLI into an account with access to the live team before deploying there.

Before promoting the application, verify the live email sender and `CRON_SECRET`, configure the existing external workers to send that secret, and schedule the account-mail worker. Email settings are not present in the local environment, and live environment settings could not be inspected with the currently connected Vercel account. Final database isolation still requires reviewing the shared chatbot service and verifying the deployed application. A Git push alone is not evidence of a successful production deployment.
