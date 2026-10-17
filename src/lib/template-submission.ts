export type SubmissionPage = { id: string; name: string };

export type PageSubmissionResult = SubmissionPage & {
    state: 'checking' | 'submitting' | 'complete' | 'failed';
    total: number;
    missing: number;
    submitted: number;
    alreadyExisted: number;
    failed: number;
    unattempted: number;
    error?: string;
};

async function readResponse(response: Response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
        throw new Error(data.message || data.detail || `Request failed (${response.status}).`);
    }
    return data;
}

/** Each page is checked independently; failed batches are left for a later retry. */
export async function submitMissingTemplatesToPages({
    pages, templateNames, onProgress, request = fetch
}: {
    pages: SubmissionPage[];
    templateNames: string[];
    onProgress: (results: PageSubmissionResult[]) => void;
    request?: typeof fetch;
}): Promise<PageSubmissionResult[]> {
    const names = [...new Set(templateNames)];
    const uniquePages = [...new Map(pages.map(page => [page.id, page])).values()];
    const results: PageSubmissionResult[] = [];
    const publish = () => onProgress(results.map(result => ({ ...result })));

    for (const page of uniquePages) {
        const result: PageSubmissionResult = {
            ...page, state: 'checking', total: names.length, missing: 0,
            submitted: 0, alreadyExisted: 0, failed: 0, unattempted: names.length
        };
        results.push(result);
        publish();
        try {
            const status = await readResponse(await request(
                `/api/facebook/templates/status?pageId=${encodeURIComponent(page.id)}`
            ));
            if (!Array.isArray(status.templates)) throw new Error('Could not read current templates.');
            // Pending and rejected names also exist and must not be resubmitted.
            const existing = new Set(status.templates.map((template: { name: string }) => template.name));
            const missing = names.filter(name => !existing.has(name));
            result.missing = missing.length;
            result.alreadyExisted = names.length - missing.length;
            result.unattempted = missing.length;
            result.state = 'submitting';
            publish();

            for (let offset = 0; offset < missing.length; offset += 25) {
                const batch = missing.slice(offset, offset + 25);
                const data = await readResponse(await request('/api/facebook/templates/submit-all', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pageId: page.id, templateNames: batch, limit: 25 })
                }));
                if (!Array.isArray(data.results)) throw new Error('Submission results were incomplete. Refresh before retrying.');
                const returned = new Map<string, { action: string; error?: string }>(
                    data.results.map((entry: { name: string; action: string; error?: string }) => [entry.name, entry])
                );
                let batchFailures = 0;
                for (const name of batch) {
                    const entry = returned.get(name);
                    if (entry?.action === 'created') result.submitted++;
                    else if (entry?.action === 'already_exists') result.alreadyExisted++;
                    else {
                        result.failed++;
                        batchFailures++;
                        result.error ||= entry?.error || 'Submission was not confirmed. Refresh before retrying.';
                    }
                }
                result.unattempted -= batch.length;
                publish();
                // Avoid repeatedly hitting a page whose token, permissions or limits failed.
                if (batchFailures === batch.length) break;
            }
            result.state = result.failed || result.unattempted ? 'failed' : 'complete';
        } catch (error) {
            result.state = 'failed';
            result.error = (error as Error).message;
        }
        publish();
    }
    return results.map(result => ({ ...result }));
}
