import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import AdminAccounts from './AdminAccounts';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
    const session = await getServerSession(authOptions);
    if (!session?.isSystemAdmin || !session.accountActive) redirect('/admin/login');
    return <AdminAccounts />;
}
