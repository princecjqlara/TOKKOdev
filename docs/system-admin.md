# Private account administration

Open `/admin/login` to sign in, then `/admin` to inspect accounts. These routes
are omitted from the public navigation and marked against search indexing.
Every administrator page and API checks the signed administrator session on the
server. A normal Facebook parent or email subaccount cannot open this area,
even if its email matches the administrator email.

## Setup

1. Apply `database/migration_system_admin.sql` after the account migrations in
   [the account rollout guide](page-member-accounts.md), including
   `migration_parent_subaccounts.sql` and
   `migration_subaccount_first_login_profile.sql`.
2. Run this command from the repository root and enter the administrator password
   at the hidden prompt:

   ```powershell
   node scripts/configure-system-admin.mjs --email you@example.com
   ```

   The script saves `SYSTEM_ADMIN_EMAIL` and a scrypt
   `SYSTEM_ADMIN_PASSWORD_HASH` to the ignored `.env.local`. It preserves other
   environment variables. `--password-stdin` accepts a password through standard
   input for a noninteractive local setup; avoid putting credentials in shell
   history or checked-in scripts.
3. Restart the application. For production, configure the administrator in the
   protected application database using the existing database connection:

   ```powershell
   node scripts/configure-system-admin-database.mjs
   node scripts/configure-system-admin-database.mjs --apply
   ```

   The first command checks the account setup without changing it. `--apply`
   installs `database/migration_system_admin_login.sql` and saves the local email
   and password hash to `app_private.system_admin_config`. It backs up any
   previous configuration to the ignored `.vercel/backups/` directory. It needs
   `DATABASE_POOLER_URL_5432` or `DATABASE_URL` and does not change workspace users.
   Deploy the updated application after installing this configuration.

   Alternatively, set both variables in the host's **server** environment.
   Explicit environment settings take precedence over database configuration.
   Use the raw hash there:
   remove the backslashes before dollar signs that are necessary in `.env.local`.
   Do not prefix either variable with `NEXT_PUBLIC_`. `NEXTAUTH_SECRET` and the
   existing Supabase service credentials are also required.

This configuration is separate from the users table; it does not overwrite an
existing Facebook account with the same email. With no environment variables,
the server reads the enabled private database configuration through a service-only
function. An incomplete or invalid explicit environment configuration disables
sign-in; it never falls back to another credential. Database failures deny access.
Login attempts use shared database rate limits.
Administrator sessions last eight hours and are invalidated by changing either
administrator credential. Database configuration edits also rotate the session
revision, so disabling and re-enabling it cannot restore old sessions. Run the
setup commands again to rotate the password.
The administrator session does not grant Facebook connection or workspace
sending privileges.

## Account overview

The overview shows parent accounts and subaccounts, email, phone, creator,
creation date, assigned Pages and assignment grantors, child account counts,
account status, password setup state, and password change time. Search by name,
email, creator, account ID, or Page name/Facebook ID. Filter by account type,
status, permanent access, or access with an expiry. Choose a parent's subaccount
count to inspect its children. Results are paginated at 25 accounts.

Account details show the expiry deadline, remaining days, days from creation to
the current deadline, and whether deletion is scheduled. Days are rounded up;
an expired account has zero days remaining. An account with no expiry is shown
as permanent. Removing an expired temporary account is still handled by the
existing subaccount cleanup worker.

Passwords remain one-way hashed and cannot be retrieved. The administrator can
set a new password for an activated email subaccount. The change runs in one
transaction, increments its session version, invalidates existing account links
and pending mail, and records the administrator email in `tokko_access_audit`.
It does not activate a disabled account, extend access, change assigned Pages,
or reset independent Facebook identities. No password, password hash, reset
token, or Facebook access token is returned in the overview.

The administrator database functions are executable only by `service_role`.
The private credential table has row-level security and no grants to browser roles.
Never expose
that key to a browser. Apply the migration before deploying the admin UI.

## Verification

```powershell
npm test -- src/lib/__tests__/system-admin-auth.test.ts src/lib/__tests__/system-admin-session.test.ts src/app/api/admin
node scripts/verify-system-admin.mjs
```

The SQL check uses the optional PGlite tooling under
`outputs/campaign-scale-tools/node_modules`, as described in the main README,
and runs against a fresh in-memory database. It never connects to production.
