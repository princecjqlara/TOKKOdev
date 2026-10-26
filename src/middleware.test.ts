import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';
afterEach(() => { vi.unstubAllEnvs(); });
describe('API origin and worker isolation', () => {
    it('rejects global worker calls from ordinary accounts and accepts only the worker secret', () => {
        vi.stubEnv('CRON_SECRET', 'worker-secret');
        expect(middleware(new NextRequest('https://tokko.example/api/cron/campaign-scheduled')).status).toBe(401);
        expect(middleware(new NextRequest('https://tokko.example/api/cron/campaign-scheduled', { headers: { authorization: 'Bearer worker-secret' } })).headers.get('x-middleware-next')).toBe('1');
    });
    it('requires configuration instead of exposing unprotected workers', () => {
        vi.stubEnv('CRON_SECRET', '');
        expect(middleware(new NextRequest('https://tokko.example/api/cron/account-mail')).status).toBe(503);
    });
    it('denies foreign-origin Page mutations and preserves OAuth/webhook entry points', () => {
        vi.stubEnv('NEXTAUTH_URL', 'https://tokko.example');
        expect(middleware(new NextRequest('https://tokko.example/api/tags', { method: 'POST', headers: { origin: 'https://foreign.example' } })).status).toBe(403);
        expect(middleware(new NextRequest('https://tokko.example/api/tags', { method: 'POST', headers: { origin: 'https://tokko.example' } })).headers.get('x-middleware-next')).toBe('1');
        expect(middleware(new NextRequest('https://tokko.example/api/facebook/webhook', { method: 'POST' })).headers.get('x-middleware-next')).toBe('1');
        expect(middleware(new NextRequest('https://tokko.example/api/auth/callback/facebook')).headers.get('x-middleware-next')).toBe('1');
    });
});
