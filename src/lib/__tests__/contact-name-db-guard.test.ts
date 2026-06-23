import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const migrationPath = join(repoRoot, 'database', 'migration_prevent_placeholder_contact_names.sql');
const extendedMigrationPath = join(repoRoot, 'database', 'migration_extend_placeholder_contact_names.sql');
const schemaPath = join(repoRoot, 'database', 'schema.sql');
const placeholderListPattern = /'unknown',\s*'unknown name',\s*'unknown user',\s*'facebook user',\s*'undefined',\s*'null'/i;

describe('contact name database guard', () => {
    it('ships a migration that backfills placeholder names before adding the constraint', () => {
        const sql = readFileSync(migrationPath, 'utf8');

        expect(sql).toMatch(/UPDATE\s+contacts/i);
        expect(sql).toMatch(/SET\s+name\s*=\s*NULL/i);
        expect(sql).toMatch(/contacts_name_not_placeholder/i);
        expect(sql).toMatch(/conrelid\s*=\s*'public\.contacts'::regclass/i);
        expect(sql).toMatch(placeholderListPattern);
    });

    it('ships a follow-up migration for existing placeholder-name constraints', () => {
        const sql = readFileSync(extendedMigrationPath, 'utf8');

        expect(sql).toMatch(/UPDATE\s+contacts/i);
        expect(sql).toMatch(/DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+contacts_name_not_placeholder/i);
        expect(sql).toMatch(/ADD\s+CONSTRAINT\s+contacts_name_not_placeholder/i);
        expect(sql).toMatch(placeholderListPattern);
    });

    it('declares the contact name guard in the base schema', () => {
        const sql = readFileSync(schemaPath, 'utf8');

        expect(sql).toMatch(/CONSTRAINT\s+contacts_name_not_placeholder\s+CHECK/i);
        expect(sql).toMatch(placeholderListPattern);
    });
});
