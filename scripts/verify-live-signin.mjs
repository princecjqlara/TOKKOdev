// Exercise sign-in entry points without a user's password or Facebook approval.
// Optional negative credential check uses a new nonexistent .invalid address.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = new URL(process.env.NEXTAUTH_URL);
assert.ok(base.protocol === 'https:' || base.hostname === 'localhost', 'Expected the configured application origin');
const report = { origin: base.origin, checks: [], validUserLoginTested: false, facebookApprovalTested: false };
async function request(path, options = {}) {
    const response = await fetch(new URL(path, base), { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(20000), ...options });
    const body = await response.json().catch(() => ({}));
    return { response, body };
}
function check(name, passed, status) {
    report.checks.push({ name, passed, status });
    if (!passed) process.exitCode = 1;
}
try {
    const providers = await request('/api/auth/providers');
    check('Facebook and email providers are available', providers.response.ok && Boolean(providers.body.facebook && providers.body.credentials), providers.response.status);
    const session = await request('/api/auth/session');
    check('An unsigned session exposes no workspace identity', session.response.ok && !session.body.user?.id, session.response.status);
    const csrf = await request('/api/auth/csrf');
    check('CSRF endpoint responds', csrf.response.ok && typeof csrf.body.csrfToken === 'string', csrf.response.status);
    assert.ok(csrf.body.csrfToken, 'CSRF response is unavailable');
    const cookie = csrf.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const form = new URLSearchParams({ csrfToken: csrf.body.csrfToken, callbackUrl: new URL('/facebook-signin?next=%2Fdashboard', base).toString(), json: 'true' });
    const facebook = await request('/api/auth/signin/facebook', { method: 'POST',
        headers: { Cookie: cookie, Origin: base.origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    const destination = new URL(facebook.body.url || facebook.response.headers.get('location') || '/', base);
    const redirectUri = destination.searchParams.get('redirect_uri');
    check('Facebook sign-in starts with the correct callback',
        (destination.hostname === 'facebook.com' || destination.hostname.endsWith('.facebook.com')) &&
        redirectUri === new URL('/api/auth/callback/facebook', base).toString(), facebook.response.status);

    if (process.argv.includes('--reject-invalid-credentials')) {
        const badCredentials = new URLSearchParams({ csrfToken: csrf.body.csrfToken, json: 'true', callbackUrl: base.toString(),
            email: `tokko-check-${randomUUID()}@example.invalid`, password: randomUUID() });
        const rejected = await request('/api/auth/callback/credentials', { method: 'POST',
            headers: { Cookie: cookie, Origin: base.origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: badCredentials });
        const error = new URL(rejected.body.url || rejected.response.headers.get('location') || '/', base).searchParams.get('error');
        check('Nonexistent credentials are rejected by the account service', error === 'CredentialsSignin', rejected.response.status);
        report.credentialRejectionCode = error;
    }
} catch (error) {
    report.failureType = error.name;
    process.exitCode = 1;
}
report.passed = report.checks.length > 0 && report.checks.every(check => check.passed) && !report.failureType;
console.log(JSON.stringify(report));
