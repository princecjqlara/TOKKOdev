import { getSupabaseAdmin } from './supabase';
import { AccessError, decryptMailToken } from './account-security';

export function accountMailConfigured() {
    return Boolean(process.env.RESEND_API_KEY && process.env.TOKKO_ACCOUNT_EMAIL_FROM && process.env.NEXTAUTH_URL && process.env.NEXTAUTH_SECRET);
}

export function requireAccountMail() {
    if (!accountMailConfigured()) throw new AccessError(503, 'Account emails are not configured yet. Ask the Tokko administrator to configure the email sender.');
}

export async function processAccountMail(deliveryId?: string): Promise<boolean> {
    requireAccountMail();
    const db = getSupabaseAdmin();
    const { data, error } = await db.rpc('tokko_claim_account_mail', { p_id: deliveryId || null });
    if (error) throw error;
    const mail = Array.isArray(data) ? data[0] : data;
    if (!mail) {
        if (!deliveryId) return false;
        const { data: prior, error: priorError } = await db.from('tokko_account_mail').select('status').eq('id', deliveryId).maybeSingle();
        if (priorError) throw priorError;
        return prior?.status === 'sent';
    }
    try {
        const url = new URL(mail.purpose === 'link_facebook' ? '/verify-facebook' : '/setup-password', process.env.NEXTAUTH_URL);
        url.hash = new URLSearchParams({ token: decryptMailToken(mail.encrypted_token) }).toString();
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json', 'Idempotency-Key': `tokko-account/${mail.id}` },
            signal: AbortSignal.timeout(15000),
            body: JSON.stringify({ from: process.env.TOKKO_ACCOUNT_EMAIL_FROM, to: [mail.email],
                subject: mail.purpose === 'setup' ? 'Set up your Tokko account' : mail.purpose === 'link_facebook' ? 'Verify your Facebook connection to Tokko' : 'Reset your Tokko password',
                text: mail.purpose === 'link_facebook'
                    ? `You requested to connect a Facebook sign-in to your existing Tokko account. This preserves your existing Pages and does not change your password.\n\nOnly if you initiated this request, open this link in the same browser you used for Facebook sign-in: ${url}\n\nIt expires at ${mail.expires_at}. If this was not you, ignore this email.`
                    : `${mail.purpose === 'setup' ? 'You have been invited to Tokko.' : 'A password reset was requested for your Tokko account.'}\n\nChoose your password: ${url}\n\nThis link can be used once and expires at ${mail.expires_at}. If you did not expect this email, you can ignore it.` })
        });
        if (!response.ok) throw new Error('Email delivery was not accepted.');
        const { error: saveError } = await db.from('tokko_account_mail').update({ status: 'sent', sent_at: new Date().toISOString(),
            lease_until: null, encrypted_token: '' }).eq('id', mail.id).eq('claim_token', mail.claim_token).eq('status', 'sending');
        if (saveError) throw saveError;
        return true;
    } catch {
        // Keep the encrypted payload for bounded retries; never log setup links or provider responses.
        const { error: retryError } = await db.from('tokko_account_mail').update({ status: 'pending', lease_until: null,
            next_attempt_at: new Date(Date.now() + 5 * 60 * 1000).toISOString() })
            .eq('id', mail.id).eq('claim_token', mail.claim_token).eq('status', 'sending');
        if (retryError) throw retryError;
        return false;
    }
}
