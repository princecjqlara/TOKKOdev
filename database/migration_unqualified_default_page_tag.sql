-- Add a protected Unqualified tag for every Page and use it for Business Suite
-- Lead Center's "Lead stage set to Unqualified" system event.
DROP TRIGGER IF EXISTS create_default_page_tags_on_insert ON pages;
DROP INDEX IF EXISTS idx_tags_one_default_per_page;

-- Reuse an existing page-owned Unqualified tag instead of creating a duplicate.
WITH existing AS (
    SELECT DISTINCT ON (t.owner_id) t.id
    FROM tags AS t
    JOIN pages AS p ON p.id = t.owner_id
    WHERE t.owner_type = 'page'
      AND regexp_replace(lower(t.name), '[^a-z]', '', 'g') = 'unqualified'
    ORDER BY t.owner_id, t.created_at NULLS LAST, t.id
)
UPDATE tags
SET is_default = TRUE, page_id = owner_id, name = 'Unqualified'
WHERE id IN (SELECT id FROM existing);

INSERT INTO tags (name, color, owner_type, owner_id, page_id, is_default)
SELECT 'Unqualified', '#dc2626', 'page', p.id, p.id, TRUE
FROM pages AS p
WHERE NOT EXISTS (
    SELECT 1 FROM tags AS t
    WHERE t.owner_type = 'page'
      AND t.owner_id = p.id
      AND regexp_replace(lower(t.name), '[^a-z]', '', 'g') = 'unqualified'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_default_page_name
ON tags (owner_id, lower(btrim(name)))
WHERE owner_type = 'page' AND is_default;

CREATE OR REPLACE FUNCTION create_default_page_tags()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO tags (name, color, owner_type, owner_id, page_id, is_default)
    VALUES
        ('Paid / Availed Service', '#16a34a', 'page', NEW.id, NEW.id, TRUE),
        ('Unqualified', '#dc2626', 'page', NEW.id, NEW.id, TRUE);
    RETURN NEW;
END;
$$;

CREATE TRIGGER create_default_page_tags_on_insert
AFTER INSERT ON pages
FOR EACH ROW EXECUTE FUNCTION create_default_page_tags();
