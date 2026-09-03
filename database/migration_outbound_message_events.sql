-- Exact attribution for Page messages shown in conversation exports.
-- Existing Facebook history cannot be attributed retroactively; new sends are
-- recorded by their Facebook message ID and joined during export.
CREATE TABLE IF NOT EXISTS public.outbound_message_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
    message_id TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL,
    source_id UUID,
    source_name TEXT,
    actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    actor_name TEXT,
    message_kind TEXT,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT outbound_message_events_source_type_check
        CHECK (source_type IN ('manual', 'campaign', 'automation', 'welcome'))
);

CREATE INDEX IF NOT EXISTS idx_outbound_message_events_page_message
    ON public.outbound_message_events(page_id, message_id);

CREATE INDEX IF NOT EXISTS idx_outbound_message_events_page_sent
    ON public.outbound_message_events(page_id, sent_at DESC);
