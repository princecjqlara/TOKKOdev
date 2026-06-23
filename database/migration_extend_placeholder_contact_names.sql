-- Extend placeholder contact-name filtering for already-migrated databases.

UPDATE contacts
SET name = NULL
WHERE name IS NOT NULL
  AND lower(btrim(name)) IN ('unknown', 'unknown name', 'unknown user', 'facebook user', 'undefined', 'null');

ALTER TABLE contacts
    DROP CONSTRAINT IF EXISTS contacts_name_not_placeholder;

ALTER TABLE contacts
    ADD CONSTRAINT contacts_name_not_placeholder
    CHECK (
        name IS NULL
        OR (
            btrim(name) <> ''
            AND lower(btrim(name)) NOT IN ('unknown', 'unknown name', 'unknown user', 'facebook user', 'undefined', 'null')
        )
    );
