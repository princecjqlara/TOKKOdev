export type SendError = { contactId: string; error: string };

export function mergeSendErrors(
    errorGroups: Array<SendError[] | undefined | null>
): SendError[] {
    const byContactId = new Map<string, SendError>();

    for (const group of errorGroups) {
        if (!group?.length) continue;
        for (const entry of group) {
            const contactId = entry?.contactId?.trim();
            if (!contactId) continue;
            const error = entry?.error?.trim() || 'Unknown error';
            if (byContactId.has(contactId)) {
                byContactId.delete(contactId);
            }
            byContactId.set(contactId, { contactId, error });
        }
    }

    return Array.from(byContactId.values());
}
