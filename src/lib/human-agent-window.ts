export const STANDARD_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HUMAN_AGENT_REPLY_WINDOW_MS = 7 * STANDARD_REPLY_WINDOW_MS;

// Leave a little room for upload/API latency at the edge of Meta's window.
const SEND_SAFETY_MARGIN_MS = 60 * 1000;

export function getManualReplyMessagingType(
    lastInboundAt: string | null | undefined,
    now: Date = new Date()
): 'RESPONSE' | 'HUMAN_AGENT' | null {
    if (!lastInboundAt) return null;
    const elapsed = now.getTime() - new Date(lastInboundAt).getTime();
    if (!Number.isFinite(elapsed) || elapsed < 0) return null;
    if (elapsed < STANDARD_REPLY_WINDOW_MS) return 'RESPONSE';
    if (elapsed < HUMAN_AGENT_REPLY_WINDOW_MS - SEND_SAFETY_MARGIN_MS) return 'HUMAN_AGENT';
    return null;
}
