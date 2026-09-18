export type MessengerSystemSignal = 'order_created' | 'qualified' | 'converted';

// These are Meta-generated conversation-history messages, not customer/staff prose.
// The stage and order text was observed in the app's read-only Messenger audit.
export function classifyMessengerSystemMessage(text: string): MessengerSystemSignal | null {
    const value = text.trim();
    const stage = /^Lead stage set to (Qualified|Converted)\.?$/i.exec(value);
    if (stage) return stage[1].toLowerCase() as 'qualified' | 'converted';

    if (/^You (?:created an order for|requested) (?:PHP|₱)[\d,.]+\b/i.test(value) &&
        /fb-pma:\/\/payments\/orderdetails\/\?[^\s]*invoice_id=\d+/i.test(value)) {
        return 'order_created';
    }

    return null;
}
