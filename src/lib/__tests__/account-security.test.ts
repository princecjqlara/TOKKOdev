import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSameOrigin, decryptMailToken, digest, encryptMailToken, hashAccountPassword, newAccountToken, normalizeEmail, verifyAccountPassword } from '../account-security';

afterEach(() => { vi.unstubAllEnvs(); });
describe('account credential safety', () => {
    it('normalizes email without letting Facebook fallback addresses become password accounts', () => {
        expect(normalizeEmail('  Person+team@Example.COM ')).toBe('person+team@example.com');
        expect(() => normalizeEmail('fb_123@facebook.local')).toThrow();
        expect(() => normalizeEmail('no-address')).toThrow();
    });
    it('salts password hashes, rejects incorrect and legacy seed credentials, and preserves long passwords', async () => {
        const password = 'A unique long account password 123!';
        const first = await hashAccountPassword(password);
        const second = await hashAccountPassword(password);
        expect(first).not.toBe(second);
        expect(first).not.toContain(password);
        expect(await verifyAccountPassword(password, first)).toBe(true);
        expect(await verifyAccountPassword(password + 'x', first)).toBe(false);
        expect(await verifyAccountPassword('changeme123', '$2a$10$legacy')).toBe(false);
        expect(await verifyAccountPassword(password, null)).toBe(false);
        await expect(hashAccountPassword('short')).rejects.toThrow();
        await expect(hashAccountPassword('x'.repeat(1025))).rejects.toThrow();
    });
    it('encrypts queued setup tokens and detects tampering', () => {
        vi.stubEnv('NEXTAUTH_SECRET', 'test-only-account-mail-key');
        const { token, hash } = newAccountToken();
        expect(hash).toBe(digest(token)); expect(token).toHaveLength(43);
        const encrypted = encryptMailToken(token);
        expect(encrypted).not.toContain(token);
        expect(decryptMailToken(encrypted)).toBe(token);
        const parts = encrypted.split('.'); parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
        expect(() => decryptMailToken(parts.join('.'))).toThrow();
    });
    it('requires the configured application origin for account writes', () => {
        vi.stubEnv('NEXTAUTH_URL', 'https://tokko.example');
        expect(() => assertSameOrigin(new Request('https://tokko.example/api/team-access', { headers: { origin: 'https://evil.example' } }))).toThrow();
        expect(() => assertSameOrigin(new Request('https://tokko.example/api/team-access'))).toThrow();
        expect(() => assertSameOrigin(new Request('https://tokko.example/api/team-access', { headers: { origin: 'https://tokko.example' } }))).not.toThrow();
    });
});
