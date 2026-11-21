import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ session: { status: 'authenticated', data: { user: { id: 'member', provider: 'credentials' } } } }));
vi.mock('next-auth/react', () => ({ useSession: () => mocks.session, signOut: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), usePathname: () => '/dashboard' }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => React.createElement('a', props, children) }));
import DashboardPage from '../../app/dashboard/page';
import DashboardLayout from '../../app/dashboard/layout';

let screen: ReactTestRenderer | undefined;
beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('React', React);
    vi.stubGlobal('window', { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), location: { pathname: '/dashboard', replace: vi.fn() } });
    vi.stubGlobal('document', { hidden: false });
});
afterEach(() => { act(() => screen?.unmount()); screen = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('dashboard loading recovery', () => {
    it.each([
        { component: DashboardPage, stage: 'request' },
        { component: DashboardPage, stage: 'response body' },
        { component: DashboardLayout, stage: 'request' },
        { component: DashboardLayout, stage: 'response body' }
    ])('offers a working retry after a stalled $stage in $component.name', async ({ component, stage }) => {
        let signal: AbortSignal | undefined;
        const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
            signal = options?.signal ?? undefined;
            if (stage === 'request') return new Promise<Response>(() => {});
            return { ok: true, json: () => new Promise(() => {}) } as Response;
        });
        vi.stubGlobal('fetch', fetchMock);
        await act(async () => { screen = create(React.createElement(component, null, 'Workspace content')); });
        await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
        expect(signal?.aborted).toBe(true);
        const retry = screen!.root.findAllByType('button').find(button => button.children.includes('Retry loading Pages'));
        expect(retry).toBeDefined();
        expect(JSON.stringify(screen!.toJSON())).not.toContain('No Pages assigned');
        fetchMock.mockImplementation(async () => Response.json({ pages: [], reconnectRequiredPages: [] }));
        await act(async () => { await retry!.props.onClick(); });
        expect(JSON.stringify(screen!.toJSON())).not.toContain('Retry loading Pages');
    });

    it.each(['request', 'response body'])('offers a working totals retry when the contacts %s stalls', async stage => {
        let stalled = true;
        let signal: AbortSignal | undefined;
        vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
            if (url === '/api/pages') return Response.json({ pages: [{ id: 'page', name: 'Assigned Page' }] });
            if (url.startsWith('/api/pages/page/contacts') && stalled) {
                signal = options?.signal as AbortSignal;
                if (stage === 'request') return new Promise<Response>(() => {});
                return { ok: true, json: () => new Promise(() => {}) } as Response;
            }
            return Response.json({ items: [], total: 5 });
        }));
        await act(async () => { screen = create(React.createElement(DashboardPage)); });
        await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
        expect(signal?.aborted).toBe(true);
        const retry = screen!.root.findAllByType('button').find(button => button.children.includes('Retry dashboard totals'));
        expect(retry).toBeDefined();
        stalled = false;
        await act(async () => { await retry!.props.onClick(); });
        expect(JSON.stringify(screen!.toJSON())).not.toContain('Retry dashboard totals');
    });

    it.each(['request', 'response body'])('resumes access checks after a stalled membership %s', async stage => {
        let attempts = 0;
        let signal: AbortSignal | undefined;
        vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
            if (url === '/api/pages') return Response.json({ pages: [{ id: 'page', name: 'Assigned Page' }] });
            if (++attempts === 1) {
                signal = options?.signal as AbortSignal;
                if (stage === 'request') return new Promise<Response>(() => {});
                return { ok: true, json: () => new Promise(() => {}) } as Response;
            }
            return Response.json({ pages: [] });
        }));
        await act(async () => { screen = create(React.createElement(DashboardLayout, null, 'Workspace content')); });
        const refresh = vi.mocked(window.setInterval).mock.calls[0][0] as () => void;
        await act(async () => { refresh(); });
        await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
        expect(signal?.aborted).toBe(true);
        await act(async () => { refresh(); });
        expect(attempts).toBe(2);
        expect(window.location.replace).toHaveBeenCalledWith('/dashboard');
    });

    it.each(['timeout', 'unmount'])('ignores a late unauthorized membership response after %s', async cancellation => {
        let complete!: (response: Response) => void;
        let signal: AbortSignal | undefined;
        vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
            if (url === '/api/pages') return Response.json({ pages: [{ id: 'page', name: 'Assigned Page' }] });
            signal = options?.signal as AbortSignal;
            return new Promise<Response>(resolve => { complete = resolve; });
        }));
        await act(async () => { screen = create(React.createElement(DashboardLayout, null, 'Workspace content')); });
        const refresh = vi.mocked(window.setInterval).mock.calls[0][0] as () => void;
        await act(async () => { refresh(); });
        await act(async () => {
            if (cancellation === 'timeout') await vi.advanceTimersByTimeAsync(12_000);
            else { screen!.unmount(); screen = undefined; }
        });
        expect(signal?.aborted).toBe(true);
        await act(async () => { complete(new Response(null, { status: 401 })); });
        expect(window.location.replace).not.toHaveBeenCalled();
    });
});
