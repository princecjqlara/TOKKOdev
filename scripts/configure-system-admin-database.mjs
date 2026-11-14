// Provision the existing local admin email/hash into the protected database.
// Defaults to read-only checks; --apply installs the migration and saves them.
import fs from 'node:fs';
import { Client } from 'pg';
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd());
const email = process.env.SYSTEM_ADMIN_EMAIL?.trim().toLowerCase();
const passwordHash = process.env.SYSTEM_ADMIN_PASSWORD_HASH;
if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.endsWith('@facebook.local')
    || !/^scrypt-v1\$[a-f0-9]{48}\$[a-f0-9]{128}$/.test(passwordHash || '')) {
    throw Error('Run configure-system-admin.mjs first to set a valid local administrator email and password hash.');
}
if (process.argv.slice(2).some(arg => arg !== '--apply')) throw Error('Usage: node scripts/configure-system-admin-database.mjs [--apply]');
const connectionString = process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL;
if (!connectionString) throw Error('Set DATABASE_POOLER_URL_5432 or DATABASE_URL for the application database.');
const db = new Client({ connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
let transaction = false;
try {
    await db.connect();
    await db.query('BEGIN'); transaction = true;
    await db.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'");
    const before = (await db.query(`SELECT public.tokko_accounts_ready() ready,
        to_regprocedure('public.tokko_admin_accounts(text,text,text,text,integer,integer,uuid)') IS NOT NULL overview,
        to_regclass('app_private.system_admin_config') IS NOT NULL credentials`)).rows[0];
    if (!before.ready || !before.overview) throw Error('Install and finalize the account and administrator migrations first.');
    if (!process.argv.includes('--apply')) {
        console.log(JSON.stringify({ ready: true, loginMigrationInstalled: before.credentials, changesApplied: false }));
    } else {
        const previous = before.credentials ? (await db.query('SELECT * FROM app_private.system_admin_config')).rows : [];
        fs.mkdirSync('.vercel/backups', { recursive: true });
        const backup = `.vercel/backups/system-admin-login-${Date.now()}.json`;
        fs.writeFileSync(backup, JSON.stringify({ createdAt: new Date().toISOString(), previous }, null, 2), { mode: 0o600, flag: 'wx' });
        const migration = fs.readFileSync('database/migration_system_admin_login.sql', 'utf8').replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
        await db.query(migration);
        await db.query(`INSERT INTO app_private.system_admin_config(id,email,password_hash,enabled) VALUES(TRUE,$1,$2,TRUE)
            ON CONFLICT(id) DO UPDATE SET email=excluded.email,password_hash=excluded.password_hash,enabled=TRUE`, [email, passwordHash]);
        const ready = (await db.query('SELECT public.tokko_accounts_ready() ready')).rows[0].ready;
        if (!ready) throw Error('Account isolation validation failed.');
        for (const role of ['anon', 'authenticated']) {
            const access = (await db.query(`SELECT has_function_privilege($1,'public.tokko_system_admin_credentials()','EXECUTE') allowed,
                has_table_privilege($1,'app_private.system_admin_config','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') table_access`, [role])).rows[0];
            if (access.allowed || access.table_access) throw Error('Administrator credentials are not isolated.');
        }
        await db.query('SET LOCAL ROLE service_role');
        const row = (await db.query('SELECT * FROM public.tokko_system_admin_credentials()')).rows[0];
        if (row?.email !== email || row.password_hash !== passwordHash) throw Error('Administrator credential verification failed.');
        await db.query('RESET ROLE');
        await db.query('COMMIT'); transaction = false;
        console.log(JSON.stringify({ ready: true, administratorConfigured: true, email, backup, changesApplied: true }));
    }
} catch (error) {
    console.error(JSON.stringify({ error: error.code || error.message })); process.exitCode = 1;
} finally {
    if (transaction) await db.query('ROLLBACK').catch(() => {});
    await db.end();
}
