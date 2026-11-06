import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ useSession: vi.fn(), replace: vi.fn(), update: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: mocks.useSession, signOut: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }), usePathname: () => '/dashboard/contacts' }));
import DashboardLayout from '../../app/dashboard/layout';
let screen: ReactTestRenderer | undefined;

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('React', React);
    vi.stubGlobal('fetch', vi.fn());
    mocks.useSession.mockReturnValue({ data: { user: {}, authenticationError: 'service_unavailable' },
        status: 'authenticated', update: mocks.update });
    mocks.update.mockResolvedValue(null);
});
afterEach(() => { act(() => screen?.unmount()); screen = undefined; vi.unstubAllGlobals(); });

describe('dashboard account recovery', () => {
    it('offers an account retry without redirecting a signed-in user during a service outage', async () => {
        await act(async () => { screen = create(React.createElement(DashboardLayout, null, 'private data')); });
        expect(JSON.stringify(screen!.toJSON())).toContain('Retry account check');
        expect(JSON.stringify(screen!.toJSON())).not.toContain('private data');
        expect(mocks.replace).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        await act(async () => { await screen!.root.findByType('button').props.onClick(); });
        expect(mocks.update).toHaveBeenCalledOnce();
    });
});
