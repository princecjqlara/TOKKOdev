// Keep learned concurrency from turning fast responses into API bursts. These
// ceilings are local to a runtime; campaign Page leases coordinate runtimes.
const pageStarts = new Map<string, Promise<void>>();

export function waitForFacebookSendSlot(pageId: string, audioOrVideo = false): Promise<void> {
    const previous = pageStarts.get(pageId);
    // Stay below Meta's 300/s text ceiling and 10/s audio/video ceiling.
    const interval = audioOrVideo ? 100 : 4;
    const slot = previous
        ? previous.then(() => new Promise<void>(resolve => setTimeout(resolve, interval)))
        : Promise.resolve();
    pageStarts.set(pageId, slot.catch(() => {}));
    return slot;
}
