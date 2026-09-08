-- Repair export claiming on databases where uuid-ossp is installed outside
-- the function's restricted search_path (common on Supabase).

ALTER TABLE public.conversation_export_jobs
    ALTER COLUMN id SET DEFAULT pg_catalog.gen_random_uuid();

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
