-- Forward-only inquiry analytics. No historical contact/queue rewrite or send.
BEGIN;
-- Keep the creation-message marker on a new contact so a retried webhook can
-- retain its New classification even if the separate insight write failed.
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS tokko_inquiry_origin_mid TEXT;
CREATE TABLE IF NOT EXISTS app_private.tokko_insight_config (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), started_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO app_private.tokko_insight_config(singleton) VALUES(TRUE) ON CONFLICT DO NOTHING;
REVOKE ALL ON app_private.tokko_insight_config FROM PUBLIC,anon,authenticated;
CREATE TABLE IF NOT EXISTS public.tokko_insight_settings (
 page_id UUID PRIMARY KEY REFERENCES public.pages(id) ON DELETE CASCADE,
 started_at TIMESTAMPTZ NOT NULL,
 returning_after_days INTEGER NOT NULL DEFAULT 30 CHECK(returning_after_days BETWEEN 1 AND 365),
 response_sla_minutes INTEGER NOT NULL DEFAULT 60 CHECK(response_sla_minutes BETWEEN 1 AND 1440),
 last_received_at TIMESTAMPTZ, last_event_at TIMESTAMPTZ,
 invalid_events BIGINT NOT NULL DEFAULT 0, historical_events_ignored BIGINT NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.tokko_inquiry_events (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
 contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
 event_key TEXT NOT NULL CHECK(length(event_key) BETWEEN 1 AND 600),
 message_id TEXT NOT NULL CHECK(length(message_id) BETWEEN 1 AND 500),
 kind TEXT NOT NULL CHECK(kind IN ('inbound','outbound','stage')),
 source TEXT NOT NULL CHECK(source IN ('messenger','manual','campaign','automation','welcome')),
 stage TEXT CHECK(stage IN ('qualified','converted','unqualified','lost','order_created')),
 occurred_at TIMESTAMPTZ NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 time_basis TEXT NOT NULL CHECK(time_basis IN ('provider','accepted_send')),
 actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
 new_contact BOOLEAN NOT NULL DEFAULT FALSE,
 returning_after_days INTEGER NOT NULL CHECK(returning_after_days BETWEEN 1 AND 365),
 UNIQUE(page_id,event_key), CHECK((kind='stage')=(stage IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS tokko_inquiry_events_contact_time ON public.tokko_inquiry_events(page_id,contact_id,occurred_at,id);
CREATE INDEX IF NOT EXISTS tokko_inquiry_events_page_time ON public.tokko_inquiry_events(page_id,occurred_at);
ALTER TABLE public.tokko_insight_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokko_inquiry_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokko_insight_settings,public.tokko_inquiry_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.tokko_insight_settings,public.tokko_inquiry_events TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.tokko_inquiry_events_id_seq TO service_role;
INSERT INTO public.tokko_insight_settings(page_id,started_at)
SELECT p.id,c.started_at FROM public.pages p CROSS JOIN app_private.tokko_insight_config c ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.record_tokko_inquiry_events(p_page UUID,p_contact UUID,p_events JSONB,p_new_contact BOOLEAN DEFAULT FALSE)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE cfg public.tokko_insight_settings; item JSONB; at_time TIMESTAMPTZ; mid TEXT; event_kind TEXT;
 event_source TEXT; event_stage TEXT; actor UUID; basis TEXT; inserted INTEGER:=0; invalid INTEGER:=0; historical INTEGER:=0; ack RECORD;
BEGIN
 IF jsonb_typeof(p_events) IS DISTINCT FROM 'array' OR jsonb_array_length(p_events)>100 THEN RAISE EXCEPTION 'Invalid event batch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.contacts WHERE id=p_contact AND page_id=p_page) THEN RAISE EXCEPTION 'Contact is outside Page scope' USING ERRCODE='42501'; END IF;
 INSERT INTO public.tokko_insight_settings(page_id,started_at) SELECT p_page,started_at FROM app_private.tokko_insight_config ON CONFLICT DO NOTHING;
 SELECT * INTO cfg FROM public.tokko_insight_settings WHERE page_id=p_page;
 FOR item IN SELECT value FROM jsonb_array_elements(p_events) LOOP
  mid:=nullif(item->>'message_id',''); event_kind:=item->>'kind'; event_source:=coalesce(item->>'source','messenger');
  event_stage:=nullif(item->>'stage',''); basis:=coalesce(item->>'time_basis','provider'); actor:=NULL;
  IF mid IS NULL OR length(mid)>500 OR event_kind IS NULL OR event_kind NOT IN ('inbound','outbound','stage') OR event_source NOT IN ('messenger','manual','campaign','automation','welcome') OR basis NOT IN ('provider','accepted_send') THEN invalid:=invalid+1;CONTINUE;END IF;
  IF (event_kind='stage' AND (event_stage IS NULL OR event_stage NOT IN ('qualified','converted','unqualified','lost','order_created'))) OR (event_kind<>'stage' AND event_stage IS NOT NULL) THEN invalid:=invalid+1;CONTINUE;END IF;
  BEGIN at_time:=(item->>'occurred_at')::timestamptz; EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN at_time:=NULL;END;
  IF at_time IS NULL OR at_time>clock_timestamp() THEN invalid:=invalid+1;CONTINUE;END IF;
  IF at_time<cfg.started_at THEN historical:=historical+1;CONTINUE;END IF;
  IF event_kind='outbound' THEN
   SELECT source_type,actor_user_id INTO ack FROM public.outbound_message_events WHERE page_id=p_page AND contact_id=p_contact AND message_id=mid;
   IF FOUND THEN event_source:=ack.source_type;actor:=ack.actor_user_id;END IF;
   -- A bulk send alone never creates a tracked inquiry or fills the event store
   -- for the historical audience. Its later echo remains correctly attributed.
   IF event_source='campaign' AND NOT EXISTS(SELECT 1 FROM public.tokko_inquiry_events WHERE page_id=p_page AND contact_id=p_contact AND kind='inbound') THEN CONTINUE;END IF;
  END IF;
  INSERT INTO public.tokko_inquiry_events AS saved(page_id,contact_id,event_key,message_id,kind,source,stage,occurred_at,time_basis,actor_user_id,new_contact,returning_after_days)
  VALUES(p_page,p_contact,'message:'||mid,mid,event_kind,event_source,event_stage,at_time,basis,actor,event_kind='inbound' AND (coalesce(p_new_contact,FALSE) OR
   (coalesce(item->>'collector'='saved_history',FALSE) AND EXISTS(SELECT 1 FROM public.contacts WHERE id=p_contact AND created_at>=cfg.started_at))),cfg.returning_after_days)
  ON CONFLICT(page_id,event_key) DO UPDATE SET
   source=CASE WHEN saved.source='messenger' THEN EXCLUDED.source ELSE saved.source END,
   actor_user_id=coalesce(saved.actor_user_id,EXCLUDED.actor_user_id),
   occurred_at=CASE WHEN saved.time_basis='accepted_send' AND EXCLUDED.time_basis='provider' THEN EXCLUDED.occurred_at ELSE saved.occurred_at END,
   time_basis=CASE WHEN EXCLUDED.time_basis='provider' THEN 'provider' ELSE saved.time_basis END,
   new_contact=saved.new_contact OR EXCLUDED.new_contact
  WHERE saved.contact_id=EXCLUDED.contact_id AND saved.kind=EXCLUDED.kind;
  inserted:=inserted+1;
 END LOOP;
 IF inserted+invalid+historical>0 THEN
 UPDATE public.tokko_insight_settings SET last_received_at=clock_timestamp(),
  last_event_at=(SELECT max(occurred_at) FROM public.tokko_inquiry_events WHERE page_id=p_page),
  invalid_events=invalid_events+invalid,historical_events_ignored=historical_events_ignored+historical WHERE page_id=p_page;
 END IF;
 RETURN jsonb_build_object('accepted',inserted,'invalid',invalid,'historical_ignored',historical);
END;$$;

CREATE OR REPLACE FUNCTION app_private.tokko_capture_outbound_insight()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NEW.source_type='campaign' AND NOT EXISTS(SELECT 1 FROM public.tokko_inquiry_events WHERE page_id=NEW.page_id AND contact_id=NEW.contact_id AND kind='inbound') THEN RETURN NEW;END IF;
 IF NEW.contact_id IS NOT NULL THEN
  PERFORM public.record_tokko_inquiry_events(NEW.page_id,NEW.contact_id,jsonb_build_array(jsonb_build_object(
   'message_id',NEW.message_id,'kind','outbound','source',NEW.source_type,'occurred_at',NEW.sent_at,'time_basis','accepted_send')),FALSE);
 END IF;RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS tokko_capture_outbound_insight ON public.outbound_message_events;
CREATE TRIGGER tokko_capture_outbound_insight AFTER INSERT OR UPDATE OF source_type,actor_user_id ON public.outbound_message_events
FOR EACH ROW EXECUTE FUNCTION app_private.tokko_capture_outbound_insight();

-- Sessionize actual inbound event time, not ingestion order. Late events revise
-- the current report consistently; their immutable source records are retained.
CREATE OR REPLACE VIEW public.tokko_inquiry_episode_facts AS
WITH ordered AS (
 SELECT e.*,lag(occurred_at) OVER(PARTITION BY page_id,contact_id ORDER BY occurred_at,id) previous_inbound
 FROM public.tokko_inquiry_events e WHERE kind='inbound'
), numbered AS (
 SELECT *,sum(CASE WHEN previous_inbound IS NULL OR occurred_at-previous_inbound>=make_interval(days=>returning_after_days) THEN 1 ELSE 0 END)
 OVER(PARTITION BY page_id,contact_id ORDER BY occurred_at,id) episode_number FROM ordered
), grouped AS (
 SELECT page_id,contact_id,episode_number,(array_agg(id ORDER BY occurred_at,id))[1] episode_id,
  min(occurred_at) started_at,max(occurred_at) last_inbound_at,count(*) inbound_messages,bool_or(new_contact) contains_new_contact
 FROM numbered GROUP BY page_id,contact_id,episode_number
)
SELECT *,lead(started_at) OVER(PARTITION BY page_id,contact_id ORDER BY started_at,episode_id) next_episode_at,
 CASE WHEN episode_number=1 AND contains_new_contact THEN 'new_contact' ELSE 'returning_contact' END kind FROM grouped;
REVOKE ALL ON public.tokko_inquiry_episode_facts FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.tokko_inquiry_episode_facts TO service_role;

CREATE OR REPLACE FUNCTION public.tokko_set_inquiry_policy(p_actor UUID,p_page UUID,p_returning_days INTEGER,p_sla_minutes INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 PERFORM public.tokko_assert_manager(p_actor,ARRAY[p_page]);
 IF p_returning_days IS NULL OR p_sla_minutes IS NULL OR p_returning_days NOT BETWEEN 1 AND 365 OR p_sla_minutes NOT BETWEEN 1 AND 1440 THEN RAISE EXCEPTION 'Invalid inquiry policy';END IF;
 INSERT INTO public.tokko_insight_settings(page_id,started_at) SELECT p_page,started_at FROM app_private.tokko_insight_config ON CONFLICT DO NOTHING;
 UPDATE public.tokko_insight_settings SET returning_after_days=p_returning_days,response_sla_minutes=p_sla_minutes,updated_at=now() WHERE page_id=p_page;
 RETURN jsonb_build_object('returning_after_days',p_returning_days,'response_sla_minutes',p_sla_minutes);
END;$$;

CREATE OR REPLACE FUNCTION public.tokko_inquiry_insights(p_actor UUID,p_page UUID,p_from DATE,p_to DATE,p_kind TEXT DEFAULT 'all',p_horizon_hours INTEGER DEFAULT 24,p_as_of TIMESTAMPTZ DEFAULT now())
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE cfg public.tokko_insight_settings; result JSONB; from_time TIMESTAMPTZ; until_time TIMESTAMPTZ; can_manage BOOLEAN:=FALSE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.user_pages up JOIN public.users u ON u.id=up.user_id WHERE up.user_id=p_actor AND up.page_id=p_page AND u.is_active AND (u.expires_at IS NULL OR u.expires_at>now())) THEN RAISE EXCEPTION 'Page access required' USING ERRCODE='42501';END IF;
 SELECT EXISTS(SELECT 1 FROM public.users u JOIN public.tokko_auth_identities i ON i.user_id=u.id AND i.provider='facebook' AND i.subject=u.facebook_id
  WHERE u.id=p_actor AND u.created_by IS NULL AND u.account_kind IN ('facebook','legacy') AND u.is_active AND (u.expires_at IS NULL OR u.expires_at>now())) INTO can_manage;
 IF p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to-p_from>365 OR p_kind IS NULL OR p_kind NOT IN ('all','new_contact','returning_contact') OR p_horizon_hours IS NULL OR p_horizon_hours NOT IN (24,168) OR p_as_of IS NULL OR p_as_of>clock_timestamp()+INTERVAL '5 minutes' THEN RAISE EXCEPTION 'Invalid reporting filters';END IF;
 SELECT * INTO cfg FROM public.tokko_insight_settings WHERE page_id=p_page;
 IF NOT FOUND THEN
  SELECT started_at INTO cfg.started_at FROM app_private.tokko_insight_config;
  cfg.returning_after_days:=30;cfg.response_sla_minutes:=60;
 END IF;
 from_time:=p_from::timestamp AT TIME ZONE 'Asia/Manila';until_time:=(p_to+1)::timestamp AT TIME ZONE 'Asia/Manila';
 WITH episodes AS (
  SELECT * FROM public.tokko_inquiry_episode_facts WHERE page_id=p_page AND started_at>=from_time AND started_at<until_time AND started_at<=p_as_of AND (p_kind='all' OR kind=p_kind)
 ), facts AS (
  SELECT e.*,c.name,c.psid,e.started_at+make_interval(hours=>p_horizon_hours)<=p_as_of AND (e.next_episode_at IS NULL OR e.next_episode_at>=e.started_at+make_interval(hours=>p_horizon_hours)) mature,
   e.next_episode_at IS NOT NULL AND e.next_episode_at<e.started_at+make_interval(hours=>p_horizon_hours) censored,
   min(v.occurred_at) FILTER(WHERE v.kind='outbound' AND v.source<>'campaign') first_reply_at,
   min(v.occurred_at) FILTER(WHERE v.kind='outbound' AND v.source='manual' AND v.actor_user_id IS NOT NULL) first_human_reply_at,
   min(v.occurred_at) FILTER(WHERE v.kind='outbound' AND v.source IN ('automation','welcome')) first_automated_reply_at,
   min(v.occurred_at) FILTER(WHERE v.kind='stage' AND v.stage='qualified') qualified_at,
   min(v.occurred_at) FILTER(WHERE v.kind='stage' AND v.stage='order_created') order_created_at,
   min(v.occurred_at) FILTER(WHERE v.kind='stage' AND v.stage='converted') converted_at,
   (array_agg(v.stage ORDER BY v.occurred_at DESC,v.id DESC) FILTER(WHERE v.kind='stage'))[1] last_stage,
   count(*) FILTER(WHERE v.kind='outbound' AND v.source='messenger') unknown_reply_sources
  FROM episodes e JOIN public.contacts c ON c.id=e.contact_id AND c.page_id=e.page_id
  LEFT JOIN public.tokko_inquiry_events v ON v.page_id=e.page_id AND v.contact_id=e.contact_id AND v.occurred_at>=e.started_at AND v.occurred_at<=p_as_of AND (e.next_episode_at IS NULL OR v.occurred_at<e.next_episode_at)
  GROUP BY e.page_id,e.contact_id,e.episode_number,e.episode_id,e.started_at,e.last_inbound_at,e.inbound_messages,e.contains_new_contact,e.next_episode_at,e.kind,c.name,c.psid
 ), totals AS (
  SELECT count(*) n,count(DISTINCT contact_id) contacts,count(*) FILTER(WHERE kind='new_contact') new_contacts,
   count(*) FILTER(WHERE kind='returning_contact') returning_contacts,count(*) FILTER(WHERE mature) mature,count(*) FILTER(WHERE censored) censored,
   count(*) FILTER(WHERE qualified_at<=started_at+make_interval(hours=>p_horizon_hours)) qualified,
   count(*) FILTER(WHERE order_created_at<=started_at+make_interval(hours=>p_horizon_hours)) ordered,
   count(*) FILTER(WHERE converted_at<=started_at+make_interval(hours=>p_horizon_hours)) converted,
   count(*) FILTER(WHERE mature AND qualified_at<=started_at+make_interval(hours=>p_horizon_hours)) mature_qualified,
   count(*) FILTER(WHERE mature AND converted_at<=started_at+make_interval(hours=>p_horizon_hours)) mature_converted,
   count(*) FILTER(WHERE first_reply_at IS NOT NULL) replied,
   count(*) FILTER(WHERE mature AND (first_reply_at IS NULL OR first_reply_at>started_at+make_interval(hours=>p_horizon_hours))) mature_unanswered,
   count(*) FILTER(WHERE started_at+make_interval(mins=>cfg.response_sla_minutes)<=p_as_of) sla_eligible,
   count(*) FILTER(WHERE started_at+make_interval(mins=>cfg.response_sla_minutes)<=p_as_of AND first_reply_at<=started_at+make_interval(mins=>cfg.response_sla_minutes)) sla_met,
   percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM first_reply_at-started_at)/60) FILTER(WHERE first_reply_at IS NOT NULL) reply_median_minutes,
   percentile_cont(0.9) WITHIN GROUP(ORDER BY extract(epoch FROM first_reply_at-started_at)/60) FILTER(WHERE first_reply_at IS NOT NULL) reply_p90_minutes,
   count(*) FILTER(WHERE first_human_reply_at IS NOT NULL) human_replied,count(*) FILTER(WHERE first_automated_reply_at IS NOT NULL) automated_replied,
   coalesce(sum(unknown_reply_sources),0) unknown_reply_sources FROM facts
 )
 SELECT jsonb_build_object('definition_version','tokko-inquiry-v1','as_of',p_as_of,'timezone','Asia/Manila','can_manage',can_manage,
  'filters',jsonb_build_object('from',p_from,'to',p_to,'kind',p_kind,'horizon_hours',p_horizon_hours),
  'collection',jsonb_build_object('started_at',cfg.started_at,'returning_after_days',cfg.returning_after_days,'response_sla_minutes',cfg.response_sla_minutes,'last_received_at',cfg.last_received_at,'last_event_at',cfg.last_event_at,'invalid_events',coalesce(cfg.invalid_events,0),'historical_events_ignored',coalesce(cfg.historical_events_ignored,0)),
  'episodes',jsonb_build_object('total',t.n,'unique_contacts',t.contacts,'new_contacts',t.new_contacts,'returning_contacts',t.returning_contacts,'mature',t.mature,'provisional',t.n-t.mature-t.censored,'censored',t.censored),
  'funnel',jsonb_build_object('qualified',t.qualified,'order_created',t.ordered,'converted',t.converted,'qualified_rate',t.mature_qualified::numeric/nullif(t.mature,0),'converted_rate',t.mature_converted::numeric/nullif(t.mature,0)),
  'response',jsonb_build_object('replied',t.replied,'human_replied',t.human_replied,'automated_replied',t.automated_replied,'unknown_source_messages',t.unknown_reply_sources,'median_minutes',t.reply_median_minutes,'p90_minutes',t.reply_p90_minutes,'sla_eligible',t.sla_eligible,'sla_met',t.sla_met,'sla_rate',t.sla_met::numeric/nullif(t.sla_eligible,0),'mature_unanswered',t.mature_unanswered,'unanswered_rate',t.mature_unanswered::numeric/nullif(t.mature,0)),
  'contact_coverage',(SELECT jsonb_build_object('total',count(*),'first_interaction_known',count(first_interaction_at),'last_inbound_known',count(last_inbound_at),'first_interaction_fraction',count(first_interaction_at)::numeric/nullif(count(*),0)) FROM public.contacts WHERE page_id=p_page),
  'items',coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY started_at DESC,episode_id DESC) FROM (SELECT episode_id,contact_id,name,psid,kind,started_at,last_inbound_at,inbound_messages,mature,first_reply_at,first_human_reply_at,first_automated_reply_at,qualified_at,order_created_at,converted_at,coalesce(last_stage,'new') stage FROM facts ORDER BY started_at DESC,episode_id DESC LIMIT 50) i),'[]'::jsonb)) INTO result FROM totals t;
 RETURN result;
END;$$;
REVOKE ALL ON FUNCTION public.record_tokko_inquiry_events(UUID,UUID,JSONB,BOOLEAN),public.tokko_inquiry_insights(UUID,UUID,DATE,DATE,TEXT,INTEGER,TIMESTAMPTZ),public.tokko_set_inquiry_policy(UUID,UUID,INTEGER,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_tokko_inquiry_events(UUID,UUID,JSONB,BOOLEAN),public.tokko_inquiry_insights(UUID,UUID,DATE,DATE,TEXT,INTEGER,TIMESTAMPTZ),public.tokko_set_inquiry_policy(UUID,UUID,INTEGER,INTEGER) TO service_role;
REVOKE ALL ON FUNCTION app_private.tokko_capture_outbound_insight() FROM PUBLIC,anon,authenticated;
INSERT INTO app_private.schema_migrations(version,description) VALUES('20261120_001','Forward-only new and returning inquiry insights') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
