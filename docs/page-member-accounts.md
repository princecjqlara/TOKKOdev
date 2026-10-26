# Page member accounts

Tokko supports Facebook sign-in and email/password sign-in. Only a verified Facebook Page manager can create another person's account or change Page assignments. Assigned email users have operational access to their assigned Pages, including pre-existing Page tags, tag creation/editing, bulk tagging, contact filters, campaigns, templates, messages, exports, history, welcome messages, and follow-ups. Team administration and Facebook reconnection remain manager operations.

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
3. Configure the environment and authenticated cron callers. Deploy the application code. Verify existing Facebook sign-in, Page features, signed Messenger media uploads, and workers. Contact updates now use authorized API refresh rather than anonymous database realtime.
4. Review **all consumers of the shared Supabase database**, including the separate chatbot service. They must use authorized server handlers/service credentials, not anonymous direct reads of Page data. The finalizer locks down every public-schema application table and administrative RPC, including chatbot tables. Keep all four existing media/export buckets private and remove broad end-user storage policies; the readiness guard rejects public buckets or storage policies that could bypass Page checks.
5. Run `database/migration_page_member_isolation.sql` in a transaction. It enables RLS, revokes direct anonymous/authenticated table and view access and administrative RPC execution, retires the known default admin password, and enables the account feature. It preserves existing users, memberships, contacts, tags, and campaigns.
6. Verify database readiness with `SELECT public.tokko_accounts_ready();`, then test manager provisioning and a separate assigned email user before opening access more widely.

Do not deploy the new authentication code before the preparation migration; session validation depends on its columns and functions. Do not activate password accounts by editing flags manually. Invite the real recipient and let them choose their own password.

## Manager and member flows

- A Page manager signs in with Facebook and opens **Team Access**. Tokko checks the current Facebook `MANAGE` task for each selected Page and the caller's Tokko membership.
- Enter the person's name/email and select explicit Pages. The account, memberships, audit rows, and encrypted invitation delivery are saved in one transaction. Repeat network submissions use an idempotency key.
- New recipients follow an expiring setup link and choose a password of at least 12 characters. The link is held in the URL fragment and removed from browser history once read. It is never returned to the manager or written to logs.
- Existing accounts keep their password, identity, and other Page assignments. Their existing sign-in method continues to work; matching email alone never links Facebook and password identities.
- Members sign in with email, use assigned Pages normally, and cannot provision accounts or assign access. An account with no assignments sees a no-Pages screen.
- Pending members can be reinvited from their Page's member list. Reissuing the same Page context expires the prior link. Delivery retries do not recreate the account or restore revoked grants.
- **Revoke this Page** removes only delegated access for that Page. Other assignments and account credentials remain unchanged. Independent Facebook-derived access is not removable through a delegated-member endpoint.

Newly issued sessions validate current account status/session version on protected requests. Page membership is read from the database on each operation, so revocation is effective for subsequent API requests. The workspace refreshes memberships periodically and on focus, remounting when assignments change. Requests already authorized/in flight, previously downloaded data, and already issued expiring file capabilities cannot be retroactively recalled.

## Tag rules

Page-owned tags are team resources, regardless of who originally created them. Members can create, edit/recolor, delete ordinary Page tags, add/remove contact tags in bulk, filter contacts, and use include/exclude tags for audiences. The existing protected default tags remain protected for managers and members alike.

Personal tags retain their privacy and explicit sharing rules. Assignment to a Page does not expose a teammate's private personal tags. Shared personal tag definitions remain editable by their creator; permitted recipients can use them. Business membership never follows automatically from Page assignment, and business-wide tags cannot be used to operate unrelated Pages. Prefer Page-owned tags for team workflows.

## Facebook identity compatibility

Provider identity is keyed by Facebook subject, not email. Existing signed Facebook sessions can bind a legacy account that lacks `facebook_id` through that same verified subject. A logged-out legacy account with an email collision enters a pending session with **no account or Page access**. The login screen offers an explicit verification link sent to the existing account's email. The person must redeem it in the same browser while the matching recent Facebook sign-in is present, then sign in through Facebook again. This preserves the existing user ID, password, and memberships. The link expires after 15 minutes and cannot set/reset a password or be redeemed by a different Facebook subject. Already bound or inactive accounts cannot be linked through this path. Never resolve a collision by overwriting another account's password or provider identity.

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
- The preparation and isolation migrations have not been applied to production. Deploy this feature only after following the deployment order above; committing or pushing the code does not activate the feature.
