import { AccessError } from './account-security';

type ProfileAccount = { created_by?: string | null; account_kind?: string; profile_required?: boolean; profile_completed_at?: string | null };

export function isSubaccount(account: ProfileAccount) {
    return Boolean(account.created_by || ['email', 'invited'].includes(account.account_kind || ''));
}

export function needsSubaccountProfile(account: ProfileAccount) {
    return isSubaccount(account) && account.profile_required === true && !account.profile_completed_at;
}

export function subaccountProfileInput(body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccessError(400, 'Enter your name and phone number.');
    const input = body as Record<string, unknown>;
    const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw new AccessError(400, 'Enter your name using 1 to 100 characters.');
    let phone = typeof input.phone === 'string' ? input.phone.trim() : '';
    if (phone.length > 40 || !/^[+\d\s().-]+$/.test(phone)) throw new AccessError(400, 'Enter a phone number with its country code, such as +63 912 345 6789.');
    phone = phone.replace(/[\s().-]/g, '');
    if (/^09\d{9}$/.test(phone)) phone = `+63${phone.slice(1)}`;
    else if (/^63\d{10}$/.test(phone)) phone = `+${phone}`;
    else if (/^00[1-9]\d{7,14}$/.test(phone)) phone = `+${phone.slice(2)}`;
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new AccessError(400, 'Enter a phone number with its country code, such as +63 912 345 6789.');
    return { name, phone };
}
