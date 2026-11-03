import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseErrorDetails } from '../database-request';

afterEach(() => vi.unstubAllEnvs());

describe('safe database failure diagnostics', () => {
    it('reports an unavailable database even when the gateway error has no message', () => {
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://original-project.supabase.co');
        expect(databaseErrorDetails({ error: 'upstream failure' }, 521)).toEqual({
            error: 'Database service is unavailable (HTTP 521).', code: null, status: 521, databaseHost: 'original-project.supabase.co'
        });
    });

    it('distinguishes missing or duplicate records from database availability failures', () => {
        expect(databaseErrorDetails({ code: 'PGRST116' }, 406)).toMatchObject({
            error: 'Expected one database record; the lookup returned none or multiple records.', code: 'PGRST116', status: 406
        });
    });

    it('omits query credentials, raw gateway bodies and authentication metadata', () => {
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://private-user:private-password@project.supabase.co/path?apikey=private-key');
        const details = databaseErrorDetails({ code: 'invalid secret-code', message: 'private-email', details: 'private-token', error: 'private-cookie' }, 401);
        expect(details).toMatchObject({ databaseHost: 'project.supabase.co', status: 401, code: null });
        expect(JSON.stringify(details)).not.toContain('private-');
    });

    it('handles timeouts, primitive errors and missing configuration without undefined messages', () => {
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
        expect(databaseErrorDetails({ code: 'DATABASE_TIMEOUT', status: 503 })).toMatchObject({ error: 'Database request timed out.', status: 503, databaseHost: null });
        expect(databaseErrorDetails('gateway failure')).toMatchObject({ error: expect.any(String), status: null, code: null });
    });
});
