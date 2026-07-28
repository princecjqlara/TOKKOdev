import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    sendMessage: vi.fn()
}));

vi.mock('../facebook', () => ({
    sendMessage: mocks.sendMessage
}));

import {
    normalizeWorkflowKeyword,
    stopWorkflowAutomationsFromPageMessage,
    triggerReplyWorkflowAutomations,
    workflowTextMatchesCode
} from '../workflow-automations';

function createWorkflowSupabaseMock(options?: {
    automations?: Array<Record<string, unknown>>;
    states?: Array<Record<string, unknown>>;
    contact?: Record<string, unknown> | null;
}) {
    const stateUpserts: Record<string, unknown>[] = [];

    const from = vi.fn((table: string) => {
        if (table === 'workflow_automations') {
            const automationResult = {
                data: options?.automations || [],
                error: null
            };
            const thirdEqChain = {
                eq: vi.fn().mockReturnValue({
                    order: vi.fn().mockResolvedValue(automationResult)
                }),
                not: vi.fn().mockResolvedValue(automationResult)
            };
            const secondEqChain = {
                eq: vi.fn().mockReturnValue(thirdEqChain),
                not: vi.fn().mockResolvedValue(automationResult)
            };

            return {
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue(secondEqChain)
                })
            };
        }

        if (table === 'workflow_automation_states') {
            return {
                select: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                        in: vi.fn().mockResolvedValue({
                            data: options?.states || [],
                            error: null
                        })
                    })
                }),
                upsert: vi.fn((payload) => {
                    stateUpserts.push(payload);
                    return Promise.resolve({ error: null });
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

    return { supabase: { from }, stateUpserts };
}

const automation = {
    id: 'automation_1',
    page_id: 'page_1',
    name: 'Reply automation',
    enabled: true,
    trigger_type: 'contact_reply',
    message_text: 'Hi {{first_name}}',
    stop_keywords: ['stop', 'pause'],
    page_stop_code: '#stopauto',
    cooldown_minutes: 0
};

describe('workflow automations', () => {
    beforeEach(() => {
        mocks.sendMessage.mockReset();
        mocks.sendMessage.mockResolvedValue({ message_id: 'mid_1' });
    });

    it('normalizes codes before matching', () => {
        expect(normalizeWorkflowKeyword('  #StopAuto   Now  ')).toBe('#stopauto now');
        expect(workflowTextMatchesCode(' #STOPAUTO ', '#stopauto')).toBe(true);
        expect(workflowTextMatchesCode('please #stopauto', '#stopauto')).toBe(false);
    });

    it('sends a Human Agent message when a contact replies inside the 7 day window', async () => {
        const { supabase, stateUpserts } = createWorkflowSupabaseMock({
            automations: [automation],
            states: []
        });

        const result = await triggerReplyWorkflowAutomations({
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
            now: new Date('2026-07-29T02:00:01.000Z')
        });

        expect(result.sent).toBe(1);
        expect(mocks.sendMessage).toHaveBeenCalledWith(
            'fb_page_1',
            'token_1',
            'psid_1',
            'Hi Juan',
            'HUMAN_AGENT'
        );
        expect(stateUpserts[0]).toMatchObject({
            automation_id: 'automation_1',
            contact_id: 'contact_1',
            status: 'active'
        });
    });

    it('stops instead of sending when the contact replies with a stop keyword', async () => {
        const { supabase, stateUpserts } = createWorkflowSupabaseMock({
            automations: [automation],
            states: []
        });

        const result = await triggerReplyWorkflowAutomations({
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
            messageText: ' STOP ',
            interactionAt: '2026-07-29T02:00:00.000Z',
            now: new Date('2026-07-29T02:00:01.000Z')
        });

        expect(result.stopped).toBe(1);
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(stateUpserts[0]).toMatchObject({
            status: 'stopped',
            stopped_reason: 'contact_stop_keyword'
        });
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
