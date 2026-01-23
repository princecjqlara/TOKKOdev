'use client';

import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Users, Plus, X, Check, AlertCircle, Trash2, Shield, User } from 'lucide-react';

interface UserData {
    id: string;
    email: string;
    name: string | null;
    role: string;
    is_active: boolean;
    created_at: string;
}

export default function AdminUsersPage() {
    const { data: session, status } = useSession();
    const router = useRouter();
    const [users, setUsers] = useState<UserData[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // New user form
    const [showForm, setShowForm] = useState(false);
    const [newEmail, setNewEmail] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [newName, setNewName] = useState('');
    const [newRole, setNewRole] = useState('user');
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        if (status === 'unauthenticated') {
            router.push('/login');
        } else if (status === 'authenticated') {
            // Check if user is admin
            if ((session?.user as any)?.role !== 'admin') {
                router.push('/dashboard');
            } else {
                fetchUsers();
            }
        }
    }, [status, session, router]);

    const fetchUsers = async () => {
        try {
            const res = await fetch('/api/admin/users');
            const data = await res.json();

            if (res.ok) {
                setUsers(data.users || []);
            } else {
                setError(data.error || 'Failed to fetch users');
            }
        } catch (err) {
            setError('Failed to fetch users');
        } finally {
            setIsLoading(false);
        }
    };

    const handleCreateUser = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        setError(null);
        setSuccess(null);

        try {
            const res = await fetch('/api/admin/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: newEmail,
                    password: newPassword,
                    name: newName,
                    role: newRole
                })
            });

            const data = await res.json();

            if (res.ok) {
                setSuccess(`User ${newEmail} created successfully`);
                setShowForm(false);
                setNewEmail('');
                setNewPassword('');
                setNewName('');
                setNewRole('user');
                fetchUsers();
            } else {
                setError(data.error || 'Failed to create user');
            }
        } catch (err) {
            setError('Failed to create user');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDeactivateUser = async (userId: string, email: string) => {
        if (!confirm(`Are you sure you want to deactivate ${email}?`)) return;

        try {
            const res = await fetch(`/api/admin/users?id=${userId}`, {
                method: 'DELETE'
            });

            const data = await res.json();

            if (res.ok) {
                setSuccess(`User ${email} deactivated`);
                fetchUsers();
            } else {
                setError(data.error || 'Failed to deactivate user');
            }
        } catch (err) {
            setError('Failed to deactivate user');
        }
    };

    if (status === 'loading' || isLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="animate-spin h-8 w-8 border-2 border-black border-t-transparent rounded-full" />
            </div>
        );
    }

    return (
        <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-4">
                    <div className="w-12 h-12 border-2 border-black flex items-center justify-center">
                        <Users className="w-6 h-6" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-black uppercase">User Management</h1>
                        <p className="text-sm text-gray-600 font-mono">Add and manage user accounts</p>
                    </div>
                </div>
                <button
                    onClick={() => setShowForm(!showForm)}
                    className="btn-wireframe flex items-center gap-2"
                >
                    {showForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                    {showForm ? 'Cancel' : 'Add User'}
                </button>
            </div>

            {/* Messages */}
            {error && (
                <div className="mb-6 p-4 border-2 border-red-500 bg-red-50 flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
                    <p className="text-red-700 text-sm">{error}</p>
                    <button onClick={() => setError(null)} className="ml-auto">
                        <X className="w-4 h-4 text-red-500" />
                    </button>
                </div>
            )}

            {success && (
                <div className="mb-6 p-4 border-2 border-green-500 bg-green-50 flex items-start gap-3">
                    <Check className="w-5 h-5 text-green-500 flex-shrink-0" />
                    <p className="text-green-700 text-sm">{success}</p>
                    <button onClick={() => setSuccess(null)} className="ml-auto">
                        <X className="w-4 h-4 text-green-500" />
                    </button>
                </div>
            )}

            {/* Add User Form */}
            {showForm && (
                <div className="mb-8 p-6 border-2 border-black bg-gray-50">
                    <h2 className="font-bold text-lg mb-4 flex items-center gap-2">
                        <Plus className="w-5 h-5" />
                        Add New User
                    </h2>
                    <form onSubmit={handleCreateUser} className="grid md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider mb-2">
                                Email *
                            </label>
                            <input
                                type="email"
                                value={newEmail}
                                onChange={(e) => setNewEmail(e.target.value)}
                                className="w-full border-2 border-black px-3 py-2 text-sm font-mono"
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider mb-2">
                                Password *
                            </label>
                            <input
                                type="password"
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                className="w-full border-2 border-black px-3 py-2 text-sm font-mono"
                                minLength={6}
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider mb-2">
                                Name
                            </label>
                            <input
                                type="text"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                className="w-full border-2 border-black px-3 py-2 text-sm font-mono"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-bold uppercase tracking-wider mb-2">
                                Role
                            </label>
                            <select
                                value={newRole}
                                onChange={(e) => setNewRole(e.target.value)}
                                className="w-full border-2 border-black px-3 py-2 text-sm font-mono bg-white"
                            >
                                <option value="user">User</option>
                                <option value="admin">Admin</option>
                            </select>
                        </div>
                        <div className="md:col-span-2">
                            <button
                                type="submit"
                                disabled={isSubmitting}
                                className="btn-wireframe-dark px-6 py-2 flex items-center gap-2"
                            >
                                {isSubmitting ? (
                                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                ) : (
                                    <Check className="w-4 h-4" />
                                )}
                                Create User
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {/* Users Table */}
            <div className="border-2 border-black overflow-hidden">
                <table className="w-full">
                    <thead>
                        <tr className="border-b-2 border-black bg-gray-100">
                            <th className="text-left px-4 py-3 font-bold text-xs uppercase tracking-wider">User</th>
                            <th className="text-left px-4 py-3 font-bold text-xs uppercase tracking-wider">Role</th>
                            <th className="text-left px-4 py-3 font-bold text-xs uppercase tracking-wider">Status</th>
                            <th className="text-right px-4 py-3 font-bold text-xs uppercase tracking-wider">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.map((user, index) => (
                            <tr key={user.id} className={index !== users.length - 1 ? 'border-b border-gray-200' : ''}>
                                <td className="px-4 py-3">
                                    <div>
                                        <p className="font-medium text-sm">{user.name || '-'}</p>
                                        <p className="text-xs text-gray-500 font-mono">{user.email}</p>
                                    </div>
                                </td>
                                <td className="px-4 py-3">
                                    <span className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-bold uppercase ${user.role === 'admin'
                                            ? 'bg-black text-white'
                                            : 'bg-gray-100 text-gray-700 border border-gray-300'
                                        }`}>
                                        {user.role === 'admin' ? <Shield className="w-3 h-3" /> : <User className="w-3 h-3" />}
                                        {user.role}
                                    </span>
                                </td>
                                <td className="px-4 py-3">
                                    <span className={`inline-block px-2 py-1 text-xs font-bold uppercase ${user.is_active
                                            ? 'bg-green-100 text-green-700 border border-green-300'
                                            : 'bg-red-100 text-red-700 border border-red-300'
                                        }`}>
                                        {user.is_active ? 'Active' : 'Inactive'}
                                    </span>
                                </td>
                                <td className="px-4 py-3 text-right">
                                    {user.is_active && user.id !== session?.user?.id && (
                                        <button
                                            onClick={() => handleDeactivateUser(user.id, user.email)}
                                            className="text-red-600 hover:text-red-800 p-1"
                                            title="Deactivate user"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    )}
                                </td>
                            </tr>
                        ))}
                        {users.length === 0 && (
                            <tr>
                                <td colSpan={4} className="px-4 py-8 text-center text-gray-500 font-mono text-sm">
                                    No users found
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
