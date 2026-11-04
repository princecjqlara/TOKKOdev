import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), replace: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: mocks.session, signOut: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }), usePathname: () => '/dashboard' }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => React.createElement('a', props, children) }));
import DashboardLayout from '../../app/dashboard/layout';

let screen: ReactTestRenderer | undefined;
let pageData: unknown;
beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockReturnValue({ status: 'authenticated', data: { user: { id: 'facebook_user', provider: 'facebook', name: 'Page manager' }, accountType: 'parent' } });
    pageData = { pages: [], facebookDiscovery: { restored: 0 } };
    vi.stubGlobal('window', { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), location: { pathname: '/dashboard', replace: vi.fn() } });
    vi.stubGlobal('document', { hidden: false });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(pageData)));
});
afterEach(() => { act(() => screen?.unmount()); screen = undefined; vi.unstubAllGlobals(); });
async function render() {
    await act(async () => { screen = create(React.createElement(DashboardLayout, null, React.createElement('span', {}, 'Tokko workspace content'))); });
}
describe('direct Facebook workspace admission', () => {
    it('keeps a Facebook user in Tokko and offers direct Page connection without demanding an email invitation', async () => {
        await render();
        const text = JSON.stringify(screen!.toJSON());
        expect(text).toContain('Facebook sign-in is complete');
        expect(text).toContain('Tokko workspace content');
        expect(text).toContain('a Tokko email invitation is not required');
        expect(screen!.root.findAllByType('a').some(link => link.props.href === '/dashboard/connect')).toBe(true);
        expect(mocks.replace).not.toHaveBeenCalled();
    });
    it('opens recovered shared Pages without another connection or import screen', async () => {
        pageData = { pages: [{ id: 'shared', fb_page_id: 'fb-page', name: 'Shared Page' }], facebookDiscovery: { restored: 1 } };
        await render();
        const text = JSON.stringify(screen!.toJSON());
        expect(text).toContain('Tokko workspace content');
        expect(text).not.toContain('No connected Pages were found');
        expect(mocks.replace).not.toHaveBeenCalled();
    });
    it('keeps email subaccount assignment instructions separate from Facebook sign-in', async () => {
        mocks.session.mockReturnValue({ status: 'authenticated', data: { user: { id: 'member', provider: 'credentials' }, accountType: 'subaccount' } });
        await render();
        const text = JSON.stringify(screen!.toJSON());
        expect(text).toContain('Ask your Tokko administrator');
        expect(text).not.toContain('Facebook sign-in is complete');
    });
});
