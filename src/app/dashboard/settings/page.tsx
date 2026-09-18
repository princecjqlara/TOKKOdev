'use client';

import { useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';
import { Page } from '@/types';
import { User, Shield, Link as LinkIcon, CheckCircle, RefreshCw } from 'lucide-react';
import Link from 'next/link';

export default function SettingsPage() {
    const { data: session } = useSession();
    const [pages, setPages] = useState<Page[]>([]);
    const [loading, setLoading] = useState(true);
    const [webhookActionPageId, setWebhookActionPageId] = useState<string | null>(null);
    const [webhookStatus, setWebhookStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
    const [origin, setOrigin] = useState('');
    const [autoTagByPage, setAutoTagByPage] = useState<Record<string, boolean>>({});
    const [autoTagErrorsByPage, setAutoTagErrorsByPage] = useState<Record<string, string>>({});
    const [autoTagLoading, setAutoTagLoading] = useState(true);
    const [autoTagSaving, setAutoTagSaving] = useState<string | null>(null);
    const [autoTagError, setAutoTagError] = useState<string | null>(null);

    useEffect(() => {
        setOrigin(window.location.origin);
        fetchPages();
        fetchAutoTagSettings();
    }, []);

    const fetchAutoTagSettings = async () => {
        try {
            const res = await fetch('/api/settings/messaging-auto-tag');
            if (!res.ok) throw new Error('Could not load auto-tag settings');
            const data = await res.json();
            setAutoTagByPage(Object.fromEntries((data.pages || []).map((page: { id: string; messaging_auto_tag_enabled: boolean }) =>
                [page.id, page.messaging_auto_tag_enabled]
            )));
            setAutoTagErrorsByPage(Object.fromEntries((data.pages || [])
                .filter((page: { messaging_auto_tag_last_error?: string | null }) => page.messaging_auto_tag_last_error)
                .map((page: { id: string; messaging_auto_tag_last_error: string }) => [page.id, page.messaging_auto_tag_last_error])));
        } catch (error) {
            setAutoTagError((error as Error).message);
        } finally {
            setAutoTagLoading(false);
        }
    };

    const toggleAutoTag = async (page: Page) => {
        setAutoTagSaving(page.id);
        setAutoTagError(null);
        try {
            const res = await fetch('/api/settings/messaging-auto-tag', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pageId: page.id, enabled: !autoTagByPage[page.id] })
            });
            if (!res.ok) throw new Error('Could not save auto-tag setting');
            const data = await res.json();
            setAutoTagByPage(current => ({ ...current, [page.id]: data.page.messaging_auto_tag_enabled }));
        } catch (error) {
            setAutoTagError((error as Error).message);
        } finally {
            setAutoTagSaving(null);
        }
    };

    const fetchPages = async () => {
        try {
            const res = await fetch('/api/pages');
            const data = await res.json();
            setPages(data.pages || []);
        } catch (error) {
            console.error('Error fetching pages:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleResubscribeWebhook = async (page: Page) => {
        setWebhookActionPageId(page.id);
        setWebhookStatus(null);

        try {
            const res = await fetch(`/api/pages/${page.id}/webhook`, {
                method: 'POST'
            });
            const data = await res.json();

            if (res.ok && data.success) {
                setWebhookStatus({
                    type: 'success',
                    message: `Webhook subscription refreshed for "${page.name}".`
                });
            } else {
                setWebhookStatus({
                    type: 'error',
                    message: data.message || 'Failed to refresh webhook subscription.'
                });
            }
        } catch (error) {
            console.error('Error refreshing page webhook subscription:', error);
            setWebhookStatus({
                type: 'error',
                message: 'Failed to refresh webhook subscription.'
            });
        } finally {
            setWebhookActionPageId(null);
        }
    };

    return (
        <div className="p-6 md:p-8 max-w-[1000px] mx-auto fade-in">
            <div className="mb-8">
                <h1 className="text-3xl font-black uppercase mb-2">Settings</h1>
                <p className="font-mono text-sm text-gray-500 uppercase tracking-wide">
                    Manage profile and connections
                </p>
            </div>

            {/* Profile Section */}
            <div className="wireframe-card mb-6">
                <div className="flex items-center gap-4 border-b-2 border-black pb-4 mb-4">
                    <User className="w-5 h-5" />
                    <h2 className="text-xl font-bold uppercase">Profile</h2>
                </div>
                <div className="flex items-center gap-6">
                    {session?.user?.image ? (
                        <img
                            src={session.user.image}
                            alt={session.user.name || 'Profile'}
                            className="w-16 h-16 border-2 border-black"
                        />
                    ) : (
                        <div className="w-16 h-16 border-2 border-black bg-gray-100 flex items-center justify-center">
                            <User className="w-8 h-8 text-gray-400" />
                        </div>
                    )}
                    <div>
                        <p className="text-lg font-black uppercase tracking-wide">{session?.user?.name}</p>
                        <p className="font-mono text-sm text-gray-600">{session?.user?.email}</p>
                    </div>
                </div>
            </div>

            <div className="wireframe-card mb-6">
                <div className="border-b-2 border-black pb-4 mb-4">
                    <h2 className="text-xl font-bold uppercase">Messaging lead auto-tag</h2>
                    <p className="font-mono text-xs text-gray-600 mt-2">
                        Add each Page&apos;s Paid / Availed Service tag to its Tokko contact when Messenger records an order created
                        or a lead stage set to Qualified or Converted. On by default. An order record does not prove payment.
                    </p>
                </div>
                {autoTagError && <p role="alert" className="text-red-700 text-sm mb-3">{autoTagError}</p>}
                {pages.map(page => (
                    <div key={page.id} className="flex items-center justify-between gap-4 py-3 border-b border-gray-200 last:border-0">
                        <span>
                            <span className="font-bold block">{page.name}</span>
                            {autoTagErrorsByPage[page.id] && <span className="text-xs text-red-700">Sync needs attention: {autoTagErrorsByPage[page.id]}</span>}
                        </span>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={autoTagByPage[page.id] ?? false}
                            aria-label={`Auto-tag messaging leads for ${page.name}`}
                            onClick={() => toggleAutoTag(page)}
                            disabled={autoTagLoading || autoTagSaving === page.id || !(page.id in autoTagByPage)}
                            className={`px-4 py-2 border-2 border-black font-bold min-w-16 disabled:opacity-50 ${autoTagByPage[page.id] ? 'bg-black text-white' : 'bg-white text-black'}`}
                        >
                            {autoTagLoading ? '...' : autoTagByPage[page.id] ? 'On' : 'Off'}
                        </button>
                    </div>
                ))}
            </div>

            {/* Connected Pages Section */}
            <div className="wireframe-card mb-6">
                <div className="flex items-center justify-between border-b-2 border-black pb-4 mb-4">
                    <div className="flex items-center gap-4">
                        <LinkIcon className="w-5 h-5" />
                        <h2 className="text-xl font-bold uppercase">Connected Pages</h2>
                    </div>
                    <Link
                        href="/dashboard/connect"
                        className="btn-wireframe text-xs py-2 h-8"
                    >
                        + Connect Page
                    </Link>
                </div>

                {loading ? (
                    <div className="flex justify-center py-8">
                        <div className="animate-spin w-8 h-8 border-2 border-black border-t-transparent rounded-full" />
                    </div>
                ) : pages.length === 0 ? (
                    <div className="text-center py-8 bg-gray-50 border border-dashed border-gray-300">
                        <p className="font-bold text-gray-500 uppercase">No pages connected yet.</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        {webhookStatus && (
                            <div className={`mb-3 p-3 border text-xs font-bold uppercase ${webhookStatus.type === 'success' ? 'bg-green-50 border-green-500 text-green-800' : 'bg-red-50 border-red-500 text-red-800'}`}>
                                {webhookStatus.message}
                            </div>
                        )}

                        <table className="table-wireframe">
                            <thead>
                                <tr>
                                    <th>Page Name</th>
                                    <th>Page ID</th>
                                    <th>Status</th>
                                    <th className="text-right">Webhook</th>
                                </tr>
                            </thead>
                            <tbody className="bg-white">
                                {pages.map((page) => (
                                    <tr key={page.id} className="hover:bg-gray-50">
                                        <td className="font-bold">{page.name}</td>
                                        <td className="font-mono text-xs text-gray-500">{page.fb_page_id}</td>
                                        <td>
                                            <span className="badge-wireframe bg-black text-white border-black">
                                                <CheckCircle className="w-3 h-3 mr-1" />
                                                Connected
                                            </span>
                                        </td>
                                        <td className="text-right">
                                            <button
                                                onClick={() => handleResubscribeWebhook(page)}
                                                disabled={webhookActionPageId === page.id}
                                                className="btn-ghost-wireframe text-xs h-8"
                                            >
                                                <RefreshCw className="w-3 h-3 mr-1" />
                                                {webhookActionPageId === page.id ? 'Refreshing...' : 'Refresh Webhook'}
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Webhook Info */}
            <div className="wireframe-card">
                <div className="flex items-center gap-4 border-b-2 border-black pb-4 mb-4">
                    <Shield className="w-5 h-5" />
                    <h2 className="text-xl font-bold uppercase">System Configuration</h2>
                </div>

                <div className="mb-4">
                    <p className="font-mono text-xs text-gray-500 mb-2 uppercase">Webhook Callback URL</p>
                    <div className="border border-black bg-gray-50 p-3 font-mono text-sm break-all">
                        {origin}/api/facebook/webhook
                    </div>
                </div>
                <div>
                    <label className="font-mono text-xs text-gray-500 mb-2 uppercase block">Required Events</label>
                    <div className="flex gap-2">
                        <span className="badge-wireframe bg-white">messages</span>
                        <span className="badge-wireframe bg-white">messaging_postbacks</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
