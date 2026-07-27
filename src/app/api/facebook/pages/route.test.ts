import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { FACEBOOK_REAUTH_MESSAGE } from '@/lib/facebook-permissions';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    getFacebookPages: vi.fn()
}));

vi.mock('next-auth', () => ({
    getServerSession: mocks.getServerSession
}));

vi.mock('@/lib/auth', () => ({
    authOptions: {}
}));

vi.mock('@/lib/facebook', () => ({
    getFacebookPages: mocks.getFacebookPages,
    isFacebookReauthRequired: (error: unknown) => Boolean((error as { requiresReauth?: boolean })?.requiresReauth)
}));

import { GET } from './route';

function createRequest(): NextRequest {
    return new Request('http://localhost:3000/api/facebook/pages') as unknown as NextRequest;
}

describe('GET /api/facebook/pages', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns a reauthorization response when Facebook rejects /me/accounts permissions', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: {
                id: 'user_1',
                email: 'user@example.com'
            },
            accessToken: 'user_access_token_1'
        });
        mocks.getFacebookPages.mockRejectedValue(
            Object.assign(new Error(FACEBOOK_REAUTH_MESSAGE), { requiresReauth: true })
        );

        const response = await GET(createRequest());
        const body = await response.json();

        expect(response.status).toBe(409);
        expect(body).toEqual({
            error: 'Facebook authorization required',
            code: 'FACEBOOK_REAUTH_REQUIRED',
            requiresReauth: true,
            message: FACEBOOK_REAUTH_MESSAGE
        });
    });
});
