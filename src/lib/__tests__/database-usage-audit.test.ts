import { describe, expect, it } from 'vitest';
import { validateUsageAuditTarget } from '../../../scripts/audit-database-usage.mjs';

const original = 'pnhzpeyzpwsmwcuafgpw';
const replacement = 'vhtbmdizugnxkgocmruq';
const settings = (project = original) => ({
    NEXT_PUBLIC_SUPABASE_URL: `https://${project}.supabase.co`,
    DATABASE_POOLER_URL_6543: `postgresql://postgres.${project}:test-password@aws-0-region.pooler.supabase.com:6543/postgres`
});

describe('database usage audit project guard', () => {
    it('accepts matching API and SQL targets and requires the intended project explicitly', () => {
        expect(validateUsageAuditTarget(settings(), original).project).toBe(original);
        expect(() => validateUsageAuditTarget(settings(), undefined)).toThrow('--expected-project');
    });
    it('refuses replacement project settings when inspecting the live original project', () => {
        expect(() => validateUsageAuditTarget(settings(replacement), original)).toThrow('No database queries were run');
    });
    it('rejects cross-project pooler settings, arbitrary hosts, and non-PostgreSQL URLs', () => {
        for (const connection of [settings(replacement).DATABASE_POOLER_URL_6543,
            `postgresql://postgres.${original}:test-password@unrelated.example:6543/postgres`,
            `https://db.${original}.supabase.co/postgres`]) {
            expect(() => validateUsageAuditTarget({ ...settings(), DATABASE_POOLER_URL_6543: connection }, original)).toThrow('No database queries were run');
        }
    });
});
