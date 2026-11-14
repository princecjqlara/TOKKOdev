import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminAccountActions from '@/app/admin/AdminAccountActions';
import type { AdminAccount } from '../admin-accounts';

const account = { id: 'member-id', email: 'member@example.test', type: 'subaccount', active: true,
    canEnable: true, canDelete: true, canScheduleDeletion: true, expiresAt: '2099-01-01T00:00:00Z', deleteAfterExpiry: true } as AdminAccount;
let renderer: ReactTestRenderer;
const changed = vi.fn();
const fetchMock = vi.fn();
function button(label: string) { return renderer.root.findAllByType('button').find(node => React.Children.toArray(node.props.children).filter(child => typeof child === 'string').join(' ').includes(label))!; }
beforeEach(() => {
    vi.clearAllMocks(); vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ message: 'Saved successfully.' }) });
});
afterEach(() => { act(() => renderer?.unmount()); vi.unstubAllGlobals(); });
function render(overrides: Partial<AdminAccount> = {}) {
    act(() => { renderer = create(React.createElement(AdminAccountActions, { account: { ...account, ...overrides }, onChanged: changed })); });
}

describe('administrator account action controls', () => {
    it('requires matching confirmation and a deliberate submit before deleting', async () => {
        render(); act(() => button('Delete account').props.onClick());
        expect(fetchMock).not.toHaveBeenCalled(); expect(button('Permanently delete account').props.disabled).toBe(true);
        act(() => renderer.root.findByType('input').props.onChange({ target: { value: ' MEMBER@example.test ' } }));
        expect(button('Permanently delete account').props.disabled).toBe(false);
        await act(async () => { renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
        expect(fetchMock).toHaveBeenCalledWith('/api/admin/accounts/member-id', expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ confirmation: ' MEMBER@example.test ' }) }));
        expect(changed).toHaveBeenCalledWith('Saved successfully.');
    });
    it('cancels deletion without issuing a request', () => {
        render(); act(() => button('Delete account').props.onClick()); act(() => button('Cancel').props.onClick());
        expect(renderer.root.findAllByType('form')).toHaveLength(0); expect(fetchMock).not.toHaveBeenCalled();
    });
    it('disables deletion for parents with children and enabling unactivated invitations', () => {
        render({ canDelete: false, active: false, canEnable: false });
        expect(button('Delete account').props.disabled).toBe(true); expect(button('Enable account').props.disabled).toBe(true);
    });
    it('asks for confirmation before disabling access and uses the status action', async () => {
        render(); act(() => button('Disable account').props.onClick()); expect(fetchMock).not.toHaveBeenCalled();
        await act(async () => { button('Confirm disable').props.onClick(); });
        expect(fetchMock).toHaveBeenCalledWith('/api/admin/accounts/member-id', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ action: 'status', active: false }) }));
    });
    it('makes access permanent and cancels scheduled deletion together', async () => {
        render(); act(() => button('Change access duration').props.onClick());
        act(() => renderer.root.findByType('select').props.onChange({ target: { value: 'permanent' } }));
        await act(async () => { renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
        expect(fetchMock).toHaveBeenCalledWith('/api/admin/accounts/member-id', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ action: 'lifetime', expiresAt: null, deleteAfterExpiry: false }) }));
    });
    it('keeps a failed deletion open with an error so the administrator can retry', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({ message: 'Account still has subaccounts.' }) });
        render(); act(() => button('Delete account').props.onClick());
        act(() => renderer.root.findByType('input').props.onChange({ target: { value: account.email } }));
        await act(async () => { renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
        expect(renderer.root.findByProps({ role: 'alert' }).props.children).toBe('Account still has subaccounts.');
        expect(changed).not.toHaveBeenCalled(); expect(renderer.root.findAllByType('form')).toHaveLength(1);
    });
});
