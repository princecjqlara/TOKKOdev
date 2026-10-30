import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ db: vi.fn(), rate: vi.fn(), mail: vi.fn(), hash: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.db }));
vi.mock('@/lib/account-auth', () => ({ takeAccountRateLimit: mocks.rate }));
vi.mock('@/lib/account-mail', () => ({ requireAccountMail: mocks.mail }));
vi.mock('@/lib/account-security', async original => ({ ...await original<typeof import('@/lib/account-security')>(), hashAccountPassword: mocks.hash }));
import { POST as savePassword } from './password/route';
import { POST as requestReset } from './reset-password/route';

function request(path: string, body: unknown) {
    return new NextRequest(`https://tokko.example/api/account/${path}`, { method: 'POST', headers: { origin: 'https://tokko.example', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv('NEXTAUTH_URL', 'https://tokko.example'); vi.stubEnv('NEXTAUTH_SECRET', 'test-mail-encryption-secret');
    mocks.db.mockReturnValue({ rpc: mocks.rpc }); mocks.rpc.mockResolvedValue({ data: true, error: null });
    mocks.hash.mockResolvedValue('scrypt-v1$private-test-hash');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe.each([{ path: 'password', handler: savePassword }, { path: 'reset-password', handler: requestReset }])('$path input validation', ({ path, handler }) => {
    it.each([null, [], '', 12, false].map(body => ({ body })))('rejects malformed bodies as a client error, without changing credentials: %j', async ({ body }) => {
        const response = await handler(request(path, body));
        expect(response.status).toBe(400);
        expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.hash).not.toHaveBeenCalled();
    });
});

it('sets a password only through the single-use password token RPC', async () => {
    const response = await savePassword(request('password', { token: 'a'.repeat(43), password: 'A chosen password 123!' }));
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('tokko_set_account_password', expect.objectContaining({ p_password: 'scrypt-v1$private-test-hash' }));
    expect(JSON.stringify(await response.json())).not.toMatch(/private-test-hash|aaaa/);
});
