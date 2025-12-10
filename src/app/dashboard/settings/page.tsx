'use client';

import { useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';
import { Page } from '@/types';
import { User, Shield, Link as LinkIcon, CheckCircle } from 'lucide-react';
import Link from 'next/link';

export default function SettingsPage() {
    const { data: session } = useSession();
    const [pages, setPages] = useState<Page[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchPages();
    }, []);

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
                        <table className="table-wireframe">
                            <thead>
                                <tr>
                                    <th>Page Name</th>
                                    <th>Page ID</th>
                                    <th>Status</th>
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
                        {typeof window !== 'undefined' ? window.location.origin : ''}/api/facebook/webhook
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
