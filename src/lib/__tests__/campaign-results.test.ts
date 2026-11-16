import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CampaignResults from '@/components/CampaignResults';

beforeEach(() => { vi.stubGlobal('React', React); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('bulk results report', () => {
    it('shows counts, an accessible graph, and the percentage denominator', () => {
        const html = renderToStaticMarkup(React.createElement(CampaignResults, { campaign: {
            total_recipients: 1000, sent_count: 750, failed_count: 150,
            failure_counts: { recipient_unavailable: 150 }
        } }));
        expect(html).toContain('role="img"');
        expect(html).toContain('Sent 750 (75%), failed 150 (15%), not sent 100 (10%)');
        expect(html).toContain('100% of failures');
        expect(html).toContain('Blocking is not confirmed');
        expect(html).toContain('delivery and read status are not confirmed');
    });

    it('explains backend pauses while leaving recipients unsent', () => {
        const html = renderToStaticMarkup(React.createElement(CampaignResults, { campaign: {
            total_recipients: 100, sent_count: 10, failed_count: 0,
            last_error: 'Database unavailable',
            last_error_diagnostic: { kind: 'backend_failure', category: 'other', source: 'backend' }
        } }));
        expect(html).toContain('failed 0 (0%), not sent 90 (90%)');
        expect(html).toContain('Latest delivery interruption: Tokkow backend / database');
        expect(html).not.toContain('Why messages failed');
    });

    it('labels unclassified retained totals and cumulative loop attempts honestly', () => {
        const html = renderToStaticMarkup(React.createElement(CampaignResults, { campaign: {
            total_recipients: 100, sent_count: 150, failed_count: 50, is_loop: true
        } }));
        expect(html).toContain('200');
        expect(html).toContain('attempts across all cycles');
        expect(html).toContain('Unclassified / history unavailable');
        expect(html).not.toContain('Queued / not sent');
    });
});
