import { requestWithTimeout } from './request-timeout';

export type ContactSyncResponse = {
    success?: boolean;
    partial?: boolean;
    synced?: number;
    failed?: number;
    tagged?: number;
    syncHadFailures?: boolean;
    total?: number;
    processed?: number;
    remaining?: number;
    remainingPsids?: string[];
    cursor?: string | null;
    nextCursor?: string | null;
    syncStartedAt?: string;
    syncRunId?: string;
    restored?: number;
    incremental?: boolean;
    message?: string;
};

export type ContactSyncProgress = {
    attempt: number;
    totalSynced: number;
    totalFailed: number;
    remainingPsids: string[];
    cursor: string | null;
    response: ContactSyncResponse;
};

export type ContactSyncResult = {
    data: ContactSyncResponse;
    totalSynced: number;
    totalFailed: number;
    completed: boolean;
};

const MAX_TIMEOUT_RETRIES_PER_STEP = 3;
const RETRY_DELAY_MS = 1500;
export const CONTACT_SYNC_REQUEST_TIMEOUT_MS = 180_000;

class ContactSyncRequestError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
        this.name = 'ContactSyncRequestError';
    }
}

function createSyncRunId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function parseSyncResponse(response: Response): Promise<ContactSyncResponse> {
    const rawBody = await response.text().catch(() => '');

    let data: ContactSyncResponse = {};
    if (rawBody) {
        try {
            data = JSON.parse(rawBody) as ContactSyncResponse;
        } catch {
            data = { message: rawBody };
        }
    }

    if (!response.ok || !data.success) {
        throw new ContactSyncRequestError(
            data.message || `Sync failed with status ${response.status}`,
            response.status
        );
    }

    return data;
}

async function postSync(
    pageId: string,
    options: {
        resumePsids: string[];
        cursor: string | null;
        syncStartedAt: string | null;
        syncRunId: string;
        syncHadFailures: boolean;
        autoTag: boolean;
    }
): Promise<ContactSyncResponse> {
    return requestWithTimeout(async signal => {
        const response = await fetch(`/api/pages/${pageId}/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            signal,
            body: JSON.stringify({
                forceFullSync: true,
                autoTag: options.autoTag,
                paged: true,
                ...(options.resumePsids.length > 0 ? { resumePsids: options.resumePsids } : {}),
                ...(options.cursor ? { cursor: options.cursor } : {}),
                ...(options.syncStartedAt ? { syncStartedAt: options.syncStartedAt } : {}),
                syncRunId: options.syncRunId,
                syncHadFailures: options.syncHadFailures
            })
        });

        return parseSyncResponse(response);
    }, CONTACT_SYNC_REQUEST_TIMEOUT_MS, 'Contact sync request timed out. Please retry syncing.');
}

export async function runContactSyncToCompletion(
    pageId: string,
    options: {
        onProgress?: (progress: ContactSyncProgress) => void;
        autoTag?: boolean;
    } = {}
): Promise<ContactSyncResult> {
    let resumePsids: string[] = [];
    let totalSynced = 0;
    let totalFailed = 0;
    let cursor: string | null = null;
    let syncStartedAt: string | null = null;
    const syncRunId = createSyncRunId();
    const seenContinuationKeys = new Set<string>();
    let syncHadFailures = false;

    for (let attempt = 1; ; attempt++) {
        let data: ContactSyncResponse | null = null;

        for (let retry = 1; retry <= MAX_TIMEOUT_RETRIES_PER_STEP; retry++) {
            try {
                data = await postSync(pageId, { resumePsids, cursor, syncStartedAt, syncRunId, syncHadFailures, autoTag: options.autoTag !== false });
                break;
            } catch (error) {
                if (error instanceof ContactSyncRequestError && error.status >= 400 && error.status < 500) {
                    throw error;
                }

                if (retry >= MAX_TIMEOUT_RETRIES_PER_STEP) {
                    throw error;
                }

                console.warn('Contact sync request failed or timed out. Retrying the same sync slice.', {
                    attempt,
                    retry,
                    remainingPsids: resumePsids.length,
                    error: error instanceof Error ? error.message : String(error)
                });
                await wait(RETRY_DELAY_MS * retry);
            }
        }

        if (!data) {
            throw new Error('Sync failed without a response');
        }

        totalSynced += data.synced || 0;
        totalFailed += data.failed || 0;
        syncHadFailures ||= data.syncHadFailures === true || (data.failed || 0) > 0;
        resumePsids = Array.isArray(data.remainingPsids) ? data.remainingPsids : [];
        syncStartedAt = data.syncStartedAt || syncStartedAt;
        cursor = resumePsids.length > 0
            ? typeof data.cursor === 'string'
                ? data.cursor
                : null
            : typeof data.nextCursor === 'string'
                ? data.nextCursor
                : typeof data.cursor === 'string'
                    ? data.cursor
                    : null;

        options.onProgress?.({
            attempt,
            totalSynced,
            totalFailed,
            remainingPsids: resumePsids,
            cursor,
            response: data
        });

        if (!data.partial) {
            return {
                data,
                totalSynced,
                totalFailed,
                completed: true
            };
        }
        if (resumePsids.length === 0 && !cursor) {
            throw new Error('Sync returned an incomplete response without a continuation. Please retry syncing.');
        }

        const continuationKey = resumePsids.length > 0
            ? `cursor:${cursor || ''}:psids:${resumePsids.join(',')}`
            : `cursor:${cursor || ''}`;
        if (seenContinuationKeys.has(continuationKey)) {
            throw new Error('Sync stopped because Facebook returned a repeated continuation cursor.');
        }
        seenContinuationKeys.add(continuationKey);
    }
}
