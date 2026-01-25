'use client';

import { useSession, signOut } from 'next-auth/react';
import { useRouter, usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
    LayoutDashboard,
    Users,
    Tag,
    MessageSquare,
    Settings,
    LogOut,
    ChevronDown,
    Plus,
    MessageCircle,
    User
} from 'lucide-react';
import { Page } from '@/types';

export default function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { data: session, status } = useSession();
    const router = useRouter();
    const pathname = usePathname();
    const [pages, setPages] = useState<Page[]>([]);
    const [selectedPage, setSelectedPage] = useState<Page | null>(null);
    const [showPageDropdown, setShowPageDropdown] = useState(false);

    useEffect(() => {
        // Only redirect if we're sure the user is unauthenticated (not loading)
        if (status === 'unauthenticated') {
            router.push('/');
        }
    }, [status, router]);

    useEffect(() => {
        // Fetch pages when session is available
        if (status === 'authenticated' && session) {
            fetchPages();
        }
    }, [status, session]);

    const fetchPages = async () => {
        try {
            const res = await fetch('/api/pages');
            const data = await res.json();
            setPages(data.pages || []);
            if (data.pages?.length > 0 && !selectedPage) {
                setSelectedPage(data.pages[0]);
            }
        } catch (error) {
            console.error('Error fetching pages:', error);
        }
    };

    // Show loading state while checking session
    if (status === 'loading') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[#0a0a0f]">
                <div className="spinner w-8 h-8"></div>
            </div>
        );
    }

    // Only show content if authenticated, otherwise redirect will happen
    if (status !== 'authenticated' || !session) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[#0a0a0f]">
                <div className="text-center">
                    <div className="spinner w-8 h-8 mx-auto mb-4"></div>
                    <p className="text-gray-400">Redirecting...</p>
                </div>
            </div>
        );
    }

    const navItems = [
        { href: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
        { href: '/dashboard/contacts', icon: Users, label: 'Contacts' },
        { href: '/dashboard/tags', icon: Tag, label: 'Tags' },
        { href: '/dashboard/campaigns', icon: MessageSquare, label: 'Campaigns' },
        { href: '/dashboard/settings', icon: Settings, label: 'Settings' },
    ];

    // Add admin nav item if user is admin
    // const isAdmin = (session?.user as any)?.role === 'admin';
    // if (isAdmin) {
    //     navItems.push({ href: '/admin/users', icon: Settings, label: 'User Admin' });
    // }

    return (
        <div className="min-h-screen bg-white flex flex-col md:flex-row" style={{ borderTop: '1px solid #000', borderLeft: '1px solid #000' }}>
            {/* Sidebar - Excel style */}
            <aside className="w-full md:w-64 bg-[#f0f0f0] border-b md:border-b-0 md:border-r border-black flex flex-col" style={{ borderRight: '2px solid #000' }}>
                {/* Logo Section */}
                <div className="px-4 md:px-6 py-4 md:py-5 border-b border-black excel-header">
                    <Link href="/dashboard" className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-white border border-black flex items-center justify-center flex-shrink-0">
                            <MessageCircle className="w-5 h-5 text-black" />
                        </div>
                        <span className="text-lg md:text-xl font-bold text-black">Tokko</span>
                    </Link>
                </div>

                {/* Page Selector Section */}
                <div className="px-4 md:px-6 py-3 md:py-4 border-b border-black">
                    <div className="relative">
                        <button
                            onClick={() => setShowPageDropdown(!showPageDropdown)}
                            className="w-full flex items-center justify-between px-3 py-2 bg-white border border-black text-left hover:bg-[#f5f5f5]"
                            style={{ fontSize: '0.875rem' }}
                        >
                            <span className="text-sm font-medium text-black truncate">
                                {selectedPage?.name || 'Select Page'}
                            </span>
                            <ChevronDown className={`w-4 h-4 text-black transition-transform flex-shrink-0 ${showPageDropdown ? 'rotate-180' : ''}`} />
                        </button>

                        {showPageDropdown && (
                            <div className="absolute top-full left-0 right-0 mt-1 bg-white border-2 border-black z-50 overflow-hidden">
                                {pages.length > 0 ? (
                                    pages.map((page) => (
                                        <button
                                            key={page.id}
                                            onClick={() => {
                                                setSelectedPage(page);
                                                setShowPageDropdown(false);
                                            }}
                                            className={`w-full px-3 py-2 text-left text-sm hover:bg-[#f0f0f0] border-b border-black last:border-b-0 ${selectedPage?.id === page.id ? 'bg-[#f0f0f0] font-semibold' : 'text-black'
                                                }`}
                                        >
                                            {page.name}
                                        </button>
                                    ))
                                ) : (
                                    <div className="px-3 py-2 text-sm text-black">
                                        No pages connected
                                    </div>
                                )}
                                <Link
                                    href="/dashboard/connect"
                                    className="flex items-center gap-2 px-3 py-2 text-sm text-black hover:bg-[#f0f0f0] border-t-2 border-black"
                                    onClick={() => setShowPageDropdown(false)}
                                >
                                    <Plus className="w-4 h-4" />
                                    Connect New Page
                                </Link>
                            </div>
                        )}
                    </div>
                </div>

                {/* Navigation Section */}
                <nav className="flex-1 px-2 md:px-4 py-3 md:py-4 space-y-0 overflow-y-auto md:overflow-y-auto overflow-x-auto md:overflow-x-hidden flex md:flex-col flex-row md:space-y-0 md:space-x-0 space-x-0">
                    {navItems.map((item) => {
                        const isActive = pathname === item.href;
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                className={`flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2 md:py-2.5 border-b border-black last:border-b-0 flex-shrink-0 ${isActive
                                    ? 'bg-[#f0f0f0] text-black font-semibold border-l-4 border-l-black'
                                    : 'text-black hover:bg-[#f5f5f5]'
                                    }`}
                                style={{ fontSize: '0.875rem' }}
                            >
                                <item.icon className="w-4 h-4 md:w-5 md:h-5 flex-shrink-0" />
                                <span className="font-medium text-xs md:text-sm whitespace-nowrap">{item.label}</span>
                            </Link>
                        );
                    })}
                </nav>

                {/* User Profile Section */}
                <div className="px-4 py-3 md:py-4 border-t-2 border-black">
                    {/* User Info */}
                    <div className="flex items-center gap-2 md:gap-3 mb-3 md:mb-4 px-2">
                        {session.user?.image ? (
                            <div className="relative">
                                <img
                                    src={session.user.image}
                                    alt={session.user.name || 'User'}
                                    className="w-10 h-10 md:w-12 md:h-12 flex-shrink-0 object-cover border border-black"
                                    style={{ borderRadius: 0 }}
                                />
                            </div>
                        ) : (
                            <div className="relative">
                                <div className="w-10 h-10 md:w-12 md:h-12 flex-shrink-0 bg-white border border-black flex items-center justify-center">
                                    <User className="w-5 h-5 md:w-6 md:h-6 text-black" />
                                </div>
                            </div>
                        )}
                        <div className="flex-1 min-w-0 hidden md:block">
                            <p className="text-sm font-semibold text-black truncate">
                                {session.user?.name || 'User'}
                            </p>
                            <p className="text-xs text-gray-600 truncate mt-0.5">
                                {session.user?.email || ''}
                            </p>
                        </div>
                    </div>

                    {/* Sign Out Button */}
                    <button
                        onClick={() => signOut({ callbackUrl: '/' })}
                        className="w-full flex items-center justify-center gap-2 px-3 md:px-4 py-2 md:py-2.5 text-black hover:bg-[#f0f0f0] border border-black text-xs md:text-sm font-medium"
                    >
                        <LogOut className="w-4 h-4" />
                        <span className="hidden md:inline">Sign Out</span>
                    </button>
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex-1 overflow-auto bg-white">
                <div className="p-4 md:p-6 lg:p-8">
                    {children}
                </div>
            </main>
        </div>
    );
}
