import { FACEBOOK_REAUTH_MESSAGE } from './facebook-permissions';

const FACEBOOK_REAUTH_PATTERNS = [
    'pages_show_list',
    'must be granted before impersonating',
    'validating access token',
    'session has expired',
    'missing permissions'
];

export function isFacebookReauthMessage(message: string) {
    const normalized = message.toLowerCase();
    const hasKnownPattern = FACEBOOK_REAUTH_PATTERNS.some((pattern) => normalized.includes(pattern));
    const isMeObjectError =
        normalized.includes('unsupported get request') &&
        normalized.includes('object with id') &&
        normalized.includes('me');

    return hasKnownPattern || isMeObjectError;
}

export function getFacebookConnectErrorMessage(message: string | null | undefined) {
    if (!message) {
        return 'Failed to load Facebook pages';
    }

    return isFacebookReauthMessage(message) ? FACEBOOK_REAUTH_MESSAGE : message;
}
