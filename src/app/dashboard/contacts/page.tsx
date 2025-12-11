'use client';

import { useSession } from 'next-auth/react';
import { useEffect, useState, useCallback } from 'react';
import {
    Search,
    Filter,
    RefreshCw,
    Trash2,
    Tag,
    MessageSquare,
    Check,
    X,
    User,
    CheckSquare
} from 'lucide-react';
import Pagination from '@/components/Pagination';
import Modal from '@/components/Modal';
import { Contact, Tag as TagType, Page, PaginatedResponse } from '@/types';

export default function ContactsPage() {
    const { data: session } = useSession();
    const [pages, setPages] = useState<Page[]>([]);
    const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [tags, setTags] = useState<TagType[]>([]);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);

    // Pagination
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(25);
    const [total, setTotal] = useState(0);

    // Filters
    const [search, setSearch] = useState('');
    const [selectedTagFilter, setSelectedTagFilter] = useState('');

    // Selection
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [selectAllMode, setSelectAllMode] = useState(false);
    const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());

    // Modals
    const [showAddTagsModal, setShowAddTagsModal] = useState(false);
    const [showRemoveTagsModal, setShowRemoveTagsModal] = useState(false);
    const [showMessageModal, setShowMessageModal] = useState(false);
    const [showDeleteModal, setShowDeleteModal] = useState(false);

    // Action states
    const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
    const [messageText, setMessageText] = useState('');
    const [actionLoading, setActionLoading] = useState(false);
    const [failedContactIds, setFailedContactIds] = useState<string[]>([]);
    const [lastSendResults, setLastSendResults] = useState<{ sent: number; failed: number } | null>(null);

    useEffect(() => {
        fetchPages();
    }, []);

    useEffect(() => {
        if (selectedPageId) {
            fetchContacts();
            fetchTags();
        }
    }, [selectedPageId, page, pageSize, search, selectedTagFilter]);

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

    const fetchContacts = useCallback(async () => {
        if (!selectedPageId) return;

        setLoading(true);
        try {
            const params = new URLSearchParams({
                page: page.toString(),
                pageSize: pageSize.toString(),
                ...(search && { search }),
                ...(selectedTagFilter && { tagId: selectedTagFilter })
            });

            const res = await fetch(`/api/pages/${selectedPageId}/contacts?${params}`);
            const data: PaginatedResponse<Contact> = await res.json();

            setContacts(data.items || []);
            setTotal(data.total || 0);
        } catch (error) {
            console.error('Error fetching contacts:', error);
        } finally {
            setLoading(false);
        }
    }, [selectedPageId, page, pageSize, search, selectedTagFilter]);

    const fetchTags = async () => {
        if (!selectedPageId) return;

        try {
            const res = await fetch(`/api/tags?scope=all&pageId=${selectedPageId}&pageSize=100`);
            const data = await res.json();
            setTags(data.items || []);
        } catch (error) {
            console.error('Error fetching tags:', error);
        }
    };

    const fetchAllContactIds = async (): Promise<string[]> => {
        if (!selectedPageId) return [];

        try {
            let allIds: string[] = [];
            let currentPage = 1;
            const pageSize = 1000;
            let hasMore = true;

            while (hasMore) {
                const params = new URLSearchParams({
                    page: currentPage.toString(),
                    pageSize: pageSize.toString(),
                    ...(search && { search }),
                    ...(selectedTagFilter && { tagId: selectedTagFilter })
                });

                const res = await fetch(`/api/pages/${selectedPageId}/contacts?${params}`);
                const data: PaginatedResponse<Contact> = await res.json();

                if (data.items && data.items.length > 0) {
                    const pageIds = data.items.map(c => c.id);
                    allIds = [...allIds, ...pageIds];

                    if ((currentPage * pageSize) >= (data.total || 0) || data.items.length < pageSize) {
                        hasMore = false;
                    } else {
                        currentPage++;
                    }
                } else {
                    hasMore = false;
                }
            }

            if (excludedIds.size > 0) {
                allIds = allIds.filter(id => !excludedIds.has(id));
            }

            return allIds;
        } catch (error) {
            console.error('Error fetching all contact IDs:', error);
            return [];
        }
    };

    const handleSync = async () => {
        if (!selectedPageId || syncing) return;

        setSyncing(true);
        try {
            // Manual sync button always does full sync to get all contacts
            const res = await fetch(`/api/pages/${selectedPageId}/sync`, { 
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ forceFullSync: true }) // Full sync for manual button clicks
            });
            
            const data = await res.json();
            if (data.success) {
                if (data.incremental) {
                    console.log(`✅ Incremental sync: ${data.synced} new/updated contacts synced${data.restored > 0 ? `, ${data.restored} deleted contacts restored` : ''}`);
                } else {
                    console.log(`✅ Full sync: ${data.synced} contacts synced${data.restored > 0 ? `, ${data.restored} deleted contacts restored` : ''}`);
                }
            }
            await fetchContacts();
        } catch (error) {
            console.error('Error syncing:', error);
        } finally {
            setSyncing(false);
        }
    };

    const getSelectionCount = () => {
        if (selectAllMode) {
            return total - excludedIds.size;
        }
        return selectedIds.size;
    };

    const isSelected = (id: string) => {
        if (selectAllMode) {
            return !excludedIds.has(id);
        }
        return selectedIds.has(id);
    };

    const handleSelectAllOnPage = () => {
        if (selectAllMode) {
            setSelectAllMode(false);
            setExcludedIds(new Set());
            setSelectedIds(new Set());
        } else {
            const allOnPageSelected = contacts.every(c => selectedIds.has(c.id));
            if (allOnPageSelected) {
                const newSelected = new Set(selectedIds);
                contacts.forEach(c => newSelected.delete(c.id));
                setSelectedIds(newSelected);
            } else {
                const newSelected = new Set(selectedIds);
                contacts.forEach(c => newSelected.add(c.id));
                setSelectedIds(newSelected);
            }
        }
    };

    const handleSelectAllAcrossPages = () => {
        setSelectAllMode(true);
        setExcludedIds(new Set());
        setSelectedIds(new Set());
    };

    const handleSelect = (id: string) => {
        if (selectAllMode) {
            const newExcluded = new Set(excludedIds);
            if (newExcluded.has(id)) {
                newExcluded.delete(id);
            } else {
                newExcluded.add(id);
            }
            setExcludedIds(newExcluded);

            if (newExcluded.size >= total) {
                setSelectAllMode(false);
                setExcludedIds(new Set());
            }
        } else {
            const newSelected = new Set(selectedIds);
            if (newSelected.has(id)) {
                newSelected.delete(id);
            } else {
                newSelected.add(id);
            }
            setSelectedIds(newSelected);
        }
    };

    const clearSelection = () => {
        setSelectAllMode(false);
        setSelectedIds(new Set());
        setExcludedIds(new Set());
    };

    const getSelectedContactIds = async (): Promise<string[]> => {
        if (selectAllMode) {
            const allIds = await fetchAllContactIds();
            console.log(`📤 Select All Mode: Fetched ${allIds.length} contact IDs`);
            return allIds;
        }
        const selected = Array.from(selectedIds);
        console.log(`📤 Individual Selection: ${selected.length} contact IDs selected`);
        return selected;
    };

    const handleBulkAddTags = async () => {
        if (getSelectionCount() === 0 || selectedTagIds.size === 0) return;

        setActionLoading(true);
        try {
            const contactIds = await getSelectedContactIds();

            await fetch(`/api/pages/${selectedPageId}/contacts/bulk-add-tags`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contactIds,
                    tagIds: Array.from(selectedTagIds)
                })
            });

            setShowAddTagsModal(false);
            setSelectedTagIds(new Set());
            clearSelection();
            await fetchContacts();
        } catch (error) {
            console.error('Error adding tags:', error);
        } finally {
            setActionLoading(false);
        }
    };

    const handleBulkRemoveTags = async () => {
        if (getSelectionCount() === 0 || selectedTagIds.size === 0) return;

        setActionLoading(true);
        try {
            const contactIds = await getSelectedContactIds();

            await fetch(`/api/pages/${selectedPageId}/contacts/bulk-remove-tags`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contactIds,
                    tagIds: Array.from(selectedTagIds)
                })
            });

            setShowRemoveTagsModal(false);
            setSelectedTagIds(new Set());
            clearSelection();
            await fetchContacts();
        } catch (error) {
            console.error('Error removing tags:', error);
        } finally {
            setActionLoading(false);
        }
    };

    const handleBulkMessage = async () => {
        if (getSelectionCount() === 0 || !messageText.trim() || !selectedPageId) return;

        setActionLoading(true);
        try {
            const allContactIds = await getSelectedContactIds();
            console.log(`📤 Sending messages to ${allContactIds.length} contacts`);
            
            if (allContactIds.length === 0) {
                alert('No contacts selected. Please select contacts first.');
                setActionLoading(false);
                return;
            }

            // Chunk contacts into batches to avoid request body size limits and timeouts
            // Send in batches of 5000 contacts at a time
            const CHUNK_SIZE = 5000;
            let totalSent = 0;
            let totalFailed = 0;
            const allFailedIds: string[] = [];

            for (let i = 0; i < allContactIds.length; i += CHUNK_SIZE) {
                const chunk = allContactIds.slice(i, i + CHUNK_SIZE);
                const chunkNumber = Math.floor(i / CHUNK_SIZE) + 1;
                const totalChunks = Math.ceil(allContactIds.length / CHUNK_SIZE);
                
                console.log(`📤 Processing chunk ${chunkNumber}/${totalChunks} (${chunk.length} contacts)`);
                
                try {
                    const response = await fetch('/api/facebook/messages/send', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            pageId: selectedPageId,
                            contactIds: chunk,
                            messageText: messageText.trim()
                        })
                    });

                    // Check if response is OK before parsing JSON
                    if (!response.ok) {
                        const contentType = response.headers.get('content-type');
                        if (contentType && contentType.includes('application/json')) {
                            const errorData = await response.json();
                            throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
                        } else {
                            // Response is HTML (error page), get text instead
                            const text = await response.text();
                            throw new Error(`Server error (${response.status}): ${response.statusText}. Please check the console for details.`);
                        }
                    }

                    const data = await response.json();
                    if (data.success) {
                        totalSent += data.results.sent || 0;
                        totalFailed += data.results.failed || 0;
                        
                        // Collect failed contact IDs
                        if (data.results.errors?.length) {
                            allFailedIds.push(...data.results.errors.map((e: { contactId: string }) => e.contactId));
                        }

                        // If partial (timeout), automatically retry remaining contacts
                        if (data.partial && data.remainingContactIds?.length > 0) {
                            console.warn(`⚠️ Chunk ${chunkNumber} timed out. Processed ${data.results.processed}/${chunk.length}. Auto-retrying ${data.remainingContactIds.length} remaining contacts...`);
                            
                            // Automatically retry remaining contacts from this chunk
                            let retryAttempt = 1;
                            const MAX_RETRIES = 3;
                            let remainingToRetry = [...data.remainingContactIds];
                            
                            while (remainingToRetry.length > 0 && retryAttempt <= MAX_RETRIES) {
                                console.log(`🔄 Auto-retry attempt ${retryAttempt}/${MAX_RETRIES} for ${remainingToRetry.length} contacts`);
                                
                                try {
                                    const retryResponse = await fetch('/api/facebook/messages/send', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            pageId: selectedPageId,
                                            contactIds: remainingToRetry,
                                            messageText: messageText.trim()
                                        })
                                    });

                                    if (!retryResponse.ok) {
                                        const contentType = retryResponse.headers.get('content-type');
                                        if (contentType && contentType.includes('application/json')) {
                                            const errorData = await retryResponse.json();
                                            throw new Error(errorData.message || `HTTP ${retryResponse.status}`);
                                        } else {
                                            const text = await retryResponse.text();
                                            throw new Error(`Server error (${retryResponse.status})`);
                                        }
                                    }

                                    const retryData = await retryResponse.json();
                                    if (retryData.success) {
                                        totalSent += retryData.results.sent || 0;
                                        totalFailed += retryData.results.failed || 0;
                                        
                                        // Collect failed contact IDs from retry
                                        if (retryData.results.errors?.length) {
                                            allFailedIds.push(...retryData.results.errors.map((e: { contactId: string }) => e.contactId));
                                        }

                                        // If retry also timed out, update remaining list for next retry
                                        if (retryData.partial && retryData.remainingContactIds?.length > 0) {
                                            remainingToRetry = retryData.remainingContactIds;
                                            retryAttempt++;
                                            console.warn(`⚠️ Retry attempt ${retryAttempt - 1} also timed out. ${remainingToRetry.length} contacts still remaining.`);
                                        } else {
                                            // Successfully completed retry
                                            console.log(`✅ Auto-retry completed: ${retryData.results.sent} sent, ${retryData.results.failed} failed`);
                                            remainingToRetry = []; // Clear to exit loop
                                        }
                                    } else {
                                        throw new Error(retryData.message || 'Retry failed');
                                    }
                                } catch (retryError) {
                                    console.error(`❌ Auto-retry attempt ${retryAttempt} failed:`, retryError);
                                    retryAttempt++;
                                    
                                    // If max retries reached, mark remaining as failed
                                    if (retryAttempt > MAX_RETRIES) {
                                        console.error(`❌ Max retries (${MAX_RETRIES}) reached. Marking ${remainingToRetry.length} contacts as failed.`);
                                        totalFailed += remainingToRetry.length;
                                        allFailedIds.push(...remainingToRetry);
                                        remainingToRetry = [];
                                    }
                                }
                            }
                            
                            if (remainingToRetry.length > 0) {
                                console.error(`❌ Could not complete all retries. ${remainingToRetry.length} contacts still remaining.`);
                            }
                        } else if (data.partial) {
                            console.warn(`⚠️ Chunk ${chunkNumber} was partially processed: ${data.results.processed}/${chunk.length}`);
                        }

                        console.log(`✅ Chunk ${chunkNumber}/${totalChunks} complete: ${data.results.sent} sent, ${data.results.failed} failed`);
                    } else {
                        throw new Error(data.message || 'Failed to send messages');
                    }
                } catch (error) {
                    console.error(`❌ Error sending chunk ${chunkNumber}:`, error);
                    // Mark all contacts in this chunk as failed
                    totalFailed += chunk.length;
                    allFailedIds.push(...chunk);
                    // Continue with next chunk instead of stopping
                }
            }

            // Store failed contact IDs for resend option
            setFailedContactIds(allFailedIds);
            setLastSendResults({ sent: totalSent, failed: totalFailed });

            if (totalFailed > 0) {
                alert(`Messages sent! Success: ${totalSent}, Failed: ${totalFailed} out of ${allContactIds.length} total.\n\nYou can resend to failed contacts using the "Resend to Failed" button.`);
            } else {
                alert(`Messages sent! Success: ${totalSent}, Failed: ${totalFailed}`);
                // Clear failed contacts if all succeeded
                setFailedContactIds([]);
                setLastSendResults(null);
                setShowMessageModal(false);
                setMessageText('');
                clearSelection();
            }
            
            await fetchContacts();
        } catch (error) {
            console.error('Error sending messages:', error);
            alert(`Error sending messages: ${(error as Error).message}`);
        } finally {
            setActionLoading(false);
        }
    };

    const handleResendToFailed = async () => {
        if (failedContactIds.length === 0 || !messageText.trim() || !selectedPageId) return;

        setActionLoading(true);
        try {
            const response = await fetch('/api/facebook/messages/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pageId: selectedPageId,
                    contactIds: failedContactIds,
                    messageText: messageText.trim()
                })
            });

            if (!response.ok) {
                const contentType = response.headers.get('content-type');
                if (contentType && contentType.includes('application/json')) {
                    const errorData = await response.json();
                    throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
                } else {
                    const text = await response.text();
                    throw new Error(`Server error (${response.status}): ${response.statusText}. Please check the console for details.`);
                }
            }

            const data = await response.json();
            if (data.success) {
                // Only update failedContactIds with contacts that actually failed this time
                const newFailedIds = data.results.errors?.map((e: { contactId: string }) => e.contactId) || [];
                setFailedContactIds(newFailedIds);
                setLastSendResults({ sent: data.results.sent, failed: data.results.failed });

                console.log(`Resend results: ${data.results.sent} sent, ${data.results.failed} failed out of ${failedContactIds.length} attempted`);
                
                if (data.debug) {
                    console.log('Debug info:', data.debug);
                }

                if (data.results.failed > 0) {
                    let message = `Resend complete! Success: ${data.results.sent}, Still failed: ${data.results.failed}`;
                    if (data.results.sent === 0 && data.debug) {
                        if (data.debug.totalFound === 0) {
                            message += `\n\n⚠️ None of the failed contact IDs were found in the database. They may have been deleted. Please sync contacts again.`;
                        } else if (data.debug.totalFiltered > 0) {
                            message += `\n\n⚠️ ${data.debug.totalFiltered} contacts were filtered out (wrong page or missing PSID). Please sync contacts again.`;
                        } else {
                            message += `\n\n⚠️ All messages failed. Please check the console for error details.`;
                        }
                    } else if (data.results.sent === 0) {
                        message += `\n\n⚠️ All messages failed. Please check the console for error details.`;
                    } else {
                        message += `\n\nYou can try resending to the failed contacts again.`;
                    }
                    alert(message);
                } else {
                    alert(`Resend complete! All ${data.results.sent} messages sent successfully!`);
                    setFailedContactIds([]);
                    setLastSendResults(null);
                    setShowMessageModal(false);
                    setMessageText('');
                }
                await fetchContacts();
            } else {
                // Handle error response with debug info
                let errorMsg = data.message || 'Failed to resend messages';
                if (data.debug) {
                    console.error('Resend error debug:', data.debug);
                    if (data.debug.totalFound === 0) {
                        errorMsg += '\n\nNone of the contact IDs were found. They may have been deleted. Please sync contacts again.';
                    }
                }
                throw new Error(errorMsg);
            }
        } catch (error) {
            console.error('Error resending messages:', error);
            alert(`Error resending messages: ${(error as Error).message}`);
        } finally {
            setActionLoading(false);
        }
    };

    const handleBulkDelete = async () => {
        if (getSelectionCount() === 0) return;

        setActionLoading(true);
        try {
            const contactIds = await getSelectedContactIds();

            await fetch(`/api/pages/${selectedPageId}/contacts/bulk`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contactIds })
            });

            setShowDeleteModal(false);
            clearSelection();
            await fetchContacts();
        } catch (error) {
            console.error('Error deleting contacts:', error);
        } finally {
            setActionLoading(false);
        }
    };

    const toggleTagSelection = (tagId: string) => {
        const newSelected = new Set(selectedTagIds);
        if (newSelected.has(tagId)) {
            newSelected.delete(tagId);
        } else {
            newSelected.add(tagId);
        }
        setSelectedTagIds(newSelected);
    };

    const allOnPageSelected = contacts.length > 0 && contacts.every(c => isSelected(c.id));

    return (
        <div className="p-6 md:p-8 max-w-[1400px] mx-auto fade-in">
            {/* Header */}
            <div className="flex flex-col md:flex-row items-center justify-between mb-8 gap-4">
                <div>
                    <h1 className="text-3xl font-black uppercase mb-2">Contacts</h1>
                    <p className="font-mono text-sm text-gray-500 uppercase tracking-wide">
                        Manage and organize your audience
                    </p>
                </div>

                <div className="flex items-center gap-3 w-full md:w-auto">
                    <div className="relative flex-1 md:w-64">
                        <select
                            value={selectedPageId || ''}
                            onChange={(e) => {
                                setSelectedPageId(e.target.value);
                                setPage(1);
                                clearSelection();
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
                        onClick={handleSync}
                        disabled={syncing}
                        className="btn-wireframe"
                    >
                        <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
                        Sync
                    </button>
                </div>
            </div>

            {/* Filters & Actions Bar */}
            <div className="wireframe-card mb-6 p-4">
                <div className="flex flex-wrap items-center gap-4">
                    {/* Search */}
                    <div className="relative flex-1 min-w-[200px]">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <input
                            type="text"
                            placeholder="SEARCH NAMES..."
                            value={search}
                            onChange={(e) => {
                                setSearch(e.target.value);
                                setPage(1);
                                clearSelection();
                            }}
                            className="input-wireframe pl-10"
                        />
                    </div>

                    {/* Tag Filter */}
                    <div className="flex items-center gap-2">
                        <Filter className="w-4 h-4" />
                        <select
                            value={selectedTagFilter}
                            onChange={(e) => {
                                setSelectedTagFilter(e.target.value);
                                setPage(1);
                                clearSelection();
                            }}
                            className="input-wireframe w-auto"
                        >
                            <option value="">ALL TAGS</option>
                            {tags.map((tag) => (
                                <option key={tag.id} value={tag.id}>
                                    {tag.name}
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* Bulk Actions */}
                    {getSelectionCount() > 0 && (
                        <div className="flex items-center gap-2 pl-4 border-l-2 border-black ml-2">
                            <span className="text-xs font-bold uppercase mr-2">
                                {selectAllMode ? (
                                    <span className="text-black">
                                        All {getSelectionCount()}
                                    </span>
                                ) : (
                                    `${getSelectionCount()} Selected`
                                )}
                            </span>
                            <button
                                onClick={clearSelection}
                                className="btn-ghost-wireframe text-xs uppercase font-bold px-2"
                            >
                                Clear
                            </button>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setShowAddTagsModal(true)}
                                    className="btn-wireframe py-1 px-3 text-xs h-8"
                                    title="Add Tags"
                                >
                                    <Tag className="w-3.5 h-3.5" />
                                </button>
                                <button
                                    onClick={() => setShowRemoveTagsModal(true)}
                                    className="btn-wireframe py-1 px-3 text-xs h-8"
                                    title="Remove Tags"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                                <button
                                    onClick={() => setShowMessageModal(true)}
                                    className="btn-wireframe py-1 px-3 text-xs h-8 bg-black text-white hover:bg-gray-800"
                                    title="Send Message"
                                >
                                    <MessageSquare className="w-3.5 h-3.5" />
                                </button>
                                <button
                                    onClick={() => setShowDeleteModal(true)}
                                    className="btn-wireframe py-1 px-3 text-xs h-8 border-red-600 hover:bg-red-50 text-red-600"
                                    title="Delete"
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Select All Banner */}
            {selectedIds.size > 0 && !selectAllMode && total > contacts.length && (
                <div className="mb-6 p-3 border border-black bg-gray-50 flex items-center justify-between">
                    <span className="text-xs font-mono uppercase">
                        {selectedIds.size} contacts on this page selected.
                    </span>
                    <button
                        onClick={handleSelectAllAcrossPages}
                        className="btn-ghost-wireframe text-xs font-bold uppercase underline"
                    >
                        Select all {total} contacts
                    </button>
                </div>
            )}

            {selectAllMode && excludedIds.size > 0 && (
                <div className="mb-6 p-3 border border-yellow-500 bg-yellow-50">
                    <span className="text-xs font-mono uppercase text-yellow-900">
                        All contacts selected except {excludedIds.size} excluded.
                    </span>
                </div>
            )}

            {/* Table */}
            <div className="overflow-x-auto border border-black mb-4">
                <table className="table-wireframe">
                    <thead>
                        <tr>
                            <th className="w-12">
                                <input
                                    type="checkbox"
                                    checked={allOnPageSelected}
                                    onChange={handleSelectAllOnPage}
                                    className="w-4 h-4 border border-black rounded-none focus:ring-0 text-black"
                                />
                            </th>
                            <th>Contact Name</th>
                            <th>Tags</th>
                            <th>Last Active</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white">
                        {loading ? (
                            <tr>
                                <td colSpan={4} className="text-center py-12">
                                    <div className="animate-spin w-8 h-8 border-2 border-black border-t-transparent rounded-full mx-auto" />
                                </td>
                            </tr>
                        ) : contacts.length === 0 ? (
                            <tr>
                                <td colSpan={4} className="text-center py-20">
                                    <User className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                                    <p className="text-lg font-bold uppercase">No contacts found</p>
                                    <p className="font-mono text-xs text-gray-500 mt-2">
                                        Try syncing your page or adjusting filters.
                                    </p>
                                </td>
                            </tr>
                        ) : (
                            contacts.map((contact) => (
                                <tr key={contact.id} className={`hover:bg-gray-50 transition-colors ${isSelected(contact.id) ? 'bg-gray-50' : ''}`}>
                                    <td>
                                        <input
                                            type="checkbox"
                                            checked={isSelected(contact.id)}
                                            onChange={() => handleSelect(contact.id)}
                                            className="w-4 h-4 border border-black rounded-none focus:ring-0 text-black"
                                        />
                                    </td>
                                    <td>
                                        <div className="flex items-center gap-4">
                                            {contact.profile_pic ? (
                                                <img
                                                    src={contact.profile_pic}
                                                    alt={contact.name || 'Contact'}
                                                    className="w-10 h-10 border border-black grayscale"
                                                />
                                            ) : (
                                                <div className="w-10 h-10 border border-black bg-gray-100 flex items-center justify-center">
                                                    <User className="w-5 h-5 text-gray-400" />
                                                </div>
                                            )}
                                            <div>
                                                <p className="font-bold uppercase text-sm">
                                                    {contact.name || 'Unknown'}
                                                </p>
                                                <p className="font-mono text-xs text-gray-500">
                                                    ID: {contact.psid.slice(0, 8)}...
                                                </p>
                                            </div>
                                        </div>
                                    </td>
                                    <td>
                                        <div className="flex flex-wrap gap-2">
                                            {contact.tags?.slice(0, 3).map((tag) => (
                                                <span
                                                    key={tag.id}
                                                    className="badge-wireframe"
                                                    style={{
                                                        backgroundColor: tag.color,
                                                        color: '#fff', // Assuming dark colors or check contrast
                                                        borderColor: 'black'
                                                    }}
                                                >
                                                    {tag.name}
                                                </span>
                                            ))}
                                            {(contact.tags?.length || 0) > 3 && (
                                                <span className="badge-wireframe bg-gray-100 text-black">
                                                    +{(contact.tags?.length || 0) - 3}
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="font-mono text-xs text-gray-500">
                                        {contact.last_interaction_at
                                            ? new Date(contact.last_interaction_at).toLocaleDateString()
                                            : 'NEVER'}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>

            {/* Pagination */}
            <div className="border border-black bg-white p-4">
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

            {/* Use same Modal structure as Tags page but updated content */}

            {/* Add Tags Modal */}
            <Modal
                isOpen={showAddTagsModal}
                onClose={() => {
                    setShowAddTagsModal(false);
                    setSelectedTagIds(new Set());
                }}
                title="Add Tags"
            >
                <div className="space-y-4">
                    <p className="font-mono text-sm text-gray-500 mb-4">
                        Select tags to add to <span className="font-bold text-black">{getSelectionCount()}</span> contacts.
                    </p>
                    <div className="max-h-64 overflow-y-auto border border-black p-2 space-y-1">
                        {tags.map((tag) => (
                            <button
                                key={tag.id}
                                onClick={() => toggleTagSelection(tag.id)}
                                className={`w-full flex items-center justify-between p-3 border border-transparent hover:bg-gray-50 transition-colors ${selectedTagIds.has(tag.id)
                                    ? 'bg-gray-100 border-black'
                                    : ''
                                    }`}
                            >
                                <span className="flex items-center gap-3">
                                    <span
                                        className="w-3 h-3 border border-black"
                                        style={{ backgroundColor: tag.color }}
                                    ></span>
                                    <span className="font-bold uppercase text-sm">{tag.name}</span>
                                </span>
                                {selectedTagIds.has(tag.id) && (
                                    <Check className="w-4 h-4 text-black" />
                                )}
                            </button>
                        ))}
                    </div>
                    <div className="flex justify-end gap-3 pt-4 border-t border-black">
                        <button
                            onClick={() => setShowAddTagsModal(false)}
                            className="btn-wireframe bg-white"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleBulkAddTags}
                            disabled={selectedTagIds.size === 0 || actionLoading}
                            className="btn-wireframe bg-black text-white hover:bg-gray-800"
                        >
                            {actionLoading ? 'Adding...' : 'Apply Tags'}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* Remove Tags Modal */}
            <Modal
                isOpen={showRemoveTagsModal}
                onClose={() => {
                    setShowRemoveTagsModal(false);
                    setSelectedTagIds(new Set());
                }}
                title="Remove Tags"
            >
                <div className="space-y-4">
                    <p className="font-mono text-sm text-gray-500 mb-4">
                        Select tags to remove from <span className="font-bold text-black">{getSelectionCount()}</span> contacts.
                    </p>
                    <div className="max-h-64 overflow-y-auto border border-black p-2 space-y-1">
                        {tags.map((tag) => (
                            <button
                                key={tag.id}
                                onClick={() => toggleTagSelection(tag.id)}
                                className={`w-full flex items-center justify-between p-3 border border-transparent hover:bg-gray-50 transition-colors ${selectedTagIds.has(tag.id)
                                    ? 'bg-red-50 border-red-200'
                                    : ''
                                    }`}
                            >
                                <span className="flex items-center gap-3">
                                    <span
                                        className="w-3 h-3 border border-black"
                                        style={{ backgroundColor: tag.color }}
                                    ></span>
                                    <span className="font-bold uppercase text-sm">{tag.name}</span>
                                </span>
                                {selectedTagIds.has(tag.id) && (
                                    <X className="w-4 h-4 text-red-500" />
                                )}
                            </button>
                        ))}
                    </div>
                    <div className="flex justify-end gap-3 pt-4 border-t border-black">
                        <button
                            onClick={() => setShowRemoveTagsModal(false)}
                            className="btn-wireframe bg-white"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleBulkRemoveTags}
                            disabled={selectedTagIds.size === 0 || actionLoading}
                            className="btn-wireframe bg-red-600 text-white border-red-600 hover:bg-red-700"
                        >
                            {actionLoading ? 'Removing...' : 'Remove Tags'}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* Message Modal */}
            <Modal
                isOpen={showMessageModal}
                onClose={() => {
                    setShowMessageModal(false);
                    // Clear failed contacts when closing modal (unless we just sent)
                    if (!actionLoading) {
                        setFailedContactIds([]);
                        setLastSendResults(null);
                    }
                }}
                title="Send Message"
            >
                <div className="space-y-4">
                    {failedContactIds.length > 0 ? (
                        <div className="bg-yellow-50 border-2 border-yellow-400 p-3 rounded">
                            <p className="font-mono text-sm text-yellow-800 mb-2">
                                <span className="font-bold">Previous send results:</span> {lastSendResults?.sent} sent, {lastSendResults?.failed} failed
                            </p>
                            <p className="font-mono text-xs text-yellow-700">
                                {failedContactIds.length} contact(s) failed. You can resend to them below.
                            </p>
                        </div>
                    ) : (
                        <p className="font-mono text-sm text-gray-500">
                            Sending to <span className="font-bold text-black">{getSelectionCount()}</span> recipients.
                        </p>
                    )}
                    <textarea
                        value={messageText}
                        onChange={(e) => setMessageText(e.target.value)}
                        placeholder="TYPE YOUR MESSAGE HERE..."
                        rows={5}
                        className="input-wireframe w-full h-auto p-3 resize-none"
                    />
                    <div className="flex justify-end gap-3 pt-4 border-t border-black">
                        <button
                            onClick={() => {
                                setShowMessageModal(false);
                                setFailedContactIds([]);
                                setLastSendResults(null);
                            }}
                            className="btn-wireframe bg-white"
                            disabled={actionLoading}
                        >
                            {failedContactIds.length > 0 ? 'Close' : 'Cancel'}
                        </button>
                        {failedContactIds.length > 0 && (
                            <button
                                onClick={handleResendToFailed}
                                disabled={!messageText.trim() || actionLoading}
                                className="btn-wireframe bg-yellow-600 text-white hover:bg-yellow-700"
                            >
                                {actionLoading ? 'Resending...' : `Resend to ${failedContactIds.length} Failed`}
                            </button>
                        )}
                        <button
                            onClick={handleBulkMessage}
                            disabled={!messageText.trim() || actionLoading}
                            className="btn-wireframe bg-black text-white hover:bg-gray-800"
                        >
                            {actionLoading ? 'Sending...' : failedContactIds.length > 0 ? 'Send to New Selection' : 'Send Now'}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* Delete Modal */}
            <Modal
                isOpen={showDeleteModal}
                onClose={() => setShowDeleteModal(false)}
                title="Delete Contacts"
            >
                <p className="text-gray-600 mb-6 font-mono text-sm">
                    Are you sure you want to delete <span className="font-bold text-black">{getSelectionCount()} contacts</span>?
                    This action cannot be undone.
                </p>
                <div className="flex justify-end gap-3 pt-4 border-t border-black">
                    <button
                        onClick={() => setShowDeleteModal(false)}
                        className="btn-wireframe bg-white"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleBulkDelete}
                        disabled={actionLoading}
                        className="btn-wireframe bg-red-600 text-white border-red-600 hover:bg-red-700"
                    >
                        {actionLoading ? 'Deleting...' : 'Delete Contacts'}
                    </button>
                </div>
            </Modal>
        </div>
    );
}
