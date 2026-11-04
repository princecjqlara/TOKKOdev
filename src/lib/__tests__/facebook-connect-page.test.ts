import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ useSession: vi.fn(), signIn: vi.fn(), sync: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: mocks.useSession, signIn: mocks.signIn }));
vi.mock('@/lib/contact-sync-client', () => ({ runContactSyncToCompletion: mocks.sync }));
import ConnectPage from '../../app/dashboard/connect/page';

let screen: ReactTestRenderer | undefined;
let needsInitialSync: boolean;
beforeEach(() => {
    vi.clearAllMocks();
    needsInitialSync = false;
    mocks.useSession.mockReturnValue({ data: { user: { id: 'new_manager', provider: 'facebook' } } });
    mocks.sync.mockResolvedValue({ completed: true, totalSynced: 1, totalFailed: 0 });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/api/facebook/pages'
        ? { pages: [{ id: 'facebook_page', name: 'Shared Page' }] }
        : url === '/api/pages' ? { pages: [] }
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
});
