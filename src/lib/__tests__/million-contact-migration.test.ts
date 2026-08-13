import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('million-contact campaign migration', () => {
    const sql = readFileSync(
        resolve(process.cwd(), 'database/migration_million_contact_campaigns.sql'),
        'utf8'
    );

    it('streams matching contacts into the recipient queue without a UUID array', () => {
        expect(sql).not.toMatch(/ARRAY_AGG\s*\(\s*contact\.id/i);
        expect(sql).toMatch(/INSERT INTO public\.campaign_recipients[\s\S]*SELECT v_campaign_id, selected\.id, 'pending'/i);
        expect(sql).toContain("SET statement_timeout = '0'");
    });

    it('adds durable media and immediate-worker lookup state', () => {
        expect(sql).toContain('template_media_header JSONB');
        expect(sql).toContain('template_media_headers JSONB');
        expect(sql).toContain('next_attempt_at TIMESTAMPTZ');
        expect(sql).toContain('idx_campaigns_immediate_sending');
    });

    it('materializes dynamic audiences entirely inside PostgreSQL', () => {
        const sql = readFileSync(
            resolve(process.cwd(), 'database/migration_campaign_send_resilience.sql'),
            'utf8'
        );

        expect(sql).toContain('materialize_dynamic_campaign_audience');
        expect(sql).toContain('INSERT INTO public.campaign_recipients');
        expect(sql).toContain('SELECT v_campaign.id, contact.id');
        expect(sql).toContain("SET statement_timeout = '0'");
        expect(sql).not.toContain('ARRAY_AGG');
    });
});
