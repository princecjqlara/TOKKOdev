import { AccessError } from './account-security';
import { parseAccountExpiry } from './account-expiry';

export function subaccountLifetime(body: Record<string, unknown>) {
    const days = body.lifetimeDays == null ? null : body.lifetimeDays;
    if (days !== null && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 3650)) throw new AccessError(400, 'Choose a whole number from 1 to 3,650 days.');
    if (days !== null && body.expiresAt !== undefined) throw new AccessError(400, 'Choose a number of days or a deadline, not both.');
    if (body.deleteAfterExpiry !== undefined && typeof body.deleteAfterExpiry !== 'boolean') throw new AccessError(400, 'Choose whether the temporary subaccount should be deleted.');
    let expiresAt;
    try { expiresAt = parseAccountExpiry(body.expiresAt); }
    catch { throw new AccessError(400, 'Choose a valid expiry date and time in the future.'); }
    return { days: days as number | null, expiresAt, deleteAfterExpiry: body.deleteAfterExpiry as boolean | undefined };
}
