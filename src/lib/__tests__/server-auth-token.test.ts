import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encode } from 'next-auth/jwt';
const mocks = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock('next/headers', () => mocks);
import { getFacebookServerToken, getServerAuthToken } from '../server-auth-token';

beforeEach(() => {
    vi.stubEnv('NEXTAUTH_SECRET', 'cookie-regression-test-secret');
    vi.stubEnv('NEXTAUTH_URL', 'https://tokko.example');
    mocks.headers.mockReturnValue(new Headers());
    mocks.cookies.mockReturnValue({ getAll: () => [] });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('server-only session token retrieval', () => {
    it.each([true, false])('reads encrypted browser cookies with secure=%s', async secure => {
        vi.stubEnv('NEXTAUTH_URL', secure ? 'https://tokko.example' : 'http://localhost:3000');
        const value = await encode({ secret: process.env.NEXTAUTH_SECRET!, token: { provider: 'facebook', facebookId: 'fb', accessToken: 'private-provider-token' } });
        const name = `${secure ? '__Secure-' : ''}next-auth.session-token`;
        mocks.cookies.mockReturnValue({ getAll: () => [{ name, value }] });
        expect(await getFacebookServerToken()).toBe('private-provider-token');
    });
    it('reassembles chunked session cookies before decrypting', async () => {
        const value = await encode({ secret: process.env.NEXTAUTH_SECRET!, token: { facebookId: 'legacy-fb', accessToken: 'private-legacy-token' } });
        const split = Math.floor(value.length / 2);
        mocks.cookies.mockReturnValue({ getAll: () => [
            { name: '__Secure-next-auth.session-token.1', value: value.slice(split) },
            { name: '__Secure-next-auth.session-token.0', value: value.slice(0, split) }
        ] });
        expect(await getFacebookServerToken()).toBe('private-legacy-token');
    });
    it('never grants Facebook authority to an email session', async () => {
        const value = await encode({ secret: process.env.NEXTAUTH_SECRET!, token: { provider: 'credentials', facebookId: 'stale', accessToken: 'stale' } });
        mocks.cookies.mockReturnValue({ getAll: () => [{ name: '__Secure-next-auth.session-token', value }] });
        expect(await getFacebookServerToken()).toBeNull();
    });
    it('returns null for absent or invalid cookies', async () => {
        expect(await getServerAuthToken()).toBeNull();
        mocks.cookies.mockReturnValue({ getAll: () => [{ name: '__Secure-next-auth.session-token', value: 'invalid' }] });
        expect(await getServerAuthToken()).toBeNull();
    });
});
