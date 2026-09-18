-- Auto-tag Messenger contacts when Meta records an order or a qualified/converted lead stage.
-- Start at deployment time: historical orders are not silently backfilled.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS messaging_auto_tag_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS messaging_auto_tag_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE pages ADD COLUMN IF NOT EXISTS messaging_auto_tag_cursor TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS messaging_auto_tag_attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE pages ADD COLUMN IF NOT EXISTS messaging_auto_tag_last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_pages_messaging_auto_tag_due
ON pages (messaging_auto_tag_attempted_at)
WHERE messaging_auto_tag_enabled;
