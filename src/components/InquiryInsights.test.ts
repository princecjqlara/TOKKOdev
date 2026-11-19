import React from 'react';
import TestRenderer from 'react-test-renderer';
import { expect, it } from 'vitest';
import InquiryInsights from './InquiryInsights';
import type { InquiryReport } from '@/lib/inquiry-insights';
const empty: InquiryReport = {
    can_manage: false,
    definition_version: 'tokko-inquiry-v1', as_of: '2026-01-01T00:00:00Z', timezone: 'Asia/Manila', filters: { from: '2026-01-01', to: '2026-01-31', kind: 'all', horizon_hours: 24 },
    collection: { started_at: '2026-01-01T00:00:00Z', returning_after_days: 30, response_sla_minutes: 60, last_received_at: null, last_event_at: null, invalid_events: 0, historical_events_ignored: 0 },
    episodes: { total: 0, unique_contacts: 0, new_contacts: 0, returning_contacts: 0, mature: 0, provisional: 0, censored: 0 },
    funnel: { qualified: 0, order_created: 0, converted: 0, qualified_rate: null, converted_rate: null },
    response: { replied: 0, human_replied: 0, automated_replied: 0, unknown_source_messages: 0, median_minutes: null, p90_minutes: null, sla_eligible: 0, sla_met: 0, sla_rate: null, mature_unanswered: 0, unanswered_rate: null },
    contact_coverage: { total: 100, first_interaction_known: 40, last_inbound_known: 80, first_interaction_fraction: 0.4 }, items: []
};
it('explains the forward-only empty state and does not report unavailable rates as zero', () => {
    const text = JSON.stringify(TestRenderer.create(React.createElement(InquiryInsights, { report: empty })).toJSON());
    expect(text).toContain('Waiting for new or returning inquiries');expect(text).toContain('Unavailable');expect(text).toContain('not added as new inquiries');
    expect(text).toContain('40%');expect(text).toContain('do not verify payments');
});
it('keeps incomplete windows and observed CRM outcomes distinct', () => {
    const report = { ...empty, episodes: { total: 2, unique_contacts: 1, new_contacts: 1, returning_contacts: 1, mature: 0, provisional: 2, censored: 0 }, funnel: { ...empty.funnel, converted: 1 } };
    const text = JSON.stringify(TestRenderer.create(React.createElement(InquiryInsights, { report })).toJSON());
    expect(text).not.toContain('Waiting for new or returning inquiries');expect(text).toContain('CRM Converted');expect(text).toContain('still provisional');expect(text).toContain('Unavailable');
});
