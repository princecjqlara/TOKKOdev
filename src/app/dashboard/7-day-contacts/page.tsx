'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckSquare, Clock3, RefreshCw, Search, Send, Paperclip, X } from 'lucide-react';
import Pagination from '@/components/Pagination';
import { getSupabaseClient } from '@/lib/supabase';
import { MAX_MESSENGER_MEDIA_BYTES, MAX_MESSENGER_MEDIA_FILES } from '@/lib/messenger-media';
import {
    createManualReplyFingerprint,
    getSentPartsForRetry,
    mergeSentParts,
    type ManualReplyRetryState
} from '@/lib/manual-reply-retry';
import type { Contact, Page, PaginatedResponse, Tag } from '@/types';

type PreparedUpload = { path: string; token: string; type: 'image' | 'video' | 'audio' | 'file'; bucket: string };
type ContactSort = 'expiring' | 'latest' | 'name_asc' | 'name_desc';
type SendProgress = { completed: number; total: number } | null;
type SendResult = {
    message?: string;
    partial?: boolean;
    sent?: Array<{ kind: string; partId?: string; messageId: string }>;
};

const BULK_SEND_CONCURRENCY = 4;

function formatRemaining(lastInboundAt: string | null | undefined, now: number): string {
    if (!lastInboundAt) return 'No customer message';
    const remaining = new Date(lastInboundAt).getTime() + 7 * 24 * 60 * 60 * 1000 - now;
    if (remaining <= 0) return 'Expired';
    const hours = Math.floor(remaining / (60 * 60 * 1000));
    return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h left` : `${hours}h left`;
}

function areContactsEquivalent(left: Contact, right: Contact): boolean {
    if (
        left.id !== right.id ||
        left.name !== right.name ||
        left.last_inbound_at !== right.last_inbound_at ||
        left.updated_at !== right.updated_at
    ) {
        return false;
    }

    const leftTags = (left.tags || []).map((tag) => `${tag.id}:${tag.name}:${tag.color}`).join('|');
    const rightTags = (right.tags || []).map((tag) => `${tag.id}:${tag.name}:${tag.color}`).join('|');
    return leftTags === rightTags;
}

function areContactListsEquivalent(left: Contact[], right: Contact[]): boolean {
    return left.length === right.length && left.every((contact, index) => areContactsEquivalent(contact, right[index]));
}

function TagFilter({
    label, tags, selected, onChange
}: {
    label: string;
    tags: Tag[];
    selected: string[];
    onChange: (ids: string[]) => void;
}) {
    return (
        <div className="min-w-0">
            <p className="text-xs font-semibold text-black mb-1">{label}</p>
            <div className="max-h-32 overflow-y-auto border border-black p-2 bg-white space-y-1">
                {tags.length === 0 && <span className="text-xs text-gray-500">No tags</span>}
                {tags.map((tag) => (
                    <label key={tag.id} className="flex items-center gap-2 text-xs text-black cursor-pointer">
                        <input
                            type="checkbox"
                            checked={selected.includes(tag.id)}
                            onChange={(event) => onChange(event.target.checked
                                ? [...selected, tag.id]
                                : selected.filter((id) => id !== tag.id))}
                        />
                        <span className="w-2 h-2 flex-shrink-0" style={{ backgroundColor: tag.color }} />
                        <span className="truncate">{tag.name}</span>
                    </label>
                ))}
            </div>
        </div>
    );
}

export default function SevenDayContactsPage() {
    const [pages, setPages] = useState<Page[]>([]);
    const [pageId, setPageId] = useState('');
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [tags, setTags] = useState<Tag[]>([]);
    const [includeTagIds, setIncludeTagIds] = useState<string[]>([]);
    const [excludeTagIds, setExcludeTagIds] = useState<string[]>([]);
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [sort, setSort] = useState<ContactSort>('expiring');
    const [listPage, setListPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [selectedContacts, setSelectedContacts] = useState<Record<string, Contact>>({});
    const [partialDeliveries, setPartialDeliveries] = useState<Record<string, ManualReplyRetryState>>({});
    const [text, setText] = useState('');
    const [files, setFiles] = useState<File[]>([]);
    const [now, setNow] = useState(Date.now());
    const [loading, setLoading] = useState(false);
    const [sending, setSending] = useState(false);
    const [sendProgress, setSendProgress] = useState<SendProgress>(null);
    const [selectingAll, setSelectingAll] = useState(false);
    const [allMatchingSelected, setAllMatchingSelected] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [refreshKey, setRefreshKey] = useState(0);
    const selectAllRequestRef = useRef(0);

    useEffect(() => {
        fetch('/api/pages')
            .then((response) => response.json())
            .then((data) => {
                const availablePages: Page[] = data.pages || [];
                setPages(availablePages);
                if (availablePages.length > 0) setPageId(availablePages[0].id);
            })
            .catch(() => setError('Could not load connected Pages.'));
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(search), 300);
        return () => clearTimeout(timer);
    }, [search]);

    useEffect(() => {
        const timer = setInterval(() => {
            setNow(Date.now());
            setRefreshKey((value) => value + 1);
        }, 60_000);
        const onFocus = () => setRefreshKey((value) => value + 1);
        window.addEventListener('focus', onFocus);
        return () => {
            clearInterval(timer);
            window.removeEventListener('focus', onFocus);
        };
    }, []);

    useEffect(() => {
        if (!pageId) return;
        const controller = new AbortController();
        fetch(`/api/tags?scope=all&pageId=${encodeURIComponent(pageId)}&page=1&pageSize=1000`, { signal: controller.signal })
            .then((response) => response.json())
            .then((data) => setTags(data.items || []))
            .catch((fetchError) => { if (fetchError.name !== 'AbortError') setTags([]); });
        return () => controller.abort();
    }, [pageId]);

    const refreshContacts = useCallback(() => setRefreshKey((value) => value + 1), []);

    const selectedContactList = Object.values(selectedContacts);
    const allVisibleSelected = contacts.length > 0 && contacts.every((contact) => selectedContacts[contact.id]);

    const toggleContact = useCallback((contact: Contact) => {
        setAllMatchingSelected(false);
        const next = { ...selectedContacts };
        if (next[contact.id]) {
            delete next[contact.id];
        } else {
            next[contact.id] = contact;
        }
        setSelectedContacts(next);
        setError('');
        setNotice('');
    }, [selectedContacts]);

    const toggleVisibleContacts = useCallback(() => {
        setAllMatchingSelected(false);
        const next = { ...selectedContacts };
        if (contacts.every((contact) => next[contact.id])) {
            for (const contact of contacts) delete next[contact.id];
        } else {
            for (const contact of contacts) next[contact.id] = contact;
        }
        setSelectedContacts(next);
    }, [contacts, selectedContacts]);

    const clearSelection = useCallback(() => {
        setSelectedContacts({});
        setAllMatchingSelected(false);
    }, []);

    useEffect(() => {
        selectAllRequestRef.current += 1;
        setAllMatchingSelected(false);
        setSelectingAll(false);
    }, [pageId, debouncedSearch, includeTagIds, excludeTagIds, sort]);

    const selectAllMatchingContacts = useCallback(async () => {
        if (!pageId || selectingAll || sending) return;
        if (allMatchingSelected) {
            clearSelection();
            return;
        }

        const requestId = ++selectAllRequestRef.current;
        setSelectingAll(true);
        setError('');
        setNotice('');
        try {
            const selected: Record<string, Contact> = {};
            const pageSize = 1000;
            let pageNumber = 1;

            while (true) {
                const params = new URLSearchParams({
                    page: String(pageNumber),
                    pageSize: String(pageSize),
                    humanAgentWindow: 'true',
                    sort,
                    includeCount: 'false',
                    includeTags: 'false',
                    ...(debouncedSearch ? { search: debouncedSearch } : {}),
                    ...(includeTagIds.length ? { tagIds: includeTagIds.join(',') } : {}),
                    ...(excludeTagIds.length ? { excludeTagIds: excludeTagIds.join(',') } : {})
                });
                const response = await fetch(`/api/pages/${encodeURIComponent(pageId)}/contacts?${params}`);
                const data = await response.json();
                if (!response.ok) throw new Error(data.message || 'Could not select all matching contacts.');
                if (selectAllRequestRef.current !== requestId) return;

                const items: Contact[] = data.items || [];
                for (const contact of items) selected[contact.id] = contact;
                if (items.length < pageSize) break;
                pageNumber += 1;
            }

            if (selectAllRequestRef.current !== requestId) return;
            setSelectedContacts(selected);
            setAllMatchingSelected(true);
            setNotice(`Selected all ${Object.keys(selected).length.toLocaleString()} matching contacts for bulk sending.`);
        } catch (selectionError) {
            if (selectAllRequestRef.current === requestId) {
                setError(selectionError instanceof Error ? selectionError.message : 'Could not select all matching contacts.');
            }
        } finally {
            if (selectAllRequestRef.current === requestId) setSelectingAll(false);
        }
    }, [allMatchingSelected, clearSelection, debouncedSearch, excludeTagIds, includeTagIds, pageId, selectingAll, sending, sort]);

    useEffect(() => {
        if (!pageId) return;
        const controller = new AbortController();
        const params = new URLSearchParams({
            page: String(listPage), pageSize: '25', humanAgentWindow: 'true', sort,
            ...(debouncedSearch ? { search: debouncedSearch } : {}),
            ...(includeTagIds.length ? { tagIds: includeTagIds.join(',') } : {}),
            ...(excludeTagIds.length ? { excludeTagIds: excludeTagIds.join(',') } : {})
        });
        setLoading(true);
        fetch(`/api/pages/${encodeURIComponent(pageId)}/contacts?${params}`, { signal: controller.signal })
            .then(async (response) => {
                const data = await response.json();
                if (!response.ok) throw new Error(data.message || 'Could not load contacts.');
                return data as PaginatedResponse<Contact>;
            })
            .then((data) => {
                const refreshedContacts = data.items || [];
                setContacts((current) => areContactListsEquivalent(current, refreshedContacts) ? current : refreshedContacts);
                setTotal(data.total || 0);
                setSelectedContacts((current) => {
                    const next = { ...current };
                    let changed = false;
                    for (const contact of refreshedContacts) {
                        if (next[contact.id] && !areContactsEquivalent(next[contact.id], contact)) {
                            next[contact.id] = contact;
                            changed = true;
                        }
                    }
                    return changed ? next : current;
                });
                setError('');
            })
            .catch((fetchError) => { if (fetchError.name !== 'AbortError') setError(fetchError.message); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [pageId, listPage, debouncedSearch, includeTagIds, excludeTagIds, sort, refreshKey]);

    useEffect(() => {
        const next = Object.fromEntries(Object.entries(selectedContacts).filter(([, contact]) => {
            if (!contact.last_inbound_at) return false;
            const expiresAt = new Date(contact.last_inbound_at).getTime() + 7 * 24 * 60 * 60 * 1000;
            return expiresAt > now + 60 * 1000;
        }));
        if (Object.keys(next).length === selectedContactList.length) return;
        setSelectedContacts(next);
        setAllMatchingSelected(false);
    }, [now, selectedContactList.length, selectedContacts]);

    useEffect(() => {
        if (allMatchingSelected && selectedContactList.length !== total) {
            setAllMatchingSelected(false);
        }
    }, [allMatchingSelected, selectedContactList.length, total]);

    function addMediaFiles(selectedFiles: FileList | null) {
        const additions = Array.from(selectedFiles || []);
        if (additions.length === 0) return;
        if (files.length + additions.length > MAX_MESSENGER_MEDIA_FILES) {
            setError(`Choose up to ${MAX_MESSENGER_MEDIA_FILES} media files at a time.`);
            return;
        }
        setFiles((current) => [...current, ...additions]);
        setError('');
    }

    async function sendBulkReply() {
        if (!pageId || selectedContactList.length === 0 || (!text.trim() && files.length === 0) || sending) return;
        const recipients = [...selectedContactList];
        setSending(true);
        setSendProgress({ completed: 0, total: recipients.length });
        setError('');
        setNotice('');
        try {
            const replyFingerprint = createManualReplyFingerprint(text, files.map((file) => ({
                name: file.name,
                size: file.size,
                type: file.type,
                lastModified: file.lastModified
            })));
            if (files.length > MAX_MESSENGER_MEDIA_FILES) {
                throw new Error(`Choose up to ${MAX_MESSENGER_MEDIA_FILES} media files at a time.`);
            }
            const preparedMedia = await Promise.all(files.map(async (file, index) => {
                if (file.size <= 0 || file.size > MAX_MESSENGER_MEDIA_BYTES) {
                    throw new Error(`${file.name} must be no larger than 10 MB.`);
                }
                const prepareResponse = await fetch(`/api/pages/${encodeURIComponent(pageId)}/human-agent-media`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mimeType: file.type, size: file.size })
                });
                const prepared: PreparedUpload & { message?: string } = await prepareResponse.json();
                if (!prepareResponse.ok) throw new Error(prepared.message || `Could not prepare ${file.name}.`);
                const { error: uploadError } = await getSupabaseClient().storage
                    .from(prepared.bucket)
                    .uploadToSignedUrl(prepared.path, prepared.token, file, { contentType: file.type });
                if (uploadError) throw new Error(`${file.name} upload failed: ${uploadError.message}`);
                return { path: prepared.path, type: prepared.type, partId: `media:${index}` };
            }));

            const successes = new Set<string>();
            const failures: Array<{ contact: Contact; message: string }> = [];
            const nextPartialDeliveries = { ...partialDeliveries };
            let nextIndex = 0;
            let completed = 0;

            async function worker() {
                while (nextIndex < recipients.length) {
                    const contact = recipients[nextIndex++];
                    try {
                        const alreadySent = getSentPartsForRetry(
                            nextPartialDeliveries[contact.id],
                            replyFingerprint
                        );
                        if (nextPartialDeliveries[contact.id]?.fingerprint !== replyFingerprint) {
                            delete nextPartialDeliveries[contact.id];
                        }
                        const pendingText = alreadySent.has('text') ? '' : text.trim();
                        const pendingMediaItems = preparedMedia.filter((item) => !alreadySent.has(item.partId));
                        if (!pendingText && pendingMediaItems.length === 0) {
                            successes.add(contact.id);
                            delete nextPartialDeliveries[contact.id];
                            continue;
                        }
                        const response = await fetch(`/api/pages/${encodeURIComponent(pageId)}/human-agent-send`, {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                contactId: contact.id,
                                text: pendingText,
                                mediaItems: pendingMediaItems
                            })
                        });
                        const result = await response.json() as SendResult;
                        if (!response.ok) {
                            const sentParts = mergeSentParts(
                                alreadySent,
                                (result.sent || []).map((item) => item.partId || item.kind)
                            );
                            if (sentParts.length > 0) {
                                nextPartialDeliveries[contact.id] = {
                                    fingerprint: replyFingerprint,
                                    sentParts
                                };
                            }
                            throw new Error(result.message || 'Messenger did not confirm the send.');
                        }
                        successes.add(contact.id);
                        delete nextPartialDeliveries[contact.id];
                    } catch (sendError) {
                        failures.push({
                            contact,
                            message: sendError instanceof Error ? sendError.message : 'Messenger did not confirm the send.'
                        });
                    } finally {
                        completed += 1;
                        setSendProgress({ completed, total: recipients.length });
                    }
                }
            }

            await Promise.all(Array.from(
                { length: Math.min(BULK_SEND_CONCURRENCY, recipients.length) },
                () => worker()
            ));

            setPartialDeliveries(nextPartialDeliveries);
            setSelectedContacts((current) => Object.fromEntries(
                Object.entries(current).filter(([contactId]) => !successes.has(contactId))
            ));
            setAllMatchingSelected(false);
            if (failures.length === 0) {
                setNotice(`Sent successfully to all ${successes.size.toLocaleString()} selected contacts.`);
                setText('');
                setFiles([]);
            } else {
                const firstFailure = failures[0];
                setNotice(successes.size > 0 ? `Sent successfully to ${successes.size.toLocaleString()} of ${recipients.length.toLocaleString()} selected contacts.` : 'No messages were confirmed sent.');
                setError(`${failures.length.toLocaleString()} failed and remain selected. ${firstFailure.contact.name || 'Unnamed contact'}: ${firstFailure.message}`);
            }
            refreshContacts();
        } catch (sendError) {
            setError(sendError instanceof Error ? sendError.message : 'Could not send the bulk reply.');
        } finally {
            setSending(false);
            setSendProgress(null);
        }
    }

    return (
        <div className="max-w-7xl mx-auto space-y-5 text-black">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-2"><Clock3 className="w-6 h-6" />7-Day Window Contacts</h1>
                    <p className="text-sm text-gray-600 mt-1">Customers whose latest message is still within Meta&apos;s reply window. The list updates every minute and when you return to this tab.</p>
                </div>
                <button type="button" onClick={refreshContacts} className="border border-black px-3 py-2 flex items-center gap-2 text-sm hover:bg-gray-100">
                    <RefreshCw className="w-4 h-4" />Refresh
                </button>
            </div>

            <p className="border border-black bg-[#f5f5f5] p-3 text-sm">
                Sends the same staff reply to all selected eligible contacts. Each contact is rechecked against Meta&apos;s 7-day window immediately before delivery, and Meta must approve Human Agent access for the connected app.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3 border border-black p-4">
                <label className="text-xs font-semibold">Facebook Page
                    <select value={pageId} onChange={(event) => {
                        setPageId(event.target.value); setListPage(1); clearSelection();
                        setIncludeTagIds([]); setExcludeTagIds([]); setText(''); setFiles([]);
                    }} className="block mt-1 w-full border border-black bg-white p-2 text-sm">
                        {pages.length === 0 && <option value="">No connected Pages</option>}
                        {pages.map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}
                    </select>
                </label>
                <label className="text-xs font-semibold">Search contact
                    <span className="flex items-center gap-2 mt-1 border border-black px-2 bg-white">
                        <Search className="w-4 h-4" />
                        <input value={search} onChange={(event) => { setSearch(event.target.value); setListPage(1); }} placeholder="Name" className="w-full py-2 outline-none text-sm font-normal" />
                    </span>
                </label>
                <label className="text-xs font-semibold">Sort contacts
                    <select value={sort} onChange={(event) => { setSort(event.target.value as ContactSort); setListPage(1); }} className="block mt-1 w-full border border-black bg-white p-2 text-sm font-normal">
                        <option value="expiring">About to expire first</option>
                        <option value="latest">Latest message first</option>
                        <option value="name_asc">Name A–Z</option>
                        <option value="name_desc">Name Z–A</option>
                    </select>
                </label>
                <TagFilter label="Has any of these tags" tags={tags} selected={includeTagIds} onChange={(ids) => { setIncludeTagIds(ids); setListPage(1); }} />
                <TagFilter label="Exclude any of these tags" tags={tags} selected={excludeTagIds} onChange={(ids) => { setExcludeTagIds(ids); setListPage(1); }} />
            </div>

            {error && <p role="alert" className="border border-red-600 bg-red-50 text-red-800 p-3 text-sm">{error}</p>}
            {notice && <p role="status" className="border border-green-700 bg-green-50 text-green-800 p-3 text-sm">{notice}</p>}

            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] gap-5 items-start">
                <section className="border border-black min-w-0">
                    <div className="border-b border-black bg-[#f0f0f0] px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-sm font-semibold">
                        <span>Eligible contacts ({total.toLocaleString()})</span>
                        <span className="flex flex-wrap items-center gap-2">
                            <button type="button" onClick={toggleVisibleContacts} disabled={contacts.length === 0 || sending || selectingAll} className="border border-black bg-white px-2 py-1 text-xs font-medium disabled:opacity-50">
                                {allVisibleSelected ? 'Unselect page' : 'Select page'}
                            </button>
                            <button type="button" onClick={selectAllMatchingContacts} disabled={total === 0 || sending || selectingAll} className="border border-black bg-white px-2 py-1 text-xs font-medium disabled:opacity-50">
                                {selectingAll ? 'Selecting all…' : allMatchingSelected ? 'Clear all selected' : `Select all ${total.toLocaleString()} matching`}
                            </button>
                            <button type="button" onClick={clearSelection} disabled={selectedContactList.length === 0 || sending || selectingAll} className="border border-black bg-white px-2 py-1 text-xs font-medium disabled:opacity-50">Clear</button>
                            <span>{selectedContactList.length.toLocaleString()} selected</span>
                        </span>
                    </div>
                    {loading && contacts.length === 0 && <p className="p-4 text-sm text-gray-600">Loading contacts…</p>}
                    {!loading && contacts.length === 0 && <p className="p-4 text-sm text-gray-600">No contacts currently match this 7-day window and filter. Sync contacts if older conversations have not been imported yet.</p>}
                    {contacts.map((contact) => (
                        <label key={contact.id} className={`flex border-b border-black last:border-b-0 cursor-pointer hover:bg-gray-50 ${selectedContacts[contact.id] ? 'bg-gray-100 border-l-4 border-l-black' : ''}`}>
                            <span className="flex items-start p-4 pr-1">
                                <input type="checkbox" checked={Boolean(selectedContacts[contact.id])} disabled={sending || selectingAll} onChange={() => toggleContact(contact)} className="mt-0.5 h-5 w-5 accent-black cursor-pointer disabled:cursor-wait" />
                            </span>
                            <div className="flex-1 min-w-0 text-left p-4 pl-2">
                                <div className="flex justify-between gap-2">
                                    <span className="font-semibold text-sm truncate">{contact.name || 'Unnamed contact'}</span>
                                    <span className="text-xs whitespace-nowrap">{formatRemaining(contact.last_inbound_at, now)}</span>
                                </div>
                                <p className="text-xs text-gray-600 mt-1">Last customer message: {contact.last_inbound_at ? new Date(contact.last_inbound_at).toLocaleString() : 'Unknown'}</p>
                                <div className="flex flex-wrap gap-1 mt-2">
                                    {(contact.tags || []).map((tag) => <span key={tag.id} className="border border-gray-400 px-1.5 py-0.5 text-xs">{tag.name}</span>)}
                                </div>
                            </div>
                        </label>
                    ))}
                    {total > 25 && <div className="p-3"><Pagination page={listPage} pageSize={25} total={total} onPageChange={setListPage} /></div>}
                </section>

                <section className="border border-black p-4 space-y-4 lg:sticky lg:top-4">
                    <div className="flex items-center justify-between gap-2">
                        <h2 className="font-bold text-lg">Bulk reply</h2>
                        <span className="text-xs font-semibold">{selectedContactList.length.toLocaleString()} selected</span>
                    </div>
                    {selectedContactList.length > 0 && (
                        <div className="max-h-32 overflow-y-auto border border-black">
                            {selectedContactList.slice(0, 100).map((contact) => (
                                <label key={contact.id} className="w-full flex items-center gap-2 border-b border-black last:border-b-0 px-2 py-1.5 text-xs text-left bg-white cursor-pointer">
                                    <input type="checkbox" checked disabled={sending} onChange={() => toggleContact(contact)} className="h-4 w-4 accent-black cursor-pointer disabled:cursor-wait" />
                                    <span className="truncate flex-1">{contact.name || 'Unnamed contact'}</span>
                                    <span className="whitespace-nowrap">{formatRemaining(contact.last_inbound_at, now)}</span>
                                </label>
                            ))}
                            {selectedContactList.length > 100 && <p className="px-2 py-1.5 text-xs text-gray-600">+ {(selectedContactList.length - 100).toLocaleString()} more selected contacts</p>}
                        </div>
                    )}
                    <p className="text-sm">{selectedContactList.length > 0 ? `This reply will be sent to ${selectedContactList.length.toLocaleString()} selected contact${selectedContactList.length === 1 ? '' : 's'}.` : 'Select one or more contacts from the list.'}</p>
                    <label className="block text-xs font-semibold">Message text (optional when media is selected)
                        <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={2000} rows={5} placeholder="Reply to this customer’s inquiry…" className="mt-1 w-full border border-black p-2 text-sm font-normal resize-y" />
                    </label>
                    <div>
                        <label className="inline-flex items-center gap-2 border border-black px-3 py-2 text-sm cursor-pointer hover:bg-gray-100">
                            <Paperclip className="w-4 h-4" />Add media
                            <input
                                type="file"
                                multiple
                                className="sr-only"
                                accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,audio/mpeg,audio/mp4,audio/wav,audio/ogg,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                                onChange={(event) => {
                                    addMediaFiles(event.target.files);
                                    event.target.value = '';
                                }}
                            />
                        </label>
                        {files.length > 0 && (
                            <div className="mt-2 border border-gray-400 divide-y divide-gray-300">
                                {files.map((file, index) => (
                                    <div key={`${file.name}-${file.size}-${file.lastModified}-${index}`} className="flex items-center justify-between gap-2 p-2 text-xs">
                                        <span className="truncate">{file.name} ({(file.size / (1024 * 1024)).toFixed(1)} MB)</span>
                                        <button type="button" onClick={() => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))} aria-label={`Remove ${file.name}`}><X className="w-4 h-4" /></button>
                                    </div>
                                ))}
                            </div>
                        )}
                        <p className="text-xs text-gray-600 mt-2">Up to {MAX_MESSENGER_MEDIA_FILES} images, videos, audio, PDF, Word, or Excel files, each up to 10 MB. Each is sent as a normal Messenger attachment.</p>
                    </div>
                    {files.length > 0 && <p className="text-xs text-gray-600">Each attachment{ text.trim() ? ' and the text' : '' } will arrive as a separate Messenger message from one send action.</p>}
                    <button
                        type="button"
                        disabled={selectedContactList.length === 0 || (!text.trim() && files.length === 0) || sending}
                        onClick={sendBulkReply}
                        className="w-full flex items-center justify-center gap-2 bg-black text-white px-4 py-3 text-sm font-semibold disabled:opacity-50"
                    >
                        {selectedContactList.length > 1 ? <CheckSquare className="w-4 h-4" /> : <Send className="w-4 h-4" />}
                        {sending && sendProgress
                            ? `Sending ${sendProgress.completed.toLocaleString()} of ${sendProgress.total.toLocaleString()}…`
                            : selectedContactList.length > 1
                                ? `Send to all ${selectedContactList.length.toLocaleString()} selected contacts`
                                : 'Send to selected contact'}
                    </button>
                </section>
            </div>
        </div>
    );
}
