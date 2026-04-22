import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const migrationPath = join(repoRoot, 'database', 'migration_prevent_placeholder_contact_names.sql');
const schemaPath = join(repoRoot, 'database', 'schema.sql');

describe('contact name database guard', () => {
    it('ships a migration that backfills placeholder names before adding the constraint', () => {
        const sql = readFileSync(migrationPath, 'utf8');

        expect(sql).toMatch(/UPDATE\s+contacts/i);
        expect(sql).toMatch(/SET\s+name\s*=\s*NULL/i);
        expect(sql).toMatch(/contacts_name_not_placeholder/i);
        expect(sql).toMatch(/conrelid\s*=\s*'public\.contacts'::regclass/i);
        expect(sql).toMatch(/lower\(btrim\(name\)\)\s+IN\s*\('unknown',\s*'undefined',\s*'null'\)/i);
    });

    it('declares the contact name guard in the base schema', () => {
        const sql = readFileSync(schemaPath, 'utf8');

        expect(sql).toMatch(/CONSTRAINT\s+contacts_name_not_placeholder\s+CHECK/i);
        expect(sql).toMatch(/lower\(btrim\(name\)\)\s+NOT\s+IN\s*\('unknown',\s*'undefined',\s*'null'\)/i);
    });
});
