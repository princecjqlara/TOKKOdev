import { readDeliveryDiagnostic, type DeliveryDiagnostic } from './delivery-diagnostics';

export type CampaignRecipientErrorRow = {
    id: string;
    contact_id: string;
    status: string;
    error_message: string | null;
    diagnostic?: DeliveryDiagnostic | null;
    contacts?: { name: string | null; psid: string | null } | { name: string | null; psid: string | null }[] | null;
};

export type CampaignRecipientError = {
    id: string;
    contactId: string;
    contactName: string | null;
    contactPsid: string | null;
    error: string;
    diagnostic: DeliveryDiagnostic;
};

export function normalizeCampaignRecipientErrors(
    rows: CampaignRecipientErrorRow[]
): CampaignRecipientError[] {
    return rows.map(row => {
        const contactRecord = Array.isArray(row.contacts)
            ? row.contacts[0]
            : row.contacts;
        const error = row.error_message?.trim() || 'Unknown error';

        return {
            id: row.id,
            contactId: row.contact_id,
            contactName: contactRecord?.name ?? null,
            contactPsid: contactRecord?.psid ?? null,
            error,
            diagnostic: readDeliveryDiagnostic(row.diagnostic, error)
        };
    });
}
