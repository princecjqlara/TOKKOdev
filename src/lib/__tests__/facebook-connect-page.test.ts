import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ useSession: vi.fn(), signIn: vi.fn(), sync: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: mocks.useSession, signIn: mocks.signIn }));
vi.mock('@/lib/contact-sync-client', () => ({ runContactSyncToCompletion: mocks.sync }));
import ConnectPage from '../../app/dashboard/connect/page';

let screen: ReactTestRenderer | undefined;
let needsInitialSync: boolean;
let assignedPages: any[];
let facebookPages: any[];
let facebookError: boolean;
let discoveryMessage: string | null;
beforeEach(() => {
    vi.clearAllMocks();
    needsInitialSync = false;
    assignedPages = [];
    facebookPages = [{ id: 'facebook_page', name: 'Shared Page', tasks: ['MANAGE'] }];
    facebookError = false;
    discoveryMessage = null;
    mocks.useSession.mockReturnValue({ data: { user: { id: 'new_manager', provider: 'facebook' } } });
    mocks.sync.mockResolvedValue({ completed: true, totalSynced: 1, totalFailed: 0 });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/api/facebook/pages'
        ? facebookError ? { error: 'Facebook authorization required', requiresReauth: true, message: 'Refresh Facebook permissions' } : { pages: facebookPages }
        : url.startsWith('/api/pages') ? { pages: assignedPages, facebookDiscovery: { message: discoveryMessage } }
        : { success: true, pageId: 'shared_page', needsInitialSync })));
});
afterEach(() => { act(() => screen?.unmount()); screen = undefined; vi.unstubAllGlobals(); });

describe('connecting a shared Page', () => {
    it('opens existing contacts without starting a new Facebook import', async () => {
        await act(async () => { screen = create(React.createElement(ConnectPage)); });
        const connect = screen!.root.findAllByType('button').find(button => button.children.includes('Connect'))!;
        await act(async () => { await connect.props.onClick(); });
        expect(mocks.sync).not.toHaveBeenCalled();
        expect(JSON.stringify(screen!.toJSON())).toContain('Existing Page contacts and tags are ready');
    });
    it('honors optional auto-tagging when a genuinely new Page needs its first import', async () => {
        needsInitialSync = true;
        await act(async () => { screen = create(React.createElement(ConnectPage)); });
        act(() => screen!.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: false } }));
        const connect = screen!.root.findAllByType('button').find(button => button.children.includes('Connect'))!;
        await act(async () => { await connect.props.onClick(); });
        expect(mocks.sync).toHaveBeenCalledWith('shared_page', expect.objectContaining({ autoTag: false }));
        expect(JSON.stringify(screen!.toJSON())).toContain('Synced 1 contacts');
    });

    it('shows assigned Pages to an invited email member without asking them to sign in with Facebook', async () => {
        assignedPages = [{ id: 'assigned_page', fb_page_id: 'facebook_page', name: 'Assigned Team Page' }];
        mocks.useSession.mockReturnValue({ data: { user: { id: 'invited_member', provider: 'credentials' } } });
        await act(async () => { screen = create(React.createElement(ConnectPage)); });
        expect(screen!.root.findByProps({ href: '/dashboard/contacts?pageId=assigned_page' }).children).toContain('Open contacts');
        expect(JSON.stringify(screen!.toJSON())).toContain('You do not need to connect Facebook again');
        expect((fetch as any).mock.calls.some(([url]: string[]) => url === '/api/facebook/pages')).toBe(false);
        expect(mocks.signIn).not.toHaveBeenCalled(); expect(mocks.sync).not.toHaveBeenCalled();
    });

    it('keeps assigned Pages usable when Facebook authorization cannot be refreshed', async () => {
        assignedPages = [{ id: 'assigned_page', fb_page_id: 'facebook_page', name: 'Assigned Team Page', requiresReconnect: true }];
        facebookError = true;
        await act(async () => { screen = create(React.createElement(ConnectPage)); });
        expect(screen!.root.findByProps({ href: '/dashboard/contacts?pageId=assigned_page' })).toBeTruthy();
        expect(JSON.stringify(screen!.toJSON())).toContain('Stored contacts and tags remain available');
        expect(mocks.sync).not.toHaveBeenCalled();
    });

    it('keeps existing contacts available when automatic discovery of more Pages fails', async () => {
        assignedPages = [{ id: 'assigned_page', fb_page_id: 'facebook_page', name: 'Existing Page' }];
        discoveryMessage = 'Refresh Facebook permissions to discover additional Pages';
        await act(async () => { screen = create(React.createElement(ConnectPage)); });
        expect(screen!.root.findByProps({ href: '/dashboard/contacts?pageId=assigned_page' })).toBeTruthy();
        expect(JSON.stringify(screen!.toJSON())).toContain(discoveryMessage);
    });

    it('does not offer token refresh to a member with messaging-only access', async () => {
        assignedPages = [{ id: 'assigned_page', fb_page_id: 'facebook_page', name: 'Assigned Team Page' }];
        facebookPages = [{ id: 'facebook_page', name: 'Shared Page', tasks: ['PROFILE_PLUS_MESSAGING'] }];
        await act(async () => { screen = create(React.createElement(ConnectPage)); });
        expect(screen!.root.findAllByType('button').some(button => button.children.includes('Reconnect'))).toBe(false);
        expect(screen!.root.findByProps({ href: '/dashboard/contacts?pageId=assigned_page' })).toBeTruthy();
    });

    it.each(['MESSAGING', 'PROFILE_PLUS_MESSAGING', 'PAGES_MESSAGING'])('enables Connect for Facebook %s access without a Tokko assignment', async task => {
        facebookPages = [{ id: 'facebook_page', name: 'Shared Page', tasks: [task] }];
        await act(async () => { screen = create(React.createElement(ConnectPage)); });
        const connect = screen!.root.findAllByType('button').find(button => button.children.includes('Connect'))!;
        expect(connect.props.disabled).toBe(false);
        expect(JSON.stringify(screen!.toJSON())).not.toContain('Ask your Tokko administrator');
        expect(JSON.stringify(screen!.toJSON())).not.toContain('Ask your Tokko admin');
        await act(async () => { await connect.props.onClick(); });
        expect(mocks.sync).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledWith('/api/pages?discoverFacebook=1');
    });

    it('keeps unsupported Facebook roles disabled with Facebook permission instructions', async () => {
        facebookPages = [{ id: 'facebook_page', name: 'Analytics Page', tasks: ['ANALYZE'] }];
        await act(async () => { screen = create(React.createElement(ConnectPage)); });
        expect(screen!.root.findAllByType('button').find(button => button.children.includes('Facebook messaging access required'))?.props.disabled).toBe(true);
    });

    it('sends an explicit refresh request when a verified manager chooses Reconnect', async () => {
        assignedPages = [{ id: 'assigned_page', fb_page_id: 'facebook_page', name: 'Assigned Team Page' }];
        facebookPages = [{ id: 'facebook_page', name: 'Shared Page', tasks: ['PROFILE_PLUS_FULL_CONTROL'] }];
        await act(async () => { screen = create(React.createElement(ConnectPage)); });
        const reconnect = screen!.root.findAllByType('button').find(button => button.children.includes('Reconnect'))!;
        await act(async () => { await reconnect.props.onClick(); });
        const connectRequest = (fetch as any).mock.calls.find(([url]: string[]) => url === '/api/facebook/connect');
        expect(JSON.parse(connectRequest[1].body)).toMatchObject({ fbPageId: 'facebook_page', refreshConnection: true });
    });

    it('explains that a Facebook app invitation alone does not provide Page access', async () => {
        facebookPages = [];
        await act(async () => { screen = create(React.createElement(ConnectPage)); });
        expect(JSON.stringify(screen!.toJSON())).toContain('A Facebook app tester invitation does not grant Page access');
        expect(JSON.stringify(screen!.toJSON())).toContain('Facebook sign-in does not require a Tokko email invitation');
    });
});
