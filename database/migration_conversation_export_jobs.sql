-- Durable, browser-independent conversation exports.
-- Run this migration before deploying the export queue application code.

CREATE TABLE IF NOT EXISTS public.conversation_export_jobs (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    format TEXT NOT NULL DEFAULT 'csv' CHECK (format IN ('csv')),
    scope TEXT NOT NULL CHECK (scope IN ('all', 'selected')),
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    contact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    next_contact_index INTEGER NOT NULL DEFAULT 0 CHECK (next_contact_index >= 0),
    next_cursor TEXT,
    total_items INTEGER CHECK (total_items IS NULL OR total_items >= 0),
    processed_items INTEGER NOT NULL DEFAULT 0 CHECK (processed_items >= 0),
    conversation_count INTEGER NOT NULL DEFAULT 0 CHECK (conversation_count >= 0),
    message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
    chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
    filename TEXT NOT NULL,
    storage_prefix TEXT NOT NULL,
    error_message TEXT,
    attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TIMESTAMPTZ,
    claim_token UUID,
    claimed_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_export_jobs_worker
    ON public.conversation_export_jobs(status, next_attempt_at, claimed_at, created_at);
CREATE INDEX IF NOT EXISTS idx_conversation_export_jobs_user_created
    ON public.conversation_export_jobs(created_by, created_at DESC);

DROP TRIGGER IF EXISTS update_conversation_export_jobs_updated_at
    ON public.conversation_export_jobs;
CREATE TRIGGER update_conversation_export_jobs_updated_at
    BEFORE UPDATE ON public.conversation_export_jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.conversation_export_jobs ENABLE ROW LEVEL SECURITY;

-- The application accesses this table with the service role and performs its
-- own page-membership checks. Keeping RLS enabled prevents direct anon access.

CREATE OR REPLACE FUNCTION public.claim_conversation_export_job(p_job_id UUID DEFAULT NULL)
RETURNS SETOF public.conversation_export_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_job_id UUID;
BEGIN
    SELECT job.id
      INTO v_job_id
      FROM public.conversation_export_jobs AS job
     WHERE (p_job_id IS NULL OR job.id = p_job_id)
       AND job.expires_at > NOW()
       AND (
            job.status = 'queued'
            OR (
                job.status = 'running'
                AND (job.claimed_at IS NULL OR job.claimed_at < NOW() - INTERVAL '6 minutes')
            )
       )
       AND (job.next_attempt_at IS NULL OR job.next_attempt_at <= NOW())
     ORDER BY job.created_at ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED;

    IF v_job_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    UPDATE public.conversation_export_jobs AS claimed
       SET status = 'running',
           claim_token = pg_catalog.gen_random_uuid(),
           claimed_at = NOW(),
           started_at = COALESCE(started_at, NOW()),
           error_message = NULL,
           updated_at = NOW()
     WHERE claimed.id = v_job_id
     RETURNING claimed.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_conversation_export_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_conversation_export_job(UUID) TO service_role;
