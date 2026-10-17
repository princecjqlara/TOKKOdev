import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import approvalEvidence from '../../../docs/template-review-results.json';
import { TEMPLATE_CANDIDATES, buildTemplateCandidates, getCandidatePayload } from '../facebook-template-candidates';
import { compareTemplates, getTemplateTone, getTemplateOptionLabel, isRetiredTemplate, selectTemplateStarterSet, TEMPLATE_TONES } from '../facebook-template-order';
import { ALL_UTILITY_TEMPLATES, UTILITY_TEMPLATES } from '../facebook-templates';

describe('short template review catalog', () => {
    it('provides thousands of distinct short one-parameter templates with matching examples', () => {
        expect(TEMPLATE_CANDIDATES).toHaveLength(2880);
        expect(new Set(TEMPLATE_CANDIDATES.map(t => t.name)).size).toBe(2880);
        expect(new Set(TEMPLATE_CANDIDATES.map(t => t.components[0].text)).size).toBe(2880);
        for (const template of TEMPLATE_CANDIDATES) {
            expect(template.name).toMatch(/^[a-z0-9_]{1,64}$/);
            const body = template.components[0];
            expect(body.text!.length).toBeLessThanOrEqual(100);
            expect(body.text!.match(/\{\{\d+\}\}/g)).toEqual(['{{1}}']);
            expect(body.text).not.toMatch(/\b(update|notice|notification|alert|status)\b/i);
            expect(body.example?.body_text?.[0]).toHaveLength(template.paramCount);
            expect(getTemplateTone(template)).toBe(template.tone);
        }
    });

    it('keeps stable names and orders every tone from casual to formal', () => {
        expect(buildTemplateCandidates()).toEqual(TEMPLATE_CANDIDATES);
        expect([...new Set(TEMPLATE_CANDIDATES.map(t => t.tone))]).toEqual(TEMPLATE_TONES);
        expect([...TEMPLATE_CANDIDATES].sort(compareTemplates)).toEqual(TEMPLATE_CANDIDATES);
    });

    it('keeps unverified candidates out of the automatic submission library', () => {
        // A candidate appears in the library only if it has been promoted to the manifest.
        const candidatesInLibrary = UTILITY_TEMPLATES.filter(t => t.name.startsWith('short_'));
        for (const template of candidatesInLibrary) {
            expect(TEMPLATE_CANDIDATES.some(candidate => candidate.name === template.name)).toBe(true);
        }
        expect(candidatesInLibrary.length).toBeLessThan(TEMPLATE_CANDIDATES.length);
        expect(Object.keys(getCandidatePayload(TEMPLATE_CANDIDATES[0])).sort()).toEqual(['category', 'components', 'language', 'name']);
    });

    it('has exact approval evidence for every short template added to the shared library', () => {
        const verified = new Map(approvalEvidence.verified.map(entry => [entry.name, entry]));
        const candidatesInLibrary = UTILITY_TEMPLATES.filter(template => template.name.startsWith('short_'));
        expect(candidatesInLibrary.length).toBeGreaterThan(0);
        for (const template of candidatesInLibrary) expect(template.name).toContain('_chat_');
        for (const template of candidatesInLibrary) {
            const record = verified.get(template.name);
            expect(record, template.name).toBeDefined();
            expect(['APPROVED', 'ACTIVE']).toContain(record!.status);
            expect(record!.category).toBe('UTILITY');
            expect(record!.language).toBe('en_US');
            const body = template.components.find(component => component.type === 'BODY')!.text!;
            expect(record!.bodySha256).toBe(createHash('sha256').update(body).digest('hex'));
        }
    });

    it('sorts legacy and live page templates consistently', () => {
        const templates = [
            { name: 'formal_notice', bodyText: 'Important notice: {{1}}.' },
            { name: 'plain', bodyText: 'Update: {{1}}.' },
            { name: 'friendly_msg_v1', bodyText: 'Hello! {{1}}.' },
            { name: 'casual_update_v1', bodyText: 'Hey! {{1}}.' }
        ];
        expect(templates.sort(compareTemplates).map(getTemplateTone)).toEqual(TEMPLATE_TONES);
    });

    it('keeps automatic page setup bounded while representing every tone', () => {
        const starter = selectTemplateStarterSet(TEMPLATE_CANDIDATES);
        expect(starter).toHaveLength(24);
        for (const tone of TEMPLATE_TONES) {
            expect(starter.filter(template => template.tone === tone)).toEqual(TEMPLATE_CANDIDATES.filter(template => template.tone === tone).slice(0, 6));
        }
        expect(selectTemplateStarterSet([])).toEqual([]);
        expect(TEMPLATE_CANDIDATES).toHaveLength(2880);
    });

    it('removes update-style templates from new selections while retaining definitions for existing campaigns', () => {
        expect(UTILITY_TEMPLATES.some(isRetiredTemplate)).toBe(false);
        expect(ALL_UTILITY_TEMPLATES.find(template => template.name === 'acct_update_2p_v1')?.paramCount).toBe(2);
        expect(UTILITY_TEMPLATES.some(template => template.name === 'acct_update_2p_v1')).toBe(false);
        expect(ALL_UTILITY_TEMPLATES.length).toBeGreaterThan(UTILITY_TEMPLATES.length);
    });

    it('shows the full message wording and placeholders instead of the internal name', () => {
        const template = { name: 'internal_id_v2', bodyText: 'Hi!\n{{1}}. Talk soon.', language: 'en_US' };
        expect(getTemplateOptionLabel(template)).toBe('Hi! {{1}}. Talk soon. (en_US)');
        expect(template.name).toBe('internal_id_v2');
        expect(getTemplateOptionLabel({ name: 'hidden_id' })).toBe('Message preview unavailable (en_US)');
    });
});
