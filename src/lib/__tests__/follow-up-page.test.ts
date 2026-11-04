import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: mocks.session }));
import AutomationsPage from '../../app/dashboard/automations/page';

let screen: ReactTestRenderer | undefined;
let saved: any[];
let existing: any[];
beforeEach(() => {
    vi.clearAllMocks(); saved = []; existing = [];
    mocks.session.mockReturnValue({ data: { user: { id: 'user_1' } } });
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
        if (options?.method === 'POST' || options?.method === 'PATCH') {
            saved.push(JSON.parse(String(options.body)));
            return Response.json({ automation: { id: 'automation_1' } });
        }
        return Response.json(url === '/api/pages' ? { pages: [{ id: 'page_1', fb_page_id: 'facebook_1', name: 'Team Page' }] }
            : url.startsWith('/api/facebook/templates?') ? { templates: [{ name: 'chosen', language: 'en_US', category: 'UTILITY', status: 'APPROVED',
                components: [{ type: 'BODY', text: 'Reminder: {{1}}' }] }] } : { items: existing });
    }));
});
afterEach(() => { act(() => screen?.unmount()); screen = undefined; vi.unstubAllGlobals(); });
const saveButton = () => screen!.root.findAllByType('button').find(button => button.children.includes('Save'))!;
async function render() { await act(async () => { screen = create(React.createElement(AutomationsPage)); }); }

describe('follow-up window and template controls', () => {
    it('requires the user to choose a template when cumulative step delays exceed seven days', async () => {
        await render();
        act(() => screen!.root.findByProps({ id: 'step-delay-0' }).props.onChange({ target: { value: '8640' } }));
        act(() => screen!.root.findByProps({ id: 'step-delay-1' }).props.onChange({ target: { value: '2880' } }));
        expect(screen!.root.findByProps({ id: 'step-template-0' }).props['aria-required']).toBe(false);
        const template = screen!.root.findByProps({ id: 'step-template-1' });
        expect(template.props['aria-required']).toBe(true);
        expect(template.props.value).toBe('');
        expect(saveButton().props.disabled).toBe(true);
        act(() => template.props.onChange({ target: { value: 'chosen|en_US' } }));
        expect(saveButton().props.disabled).toBe(false);
        await act(async () => { await saveButton().props.onClick(); });
        expect(saved[0].steps[1]).toMatchObject({ delay_minutes: 2880, template_name: 'chosen', template_language: 'en_US' });
        expect(saved[0].steps[0].delay_minutes).toBe(8640);
    });
    it('preserves the chosen template and delays beyond seven days when editing a saved workflow', async () => {
        existing = [{ id: 'automation_1', name: 'Eight-day follow-up', enabled: true, steps: [{ message_text: 'Hello', delay_minutes: 11520,
            template_name: 'chosen', template_language: 'en_US', template_parameters: ['Saved wording'] }] }];
        await render();
        const item = screen!.root.findAllByType('button').find(button => button.findAllByType('p').some(p => p.children.includes('Eight-day follow-up')))!;
        act(() => item.props.onClick());
        expect(screen!.root.findByProps({ id: 'step-delay-0' }).props.value).toBe(11520);
        expect(screen!.root.findByProps({ id: 'step-template-0' }).props.value).toBe('chosen|en_US');
        expect(saveButton().props.disabled).toBe(false);
        await act(async () => { await saveButton().props.onClick(); });
        expect(saved[0].steps[0].template_parameters).toEqual(['Saved wording']);
    });
});
