# Database Migration Instructions

## Migration: Add last_synced_at for Incremental Syncing

**IMPORTANT:** Copy ONLY the SQL code below. Do NOT copy any TypeScript, JavaScript, or React code.

### Step 1: Open Supabase SQL Editor
1. Go to your Supabase project dashboard
2. Click on "SQL Editor" in the left sidebar
3. Click "New query"

### Step 2: Run the migration
Copy and paste **ONLY** the following SQL code:

```sql
ALTER TABLE pages 
ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pages_last_synced_at ON pages(last_synced_at);

UPDATE pages 
SET last_synced_at = created_at 
WHERE last_synced_at IS NULL;
```

### Step 3: Execute
Click "Run" or press Ctrl+Enter

### Troubleshooting
- If you see a syntax error mentioning `'use client'` or other code, you accidentally copied non-SQL code
- Make sure you're only copying the SQL code above (between the ```sql markers)
- The SQL should start with `ALTER TABLE` and end with `WHERE last_synced_at IS NULL;`

