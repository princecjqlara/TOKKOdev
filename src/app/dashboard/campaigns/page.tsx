'use client';

import { useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';
import { Plus, Send, Trash2, Users, Clock, CheckCircle, XCircle, MessageSquare, StopCircle } from 'lucide-react';
import Pagination from '@/components/Pagination';
import Modal from '@/components/Modal';
import { Campaign, Page, Contact, PaginatedResponse } from '@/types';

export default function CampaignsPage() {
    const { data: session } = useSession();
    const [pages, setPages] = useState<Page[]>([]);
    const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [loading, setLoading] = useState(true);

    // Pagination
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(25);
    const [total, setTotal] = useState(0);

    // Modals
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [showDeleteModal, setShowDeleteModal] = useState(false);

    // Form state
    const [campaignName, setCampaignName] = useState('');
    const [messageText, setMessageText] = useState('');
    const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set());
    const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);
    const [actionLoading, setActionLoading] = useState(false);
    const [sendingCampaignId, setSendingCampaignId] = useState<string | null>(null);
    const [cancellingCampaignId, setCancellingCampaignId] = useState<string | null>(null);

    // Loop campaign state
    const [isLoop, setIsLoop] = useState(false);
    const [aiPrompt, setAiPrompt] = useState('');

    // Contacts pagination and filtering for modal
    const [contactsPage, setContactsPage] = useState(1);
    const [contactsTotal, setContactsTotal] = useState(0);
    const [tags, setTags] = useState<{ id: string; name: string; color: string }[]>([]);
    const [selectedTagFilter, setSelectedTagFilter] = useState('');
    const [isSelectAllMode, setIsSelectAllMode] = useState(false);

    useEffect(() => {
        fetchPages();
    }, []);

    useEffect(() => {
        if (selectedPageId) {
            fetchCampaigns();
        }
    }, [selectedPageId, page, pageSize]);

    const fetchPages = async () => {
        try {
            const res = await fetch('/api/pages');
            const data = await res.json();
            setPages(data.pages || []);
            if (data.pages?.length > 0) {
                setSelectedPageId(data.pages[0].id);
            }
        } catch (error) {
            console.error('Error fetching pages:', error);
        }
    };

    const fetchCampaigns = async () => {
        if (!selectedPageId) return;

        setLoading(true);
        try {
            const params = new URLSearchParams({
                page: page.toString(),
                pageSize: pageSize.toString(),
                pageId: selectedPageId
            });

            const res = await fetch(`/api/campaigns?${params}`);
            const data: PaginatedResponse<Campaign> = await res.json();

            setCampaigns(data.items || []);
            setTotal(data.total || 0);
        } catch (error) {
            console.error('Error fetching campaigns:', error);
        } finally {
            setLoading(false);
        }
    };

    const fetchContacts = async (tagFilter?: string) => {
        if (!selectedPageId) return;

        try {
            const params = new URLSearchParams({
                page: contactsPage.toString(),
                pageSize: '50'
            });

            // Add tag filter if specified
            if (tagFilter) {
                params.set('tagId', tagFilter);
            }

            const res = await fetch(`/api/pages/${selectedPageId}/contacts?${params}`);
            const data: PaginatedResponse<Contact> = await res.json();

            setContacts(data.items || []);
            setContactsTotal(data.total || 0);
        } catch (error) {
            console.error('Error fetching contacts:', error);
        }
    };

    const fetchTags = async () => {
        if (!selectedPageId) return;
        try {
            const res = await fetch(`/api/tags?pageId=${selectedPageId}`);
            const data = await res.json();
            setTags(data.tags || []);
        } catch (error) {
            console.error('Error fetching tags:', error);
        }
    };

    const handleOpenCreateModal = async () => {
        setCampaignName('');
        setMessageText('');
        setSelectedContactIds(new Set());
        setContactsPage(1);
        setIsLoop(false);
        setAiPrompt('');
        setSelectedTagFilter('');
        setIsSelectAllMode(false);
        await Promise.all([fetchContacts(), fetchTags()]);
        setShowCreateModal(true);
    };

    const handleCreate = async () => {
        // For loop campaigns, need aiPrompt; for regular campaigns, need messageText
        const hasRecipients = isSelectAllMode ? contactsTotal > 0 : selectedContactIds.size > 0;
        if (!campaignName.trim() || !hasRecipients) return;
        if (isLoop && !aiPrompt.trim()) return;
        if (!isLoop && !messageText.trim()) return;

        setActionLoading(true);
        try {
            // If selectAll mode, fetch all contact IDs
            let contactIds = Array.from(selectedContactIds);

            if (isSelectAllMode) {
                // Fetch all contact IDs with the current filter
                const params = new URLSearchParams({
                    page: '1',
                    pageSize: contactsTotal.toString()
                });
                if (selectedTagFilter) {
                    params.set('tagId', selectedTagFilter);
                }
                const res = await fetch(`/api/pages/${selectedPageId}/contacts?${params}`);
                const data: PaginatedResponse<Contact> = await res.json();
                contactIds = data.items.map(c => c.id);
            }

            await fetch('/api/campaigns', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pageId: selectedPageId,
                    name: campaignName.trim(),
                    messageText: isLoop ? null : messageText.trim(),
                    contactIds,
                    isLoop,
                    aiPrompt: isLoop ? aiPrompt.trim() : null
                })
            });

            setShowCreateModal(false);
            await fetchCampaigns();
        } catch (error) {
            console.error('Error creating campaign:', error);
        } finally {
            setActionLoading(false);
        }
    };

    const handleSend = async (campaignId: string) => {
        setSendingCampaignId(campaignId);
        try {
            await fetch(`/api/campaigns/${campaignId}/send`, {
                method: 'POST'
            });
            await fetchCampaigns();
        } catch (error) {
            console.error('Error sending campaign:', error);
        } finally {
            setSendingCampaignId(null);
        }
    };

    const handleCancel = async (campaignId: string) => {
        setCancellingCampaignId(campaignId);
        try {
            await fetch(`/api/campaigns/${campaignId}/cancel`, {
                method: 'POST'
            });
            await fetchCampaigns();
        } catch (error) {
            console.error('Error cancelling campaign:', error);
        } finally {
            setCancellingCampaignId(null);
        }
    };

    const handleDelete = async () => {
        if (!editingCampaign) return;

        setActionLoading(true);
        try {
            await fetch(`/api/campaigns?id=${editingCampaign.id}`, {
                method: 'DELETE'
            });

            setShowDeleteModal(false);
            setEditingCampaign(null);
            await fetchCampaigns();
        } catch (error) {
            console.error('Error deleting campaign:', error);
        } finally {
            setActionLoading(false);
        }
    };

    const toggleContactSelection = (contactId: string) => {
        const newSelected = new Set(selectedContactIds);
        if (newSelected.has(contactId)) {
            newSelected.delete(contactId);
        } else {
            newSelected.add(contactId);
        }
        setSelectedContactIds(newSelected);
    };

    const selectAllContacts = () => {
        if (contacts.every(c => selectedContactIds.has(c.id))) {
            const newSelected = new Set(selectedContactIds);
            contacts.forEach(c => newSelected.delete(c.id));
            setSelectedContactIds(newSelected);
        } else {
            const newSelected = new Set(selectedContactIds);
            contacts.forEach(c => newSelected.add(c.id));
            setSelectedContactIds(newSelected);
        }
    };

    const getStatusBadge = (status: string) => {
        let classes = "badge-wireframe ";
        switch (status) {
            case 'draft':
                return <span className={classes + "bg-gray-200 text-black border-gray-400"}>DRAFT</span>;
            case 'sending':
                return <span className={classes + "bg-yellow-100 text-yellow-800 border-yellow-800 animate-pulse"}>SENDING</span>;
            case 'completed':
                return <span className={classes + "bg-black text-white border-black"}>COMPLETED</span>;
            case 'cancelled':
                return <span className={classes + "bg-red-50 text-red-600 border-red-600"}>CANCELLED</span>;
            case 'scheduled':
                return <span className={classes + "bg-blue-100 text-blue-800 border-blue-800"}>SCHEDULED</span>;
            default:
                return <span className={classes}>{status}</span>;
        }
    };

    // Get loop status badge
    const getLoopBadge = (campaign: Campaign) => {
        // @ts-expect-error - is_loop field added by migration
        if (!campaign.is_loop) return null;
        // @ts-expect-error - loop_status field added by migration
        const loopStatus = campaign.loop_status;
        const classes = "badge-wireframe text-xs ";
        switch (loopStatus) {
            case 'active':
                return <span className={classes + "bg-green-100 text-green-800 border-green-800"}>🔄 LOOP ACTIVE</span>;
            case 'paused':
                return <span className={classes + "bg-orange-100 text-orange-800 border-orange-800"}>⏸️ LOOP PAUSED</span>;
            default:
                return <span className={classes + "bg-gray-100 text-gray-600 border-gray-600"}>LOOP STOPPED</span>;
        }
    };

    return (
        <div className="p-6 md:p-8 max-w-[1400px] mx-auto fade-in">
            {/* Header */}
            <div className="flex flex-col md:flex-row items-center justify-between mb-8 gap-4">
                <div>
                    <h1 className="text-3xl font-black uppercase mb-2">Campaigns</h1>
                    <p className="font-mono text-sm text-gray-500 uppercase tracking-wide">
                        Bulk messaging and promotion management
                    </p>
                </div>

                <div className="flex items-center gap-3 w-full md:w-auto">
                    <div className="relative flex-1 md:w-64">
                        <select
                            value={selectedPageId || ''}
                            onChange={(e) => {
                                setSelectedPageId(e.target.value);
                                setPage(1);
                            }}
                            className="input-wireframe h-10 w-full"
                        >
                            {pages.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.name}
                                </option>
                            ))}
                        </select>
                    </div>

                    <button
                        onClick={handleOpenCreateModal}
                        className="btn-wireframe"
                    >
                        <Plus className="w-4 h-4 mr-2" />
                        Create
                    </button>
                </div>
            </div>

            {/* Campaigns List */}
            {loading ? (
                <div className="flex items-center justify-center h-64 border border-black wireframe-card">
                    <div className="animate-spin w-8 h-8 border-2 border-black border-t-transparent rounded-full" />
                </div>
            ) : campaigns.length === 0 ? (
                <div className="wireframe-card text-center py-20">
                    <MessageSquare className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                    <h3 className="text-xl font-bold uppercase mb-2">No campaigns yet</h3>
                    <p className="font-mono text-sm text-gray-500 mb-6">
                        Create your first campaign to start messaging your audience.
                    </p>
                    <button
                        onClick={handleOpenCreateModal}
                        className="btn-wireframe"
                    >
                        <Plus className="w-4 h-4 mr-2" />
                        New Campaign
                    </button>
                </div>
            ) : (
                <>
                    <div className="grid gap-4">
                        {campaigns.map((campaign) => (
                            <div key={campaign.id} className="wireframe-card flex flex-col md:flex-row items-start justify-between gap-6 hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] transition-shadow">
                                <div className="flex-1 space-y-3">
                                    <div className="flex items-center gap-3 flex-wrap">
                                        <h3 className="text-xl font-black uppercase tracking-tight">{campaign.name}</h3>
                                        {getStatusBadge(campaign.status)}
                                        {getLoopBadge(campaign)}
                                    </div>
                                    <p className="text-sm font-mono text-gray-600 line-clamp-2 border-l-2 border-gray-200 pl-3">
                                        {/* @ts-expect-error - is_loop/ai_prompt fields added by migration */}
                                        {campaign.is_loop ? `🤖 AI Prompt: "${campaign.ai_prompt}"` : `"${campaign.message_text}"`}
                                    </p>
                                    <div className="flex flex-wrap items-center gap-6 text-sm font-bold uppercase tracking-wider text-gray-500">
                                        <span className="flex items-center gap-1">
                                            <Users className="w-4 h-4" />
                                            {campaign.total_recipients} Recip.
                                        </span>
                                        {campaign.status !== 'draft' && (
                                            <span className="flex items-center gap-1 text-black">
                                                <CheckCircle className="w-4 h-4" />
                                                {campaign.sent_count} Sent
                                            </span>
                                        )}
                                        <span className="flex items-center gap-1">
                                            <Clock className="w-4 h-4" />
                                            {new Date(campaign.created_at).toLocaleDateString()}
                                        </span>
                                    </div>
                                </div>

                                <div className="flex items-center gap-2 w-full md:w-auto mt-2 md:mt-0">
                                    {campaign.status === 'draft' && (
                                        <button
                                            onClick={() => handleSend(campaign.id)}
                                            disabled={sendingCampaignId === campaign.id}
                                            className="btn-wireframe bg-black text-white hover:bg-gray-800 flex-1 md:flex-none"
                                        >
                                            {sendingCampaignId === campaign.id ? (
                                                'Sending...'
                                            ) : (
                                                <>
                                                    <Send className="w-4 h-4 mr-2" />
                                                    Send Now
                                                </>
                                            )}
                                        </button>
                                    )}
                                    {campaign.status === 'sending' && (
                                        <button
                                            onClick={() => handleCancel(campaign.id)}
                                            disabled={cancellingCampaignId === campaign.id}
                                            className="btn-wireframe bg-amber-400 border-amber-500 hover:bg-amber-500 flex-1 md:flex-none"
                                        >
                                            {cancellingCampaignId === campaign.id ? (
                                                'Stopping...'
                                            ) : (
                                                <>
                                                    <StopCircle className="w-4 h-4 mr-2" />
                                                    Cancel
                                                </>
                                            )}
                                        </button>
                                    )}
                                    <button
                                        onClick={() => {
                                            setEditingCampaign(campaign);
                                            setShowDeleteModal(true);
                                        }}
                                        className="btn-wireframe border-red-200 text-red-500 hover:bg-red-50 hover:text-red-600 px-3"
                                        title="Delete Campaign"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="mt-8 border border-black bg-white p-4">
                        <Pagination
                            page={page}
                            pageSize={pageSize}
                            total={total}
                            onPageChange={setPage}
                            onPageSizeChange={(size) => {
                                setPageSize(size);
                                setPage(1);
                            }}
                        />
                    </div>
                </>
            )}

            {/* Create Campaign Modal */}
            <Modal
                isOpen={showCreateModal}
                onClose={() => setShowCreateModal(false)}
                title="Create Campaign"
                size="xl"
            >
                <div className="space-y-6 mb-6">
                    <div>
                        <label className="label-wireframe">Campaign Name</label>
                        <input
                            type="text"
                            value={campaignName}
                            onChange={(e) => setCampaignName(e.target.value)}
                            placeholder="E.G. SUMMER PROMO"
                            className="input-wireframe"
                        />
                    </div>

                    {/* Loop Campaign Toggle */}
                    <div className="border border-gray-200 p-4 bg-gray-50">
                        <label className="flex items-center gap-3 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={isLoop}
                                onChange={(e) => setIsLoop(e.target.checked)}
                                className="w-5 h-5 accent-black"
                            />
                            <div>
                                <span className="font-bold uppercase text-sm">Enable 24/7 Loop Campaign</span>
                                <p className="text-xs text-gray-500 font-mono mt-1">
                                    AI generates personalized messages and sends at each contact&apos;s best time daily
                                </p>
                            </div>
                        </label>
                    </div>

                    {isLoop ? (
                        <div>
                            <label className="label-wireframe">AI Prompt</label>
                            <textarea
                                value={aiPrompt}
                                onChange={(e) => setAiPrompt(e.target.value)}
                                placeholder="E.G. Remind them about our summer sale and ask if they&apos;d like to schedule a viewing..."
                                rows={4}
                                className="input-wireframe resize-none h-auto p-3"
                            />
                            <p className="text-xs text-gray-400 font-mono mt-2">
                                AI will use this prompt to generate unique messages for each contact using their name
                            </p>
                        </div>
                    ) : (
                        <div>
                            <label className="label-wireframe">Message Content</label>
                            <textarea
                                value={messageText}
                                onChange={(e) => setMessageText(e.target.value)}
                                placeholder="TYPE YOUR MESSAGE HERE..."
                                rows={4}
                                className="input-wireframe resize-none h-auto p-3"
                            />
                        </div>
                    )}

                    <div>
                        <div className="flex items-center justify-between mb-3">
                            <label className="label-wireframe mb-0">
                                Select Recipients ({isSelectAllMode ? contactsTotal : selectedContactIds.size})
                            </label>
                            <div className="flex items-center gap-2">
                                {/* Tag Filter */}
                                <select
                                    value={selectedTagFilter}
                                    onChange={(e) => {
                                        setSelectedTagFilter(e.target.value);
                                        setContactsPage(1);
                                        setSelectedContactIds(new Set());
                                        setIsSelectAllMode(false);
                                        fetchContacts(e.target.value);
                                    }}
                                    className="input-wireframe h-8 text-xs w-auto"
                                >
                                    <option value="">ALL TAGS</option>
                                    {tags.map((tag) => (
                                        <option key={tag.id} value={tag.id}>
                                            {tag.name}
                                        </option>
                                    ))}
                                </select>
                                {/* Select All */}
                                <button
                                    onClick={() => {
                                        if (isSelectAllMode) {
                                            setIsSelectAllMode(false);
                                            setSelectedContactIds(new Set());
                                        } else {
                                            setIsSelectAllMode(true);
                                            // Add all currently visible contacts
                                            const allIds = new Set(contacts.map(c => c.id));
                                            setSelectedContactIds(allIds);
                                        }
                                    }}
                                    className="text-xs font-bold uppercase underline hover:text-gray-600 whitespace-nowrap"
                                >
                                    {isSelectAllMode ? `Deselect All (${contactsTotal})` : `Select All (${contactsTotal})`}
                                </button>
                            </div>
                        </div>
                        {isSelectAllMode && (
                            <div className="bg-green-50 border border-green-300 p-2 mb-2 text-xs font-mono text-green-800">
                                ✓ All {contactsTotal} contacts{selectedTagFilter ? ' with this tag' : ''} will be added to the campaign
                            </div>
                        )}
                        <div className="max-h-64 overflow-y-auto border border-black p-2 space-y-1">
                            {contacts.map((contact) => (
                                <button
                                    key={contact.id}
                                    onClick={() => toggleContactSelection(contact.id)}
                                    className={`w-full flex items-center justify-between p-3 border border-transparent hover:bg-gray-50 transition-colors ${selectedContactIds.has(contact.id)
                                        ? 'bg-gray-100 border-black'
                                        : ''
                                        }`}
                                >
                                    <span className="font-bold uppercase text-sm">{contact.name || 'Unknown'}</span>
                                    {selectedContactIds.has(contact.id) && (
                                        <CheckCircle className="w-4 h-4 text-black" />
                                    )}
                                </button>
                            ))}
                        </div>
                        {contactsTotal > 50 && (
                            <div className="mt-2 flex justify-between items-center border-t border-gray-200 pt-2">
                                <span className="text-xs font-mono text-gray-500">
                                    Page {contactsPage} of {Math.ceil(contactsTotal / 50)}
                                </span>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => {
                                            setContactsPage(p => Math.max(1, p - 1));
                                            fetchContacts();
                                        }}
                                        disabled={contactsPage === 1}
                                        className="btn-ghost-wireframe text-xs px-2 py-1 h-auto"
                                    >
                                        Prev
                                    </button>
                                    <button
                                        onClick={() => {
                                            setContactsPage(p => p + 1);
                                            fetchContacts();
                                        }}
                                        disabled={contactsPage >= Math.ceil(contactsTotal / 50)}
                                        className="btn-ghost-wireframe text-xs px-2 py-1 h-auto"
                                    >
                                        Next
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex justify-end gap-3 pt-4 border-t border-black">
                    <button
                        onClick={() => setShowCreateModal(false)}
                        className="btn-wireframe bg-white"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleCreate}
                        disabled={
                            !campaignName.trim() ||
                            selectedContactIds.size === 0 ||
                            actionLoading ||
                            (isLoop ? !aiPrompt.trim() : !messageText.trim())
                        }
                        className="btn-wireframe bg-black text-white hover:bg-gray-800"
                    >
                        {actionLoading ? 'Creating...' : (isLoop ? 'Create Loop Campaign' : 'Create Campaign')}
                    </button>
                </div>
            </Modal>

            {/* Delete Campaign Modal */}
            <Modal
                isOpen={showDeleteModal}
                onClose={() => {
                    setShowDeleteModal(false);
                    setEditingCampaign(null);
                }}
                title="Delete Campaign"
            >
                <p className="text-gray-600 mb-6 font-mono text-sm">
                    Are you sure you want to delete <span className="font-bold text-black">&quot;{editingCampaign?.name}&quot;</span>?
                    This action cannot be undone.
                </p>
                <div className="flex justify-end gap-3 pt-4 border-t border-black">
                    <button
                        onClick={() => {
                            setShowDeleteModal(false);
                            setEditingCampaign(null);
                        }}
                        className="btn-wireframe bg-white"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleDelete}
                        disabled={actionLoading}
                        className="btn-wireframe bg-red-600 text-white border-red-600 hover:bg-red-700"
                    >
                        {actionLoading ? 'Deleting...' : 'Delete'}
                    </button>
                </div>
            </Modal>
        </div>
    );
}
