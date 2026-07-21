-- Prevent placeholder contact names from being stored
-- Run this SQL in your Supabase SQL Editor

-- Clean up any existing placeholder or blank names so the constraint can be applied safely
UPDATE contacts
SET name = NULL
WHERE name IS NOT NULL
  AND (
    btrim(name) = ''
    OR lower(btrim(name)) IN ('unknown', 'unknown name', 'unknown user', 'facebook user', 'messenger contact', 'undefined', 'null')
  );

-- Reject future placeholder name writes at the database layer
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'contacts_name_not_placeholder'
          AND conrelid = 'public.contacts'::regclass
    ) THEN
        ALTER TABLE contacts
        ADD CONSTRAINT contacts_name_not_placeholder
        CHECK (
            name IS NULL
            OR (
                btrim(name) <> ''
                AND lower(btrim(name)) NOT IN ('unknown', 'unknown name', 'unknown user', 'facebook user', 'messenger contact', 'undefined', 'null')
            )
        );
    END IF;
END $$;
