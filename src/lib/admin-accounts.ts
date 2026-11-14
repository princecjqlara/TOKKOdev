export type AdminIdentity = { id: string; name: string | null; email: string | null };
export type AdminAccount = AdminIdentity & {
    type: 'parent' | 'subaccount';
    kind: string;
    active: boolean;
    status: 'active' | 'disabled' | 'pending' | 'expired';
    createdAt: string;
    expiresAt: string | null;
    daysRemaining: number | null;
    lifetimeDays: number | null;
    deleteAfterExpiry: boolean;
    creator: AdminIdentity | null;
    phone: string | null;
    emailLoginEnabled: boolean;
    emailVerifiedAt: string | null;
    hasPassword: boolean;
    passwordChangedAt: string | null;
    canResetPassword: boolean;
    subaccountCount: number;
    pages: { id: string; name: string; facebookId: string; assignedAt: string;
        source: string; assignedBy: AdminIdentity | null }[];
};
export type AdminAccountsResponse = {
    accounts: AdminAccount[];
    total: number;
    page: number;
    pageSize: number;
    summary: { accounts: number; parents: number; subaccounts: number; permanent: number; temporary: number; expired: number };
};
