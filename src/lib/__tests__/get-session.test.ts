import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getServerSession: vi.fn() }));
vi.mock('next-auth', () => mocks);
vi.mock('../auth', () => ({ authOptions: {} }));
import { getSessionFromRequest } from '../get-session';
import type { NextRequest } from 'next/server';
const request = new Request('https://tokko.test/api/pages') as NextRequest;

describe('request session failures', () => {
    it('distinguishes an unavailable account service from a signed-out user', async () => {
        mocks.getServerSession.mockResolvedValueOnce({ user: {}, authenticationError: 'service_unavailable' });
        await expect(getSessionFromRequest(request)).rejects.toMatchObject({ status: 503 });
        mocks.getServerSession.mockResolvedValueOnce(null);
        expect(await getSessionFromRequest(request)).toBeNull();
    });
    it('continues to reject inactive accounts and incomplete profiles', async () => {
        for (const extra of [{ authenticationError: 'account_unavailable' }, { requiresProfileCompletion: true }]) {
            mocks.getServerSession.mockResolvedValueOnce({ user: {}, ...extra });
            expect(await getSessionFromRequest(request)).toBeNull();
        }
    });
});
