'use client';

import { useSession, signIn } from 'next-auth/react';
import React, { useCallback, useEffect, useState } from 'react';
import { FacebookPageSummary, Page } from '@/types';
import { Check, Facebook, RefreshCw, AlertCircle } from 'lucide-react';
import { runContactSyncToCompletion } from '@/lib/contact-sync-client';
import { FACEBOOK_PERMISSION_SCOPE } from '@/lib/facebook-permissions';
import { facebookSignInCallback } from '@/lib/facebook-signin';
import { getFacebookConnectErrorMessage, isFacebookReauthMessage } from '@/lib/facebook-errors';
import { hasFacebookManagementTask, hasFacebookMessagingTask } from '@/lib/facebook-page-capabilities';

export default function ConnectPage() {
    const { data: session } = useSession();
    const [facebookPages, setFacebookPages] = useState<FacebookPageSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [connecting, setConnecting] = useState<string | null>(null);
    const [connectedPages, setConnectedPages] = useState<Set<string>>(new Set());
    const [assignedPages, setAssignedPages] = useState<Page[]>([]);
    const [assignedLoading, setAssignedLoading] = useState(true);
    const [assignedError, setAssignedError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [requiresReauth, setRequiresReauth] = useState(false);
    const [success, setSuccess] = useState<string | null>(null);
    const [autoTagDuringSync, setAutoTagDuringSync] = useState(true);

    const userId = session?.user?.id;
    const provider = session?.user?.provider;
    const hasFacebookSession = provider === 'facebook';
    const fetchFacebookPages = useCallback(async () => {
        if (!userId || provider !== 'facebook') {
            setFacebookPages([]);
            setLoading(false);
            return;
        }

        setLoading(true);
        try {
            const res = await fetch('/api/facebook/pages');
            const data = await res.json();

            if (data.error) {
                const message = getFacebookConnectErrorMessage(data.message || data.error);
                setError(message);
                setRequiresReauth(Boolean(data.requiresReauth) || isFacebookReauthMessage(data.message || data.error || ''));
            } else {
                setFacebookPages(data.pages || []);
                setRequiresReauth(false);
            }
        } catch (error) {
            console.error('Error fetching Facebook pages:', error);
            setError('Failed to load Facebook pages');
            setRequiresReauth(false);
        } finally {
            setLoading(false);
        }
    }, [userId, provider]);

    const fetchConnectedPages = useCallback(async () => {
        if (!userId) { setAssignedLoading(false); return; }
        setAssignedLoading(true);
        setAssignedError(null);
        try {
            const res = await fetch('/api/pages');
            const data = await res.json();
            if (!res.ok) throw new Error(data.message || 'Could not load your assigned Pages.');
            setAssignedError(data.facebookDiscovery?.message || null);
            setAssignedPages(data.pages || []);
            const fbPageIds = new Set((data.pages || []).map((page: Page) => page.fb_page_id));
            setConnectedPages(fbPageIds as Set<string>);
        } catch (error) {
            console.error('Error fetching connected pages:', error);
            setAssignedError((error as Error).message);
        } finally {
            setAssignedLoading(false);
        }
    }, [userId]);

    useEffect(() => {
        setAssignedPages([]);
        setConnectedPages(new Set());
        setError(null);
        void Promise.all([fetchFacebookPages(), fetchConnectedPages()]);
    }, [fetchFacebookPages, fetchConnectedPages]);

    const handleConnect = async (page: FacebookPageSummary, refreshConnection = false) => {
        setConnecting(page.id);
        setError(null);
        setSuccess(null);

        try {
            const res = await fetch('/api/facebook/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fbPageId: page.id,
                    refreshConnection
                })
            });

            const data = await res.json();

            if (data.success) {
                setConnectedPages(prev => new Set([...prev, page.id]));
                const connectedMessage = data.warning?.message || data.message || `Successfully connected "${page.name}".`;
                await fetchConnectedPages();
                if (data.needsInitialSync === false) {
                    setSuccess(`${connectedMessage} Existing Page contacts and tags are ready in Contacts. No new import needed.`);
                    return;
                }
                setSuccess(`${connectedMessage} Syncing contacts...`);

                try {
                    const syncResult = await runContactSyncToCompletion(data.pageId, {
                        autoTag: autoTagDuringSync,
                        onProgress: ({ attempt, remainingPsids, cursor }) => {
                            if (remainingPsids.length > 0) {
                                setSuccess(`Successfully connected "${page.name}". Syncing contacts... continuing ${remainingPsids.length} remaining contacts (slice ${attempt + 1}).`);
                            } else if (cursor) {
                                setSuccess(`Successfully connected "${page.name}". Syncing contacts... continuing with the next Facebook page (slice ${attempt + 1}).`);
                            }
                        }
                    });

                    if (!syncResult.completed) {
                        throw new Error('Initial contact sync stopped before Facebook returned the final contacts page');
                    }

                    setSuccess(
                        `${connectedMessage} Synced ${syncResult.totalSynced} contacts${syncResult.totalFailed > 0 ? ` (${syncResult.totalFailed} failed)` : ''}.`
                    );
                } catch (syncError) {
                    console.error('Error running initial contact sync:', syncError);
                    setSuccess(`${connectedMessage} Initial contact sync can be retried from Contacts.`);
                }
            } else {
                setError(getFacebookConnectErrorMessage(data.message || data.error));
                setRequiresReauth(Boolean(data.requiresReauth) || isFacebookReauthMessage(data.message || data.error || ''));
            }
        } catch (error) {
            console.error('Error connecting page:', error);
            setError('Failed to connect page');
        } finally {
            setConnecting(null);
        }
    };

    const handleFacebookLogin = () => {
        setLoading(true);
        setError(null);
        setRequiresReauth(false);
        signIn(
            'facebook',
            { callbackUrl: facebookSignInCallback('/dashboard/connect') },
            {
                auth_type: 'rerequest',
                scope: FACEBOOK_PERMISSION_SCOPE
            }
        );
    };

    if (!userId) {
        return (
            <div className="max-w-[600px] mx-auto p-8 mt-12">
                <div className="wireframe-card text-center py-12">
                    <Facebook className="w-16 h-16 mx-auto mb-6 text-blue-600" />
                    <h1 className="text-2xl font-black uppercase mb-2">
                        Connect Facebook
                    </h1>
                    <p className="font-mono text-sm text-gray-500 mb-8 max-w-sm mx-auto">
                        Sign in to Tokko to open the Pages assigned to your account.
                    </p>
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
                        Open assigned Pages or connect a new Facebook Page
                    </p>
                </div>

                {hasFacebookSession && <button
                    onClick={handleFacebookLogin}
                    className="btn-wireframe text-xs bg-white h-9"
                >
                    <RefreshCw className="w-3 h-3 mr-2" />
                    Refresh Permissions
                </button>}
            </div>

            <section className="border border-black mb-6" aria-label="Your assigned Pages">
                <div className="p-4 border-b border-black">
                    <h2 className="font-bold">{hasFacebookSession ? 'Your Facebook Pages' : 'Your assigned Pages'}</h2>
                    <p className="text-sm text-gray-600 mt-1">{hasFacebookSession
                        ? 'Pages you manage on Facebook can reuse an existing Tokko connection and its shared contacts. Connect a new Page below when needed.'
                        : 'Tokko invitations give access to the existing contacts and tags. You do not need to connect Facebook again.'}</p>
                </div>
                {assignedLoading ? <p className="p-4 text-sm">Loading assigned Pages...</p>
                    : assignedError ? <p role="alert" className="p-4 text-sm text-red-700">{assignedError}</p>
                    : !assignedPages.length ? <p className="p-4 text-sm text-gray-600">{hasFacebookSession
                        ? 'Facebook sign-in does not require a Tokko email invitation. Select a Page you manage below. If it is missing, refresh Facebook permissions and select that Page.'
                        : 'No Pages are assigned to this account yet. Ask your Tokko administrator to assign the Page in Team Access. Use the same account that was invited.'}</p>
                    : assignedPages.map(page => {
                        const facebookPage = facebookPages.find(candidate => candidate.id === page.fb_page_id);
                        return <div key={page.id} className="flex flex-wrap items-center justify-between gap-3 p-4 border-b last:border-0">
                            <div><p className="font-bold text-sm">{page.name}</p>
                                {page.requiresReconnect && <p className="text-xs text-amber-800 mt-1">The shared Facebook connection needs its Page administrator to reconnect. Stored contacts and tags remain available.</p>}
                            </div>
                            <div className="flex gap-2">
                                <a href={`/dashboard/contacts?pageId=${encodeURIComponent(page.id)}`} className="btn-wireframe text-xs">Open contacts</a>
                                {facebookPage && hasFacebookManagementTask(facebookPage) && <button
                                    onClick={() => void handleConnect(facebookPage, true)} disabled={connecting === facebookPage.id}
                                    className="btn-wireframe text-xs bg-white">{connecting === facebookPage.id ? 'Reconnecting...' : 'Reconnect'}</button>}
                            </div>
                        </div>;
                    })}
            </section>

            {/* Messages */}
            {error && (
                <div className="mb-6 p-4 border border-black bg-red-50 flex flex-col md:flex-row md:items-center gap-3">
                    <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                    <span className="text-sm font-bold text-red-800 uppercase flex-1">{error}</span>
                    {requiresReauth && (
                        <button
                            onClick={handleFacebookLogin}
                            className="btn-wireframe text-xs bg-white h-9 shrink-0"
                        >
                            <RefreshCw className="w-3 h-3 mr-2" />
                            Refresh Permissions
                        </button>
                    )}
                </div>
            )}

            {success && (
                <div className="mb-6 p-4 border border-black bg-green-50 flex items-start gap-3">
                    <Check className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
                    <span className="text-sm font-bold text-green-800 uppercase">{success}</span>
                </div>
            )}

            {hasFacebookSession && <>
            <label className="flex items-center gap-2 text-sm mb-4">
                <input type="checkbox" checked={autoTagDuringSync} disabled={connecting !== null}
                    onChange={event => setAutoTagDuringSync(event.target.checked)} />
                Auto-tag during the first import. Existing Page contacts are shared with all assigned members.
            </label>
            {/* Content */}
            {loading ? (
                <div className="flex justify-center py-20 wireframe-card">
                    <div className="animate-spin w-8 h-8 border-2 border-black border-t-transparent rounded-full" />
                </div>
            ) : facebookPages.length === 0 ? (
                <div className="wireframe-card text-center py-12">
                    <p className="text-lg font-bold uppercase mb-2">No Facebook Pages found</p>
                    <p className="font-mono text-sm text-gray-500 mb-4">
                        If you were invited to a Facebook Page, accept that invitation and refresh permissions to select it.
                        A Facebook app tester invitation does not grant Page access. Tokko team members can open their assigned Pages above.
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
                                                <span className="text-xs text-gray-600">Use your assigned Page above</span>
                                            ) : (
                                                <button
                                                    onClick={() => handleConnect(page)}
                                                    disabled={isConnecting || !hasFacebookManagementTask(page)}
                                                    className="btn-wireframe text-xs py-1.5 h-8 bg-black text-white hover:bg-gray-800"
                                                >
                                                    {isConnecting ? (
                                                        <span className="animate-pulse">Connecting...</span>
                                                    ) : (
                                                        hasFacebookManagementTask(page) ? 'Connect' : hasFacebookMessagingTask(page) ? 'Ask your Tokko admin to assign this Page' : 'Page management access required'
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
            </>}
        </div>
    );
}
