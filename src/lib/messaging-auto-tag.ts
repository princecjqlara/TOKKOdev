export type MessengerLeadStage = 'qualified' | 'converted' | 'unqualified' | 'lost';
export type MessengerSystemSignal = 'order_created' | MessengerLeadStage;

export const MESSENGER_STAGE_TAG_NAMES: Record<MessengerLeadStage, string> = {
    qualified: 'Qualified', converted: 'Converted', unqualified: 'Not Qualified', lost: 'Lost'
};
export const MESSAGING_AUTO_TAG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function isWithinMessagingAutoTagWindow(value: string | null | undefined, now = Date.now()): boolean {
    const timestamp = value ? Date.parse(value) : NaN;
    return Number.isFinite(timestamp) && timestamp >= now - MESSAGING_AUTO_TAG_WINDOW_MS && timestamp <= now;
}

// These are Meta-generated conversation-history messages, not customer/staff prose.
// The stage and order text was observed in the app's read-only Messenger audit.
export function classifyMessengerSystemMessage(text: string): MessengerSystemSignal | null {
    const value = text.trim();
    const stage = /^Lead stage set to (Qualified|Converted|Not Qualified|Unqualified|Lost)\.?$/i.exec(value);
    if (stage) return stage[1].toLowerCase() === 'not qualified'
        ? 'unqualified' : stage[1].toLowerCase() as MessengerLeadStage;

    if (/^You (?:created an order for|requested) (?:PHP|₱)\s*[\d,.]+\b/i.test(value) &&
        /fb-pma:\/\/payments\/orderdetails\/\?[^\s]*invoice_id=\d+/i.test(value)) {
        return 'order_created';
    }

    return null;
}
