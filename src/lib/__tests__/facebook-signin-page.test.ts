import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { Session } from 'next-auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ useSession: vi.fn(), signIn: vi.fn() }));
vi.mock('next-auth/react', () => mocks);
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => React.createElement('a', props, children) }));
import FacebookSignInPage from '../../app/facebook-signin/page';
import { FACEBOOK_PERMISSION_SCOPE } from '../facebook-permissions';

let page: ReactTestRenderer | undefined;
let session: { data: Session | null; status: 'loading' | 'authenticated' | 'unauthenticated' };
let location: { search: string; replace: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn> };
const text = () => JSON.stringify(page!.toJSON());
function render() { act(() => { page = create(React.createElement(FacebookSignInPage)); }); }
function refresh() { act(() => { page!.update(React.createElement(FacebookSignInPage)); }); }
function button(label: string) { return page!.root.findAllByType('button').find(node => node.children.join('') === label)!; }

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    session = { data: null, status: 'loading' };
    mocks.useSession.mockImplementation(() => session);
    mocks.signIn.mockResolvedValue(undefined);
    location = { search: '', replace: vi.fn(), reload: vi.fn() };
    vi.stubGlobal('window', { location });
});
afterEach(() => {
    act(() => page?.unmount());
    page = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('Facebook sign-in recovery', () => {
    it('replaces an endless session check with an account retry that preserves the existing login', () => {
        render();
        expect(text()).toContain('Completing Facebook sign-in');
        act(() => vi.advanceTimersByTime(15_000));
        expect(text()).not.toContain('Completing Facebook sign-in');
        expect(text()).toContain('The sign-in check took too long');
        act(() => button('Retry account check').props.onClick());
        expect(location.reload).toHaveBeenCalledOnce();
        expect(mocks.signIn).not.toHaveBeenCalled();
        expect(location.replace).not.toHaveBeenCalled();
    });

    it('opens a verified workspace with a full navigation and retains the safe requested path', () => {
        location.search = '?next=%2Fdashboard%2Fcontacts%3Ftag%3D123';
        session = { data: { user: { id: 'verified', provider: 'facebook' } } as Session, status: 'authenticated' };
        render();
        expect(location.replace).toHaveBeenCalledOnce();
        expect(location.replace).toHaveBeenCalledWith('/dashboard/contacts?tag=123');
        act(() => vi.advanceTimersByTime(15_000));
        const link = page!.root.findAllByType('a').find(node => node.children.join('') === 'Open your workspace');
        expect(link?.props.href).toBe('/dashboard/contacts?tag=123');
        expect(text()).not.toContain('Completing Facebook sign-in');
        expect(location.replace).toHaveBeenCalledOnce();
    });

    it('still opens the workspace when the session arrives after the recovery controls appear', () => {
        render();
        act(() => vi.advanceTimersByTime(15_000));
        session = { data: { user: { id: 'verified', provider: 'facebook' } } as Session, status: 'authenticated' };
        refresh();
        expect(location.replace).toHaveBeenCalledOnce();
        expect(location.replace).toHaveBeenCalledWith('/dashboard');
    });

    it('offers a session retry for a temporary service failure without claiming the account expired', () => {
        session = { data: { user: {}, signInProvider: 'facebook', authenticationError: 'service_unavailable' } as Session, status: 'authenticated' };
        render();
        expect(text()).toContain('temporarily unavailable');
        expect(button('Retry account check')).toBeTruthy();
        expect(location.replace).not.toHaveBeenCalled();
    });

    it('keeps an inactive account out of the workspace', () => {
        session = { data: { user: {}, signInProvider: 'facebook', authenticationError: 'account_unavailable' } as Session, status: 'authenticated' };
        render();
        expect(text()).toContain('inactive or expired');
        expect(location.replace).not.toHaveBeenCalled();
    });

    it('displays OAuth errors immediately even if session loading stalls', () => {
        location.search = '?error=OAuthCallback';
        render();
        expect(text()).not.toContain('Completing Facebook sign-in');
        expect(button('Continue with Facebook')).toBeTruthy();
        expect(location.replace).not.toHaveBeenCalled();
    });

    it('retains the original return path and permissions when Facebook sign-in is retried', async () => {
        location.search = '?next=%2Fdashboard%2Fads';
        session.status = 'unauthenticated';
        render();
        await act(async () => button('Continue with Facebook').props.onClick());
        expect(mocks.signIn).toHaveBeenCalledWith('facebook', { callbackUrl: '/facebook-signin?next=%2Fdashboard%2Fads' }, { auth_type: 'rerequest', scope: FACEBOOK_PERMISSION_SCOPE });
    });

    it('makes Facebook retry available again when starting OAuth stalls', () => {
        session.status = 'unauthenticated';
        mocks.signIn.mockImplementationOnce(() => new Promise(() => {}));
        render();
        act(() => button('Continue with Facebook').props.onClick());
        expect(button('Connecting…').props.disabled).toBe(true);
        act(() => vi.advanceTimersByTime(15_000));
        expect(button('Continue with Facebook').props.disabled).toBe(false);
    });
});
