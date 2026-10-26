import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock('../supabase', () => ({ getSupabaseAdmin: mocks.db }));
import { processAccountMail } from '../account-mail';
import { encryptMailToken } from '../account-security';
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('RESEND_API_KEY', 'test-provider-key'); vi.stubEnv('TOKKO_ACCOUNT_EMAIL_FROM', 'Tokko <accounts@example.com>');
    vi.stubEnv('NEXTAUTH_URL', 'https://tokko.example'); vi.stubEnv('NEXTAUTH_SECRET', 'test-secret'); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function database(purpose = 'setup') {
    const updates: Record<string, unknown>[] = [];
    const rpc = vi.fn().mockResolvedValue({ data: [{ id: 'mail', claim_token: 'lease', email: 'recipient@example.com',
        encrypted_token: encryptMailToken('secret-setup-token'), purpose, expires_at: '2026-10-27T00:00:00Z' }], error: null });
    const chain: any = { eq: () => chain, then: (resolve: (result: { error: null }) => unknown) => Promise.resolve({ error: null }).then(resolve) };
    return { rpc, updates, from: () => ({ update: (data: Record<string, unknown>) => { updates.push(data); return chain; } }) };
}
describe('recipient-only durable account emails', () => {
    it('sends only to the recipient using a stable provider idempotency key and clears the encrypted payload after acceptance', async () => {
        const db = database(); mocks.db.mockReturnValue(db);
        const send = vi.fn().mockResolvedValue(new Response('{}', { status: 200 })); vi.stubGlobal('fetch', send);
        expect(await processAccountMail('mail')).toBe(true);
        const payload = JSON.parse(send.mock.calls[0][1].body);
        expect(payload.to).toEqual(['recipient@example.com']);
        expect(payload.text).toContain('https://tokko.example/setup-password#token=secret-setup-token');
        expect(send.mock.calls[0][1].headers['Idempotency-Key']).toBe('tokko-account/mail');
        expect(db.updates).toContainEqual(expect.objectContaining({ status: 'sent', encrypted_token: '' }));
    });
    it('preserves failed sends for bounded worker retry instead of rolling back or recreating the account', async () => {
        const db = database(); mocks.db.mockReturnValue(db); vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
        expect(await processAccountMail('mail')).toBe(false);
        expect(db.updates).toContainEqual(expect.objectContaining({ status: 'pending', lease_until: null }));
        expect(db.rpc).toHaveBeenCalledTimes(1);
    });
});
