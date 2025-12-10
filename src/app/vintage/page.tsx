'use client';

import { useSession, signIn, signOut } from 'next-auth/react';
import { useEffect, useState, useRef } from 'react';
import { FacebookPage } from '@/types';

// Types for local state
interface Contact {
    id: string; // Internal DB ID
    psid: string;
    name: string;
    profile_pic?: string;
    last_interaction_at?: string;
    tags?: any[];
}

export default function VintagePage() {
    const { data: session, status } = useSession();

    // UI State
    const [currentTime, setCurrentTime] = useState<string>('');

    // Data State
    const [facebookPages, setFacebookPages] = useState<FacebookPage[]>([]);
    const [connectedPageIds, setConnectedPageIds] = useState<Set<string>>(new Set());
    const [selectedPageId, setSelectedPageId] = useState<string>('');
    const [contacts, setContacts] = useState<Contact[]>([]);

    // Selection & Action State
    const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set());
    const [statusMessage, setStatusMessage] = useState<string>('Ready.');
    const [isLoading, setIsLoading] = useState<boolean>(false);

    // Message State
    const [messageText, setMessageText] = useState<string>('');

    // Sending State
    const [isSending, setIsSending] = useState<boolean>(false);
    const [sentCount, setSentCount] = useState<number>(0);
    const stopSignal = useRef<boolean>(false);

    // Clock effect
    useEffect(() => {
        const timer = setInterval(() => {
            const now = new Date();
            setCurrentTime(now.toLocaleTimeString());
        }, 1000);
        return () => clearInterval(timer);
    }, []);

    // Initial Data Fetch
    useEffect(() => {
        if (status === 'loading') {
            setStatusMessage('Authenticating...');
            return;
        }

        if (status === 'unauthenticated') {
            setStatusMessage('Please log in.');
            return;
        }

        if (session && (session as any).accessToken) {
            setStatusMessage('Authenticated. Fetching data...');
            fetchPages();
            fetchConnectedStatus();
        } else {
            setStatusMessage('Session valid but no access token.');
        }
    }, [session, status]);

    // Fetch available Facebook Pages from Graph API
    const fetchPages = async () => {
        setIsLoading(true);
        setStatusMessage('Fetching Facebook Pages...');
        try {
            // 15s Timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const res = await fetch('/api/facebook/pages', { signal: controller.signal });
            clearTimeout(timeoutId);
            const data = await res.json();
            if (data.pages) {
                setFacebookPages(data.pages);
                setStatusMessage(`Found ${data.pages.length} pages.`);
            } else {
                setStatusMessage('No pages found or error occurred.');
            }
        } catch (e: any) {
            console.error('Fetch Pages Error:', e);
            if (e.name === 'AbortError') {
                setStatusMessage('Error: Timeout fetching pages.');
            } else {
                setStatusMessage(`Error fetching pages: ${e.message}`);
            }
        } finally {
            setIsLoading(false);
        }
    };

    // Fetch connected pages from our DB
    const fetchConnectedStatus = async () => {
        try {
            const res = await fetch('/api/pages');
            const data = await res.json();
            // Store FB Page IDs to show connected status
            const ids = new Set(data.pages?.map((p: any) => p.fb_page_id) || []);
            setConnectedPageIds(ids as Set<string>);
        } catch (e) {
            console.error(e);
        }
    };

    const handleLogin = () => {
        signIn('facebook', { callbackUrl: '/vintage' });
    };

    // Connect a selected Page
    const handleConnectPage = async () => {
        if (!selectedPageId) return alert('Please select a page first.');

        const page = facebookPages.find(p => p.id === selectedPageId);
        if (!page) return;

        setStatusMessage(`Connecting to ${page.name}...`);
        setIsLoading(true);

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
                setStatusMessage(`Connected to ${page.name}.`);
                fetchConnectedStatus();
            } else {
                setStatusMessage(`Error: ${data.message}`);
            }
        } catch (e) {
            setStatusMessage('Connection failed.');
        } finally {
            setIsLoading(false);
        }
    };

    // Sync Contacts for the selected page
    const handleSyncContacts = async () => {
        if (!selectedPageId) return alert('Please select a page.');

        setStatusMessage('Resolving page details...');
        try {
            const res = await fetch('/api/pages');
            const data = await res.json();
            const dbPage = data.pages?.find((p: any) => p.fb_page_id === selectedPageId);

            if (!dbPage) {
                setStatusMessage('Page must be connected first!');
                return;
            }

            setStatusMessage('Syncing contacts from Facebook... This may take a while.');
            setIsLoading(true);
            const syncRes = await fetch(`/api/pages/${dbPage.id}/sync`, { method: 'POST' });
            const syncData = await syncRes.json();

            if (syncData.success) {
                setStatusMessage(`Sync complete. Synced: ${syncData.synced}, Failed: ${syncData.failed}`);
                fetchContacts(dbPage.id);
            } else {
                setStatusMessage(`Sync failed: ${syncData.message}`);
            }

        } catch (e) {
            setStatusMessage('Sync encountered an error.');
        } finally {
            setIsLoading(false);
        }
    };

    // Fetch contacts from DB (Prompted by user or after sync)
    const handleFetchContactsAction = async () => {
        if (!selectedPageId) return;

        // Find DB ID again
        const res = await fetch('/api/pages');
        const data = await res.json();
        const dbPage = data.pages?.find((p: any) => p.fb_page_id === selectedPageId);

        if (dbPage) {
            fetchContacts(dbPage.id);
        } else {
            setStatusMessage('Page not connected in database.');
        }
    };

    const fetchContacts = async (dbPageId: string) => {
        setStatusMessage('Loading contacts...');
        setIsLoading(true);
        try {
            // Fetch all contacts (loop pages of 100)
            let allContacts: Contact[] = [];
            let pageIdx = 1;
            const pageSize = 100;
            let hasMore = true;

            while (hasMore) {
                const res = await fetch(`/api/pages/${dbPageId}/contacts?page=${pageIdx}&pageSize=${pageSize}`);
                const data = await res.json();

                if (data.items && data.items.length > 0) {
                    allContacts = [...allContacts, ...data.items];
                    pageIdx++;
                    // Basic safety limit to prevent extreme load
                    if (pageIdx > 200) hasMore = false;
                    if (data.items.length < pageSize) hasMore = false;
                } else {
                    hasMore = false;
                }
            }

            setContacts(allContacts);
            setStatusMessage(`Loaded ${allContacts.length} contacts.`);
            // Reset selection when loading new contacts
            setSelectedContactIds(new Set());
        } catch (e) {
            setStatusMessage('Failed to load contacts.');
        } finally {
            setIsLoading(false);
        }
    };

    // Disconnect
    const handleDisconnect = async () => {
        if (!confirm('Are you sure you want to disconnect this page?')) return;
        alert('To disconnect, please use the main dashboard settings for safety.');
    };

    // Bulk Delete
    const handleBulkDelete = async () => {
        if (selectedContactIds.size === 0) return alert('No contacts selected.');
        if (!confirm(`Are you sure you want to PERMANENTLY DELETE ${selectedContactIds.size} contacts?`)) return;

        // Find DB Page ID
        const res = await fetch('/api/pages');
        const data = await res.json();
        const dbPage = data.pages?.find((p: any) => p.fb_page_id === selectedPageId);

        if (!dbPage) return alert('Page error.');

        setIsLoading(true);
        setStatusMessage('Deleting contacts...');

        try {
            const deleteRes = await fetch(`/api/pages/${dbPage.id}/contacts/bulk`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contactIds: Array.from(selectedContactIds)
                })
            });

            const result = await deleteRes.json();

            if (result.success) {
                setStatusMessage(`Deleted ${result.deletedCount} contacts.`);
                // Refresh contacts
                fetchContacts(dbPage.id);
            } else {
                setStatusMessage(`Delete failed: ${result.message}`);
            }
        } catch (e) {
            setStatusMessage('Error deleting contacts.');
        } finally {
            setIsLoading(false);
        }
    };

    // Bulk selection
    const handleSelectAll = () => {
        if (selectedContactIds.size === contacts.length && contacts.length > 0) {
            setSelectedContactIds(new Set());
        } else {
            const allIds = new Set(contacts.map(c => c.id));
            setSelectedContactIds(allIds);
        }
    };

    const handleClearSelection = () => {
        setSelectedContactIds(new Set());
    };

    const handleCheckboxChange = (id: string, checked: boolean) => {
        const newSet = new Set(selectedContactIds);
        if (checked) {
            newSet.add(id);
        } else {
            newSet.delete(id);
        }
        setSelectedContactIds(newSet);
    };

    // Sending Logic
    const handleSend = async () => {
        if (selectedContactIds.size === 0) return alert('No contacts selected.');
        if (!messageText.trim()) return alert('Message cannot be empty.');

        // Find DB Page ID
        const res = await fetch('/api/pages');
        const data = await res.json();
        const dbPage = data.pages?.find((p: any) => p.fb_page_id === selectedPageId);

        if (!dbPage) return alert('Page error.');

        setIsSending(true);
        stopSignal.current = false;
        setSentCount(0);
        setStatusMessage('Starting bulk send...');

        const targets = Array.from(selectedContactIds);
        const BATCH_SIZE = 5;

        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < targets.length; i += BATCH_SIZE) {
            if (stopSignal.current) {
                setStatusMessage('Sending stopped by user.');
                break;
            }

            const batch = targets.slice(i, i + BATCH_SIZE);

            try {
                // Call Send API
                const sendRes = await fetch('/api/facebook/messages/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        pageId: dbPage.id,
                        contactIds: batch,
                        messageText: messageText
                    })
                });

                // Check if response is OK before parsing JSON
                if (!sendRes.ok) {
                    const contentType = sendRes.headers.get('content-type');
                    if (contentType && contentType.includes('application/json')) {
                        const errorData = await sendRes.json();
                        console.error(`Send API error: ${errorData.message || `HTTP ${sendRes.status}`}`);
                    } else {
                        // Response is HTML (error page)
                        const text = await sendRes.text();
                        console.error(`Send API returned HTML error page (${sendRes.status}):`, text.substring(0, 200));
                    }
                    failCount += batch.length;
                } else {
                    const sendResult = await sendRes.json();
                    if (sendResult.success) {
                        successCount += sendResult.results.sent;
                        failCount += sendResult.results.failed;
                    } else {
                        failCount += batch.length;
                    }
                }

                setSentCount(prev => prev + batch.length);
                setStatusMessage(`Sending... (${Math.min(i + BATCH_SIZE + successCount + failCount, targets.length)}/${targets.length})`);
            } catch (e) {
                console.error('Error in send batch:', e);
                failCount += batch.length;
            }

            // Small delay to prevent rate limits
            await new Promise(r => setTimeout(r, 500));
        }

        setIsSending(false);
        if (!stopSignal.current) {
            setStatusMessage(`Done. Sent: ${successCount}, Failed: ${failCount}`);
        }
    };

    const handleStop = () => {
        stopSignal.current = true;
        setStatusMessage('Stopping...');
    };

    const handleMinimze = () => {
        alert('You cannot minimize this window. It is too important.');
    };

    const handleClose = () => {
        if (confirm('Are you sure you want to exit?')) {
            window.location.href = '/dashboard';
        }
    };

    return (
        <div className="vintage-body">
            <div className="vintage-window">
                <div className="vintage-title-bar">
                    <span>Vintage Bulk Messenger - [Logged in as: {session?.user?.name || 'Guest'}]</span>
                    <div className="vintage-title-controls">
                        <button onClick={handleMinimze}>_</button>
                        <button onClick={handleClose}>X</button>
                    </div>
                </div>

                {/* Menu Bar (Visual Only) */}
                <div style={{ padding: '2px 8px', borderBottom: '1px solid #808080', marginBottom: '8px' }}>
                    <span style={{ marginRight: '12px' }}><u>F</u>ile</span>
                    <span style={{ marginRight: '12px' }}><u>E</u>dit</span>
                    <span style={{ marginRight: '12px' }}><u>V</u>iew</span>
                    <span style={{ marginRight: '12px' }}><u>H</u>elp</span>
                </div>

                <div className="vintage-content">
                    {!session ? (
                        <div className="vintage-group" style={{ textAlign: 'center', padding: '40px' }}>
                            <div className="vintage-group-label">Authentication Required</div>
                            <p style={{ marginBottom: '20px' }}>Access to Facebook API is restricted.</p>
                            <button className="vintage-btn vintage-btn-primary" onClick={handleLogin}>
                                Login with Facebook
                            </button>
                        </div>
                    ) : (
                        <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', gap: '10px' }}>
                            {/* Left Panel: Page Selection & Controls */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                {/* Page Selector */}
                                <div className="vintage-group">
                                    <div className="vintage-group-label">1. Select Page</div>
                                    <select
                                        className="vintage-select"
                                        value={selectedPageId}
                                        onChange={(e) => setSelectedPageId(e.target.value)}
                                        size={10}
                                        style={{ height: '150px' }}
                                    >
                                        <option value="" disabled>-- Select a Page --</option>
                                        {facebookPages.map(page => (
                                            <option key={page.id} value={page.id}>
                                                {connectedPageIds.has(page.id) ? '*' : ''} {page.name}
                                            </option>
                                        ))}
                                    </select>
                                    <div style={{ marginTop: '8px', display: 'flex', gap: '4px', flexDirection: 'column' }}>
                                        <button
                                            className="vintage-btn"
                                            onClick={handleConnectPage}
                                            disabled={isLoading || !selectedPageId}
                                        >
                                            Connect Page
                                        </button>
                                        <button
                                            className="vintage-btn"
                                            onClick={handleSyncContacts}
                                            disabled={isLoading || !selectedPageId}
                                        >
                                            Sync Contacts
                                        </button>
                                        <button
                                            className="vintage-btn"
                                            onClick={handleFetchContactsAction}
                                            disabled={isLoading || !selectedPageId}
                                        >
                                            Fetch Stored Contacts
                                        </button>
                                        <button
                                            className="vintage-btn vintage-btn-danger"
                                            onClick={handleDisconnect}
                                            disabled={isLoading || !selectedPageId}
                                        >
                                            Disconnect
                                        </button>
                                    </div>
                                    <div style={{ fontSize: '10px', marginTop: '4px', color: '#666' }}>
                                        * indicates connected
                                    </div>
                                </div>

                                {/* Message Composition */}
                                <div className="vintage-group" style={{ flex: 1 }}>
                                    <div className="vintage-group-label">3. Message</div>
                                    <textarea
                                        className="vintage-textarea"
                                        style={{ height: '100px', resize: 'none' }}
                                        placeholder="Type your message here..."
                                        value={messageText}
                                        onChange={(e) => setMessageText(e.target.value)}
                                        disabled={isSending}
                                    />
                                    <div style={{ marginTop: '8px' }}>
                                        <button className="vintage-btn" style={{ width: '100%', marginBottom: '4px' }}>
                                            Add Attachment...
                                        </button>

                                        {!isSending ? (
                                            <button
                                                className="vintage-btn vintage-btn-primary"
                                                style={{ width: '100%' }}
                                                onClick={handleSend}
                                                disabled={isLoading || selectedContactIds.size === 0}
                                            >
                                                SEND BULK MSG
                                            </button>
                                        ) : (
                                            <button
                                                className="vintage-btn vintage-btn-danger"
                                                style={{ width: '100%' }}
                                                onClick={handleStop}
                                            >
                                                STOP SENDING!
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Right Panel: Contacts Table */}
                            <div className="vintage-group" style={{ display: 'flex', flexDirection: 'column' }}>
                                <div className="vintage-group-label">2. Contacts Target List</div>

                                {/* Filters */}
                                <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center' }}>
                                    <label>Filter:</label>
                                    <input className="vintage-input" style={{ width: '150px' }} placeholder="Name..." />
                                    <div style={{ flex: 1 }}></div>
                                    <button className="vintage-btn" onClick={handleSelectAll}>Select All</button>
                                    <button className="vintage-btn" onClick={handleClearSelection}>Clear</button>
                                    <button className="vintage-btn vintage-btn-danger" onClick={handleBulkDelete}>Delete Selected</button>
                                </div>

                                {/* Table */}
                                <div className="vintage-inset" style={{ flex: 1, overflow: 'hidden', padding: 0 }}>
                                    <div className="vintage-table-container" style={{ height: '100%', marginTop: 0, border: 'none' }}>
                                        <table className="vintage-table">
                                            <thead>
                                                <tr>
                                                    <th style={{ width: '30px' }}>
                                                        <input
                                                            type="checkbox"
                                                            checked={selectedContactIds.size === contacts.length && contacts.length > 0}
                                                            onChange={handleSelectAll}
                                                        />
                                                    </th>
                                                    <th>Name</th>
                                                    <th>PSID</th>
                                                    <th>Last Interaction</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {contacts.length === 0 ? (
                                                    <tr>
                                                        <td colSpan={4} style={{ textAlign: 'center', padding: '20px' }}>
                                                            {selectedPageId ? 'No contacts loaded. Click "Fetch Stored Contacts" or "Sync".' : 'Select a page to view contacts.'}
                                                        </td>
                                                    </tr>
                                                ) : (
                                                    contacts.map(contact => (
                                                        <tr
                                                            key={contact.id}
                                                            className={selectedContactIds.has(contact.id) ? 'selected' : ''}
                                                            onClick={(e) => {
                                                                if ((e.target as HTMLElement).tagName !== 'INPUT') {
                                                                    handleCheckboxChange(contact.id, !selectedContactIds.has(contact.id));
                                                                }
                                                            }}
                                                            style={{ cursor: 'pointer' }}
                                                        >
                                                            <td style={{ textAlign: 'center' }}>
                                                                <input
                                                                    type="checkbox"
                                                                    checked={selectedContactIds.has(contact.id)}
                                                                    onChange={() => handleCheckboxChange(contact.id, !selectedContactIds.has(contact.id))}
                                                                />
                                                            </td>
                                                            <td>{contact.name}</td>
                                                            <td style={{ fontFamily: 'monospace' }}>{contact.psid}</td>
                                                            <td>{new Date(contact.last_interaction_at || '').toLocaleDateString()}</td>
                                                        </tr>
                                                    ))
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>

                                <div style={{ marginTop: '8px', fontSize: '12px' }}>
                                    Selected: {selectedContactIds.size} | Total: {contacts.length}
                                    {isSending && ` | Sent: ${sentCount}`}
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {/* Status Bar */}
                <div className="vintage-status-bar">
                    <span>{statusMessage}</span>
                    <div className="vintage-inset" style={{ width: '100px', textAlign: 'center' }}>
                        {currentTime}
                    </div>
                </div>
            </div>
        </div>
    );
}
