import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import AdminLogin from './AdminLogin';

export const dynamic = 'force-dynamic';

export default async function AdminLoginPage() {
    const session = await getServerSession(authOptions);
    if (session?.isSystemAdmin && session.accountActive) redirect('/admin');
    return <AdminLogin />;
}
