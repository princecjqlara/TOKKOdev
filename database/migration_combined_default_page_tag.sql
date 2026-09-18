-- One combined page tag. Reuse existing Paid / Availed Service tags and their
-- contact assignments; never replace a page's existing combined tag.
ALTER TABLE tags
ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

-- Correct the mistaken three-tag rollout on 2026-09-18. These 119 rows were
-- created together and have no contact assignments. The older PAID tag is kept.
DROP TRIGGER IF EXISTS create_default_page_tags_on_insert ON pages;
DROP INDEX IF EXISTS idx_tags_default_page_name;

DELETE FROM tags AS t
WHERE t.is_default
  AND t.owner_type = 'page'
  AND t.page_id = t.owner_id
  AND t.name IN ('Paid', 'Avail Service', 'Qualified')
  AND t.created_at = TIMESTAMPTZ '2026-09-18 17:20:20.910+00'
  AND NOT EXISTS (SELECT 1 FROM contact_tags AS ct WHERE ct.tag_id = t.id);

UPDATE tags
SET is_default = FALSE
WHERE is_default
  AND owner_type = 'page'
  AND lower(btrim(name)) IN ('paid', 'avail service', 'qualified');

WITH existing AS (
    SELECT DISTINCT ON (t.owner_id) t.id
    FROM tags AS t
    JOIN pages AS p ON p.id = t.owner_id
    WHERE t.owner_type = 'page'
      AND regexp_replace(lower(t.name), '[^a-z]', '', 'g')
          IN ('paidavailedservice', 'paidavailedservices')
    ORDER BY t.owner_id, t.created_at NULLS LAST, t.id
)
UPDATE tags
SET is_default = TRUE, page_id = owner_id
WHERE id IN (SELECT id FROM existing);

INSERT INTO tags (name, color, owner_type, owner_id, page_id, is_default)
SELECT 'Paid / Availed Service', '#16a34a', 'page', p.id, p.id, TRUE
FROM pages AS p
WHERE NOT EXISTS (
    SELECT 1 FROM tags AS t
    WHERE t.owner_type = 'page'
      AND t.owner_id = p.id
      AND regexp_replace(lower(t.name), '[^a-z]', '', 'g')
          IN ('paidavailedservice', 'paidavailedservices')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_one_default_per_page
ON tags (owner_id) WHERE owner_type = 'page' AND is_default;

CREATE OR REPLACE FUNCTION create_default_page_tags()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO tags (name, color, owner_type, owner_id, page_id, is_default)
    VALUES ('Paid / Availed Service', '#16a34a', 'page', NEW.id, NEW.id, TRUE);
    RETURN NEW;
END;
$$;

CREATE TRIGGER create_default_page_tags_on_insert
AFTER INSERT ON pages
FOR EACH ROW EXECUTE FUNCTION create_default_page_tags();
