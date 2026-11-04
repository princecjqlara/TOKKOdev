import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    sendMessage: vi.fn(),
    sendMessengerMediaAttachment: vi.fn(),
    getPageTemplates: vi.fn()
}));

vi.mock('../facebook', () => ({
    sendMessage: mocks.sendMessage,
    sendMessengerMediaAttachment: mocks.sendMessengerMediaAttachment,
    getPageTemplates: mocks.getPageTemplates
}));

import {
    handleFollowUpWorkflowContactReply,
    normalizeWorkflowKeyword,
    normalizeWorkflowSteps,
    processDueFollowUpAutomationSteps,
    stopWorkflowAutomationsFromPageMessage,
    workflowTextMatchesCode
} from '../workflow-automations';

function createWorkflowSupabaseMock(options?: {
    automations?: Array<Record<string, unknown>>;
    states?: Array<Record<string, unknown>>;
    contact?: Record<string, unknown> | null;
}) {
    const stateUpserts: Record<string, unknown>[] = [];
    const stateUpdates: Record<string, unknown>[] = [];

    const from = vi.fn((table: string) => {
        if (table === 'workflow_automations') {
            const automationResult = {
                data: options?.automations || [],
                error: null
            };
            return {
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        eq: vi.fn().mockReturnValue({
                            order: vi.fn().mockResolvedValue(automationResult),
                            not: vi.fn().mockResolvedValue(automationResult)
                        }),
                        not: vi.fn().mockResolvedValue(automationResult)
                    })
                })
            };
        }

        if (table === 'workflow_automation_states') {
            const stateRows = options?.states || [];
            return {
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        in: vi.fn().mockResolvedValue({
                            data: stateRows,
                            error: null
                        }),
                        lte: vi.fn().mockReturnValue({
                            order: vi.fn().mockReturnValue({
                                limit: vi.fn().mockResolvedValue({
                                    data: stateRows,
                                    error: null
                                })
                            })
                        })
                    })
                }),
                upsert: vi.fn((payload) => {
                    stateUpserts.push(payload);
                    return Promise.resolve({ error: null });
                }),
                update: vi.fn((payload) => {
                    stateUpdates.push(payload);
                    return {
                        eq: vi.fn().mockResolvedValue({ error: null })
                    };
                })
            };
        }

        if (table === 'contacts') {
            return {
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        eq: vi.fn().mockReturnValue({
                            maybeSingle: vi.fn().mockResolvedValue({
                                data: options?.contact ?? { id: 'contact_1' },
                                error: null
                            })
                        })
                    })
                })
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return { supabase: { from }, stateUpserts, stateUpdates };
}

const automation = {
    id: 'automation_1',
    page_id: 'page_1',
    name: 'Follow-up automation',
    enabled: true,
    trigger_type: 'follow_up',
    message_text: 'Hi {{first_name}}',
    steps: [
        { message_text: 'Hi {{first_name}} step 1', delay_minutes: 30 },
        { message_text: 'Hi {{first_name}} step 2', delay_minutes: 60 }
    ],
    reply_action: 'reset',
    page_stop_code: '#stopauto',
    cooldown_minutes: 30
};

describe('workflow automations', () => {
    beforeEach(() => {
        mocks.sendMessage.mockReset();
        mocks.sendMessengerMediaAttachment.mockReset();
        mocks.getPageTemplates.mockReset();
        mocks.getPageTemplates.mockResolvedValue([{ name: 'follow_up', language: 'en_US', category: 'UTILITY', status: 'APPROVED',
            components: [{ type: 'BODY', text: 'Hello {{1}}' }] }]);
        mocks.sendMessage.mockResolvedValue({ message_id: 'mid_1' });
        mocks.sendMessengerMediaAttachment.mockResolvedValue({ message_id: 'mid_media_1' });
    });

    it('normalizes codes before matching', () => {
        expect(normalizeWorkflowKeyword('  #StopAuto   Now  ')).toBe('#stopauto now');
        expect(workflowTextMatchesCode(' #STOPAUTO ', '#stopauto')).toBe(true);
        expect(workflowTextMatchesCode('please #stopauto', '#stopauto')).toBe(false);
    });

    it('preserves delays beyond seven days and template-only steps', () => {
        expect(normalizeWorkflowSteps([{ message_text: '', delay_minutes: 8 * 1440, template_name: 'follow_up',
            template_language: 'en-US', template_parameters: ['{{first_name}}'] }])).toMatchObject([
            { delay_minutes: 11520, template_name: 'follow_up', template_language: 'en_US', template_parameters: ['{{first_name}}'] }
        ]);
    });

    function dueFixture(inbound: string | null, step: Record<string, unknown> = {}, extra = {}) {
        return createWorkflowSupabaseMock({ states: [{ id: 'state_1', automation_id: automation.id, contact_id: 'contact_1',
            status: 'active', current_step_index: 0, next_step_at: '2026-07-28T00:00:00Z', workflow_automations: {
                ...automation, steps: [{ message_text: 'Hi {{first_name}}', delay_minutes: 60, ...step }],
                pages: { fb_page_id: 'fb_page_1', access_token: 'token_1' }
            }, contacts: { id: 'contact_1', psid: 'psid_1', page_id: 'page_1', name: 'Juan Dela Cruz',
                last_interaction_at: '2026-07-29T00:00:00Z', last_inbound_at: inbound, ...extra } }] });
    }

    it('selects a standard response for a recent inbound reply', async () => {
        const { supabase } = dueFixture('2026-07-28T23:00:00Z');
        expect((await processDueFollowUpAutomationSteps({ supabase, now: new Date('2026-07-29T00:00:00Z') })).sent).toBe(1);
        expect(mocks.sendMessage).toHaveBeenCalledWith('fb_page_1', 'token_1', 'psid_1', 'Hi Juan', 'RESPONSE');
        expect(mocks.getPageTemplates).not.toHaveBeenCalled();
    });

    it('uses the selected approved template after the window expires, even for a late cron run', async () => {
        const { supabase, stateUpdates } = dueFixture('2026-07-21T00:00:00Z', { template_name: 'follow_up',
            template_language: 'en_US', template_parameters: ['{{first_name}}'] });
        const result = await processDueFollowUpAutomationSteps({ supabase, now: new Date('2026-07-29T00:00:00Z') });
        expect(result).toMatchObject({ sent: 1, completed: 1, stopped: 0 });
        expect(mocks.sendMessage).toHaveBeenCalledWith('fb_page_1', 'token_1', 'psid_1', 'Hi Juan', 'UTILITY',
            'follow_up', 'en_US', ['Juan'], undefined, undefined);
        expect(stateUpdates[0]).toMatchObject({ status: 'completed' });
    });

    it.each([null, 'invalid', '2026-07-21T00:00:00Z', '2026-07-29T00:01:00Z'])('stops without a template when inbound eligibility is missing or expired: %s', async inbound => {
        const { supabase, stateUpdates } = dueFixture(inbound);
        const result = await processDueFollowUpAutomationSteps({ supabase, now: new Date('2026-07-29T00:00:00Z') });
        expect(result).toMatchObject({ stopped: 1, sent: 0 });
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(mocks.sendMessengerMediaAttachment).not.toHaveBeenCalled();
        expect(stateUpdates[0]).toMatchObject({ status: 'stopped', stopped_reason: 'template_required' });
    });

    it('never falls back to a different template when approval is revoked', async () => {
        const { supabase, stateUpdates } = dueFixture('2026-07-21T00:00:00Z', { template_name: 'follow_up', template_parameters: ['Juan'] });
        mocks.getPageTemplates.mockResolvedValue([{ name: 'follow_up', status: 'REJECTED', language: 'en_US', category: 'UTILITY', components: [] }]);
        expect((await processDueFollowUpAutomationSteps({ supabase, now: new Date('2026-07-29T00:00:00Z') })).stopped).toBe(1);
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(stateUpdates[0]).toMatchObject({ stopped_reason: 'template_unavailable' });
    });

    it('honors explicit template delivery inside an open reply window', async () => {
        const { supabase } = dueFixture('2026-07-28T23:00:00Z', { use_template: true, template_name: 'follow_up',
            template_language: 'en_US', template_parameters: ['{{first_name}}'] });
        expect((await processDueFollowUpAutomationSteps({ supabase, now: new Date('2026-07-29T00:00:00Z') })).sent).toBe(1);
        expect(mocks.sendMessage).toHaveBeenCalledWith('fb_page_1', 'token_1', 'psid_1', 'Hi Juan', 'UTILITY',
            'follow_up', 'en_US', ['Juan'], undefined, undefined);
    });

    it('puts media inside the approved template header outside seven days', async () => {
        const { supabase } = dueFixture('2026-07-21T00:00:00Z', { template_name: 'follow_up', template_parameters: ['Juan'],
            media_type: 'image', media_url: 'https://example.com/photo.jpg' });
        mocks.getPageTemplates.mockResolvedValue([{ name: 'follow_up', status: 'APPROVED', language: 'en_US', category: 'UTILITY',
            components: [{ type: 'BODY', text: 'Hello {{1}}' }, { type: 'HEADER', format: 'IMAGE' }] }]);
        expect((await processDueFollowUpAutomationSteps({ supabase, now: new Date('2026-07-29T00:00:00Z') })).sent).toBe(1);
        expect(mocks.sendMessage).toHaveBeenCalledWith('fb_page_1', 'token_1', 'psid_1', 'Hi Juan', 'UTILITY',
            'follow_up', 'en_US', ['Juan'], undefined, { type: 'image', url: 'https://example.com/photo.jpg' });
        expect(mocks.sendMessengerMediaAttachment).not.toHaveBeenCalled();
    });

    it('resets a follow-up sequence to step 1 when configured to reset on contact reply', async () => {
        const { supabase, stateUpserts } = createWorkflowSupabaseMock({
            automations: [automation],
            states: [{ automation_id: 'automation_1', status: 'active', current_step_index: 1 }]
        });

        const result = await handleFollowUpWorkflowContactReply({
            supabase,
            page: {
                id: 'page_1',
                fb_page_id: 'fb_page_1',
                access_token: 'token_1'
            },
            contact: {
                id: 'contact_1',
                page_id: 'page_1',
                psid: 'psid_1',
                name: 'Juan Dela Cruz',
                last_interaction_at: '2026-07-29T02:00:00.000Z'
            },
            messageText: 'hello',
            interactionAt: '2026-07-29T02:00:00.000Z',
            now: new Date('2026-07-29T02:00:00.000Z')
        });

        expect(result.reset).toBe(1);
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(stateUpserts[0]).toMatchObject({
            automation_id: 'automation_1',
            contact_id: 'contact_1',
            status: 'active',
            current_step_index: 0,
            next_step_at: '2026-07-29T02:30:00.000Z'
        });
    });

    it('schedules step 1 for a new contact even when later replies should stop the workflow', async () => {
        const { supabase, stateUpserts } = createWorkflowSupabaseMock({
            automations: [{ ...automation, reply_action: 'stop' }],
            states: []
        });

        const result = await handleFollowUpWorkflowContactReply({
            supabase,
            page: {
                id: 'page_1',
                fb_page_id: 'fb_page_1',
                access_token: 'token_1'
            },
            contact: {
                id: 'contact_1',
                page_id: 'page_1',
                psid: 'psid_1',
                name: 'Juan Dela Cruz',
                last_interaction_at: '2026-07-29T02:00:00.000Z'
            },
            messageText: 'anything',
            interactionAt: '2026-07-29T02:00:00.000Z',
            now: new Date('2026-07-29T02:00:00.000Z')
        });

        expect(result.scheduled).toBe(1);
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(stateUpserts[0]).toMatchObject({
            status: 'active',
            current_step_index: 0,
            next_step_at: '2026-07-29T02:30:00.000Z'
        });
    });

    it('stops an active follow-up sequence when configured to stop on contact reply', async () => {
        const { supabase, stateUpserts } = createWorkflowSupabaseMock({
            automations: [{ ...automation, reply_action: 'stop' }],
            states: [{ automation_id: 'automation_1', status: 'active', current_step_index: 0 }]
        });

        const result = await handleFollowUpWorkflowContactReply({
            supabase,
            page: { id: 'page_1', fb_page_id: 'fb_page_1', access_token: 'token_1' },
            contact: {
                id: 'contact_1',
                page_id: 'page_1',
                psid: 'psid_1',
                name: 'Juan Dela Cruz',
                last_interaction_at: '2026-07-29T02:00:00.000Z'
            },
            messageText: 'anything',
            interactionAt: '2026-07-29T02:00:00.000Z',
            now: new Date('2026-07-29T02:00:00.000Z')
        });

        expect(result.stopped).toBe(1);
        expect(stateUpserts[0]).toMatchObject({
            status: 'stopped',
            stopped_reason: 'contact_reply',
            next_step_at: null
        });
    });

    it('ignores a replayed contact webhook instead of resetting the timer', async () => {
        const { supabase, stateUpserts } = createWorkflowSupabaseMock({
            automations: [automation],
            states: [{
                automation_id: 'automation_1',
                status: 'active',
                current_step_index: 0,
                last_contact_reply_at: '2026-07-29T02:00:00.000Z'
            }]
        });

        const result = await handleFollowUpWorkflowContactReply({
            supabase,
            page: { id: 'page_1', fb_page_id: 'fb_page_1', access_token: 'token_1' },
            contact: {
                id: 'contact_1',
                page_id: 'page_1',
                psid: 'psid_1',
                name: null,
                last_interaction_at: '2026-07-29T02:00:00.000Z'
            },
            messageText: 'duplicate delivery',
            interactionAt: '2026-07-29T02:00:00.000Z',
            now: new Date('2026-07-29T02:00:05.000Z')
        });

        expect(result.skipped).toBe(1);
        expect(stateUpserts).toHaveLength(0);
    });

    it('restarts a workflow after a fresh reply reopens the Human Agent window', async () => {
        const { supabase, stateUpserts } = createWorkflowSupabaseMock({
            automations: [{ ...automation, reply_action: 'stop' }],
            states: [{
                automation_id: 'automation_1',
                status: 'stopped',
                stopped_reason: 'outside_human_agent_window',
                current_step_index: 0,
                last_contact_reply_at: '2026-07-20T02:00:00.000Z'
            }]
        });

        const result = await handleFollowUpWorkflowContactReply({
            supabase,
            page: { id: 'page_1', fb_page_id: 'fb_page_1', access_token: 'token_1' },
            contact: {
                id: 'contact_1',
                page_id: 'page_1',
                psid: 'psid_1',
                name: null,
                last_interaction_at: '2026-07-29T02:00:00.000Z'
            },
            messageText: 'new reply',
            interactionAt: '2026-07-29T02:00:00.000Z',
            now: new Date('2026-07-29T02:00:00.000Z')
        });

        expect(result.scheduled).toBe(1);
        expect(stateUpserts[0]).toMatchObject({
            status: 'active',
            current_step_index: 0,
            next_step_at: '2026-07-29T02:30:00.000Z'
        });
    });

    it('sends a due follow-up step and schedules the next interval', async () => {
        const { supabase, stateUpdates } = createWorkflowSupabaseMock({
            states: [{
                id: 'state_1',
                automation_id: 'automation_1',
                contact_id: 'contact_1',
                status: 'active',
                current_step_index: 0,
                next_step_at: '2026-07-29T02:30:00.000Z',
                workflow_automations: {
                    ...automation,
                    pages: { fb_page_id: 'fb_page_1', access_token: 'token_1' }
                },
                contacts: {
                    id: 'contact_1',
                    page_id: 'page_1',
                    psid: 'psid_1',
                    name: 'Juan Dela Cruz',
                    last_interaction_at: '2026-07-29T02:00:00.000Z',
                    last_inbound_at: '2026-07-27T02:00:00.000Z'
                }
            }]
        });

        const result = await processDueFollowUpAutomationSteps({
            supabase,
            now: new Date('2026-07-29T02:30:00.000Z')
        });

        expect(result.sent).toBe(1);
        expect(mocks.sendMessage).toHaveBeenCalledWith(
            'fb_page_1',
            'token_1',
            'psid_1',
            'Hi Juan step 1',
            'HUMAN_AGENT'
        );
        expect(stateUpdates[0]).toMatchObject({
            status: 'active',
            current_step_index: 1,
            next_step_at: '2026-07-29T03:30:00.000Z'
        });
    });

    it('sends follow-up step media as a human-agent attachment after text', async () => {
        const { supabase, stateUpdates } = createWorkflowSupabaseMock({
            states: [{
                id: 'state_1',
                automation_id: 'automation_1',
                contact_id: 'contact_1',
                status: 'active',
                current_step_index: 0,
                next_step_at: '2026-07-29T02:30:00.000Z',
                workflow_automations: {
                    ...automation,
                    steps: [{
                        message_text: 'Hi {{first_name}}, here is the video.',
                        delay_minutes: 30,
                        media_type: 'video',
                        media_url: 'https://example.com/{{first_name}}-tour.mp4'
                    }],
                    pages: { fb_page_id: 'fb_page_1', access_token: 'token_1' }
                },
                contacts: {
                    id: 'contact_1',
                    page_id: 'page_1',
                    psid: 'psid_1',
                    name: 'Juan Dela Cruz',
                    last_interaction_at: '2026-07-29T02:00:00.000Z',
                    last_inbound_at: '2026-07-27T02:00:00.000Z'
                }
            }]
        });

        const result = await processDueFollowUpAutomationSteps({
            supabase,
            now: new Date('2026-07-29T02:30:00.000Z')
        });

        expect(result.sent).toBe(1);
        expect(mocks.sendMessage).toHaveBeenCalledWith(
            'fb_page_1',
            'token_1',
            'psid_1',
            'Hi Juan, here is the video.',
            'HUMAN_AGENT'
        );
        expect(mocks.sendMessengerMediaAttachment).toHaveBeenCalledWith(
            'fb_page_1',
            'token_1',
            'psid_1',
            {
                type: 'video',
                url: 'https://example.com/Juan-tour.mp4'
            },
            'HUMAN_AGENT'
        );
        expect(stateUpdates[0]).toMatchObject({
            status: 'completed',
            current_step_index: 1
        });
    });

    it('allows a media-only follow-up step', async () => {
        const { supabase } = createWorkflowSupabaseMock({
            states: [{
                id: 'state_1',
                automation_id: 'automation_1',
                contact_id: 'contact_1',
                status: 'active',
                current_step_index: 0,
                next_step_at: '2026-07-29T02:30:00.000Z',
                workflow_automations: {
                    ...automation,
                    steps: [{
                        message_text: '',
                        delay_minutes: 30,
                        media_type: 'image',
                        media_url: 'https://example.com/photo.jpg'
                    }],
                    pages: { fb_page_id: 'fb_page_1', access_token: 'token_1' }
                },
                contacts: {
                    id: 'contact_1',
                    page_id: 'page_1',
                    psid: 'psid_1',
                    name: 'Juan Dela Cruz',
                    last_interaction_at: '2026-07-29T02:00:00.000Z',
                    last_inbound_at: '2026-07-27T02:00:00.000Z'
                }
            }]
        });

        const result = await processDueFollowUpAutomationSteps({
            supabase,
            now: new Date('2026-07-29T02:30:00.000Z')
        });

        expect(result.sent).toBe(1);
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(mocks.sendMessengerMediaAttachment).toHaveBeenCalledWith(
            'fb_page_1',
            'token_1',
            'psid_1',
            {
                type: 'image',
                url: 'https://example.com/photo.jpg'
            },
            'HUMAN_AGENT'
        );
    });

    it('stops automation for a contact when a page message exactly matches the stop code', async () => {
        const { supabase, stateUpserts } = createWorkflowSupabaseMock({
            automations: [automation],
            contact: { id: 'contact_1' }
        });

        const result = await stopWorkflowAutomationsFromPageMessage({
            supabase,
            pageId: 'page_1',
            contactPsid: 'psid_1',
            messageText: ' #STOPAUTO ',
            now: new Date('2026-07-29T02:00:00.000Z')
        });

        expect(result.stopped).toBe(1);
        expect(stateUpserts[0]).toMatchObject({
            automation_id: 'automation_1',
            contact_id: 'contact_1',
            status: 'stopped',
            stopped_reason: 'page_stop_code'
        });
    });
});
