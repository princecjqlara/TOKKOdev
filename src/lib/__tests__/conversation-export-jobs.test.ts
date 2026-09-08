import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getSupabaseAdmin: vi.fn(),
    getConversationIdForPsid: vi.fn(),
    getConversationMessages: vi.fn(),
    getPageConversationsBatch: vi.fn(),
    isFacebookReauthRequired: vi.fn()
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/facebook', () => ({
    getConversationIdForPsid: mocks.getConversationIdForPsid,
    getConversationMessages: mocks.getConversationMessages,
    getPageConversationsBatch: mocks.getPageConversationsBatch,
    isFacebookReauthRequired: mocks.isFacebookReauthRequired
}));

import { processOneConversationExportBatch } from '@/lib/conversation-export-jobs';

type Result = { data?: unknown; error?: unknown };

function queryBuilder(result: Result) {
    const builder: Record<string, any> = {};
    for (const method of ['select', 'eq', 'in', 'is', 'gt', 'or', 'order', 'limit']) {
        builder[method] = vi.fn(() => builder);
    }
    builder.single = vi.fn().mockResolvedValue(result);
    builder.maybeSingle = vi.fn().mockResolvedValue(result);
    builder.then = (onFulfilled: (value: Result) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(onFulfilled, onRejected);
    return builder;
}

function baseJob(overrides: Record<string, unknown> = {}) {
    return {
        id: 'job_1',
        page_id: 'page_1',
        created_by: 'user_1',
        scope: 'selected',
        contact_ids: ['contact_1'],
        next_contact_index: 0,
        next_cursor: null,
        total_items: 1,
        processed_items: 0,
        conversation_count: 0,
        message_count: 0,
        chunk_count: 0,
        filename: 'page-conversations.csv',
        storage_prefix: 'user_1/job_1',
        attempt_count: 0,
        claim_token: 'claim_1',
        ...overrides
    };
}

function createSupabaseMock(job: Record<string, unknown>) {
    const updates: Record<string, unknown>[] = [];
    const upload = vi.fn().mockResolvedValue({ data: { path: 'chunk.csv' }, error: null });
    const supabase = {
        rpc: vi.fn().mockResolvedValue({ data: [job], error: null }),
        from: vi.fn((table: string) => {
            if (table === 'pages') {
                return queryBuilder({
                    data: { fb_page_id: 'fb_page_1', access_token: 'page_token', name: 'My Page' },
                    error: null
                });
            }
            if (table === 'contacts') {
                return queryBuilder({
                    data: [{ id: 'contact_1', psid: 'psid_1', name: 'Customer One' }],
                    error: null
                });
            }
            if (table === 'outbound_message_events') {
                return queryBuilder({ data: [], error: null });
            }
            if (table === 'conversation_export_jobs') {
                return {
                    update: vi.fn((value: Record<string, unknown>) => {
                        updates.push(value);
                        return queryBuilder({ data: null, error: null });
                    })
                };
            }
            throw new Error(`Unexpected table: ${table}`);
        }),
        storage: {
            getBucket: vi.fn().mockResolvedValue({ data: { id: 'conversation-exports' }, error: null }),
            createBucket: vi.fn(),
            from: vi.fn(() => ({ upload }))
        }
    };
    return { supabase, updates, upload };
}

describe('conversation export background worker', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isFacebookReauthRequired.mockReturnValue(false);
        mocks.getConversationIdForPsid.mockResolvedValue('conversation_1');
        mocks.getConversationMessages.mockResolvedValue([{
            id: 'message_1',
            message: 'Hello, "Customer"',
            created_time: '2026-09-07T00:00:00.000Z',
            from: { id: 'psid_1', name: 'Customer One' }
        }]);
    });

    it('finishes a selected-contact job and persists a downloadable CSV chunk', async () => {
        const { supabase, updates, upload } = createSupabaseMock(baseJob());
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const result = await processOneConversationExportBatch('job_1');

        expect(result).toEqual({
            jobId: 'job_1', complete: true, processedItems: 1, conversations: 1, messages: 1
        });
        expect(upload).toHaveBeenCalledOnce();
        const [path, body, options] = upload.mock.calls[0];
        expect(path).toBe('user_1/job_1/chunk-000000.csv');
        expect(body.toString()).toContain('pageId,pageName,fbPageId');
        expect(body.toString()).toContain('"Hello, ""Customer"""');
        expect(options).toEqual({ contentType: 'text/csv', cacheControl: '3600', upsert: true });
        expect(updates.at(-1)).toMatchObject({
            status: 'completed', processed_items: 1, conversation_count: 1,
            message_count: 1, chunk_count: 1, claim_token: null
        });
    });

    it('resumes an all-conversation job without adding a second CSV header', async () => {
        const job = baseJob({
            scope: 'all', contact_ids: [], next_cursor: 'cursor_1', total_items: 2,
            processed_items: 1, conversation_count: 1, message_count: 1, chunk_count: 1
        });
        const { supabase, updates, upload } = createSupabaseMock(job);
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getPageConversationsBatch.mockResolvedValue({
            conversations: [{
                id: 'conversation_2',
                updated_time: '2026-09-07T00:00:00.000Z',
                participants: { data: [
                    { id: 'fb_page_1', name: 'My Page' },
                    { id: 'psid_1', name: 'Customer One' }
                ] }
            }],
            nextCursor: null
        });

        const result = await processOneConversationExportBatch();

        expect(result).toMatchObject({ complete: true, processedItems: 1 });
        const [path, body] = upload.mock.calls[0];
        expect(path).toBe('user_1/job_1/chunk-000001.csv');
        expect(body.toString().startsWith('\n')).toBe(true);
        expect(body.toString()).not.toContain('pageId,pageName,fbPageId');
        expect(updates.at(-1)).toMatchObject({
            status: 'completed', processed_items: 2, conversation_count: 2,
            message_count: 2, chunk_count: 2, next_cursor: null
        });
    });

    it('requeues a transient Facebook failure without advancing the checkpoint', async () => {
        const { supabase, updates, upload } = createSupabaseMock(baseJob());
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.getConversationIdForPsid.mockRejectedValue(new Error('Facebook temporarily unavailable'));

        const result = await processOneConversationExportBatch('job_1');

        expect(result).toMatchObject({ jobId: 'job_1', complete: false, error: 'Facebook temporarily unavailable' });
        expect(upload).not.toHaveBeenCalled();
        expect(updates.at(-1)).toMatchObject({
            status: 'queued', attempt_count: 1, error_message: 'Facebook temporarily unavailable',
            claim_token: null, claimed_at: null
        });
        expect(updates.at(-1)?.next_attempt_at).toEqual(expect.any(String));
    });

    it('falls back to an application-generated claim token when uuid-ossp is unavailable', async () => {
        const job = baseJob({ status: 'queued', claim_token: null, claimed_at: null });
        const { supabase, updates, upload } = createSupabaseMock(job);
        const originalFrom = supabase.from;
        let exportJobCall = 0;
        supabase.rpc.mockResolvedValue({
            data: null,
            error: { code: '42883', message: 'function uuid_generate_v4() does not exist' }
        });
        supabase.from = vi.fn((table: string) => {
            if (table !== 'conversation_export_jobs') return originalFrom(table);
            exportJobCall += 1;
            if (exportJobCall === 1) return queryBuilder({ data: job, error: null });
            if (exportJobCall === 2) {
                return {
                    update: vi.fn((value: Record<string, unknown>) => {
                        updates.push(value);
                        return queryBuilder({ data: { ...job, ...value }, error: null });
                    })
                } as any;
            }
            return originalFrom(table);
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const result = await processOneConversationExportBatch('job_1');

        expect(result).toMatchObject({ jobId: 'job_1', complete: true });
        expect(upload).toHaveBeenCalledOnce();
        expect(updates[0]).toMatchObject({ status: 'running', error_message: null });
        expect(updates[0].claim_token).toMatch(/^[0-9a-f-]{36}$/);
        expect(updates.at(-1)).toMatchObject({ status: 'completed', claim_token: null });
    });
});
