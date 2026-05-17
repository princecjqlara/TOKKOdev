export type ContactSyncResponse = {
    success?: boolean;
    partial?: boolean;
    synced?: number;
    failed?: number;
    total?: number;
    processed?: number;
    remaining?: number;
    remainingPsids?: string[];
    restored?: number;
    incremental?: boolean;
    message?: string;
};

export type ContactSyncProgress = {
    attempt: number;
    totalSynced: number;
    totalFailed: number;
    remainingPsids: string[];
    response: ContactSyncResponse;
};

export type ContactSyncResult = {
    data: ContactSyncResponse;
    totalSynced: number;
    totalFailed: number;
    completed: boolean;
};

const MAX_CONTINUATIONS = 100;
const MAX_TIMEOUT_RETRIES_PER_STEP = 3;
const RETRY_DELAY_MS = 1500;

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
        throw new Error(data.message || `Sync failed with status ${response.status}`);
    }

    return data;
}

async function postSync(pageId: string, resumePsids: string[]): Promise<ContactSyncResponse> {
    const response = await fetch(`/api/pages/${pageId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
            forceFullSync: true,
            ...(resumePsids.length > 0 ? { resumePsids } : {})
        })
    });

    return parseSyncResponse(response);
}

export async function runContactSyncToCompletion(
    pageId: string,
    options: {
        onProgress?: (progress: ContactSyncProgress) => void;
    } = {}
): Promise<ContactSyncResult> {
    let resumePsids: string[] = [];
    let totalSynced = 0;
    let totalFailed = 0;
    let lastData: ContactSyncResponse = {};

    for (let attempt = 1; attempt <= MAX_CONTINUATIONS; attempt++) {
        let data: ContactSyncResponse | null = null;

        for (let retry = 1; retry <= MAX_TIMEOUT_RETRIES_PER_STEP; retry++) {
            try {
                data = await postSync(pageId, resumePsids);
                break;
            } catch (error) {
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

        lastData = data;
        totalSynced += data.synced || 0;
        totalFailed += data.failed || 0;
        resumePsids = Array.isArray(data.remainingPsids) ? data.remainingPsids : [];

        options.onProgress?.({
            attempt,
            totalSynced,
            totalFailed,
            remainingPsids: resumePsids,
            response: data
        });

        if (!data.partial || resumePsids.length === 0) {
            return {
                data,
                totalSynced,
                totalFailed,
                completed: true
            };
        }
    }

    return {
        data: lastData,
        totalSynced,
        totalFailed,
        completed: false
    };
}
