import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn()
}));

vi.mock('@/lib/get-session', () => ({
    getSessionFromRequest: mocks.getSessionFromRequest
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/auth', () => ({
    authOptions: {
        providers: []
    }
}));

import { GET as getDatabaseCheck } from './test-db/route';
import { GET as getSyncCheck } from './test-sync/route';
import { GET as getLoggingCheck } from './test-logging/route';
import { GET as getFacebookOauthCheck } from './test-facebook-oauth/route';
import { GET as getOauthConfigCheck } from './check-oauth-config/route';

const handlers = [
    getDatabaseCheck,
    getSyncCheck,
    getLoggingCheck,
    getFacebookOauthCheck,
    getOauthConfigCheck
];

describe('diagnostic routes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionFromRequest.mockResolvedValue(null);
    });

    it('requires authentication before returning diagnostic data', async () => {
        for (const handler of handlers) {
            const response = await handler(
                new Request('http://localhost:3000/api/diagnostic') as NextRequest
            );
            expect(response.status).toBe(401);
        }

        expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    });
});
