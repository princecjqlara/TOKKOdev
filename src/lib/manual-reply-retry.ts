export type ManualReplyRetryState = {
    fingerprint: string;
    sentParts: string[];
};

type MediaFingerprint = {
    name: string;
    size: number;
    type: string;
    lastModified: number;
};

export function createManualReplyFingerprint(text: string, media: MediaFingerprint[]): string {
    return JSON.stringify([
        text.trim(),
        media.map((item) => [item.name, item.size, item.type, item.lastModified])
    ]);
}

export function getSentPartsForRetry(
    state: ManualReplyRetryState | undefined,
    fingerprint: string
): Set<string> {
    if (!state || state.fingerprint !== fingerprint) return new Set();
    return new Set(state.sentParts);
}

export function mergeSentParts(previous: Iterable<string>, newlySent: Iterable<string>): string[] {
    return [...new Set([...previous, ...newlySent])];
}
