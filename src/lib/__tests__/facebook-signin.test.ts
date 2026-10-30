import { describe, expect, it } from 'vitest';
import type { Session } from 'next-auth';
import { facebookReturnPath, facebookSignInCallback, facebookSignInDestination, facebookSignInMessage } from '../facebook-signin';

describe('Facebook sign-in completion routing', () => {
    it('opens the requested Page screen after a successful Facebook login', () => {
        expect(facebookSignInDestination({ user: { id: 'original', provider: 'facebook' } } as Session, '/dashboard/team')).toBe('/dashboard/team');
        expect(facebookSignInCallback('/dashboard/ads')).toBe('/facebook-signin?next=%2Fdashboard%2Fads');
    });
    it('takes pending Facebook identities to explicit confirmation without an email sign-in redirect', () => {
        expect(facebookSignInDestination({ user: {}, requiresFacebookVerification: true } as Session, '/dashboard/connect')).toBe('/verify-facebook?next=%2Fdashboard%2Fconnect');
        expect(facebookSignInDestination(null, '/dashboard')).toBeNull();
        expect(facebookSignInDestination({ user: {}, signInProvider: 'facebook', accountActive: false } as Session, '/dashboard')).toBeNull();
        expect(facebookSignInDestination({ user: { id: 'email-member', provider: 'credentials' } } as Session, '/dashboard')).toBeNull();
    });
    it.each(['https://evil.test', '//evil.test', '/\\evil.test', '/dashboard/../../evil', '/login', '/facebook-signin', '/api/auth/signout', '/dashboard\r\nLocation:evil'])('rejects unsafe or looping return paths: %s', path => {
        expect(facebookReturnPath(path)).toBe('/dashboard');
    });
    it('preserves safe filters and separates service errors from account expiry', () => {
        expect(facebookReturnPath('/dashboard/contacts?tag=123#latest')).toBe('/dashboard/contacts?tag=123#latest');
        expect(facebookReturnPath('/vintage')).toBe('/vintage');
        expect(facebookSignInMessage(null, 'service_unavailable')).toContain('temporarily unavailable');
        expect(facebookSignInMessage(null, 'account_unavailable')).toContain('inactive or expired');
        expect(facebookSignInMessage('OAuthCallback')).toContain('Facebook');
    });
});
