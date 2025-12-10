'use client';

import { useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';
import { Users, Tag, MessageSquare, RefreshCw, Clock, ArrowUpRight } from 'lucide-react';
import { Page } from '@/types';

interface Stats {
    totalContacts: number;
    totalTags: number;
    totalCampaigns: number;
    recentContacts: number;
}

export default function DashboardPage() {
    const { data: session } = useSession();
    const [pages, setPages] = useState<Page[]>([]);
    const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
    const [stats, setStats] = useState<Stats>({
        totalContacts: 0,
        totalTags: 0,
        totalCampaigns: 0,
        recentContacts: 0
    });
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);

    useEffect(() => {
        void fetchPages();
    }, []);

    useEffect(() => {
        if (selectedPageId) {
            void fetchStats(selectedPageId);
        }
    }, [selectedPageId]);

    const fetchPages = async () => {
        try {
            const res = await fetch('/api/pages');
            const data = await res.json();
            const pageList: Page[] = data.pages || [];
            setPages(pageList);
            if (pageList.length > 0) {
                setSelectedPageId(pageList[0].id);
            }
        } catch (error) {
            console.error('Error fetching pages:', error);
        } finally {
            setLoading(false);
        }
    };

    const fetchStats = async (pageId: string) => {
        try {
            const contactsRes = await fetch(`/api/pages/${pageId}/contacts?pageSize=1`);
            const contactsData = await contactsRes.json();

            const tagsRes = await fetch(`/api/tags?scope=page&pageId=${pageId}&pageSize=1`);
            const tagsData = await tagsRes.json();

            const campaignsRes = await fetch(`/api/campaigns?pageId=${pageId}&pageSize=1`);
            const campaignsData = await campaignsRes.json();

            setStats({
                totalContacts: contactsData.total || 0,
                totalTags: tagsData.total || 0,
                totalCampaigns: campaignsData.total || 0,
                recentContacts: 0
            });
        } catch (error) {
            console.error('Error fetching stats:', error);
        }
    };

    const handleSync = async () => {
        if (!selectedPageId) {
            alert('Please select a page first.');
            return;
        }

        if (syncing) return;

        setSyncing(true);

        try {
            // Check if user wants full sync (hold Shift while clicking)
            const forceFullSync = false; // Can be changed to detect Shift key if needed
            
            const res = await fetch(`/api/pages/${selectedPageId}/sync`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ forceFullSync })
            });

            const resClone = res.clone();
            let rawBody = '';
            let data: any = null;
            try {
                rawBody = await resClone.text();
                data = rawBody ? JSON.parse(rawBody) : null;
            } catch {
                // ignore parse/read errors; rawBody may stay empty
            }

            if (!res.ok) {
                const msg = data?.message || rawBody || `Sync failed with status ${res.status}`;
                throw new Error(msg);
            }

            if (data?.success) {
                if (data.partial) {
                    alert(`Partial sync complete!\n\nSynced: ${data.synced}\nFailed: ${data.failed}\nProcessed: ${data.processed} of ${data.total}\n\n${data.message}\n\nClick "Sync Now" again to continue syncing remaining contacts.`);
                } else {
                    const syncType = data.incremental ? 'Incremental' : 'Full';
                    let message = `${syncType} sync complete!\n\nSynced: ${data.synced}\nFailed: ${data.failed}\nTotal: ${data.total}`;
                    if (data.restored > 0) {
                        message += `\n\n✅ Restored: ${data.restored} previously deleted contacts`;
                    }
                    message += `\n\n${data.incremental ? 'Only new/updated contacts were synced. Use full sync to sync all contacts.' : 'All contacts have been synced.'}`;
                    alert(message);
                }
                await fetchStats(selectedPageId);
            } else {
                throw new Error(data?.message || rawBody || 'Sync failed');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.error('Error syncing contacts:', error);
            alert(`Sync failed: ${message}`);
        } finally {
            setSyncing(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="animate-spin w-8 h-8 border-2 border-black border-t-transparent rounded-full" />
            </div>
        );
    }

    if (pages.length === 0) {
        return (
            <div className="max-w-2xl mx-auto p-8">
                <div className="wireframe-card text-center">
                    <div className="w-20 h-20 border border-black flex items-center justify-center mx-auto mb-6 bg-gray-50">
                        <MessageSquare className="w-10 h-10 text-black" />
                    </div>
                    <h2 className="text-2xl font-bold uppercase mb-3">Welcome to Tokko</h2>
                    <p className="text-gray-600 mb-8 font-mono text-sm max-w-md mx-auto">
                        Connect your first Facebook Page to get started with contact management and messaging.
                    </p>
                    <a href="/dashboard/connect" className="btn-wireframe">
                        Connect Facebook Page
                    </a>
                </div>
            </div>
        );
    }

    const selectedPage = pages.find((page) => page.id === selectedPageId);

    return (
        <div className="p-6 md:p-8 max-w-[1400px] mx-auto fade-in">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12">
                <div>
                    <h1 className="text-4xl md:text-5xl font-black uppercase mb-2">Dashboard</h1>
                    <p className="font-mono text-sm text-gray-500 uppercase tracking-widest">
                        Welcome back, {session?.user?.name?.split(' ')[0] || 'User'}
                    </p>
                </div>

                <div className="flex flex-col sm:flex-row gap-4">
                    <div className="flex flex-col">
                        <label className="text-xs font-bold uppercase mb-1">Select Page</label>
                        <select
                            value={selectedPageId || ''}
                            onChange={(e) => setSelectedPageId(e.target.value)}
                            className="h-10 border border-black px-4 bg-white font-mono text-sm focus:outline-none focus:bg-gray-50 min-w-[200px]"
                        >
                            {pages.length === 0 ? (
                                <option value="">No pages available</option>
                            ) : (
                                pages.map((page) => (
                                    <option key={page.id} value={page.id}>
                                        {page.name}
                                    </option>
                                ))
                            )}
                        </select>
                    </div>

                    <div className="flex flex-col">
                        <label className="text-xs font-bold uppercase mb-1">Actions</label>
                        <button
                            onClick={handleSync}
                            disabled={syncing || !selectedPageId}
                            className="h-10 px-6 border border-black bg-black text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed font-bold uppercase text-sm flex items-center gap-2"
                        >
                            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
                            {syncing ? 'Syncing...' : 'Sync Data'}
                        </button>
                    </div>
                </div>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
                {/* Stat 1 */}
                <div className="wireframe-card group hover:bg-gray-50 transition-colors">
                    <div className="flex justify-between items-start mb-4">
                        <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Total Contacts</span>
                        <Users className="w-5 h-5" />
                    </div>
                    <div className="text-4xl font-black">{stats.totalContacts.toLocaleString()}</div>
                    <div className="mt-4 pt-4 border-t border-gray-100 flex items-center justify-between text-xs">
                        <span className="font-mono text-gray-400">Database</span>
                        <ArrowUpRight className="w-3 h-3 text-gray-400" />
                    </div>
                </div>

                {/* Stat 2 */}
                <div className="wireframe-card group hover:bg-gray-50 transition-colors">
                    <div className="flex justify-between items-start mb-4">
                        <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Active Tags</span>
                        <Tag className="w-5 h-5" />
                    </div>
                    <div className="text-4xl font-black">{stats.totalTags.toLocaleString()}</div>
                    <div className="mt-4 pt-4 border-t border-gray-100 flex items-center justify-between text-xs">
                        <span className="font-mono text-gray-400">Organization</span>
                        <ArrowUpRight className="w-3 h-3 text-gray-400" />
                    </div>
                </div>

                {/* Stat 3 */}
                <div className="wireframe-card group hover:bg-gray-50 transition-colors">
                    <div className="flex justify-between items-start mb-4">
                        <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Campaigns</span>
                        <MessageSquare className="w-5 h-5" />
                    </div>
                    <div className="text-4xl font-black">{stats.totalCampaigns.toLocaleString()}</div>
                    <div className="mt-4 pt-4 border-t border-gray-100 flex items-center justify-between text-xs">
                        <span className="font-mono text-gray-400">Marketing</span>
                        <ArrowUpRight className="w-3 h-3 text-gray-400" />
                    </div>
                </div>

                {/* Stat 4 */}
                <div className="wireframe-card group hover:bg-gray-50 transition-colors">
                    <div className="flex justify-between items-start mb-4">
                        <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Page Status</span>
                        <Clock className="w-5 h-5" />
                    </div>
                    <div className="text-xl font-bold uppercase truncate">{selectedPage ? 'Connected' : 'Offline'}</div>
                    <div className="mt-auto pt-4 border-t border-gray-100 flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${selectedPage ? 'bg-green-500' : 'bg-red-500'}`} />
                            <span className="font-mono text-gray-400">{selectedPage ? 'Live' : 'Error'}</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Quick Actions Table */}
            <div className="mb-8">
                <h3 className="text-xl font-bold uppercase mb-6 flex items-center gap-3">
                    <span className="w-2 h-2 bg-black"></span>
                    Quick Actions
                </h3>
                <div className="border border-black bg-white">
                    <div className="grid grid-cols-12 border-b border-black bg-gray-50 text-xs font-bold uppercase tracking-wider">
                        <div className="col-span-4 p-4 border-r border-black">Module</div>
                        <div className="col-span-6 p-4 border-r border-black">Description</div>
                        <div className="col-span-2 p-4 text-center">Action</div>
                    </div>

                    {/* Row 1 */}
                    <div className="grid grid-cols-12 border-b border-black group hover:bg-gray-50 transition-colors">
                        <div className="col-span-4 p-4 border-r border-black flex items-center gap-3 font-bold">
                            <Users className="w-4 h-4" /> Manage Contacts
                        </div>
                        <div className="col-span-6 p-4 border-r border-black font-mono text-sm text-gray-600 flex items-center">
                            View, filter, and manage your page contacts.
                        </div>
                        <div className="col-span-2 p-4 flex items-center justify-center">
                            <a href="/dashboard/contacts" className="text-xs font-bold uppercase underline hover:no-underline">Open</a>
                        </div>
                    </div>

                    {/* Row 2 */}
                    <div className="grid grid-cols-12 border-b border-black group hover:bg-gray-50 transition-colors">
                        <div className="col-span-4 p-4 border-r border-black flex items-center gap-3 font-bold">
                            <Tag className="w-4 h-4" /> Manage Tags
                        </div>
                        <div className="col-span-6 p-4 border-r border-black font-mono text-sm text-gray-600 flex items-center">
                            Create and organize tags for your contacts.
                        </div>
                        <div className="col-span-2 p-4 flex items-center justify-center">
                            <a href="/dashboard/tags" className="text-xs font-bold uppercase underline hover:no-underline">Open</a>
                        </div>
                    </div>

                    {/* Row 3 */}
                    <div className="grid grid-cols-12 group hover:bg-gray-50 transition-colors">
                        <div className="col-span-4 p-4 border-r border-black flex items-center gap-3 font-bold">
                            <MessageSquare className="w-4 h-4" /> Create Campaign
                        </div>
                        <div className="col-span-6 p-4 border-r border-black font-mono text-sm text-gray-600 flex items-center">
                            Send bulk messages to your audience.
                        </div>
                        <div className="col-span-2 p-4 flex items-center justify-center">
                            <a href="/dashboard/campaigns" className="text-xs font-bold uppercase underline hover:no-underline">Open</a>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
