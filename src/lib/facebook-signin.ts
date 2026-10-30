import type { Session } from 'next-auth';

export function facebookReturnPath(value: unknown): string {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/dashboard';
    try {
        const url = new URL(value, 'https://tokko.invalid');
        if (url.origin !== 'https://tokko.invalid' || !(url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/') || url.pathname === '/vintage')) return '/dashboard';
        return url.pathname + url.search + url.hash;
    } catch { return '/dashboard'; }
}

export function facebookSignInCallback(next: unknown = '/dashboard'): string {
    return `/facebook-signin?${new URLSearchParams({ next: facebookReturnPath(next) })}`;
}

export function facebookSignInDestination(session: Session | null, next: unknown): string | null {
    if (session?.user?.id && (session.user.provider === 'facebook' || session.signInProvider === 'facebook')) return facebookReturnPath(next);
    if (session?.requiresFacebookVerification) return `/verify-facebook?${new URLSearchParams({ next: facebookReturnPath(next) })}`;
    return null;
}

export function facebookSignInMessage(error: string | null, accountError?: Session['authenticationError']): string {
    if (accountError === 'service_unavailable' || error === 'Configuration') return 'Facebook sign-in is temporarily unavailable. Retry, or ask the Tokko administrator to check the sign-in service.';
    if (accountError === 'account_unavailable') return 'Facebook confirmed your identity, but this Tokko account is inactive or expired. Contact your Page administrator to restore access.';
    if (error === 'AccessDenied') return 'Facebook sign-in was not approved. Continue with Facebook again and approve the requested permissions.';
    if (error) return 'Facebook sign-in could not be completed. Try again with the Facebook account that manages your Pages.';
    return 'Your Facebook session could not be completed. Continue with Facebook again to open your workspace.';
}
