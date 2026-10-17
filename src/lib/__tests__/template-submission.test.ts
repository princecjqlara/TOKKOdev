import { describe, expect, it, vi } from 'vitest';
import { submitMissingTemplatesToPages, type PageSubmissionResult } from '../template-submission';

const pages = [{ id: 'page-1', name: 'First page' }, { id: 'page-2', name: 'Second page' }];
const response = (data: object, status = 200) => new Response(JSON.stringify(data), { status });

describe('submit missing templates across pages', () => {
    it('checks each page and skips existing names in every review status', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce(response({ templates: [
                { name: 'approved', status: 'APPROVED' },
                { name: 'pending', status: 'PENDING' },
                { name: 'rejected', status: 'REJECTED' }
            ] }))
            .mockResolvedValueOnce(response({ success: true, results: [{ name: 'missing', action: 'created' }] }))
            .mockResolvedValueOnce(response({ templates: ['approved', 'pending', 'rejected', 'missing'].map(name => ({ name })) }));
        const snapshots: PageSubmissionResult[][] = [];
        const results = await submitMissingTemplatesToPages({
            pages: [...pages, pages[0]], templateNames: ['approved', 'pending', 'rejected', 'missing', 'missing'],
            request, onProgress: value => snapshots.push(value)
        });
        expect(request).toHaveBeenCalledTimes(3);
        expect(request.mock.calls[0][0]).toContain('pageId=page-1');
        expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ pageId: 'page-1', templateNames: ['missing'], limit: 25 });
        expect(request.mock.calls[2][0]).toContain('pageId=page-2');
        expect(results).toEqual([
            expect.objectContaining({ state: 'complete', submitted: 1, alreadyExisted: 3, unattempted: 0 }),
            expect.objectContaining({ state: 'complete', submitted: 0, alreadyExisted: 4, unattempted: 0 })
        ]);
        expect(snapshots[0][0].state).toBe('checking');
        expect(snapshots.at(-1)).toEqual(results);
    });

    it('continues to other pages when a page cannot be checked, without submitting blindly', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce(response({ message: 'Reconnect this page.' }, 502))
            .mockResolvedValueOnce(response({ templates: [] }))
            .mockResolvedValueOnce(response({ success: true, results: [{ name: 'one', action: 'created' }] }));
        const results = await submitMissingTemplatesToPages({ pages, templateNames: ['one'], request, onProgress: vi.fn() });
        expect(results[0]).toMatchObject({ state: 'failed', error: 'Reconnect this page.', unattempted: 1 });
        expect(results[1]).toMatchObject({ state: 'complete', submitted: 1 });
        expect(JSON.parse(request.mock.calls[2][1].body).pageId).toBe('page-2');
    });

    it('uses bounded batches and counts actual results including concurrent existing submissions', async () => {
        const names = Array.from({ length: 52 }, (_, i) => `template_${i}`);
        const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            if (!init) return response({ templates: [] });
            const { templateNames } = JSON.parse(init.body as string);
            return response({ success: true, results: templateNames.map((name: string) => ({
                name, action: name === 'template_0' ? 'already_exists' : name === 'template_1' ? 'error' : 'created',
                error: name === 'template_1' ? 'Invalid template' : undefined
            })) });
        });
        const [result] = await submitMissingTemplatesToPages({ pages: [pages[0]], templateNames: names, request, onProgress: vi.fn() });
        const posts = request.mock.calls.filter(call => call[1]);
        expect(posts.map(call => JSON.parse(call[1]!.body as string).templateNames.length)).toEqual([25, 25, 2]);
        expect(result).toMatchObject({ submitted: 50, alreadyExisted: 1, failed: 1, unattempted: 0, state: 'failed' });
    });

    it('stops sending to a failing page while continuing with the next page', async () => {
        const names = Array.from({ length: 30 }, (_, i) => `template_${i}`);
        const request = vi.fn()
            .mockResolvedValueOnce(response({ templates: [] }))
            .mockResolvedValueOnce(response({ success: true, results: names.slice(0, 25).map(name => ({ name, action: 'error', error: 'Rate limited' })) }))
            .mockResolvedValueOnce(response({ templates: names.map(name => ({ name })) }));
        const results = await submitMissingTemplatesToPages({ pages, templateNames: names, request, onProgress: vi.fn() });
        expect(request).toHaveBeenCalledTimes(3);
        expect(results[0]).toMatchObject({ state: 'failed', failed: 25, unattempted: 5, error: 'Rate limited' });
        expect(results[1]).toMatchObject({ state: 'complete', alreadyExisted: 30 });
    });

    it('retains completed batches when a later request fails and does not retry automatically', async () => {
        const names = Array.from({ length: 30 }, (_, i) => `template_${i}`);
        const request = vi.fn()
            .mockResolvedValueOnce(response({ templates: [] }))
            .mockResolvedValueOnce(response({ success: true, results: names.slice(0, 25).map(name => ({ name, action: 'created' })) }))
            .mockRejectedValueOnce(new Error('Connection lost'));
        const [result] = await submitMissingTemplatesToPages({ pages: [pages[0]], templateNames: names, request, onProgress: vi.fn() });
        expect(result).toMatchObject({ state: 'failed', submitted: 25, failed: 0, unattempted: 5, error: 'Connection lost' });
        expect(request).toHaveBeenCalledTimes(3);
    });

    it('does not report incomplete responses as successful submissions', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce(response({ templates: [] }))
            .mockResolvedValueOnce(response({ success: true, results: [] }));
        const [result] = await submitMissingTemplatesToPages({ pages: [pages[0]], templateNames: ['one'], request, onProgress: vi.fn() });
        expect(result).toMatchObject({ state: 'failed', submitted: 0, failed: 1 });
    });
});
