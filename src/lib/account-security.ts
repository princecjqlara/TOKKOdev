import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export class AccessError extends Error {
    constructor(public status: number, message: string) { super(message); this.name = 'AccessError'; }
}

export function normalizeEmail(value: unknown): string {
    const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.endsWith('@facebook.local')) {
        throw new AccessError(400, 'Enter a valid email address.');
    }
    return email;
}

export function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function newAccountToken() { const token = randomBytes(32).toString('base64url'); return { token, hash: digest(token) }; }

// Stable across retries without storing a plain password or an offline verifier.
export function accountPasswordFingerprint(password: string) {
    if (!process.env.NEXTAUTH_SECRET) throw new Error('NEXTAUTH_SECRET is required.');
    return createHmac('sha256', process.env.NEXTAUTH_SECRET).update('tokko-member-password-v1:').update(password).digest('hex');
}

function derive(password: string, salt: string): Promise<Buffer> {
    return new Promise((resolve, reject) => scrypt(password, salt, 64,
        { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
        (error, key) => error ? reject(error) : resolve(key)));
}

export async function hashAccountPassword(password: unknown): Promise<string> {
    if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024) {
        throw new AccessError(400, 'Use a password of at least 12 characters and no more than 1,024 bytes.');
    }
    const salt = randomBytes(24).toString('hex');
    return `scrypt-v1$${salt}$${(await derive(password, salt)).toString('hex')}`;
}

export async function verifyAccountPassword(password: unknown, stored: unknown): Promise<boolean> {
    const validInput = typeof password === 'string' && Buffer.byteLength(password) <= 1024;
    const match = typeof stored === 'string' ? /^scrypt-v1\$([a-f0-9]{48})\$([a-f0-9]{128})$/.exec(stored) : null;
    // Unknown accounts and legacy/default hashes still perform the expensive comparison.
    const actual = await derive(validInput ? password : '', match?.[1] || '0'.repeat(48));
    const expected = Buffer.from(match?.[2] || '0'.repeat(128), 'hex');
    return Boolean(validInput && match && timingSafeEqual(actual, expected));
}

function mailKey(): Buffer {
    if (!process.env.NEXTAUTH_SECRET) throw new Error('NEXTAUTH_SECRET is required.');
    return createHash('sha256').update(`tokko-account-mail-v1:${process.env.NEXTAUTH_SECRET}`).digest();
}

export function encryptMailToken(token: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', mailKey(), iv);
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}

export function decryptMailToken(value: string): string {
    const parts = value.split('.').map(part => Buffer.from(part, 'base64url'));
    if (parts.length !== 3) throw new Error('Invalid email payload.');
    const decipher = createDecipheriv('aes-256-gcm', mailKey(), parts[0]);
    decipher.setAuthTag(parts[1]);
    return Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString('utf8');
}

export function assertSameOrigin(request: Request) {
    const origin = request.headers.get('origin');
    const expected = new URL(process.env.NEXTAUTH_URL || request.url).origin;
    if (!origin || origin !== expected) throw new AccessError(403, 'This request must come from Tokko.');
}

export function validUuid(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function accountErrorResponse(error: unknown): Response {
    const status = error instanceof AccessError ? error.status : error instanceof SyntaxError ? 400 : 503;
    if (!(error instanceof AccessError)) console.error('Account operation failed:', (error as { code?: string })?.code || 'unavailable');
    return Response.json({ message: error instanceof AccessError ? error.message : error instanceof SyntaxError ? 'Invalid request data.' : 'Account service is temporarily unavailable. Please retry.' },
        { status, headers: { 'Cache-Control': 'no-store' } });
}
