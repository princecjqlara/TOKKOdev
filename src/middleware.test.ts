import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';
afterEach(() => { vi.unstubAllEnvs(); });
describe('API origins and public workers', () => {
    it.each([undefined, 'legacy-worker-secret'])('allows scheduled workers without headers when CRON_SECRET is %s', secret => {
        vi.stubEnv('CRON_SECRET', secret);
        const workers = ['campaign-scheduled', 'campaign-loop', 'sync', 'follow-up-automations',
            'exports', 'messaging-auto-tag', 'subaccounts', 'account-mail'];
        for (const worker of workers) {
            for (const method of ['GET', 'OPTIONS']) {
                const response = middleware(new NextRequest(`https://tokko.example/api/cron/${worker}`, { method }));
                expect(response.headers.get('x-middleware-next')).toBe('1');
            }
        }
    });
    it('ignores an obsolete scheduler authorization header', () => {
        vi.stubEnv('CRON_SECRET', 'legacy-worker-secret');
        const response = middleware(new NextRequest('https://tokko.example/api/cron/campaign-scheduled', {
            headers: { authorization: 'Bearer outdated-key' }
        }));
        expect(response.headers.get('x-middleware-next')).toBe('1');
    });
    it('denies foreign-origin Page mutations and preserves OAuth/webhook entry points', () => {
        vi.stubEnv('NEXTAUTH_URL', 'https://tokko.example');
        expect(middleware(new NextRequest('https://tokko.example/api/tags', { method: 'POST', headers: { origin: 'https://foreign.example' } })).status).toBe(403);
        expect(middleware(new NextRequest('https://tokko.example/api/cron-settings', { method: 'POST', headers: { origin: 'https://foreign.example' } })).status).toBe(403);
        expect(middleware(new NextRequest('https://tokko.example/api/tags', { method: 'POST', headers: { origin: 'https://tokko.example' } })).headers.get('x-middleware-next')).toBe('1');
        expect(middleware(new NextRequest('https://tokko.example/api/facebook/webhook', { method: 'POST' })).headers.get('x-middleware-next')).toBe('1');
        expect(middleware(new NextRequest('https://tokko.example/api/auth/callback/facebook')).headers.get('x-middleware-next')).toBe('1');
    });
});
