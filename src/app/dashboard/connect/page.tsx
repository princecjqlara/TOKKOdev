'use client';

import { useSession, signIn } from 'next-auth/react';
import { useEffect, useState } from 'react';
import { FacebookPage } from '@/types';
import { Check, Facebook, RefreshCw, AlertCircle } from 'lucide-react';

export default function ConnectPage() {
    const { data: session } = useSession();
    const [facebookPages, setFacebookPages] = useState<FacebookPage[]>([]);
    const [loading, setLoading] = useState(true);
    const [connecting, setConnecting] = useState<string | null>(null);
    const [connectedPages, setConnectedPages] = useState<Set<string>>(new Set());
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    useEffect(() => {
        fetchFacebookPages();
        fetchConnectedPages();
    }, [session]);

    const fetchFacebookPages = async () => {
        if (!session?.accessToken) {
            setLoading(false);
            return;
        }

        try {
            const res = await fetch('/api/facebook/pages');
            const data = await res.json();

            if (data.error) {
                setError(data.message);
            } else {
                setFacebookPages(data.pages || []);
            }
        } catch (error) {
            console.error('Error fetching Facebook pages:', error);
            setError('Failed to load Facebook pages');
        } finally {
            setLoading(false);
        }
    };

    const fetchConnectedPages = async () => {
        try {
            const res = await fetch('/api/pages');
            const data = await res.json();
            const fbPageIds = new Set(data.pages?.map((p: { fb_page_id: string }) => p.fb_page_id) || []);
            setConnectedPages(fbPageIds as Set<string>);
        } catch (error) {
            console.error('Error fetching connected pages:', error);
        }
    };

    const handleConnect = async (page: FacebookPage) => {
        setConnecting(page.id);
        setError(null);
        setSuccess(null);

        try {
            const res = await fetch('/api/facebook/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fbPageId: page.id,
                    name: page.name,
                    accessToken: page.access_token
                })
            });

            const data = await res.json();

            if (data.success) {
                setConnectedPages(prev => new Set([...prev, page.id]));
                setSuccess(`Successfully connected "${page.name}"`);
            } else {
                setError(data.message || 'Failed to connect page');
            }
        } catch (error) {
            console.error('Error connecting page:', error);
            setError('Failed to connect page');
        } finally {
            setConnecting(null);
        }
    };

    const handleFacebookLogin = () => {
        signIn('facebook', { callbackUrl: '/dashboard/connect' });
    };

    // Not logged in with Facebook
    if (!session?.accessToken) {
        return (
            <div className="max-w-[600px] mx-auto p-8 mt-12">
                <div className="wireframe-card text-center py-12">
                    <Facebook className="w-16 h-16 mx-auto mb-6 text-blue-600" />
                    <h1 className="text-2xl font-black uppercase mb-2">
                        Connect Facebook
                    </h1>
                    <p className="font-mono text-sm text-gray-500 mb-8 max-w-sm mx-auto">
                        Connect your Facebook account to access your pages and start managing contacts securely.
                    </p>
                    <button
                        onClick={handleFacebookLogin}
                        className="btn-wireframe bg-blue-600 text-white border-blue-600 hover:bg-blue-700 hover:text-white"
                    >
                        Login with Facebook
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="p-6 md:p-8 max-w-[1000px] mx-auto fade-in">
            {/* Header */}
            <div className="mb-8 border-b-2 border-black pb-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-black uppercase mb-1">
                        Connect Pages
                    </h1>
                    <p className="font-mono text-sm text-gray-500 uppercase tracking-wide">
                        Select Facebook pages to manage
                    </p>
                </div>

                <button
                    onClick={handleFacebookLogin}
                    className="btn-wireframe text-xs bg-white h-9"
                >
                    <RefreshCw className="w-3 h-3 mr-2" />
                    Refresh Permissions
                </button>
            </div>

            {/* Messages */}
            {error && (
                <div className="mb-6 p-4 border border-black bg-red-50 flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                    <span className="text-sm font-bold text-red-800 uppercase">{error}</span>
                </div>
            )}

            {success && (
                <div className="mb-6 p-4 border border-black bg-green-50 flex items-start gap-3">
                    <Check className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
                    <span className="text-sm font-bold text-green-800 uppercase">{success}</span>
                </div>
            )}

            {/* Content */}
            {loading ? (
                <div className="flex justify-center py-20 wireframe-card">
                    <div className="animate-spin w-8 h-8 border-2 border-black border-t-transparent rounded-full" />
                </div>
            ) : facebookPages.length === 0 ? (
                <div className="wireframe-card text-center py-12">
                    <p className="text-lg font-bold uppercase mb-2">No Facebook Pages found</p>
                    <p className="font-mono text-sm text-gray-500 mb-4">
                        Ensure you are an admin of a Facebook Page and have granted permissions.
                    </p>
                </div>
            ) : (
                <div className="overflow-x-auto border border-black">
                    <table className="table-wireframe">
                        <thead>
                            <tr>
                                <th>Page Name</th>
                                <th>Category</th>
                                <th>Status</th>
                                <th className="text-right">Action</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white">
                            {facebookPages.map((page) => {
                                const isConnected = connectedPages.has(page.id);
                                const isConnecting = connecting === page.id;

                                return (
                                    <tr key={page.id} className="hover:bg-gray-50 transition-colors">
                                        <td className="font-bold">{page.name}</td>
                                        <td className="font-mono text-xs text-gray-500 uppercase">{page.category || '-'}</td>
                                        <td>
                                            {isConnected ? (
                                                <span className="badge-wireframe bg-black text-white border-black">
                                                    Connected
                                                </span>
                                            ) : (
                                                <span className="badge-wireframe bg-gray-100 text-gray-400 border-gray-200">
                                                    Not Connected
                                                </span>
                                            )}
                                        </td>
                                        <td className="text-right">
                                            {isConnected ? (
                                                <button
                                                    disabled
                                                    className="btn-ghost-wireframe text-xs opacity-50 cursor-not-allowed font-bold"
                                                >
                                                    Installed
                                                </button>
                                            ) : (
                                                <button
                                                    onClick={() => handleConnect(page)}
                                                    disabled={isConnecting}
                                                    className="btn-wireframe text-xs py-1.5 h-8 bg-black text-white hover:bg-gray-800"
                                                >
                                                    {isConnecting ? (
                                                        <span className="animate-pulse">Connecting...</span>
                                                    ) : (
                                                        'Connect'
                                                    )}
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
