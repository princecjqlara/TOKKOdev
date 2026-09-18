'use client';

import { useCallback, useEffect, useState } from 'react';
import { Clock3, RefreshCw, Search, Send, Paperclip, X } from 'lucide-react';
import Pagination from '@/components/Pagination';
import { getSupabaseClient } from '@/lib/supabase';
import { MAX_MESSENGER_MEDIA_BYTES } from '@/lib/messenger-media';
import type { Contact, Page, PaginatedResponse, Tag } from '@/types';

type PreparedUpload = { path: string; token: string; type: 'image' | 'video' | 'audio' | 'file'; bucket: string };

function formatRemaining(lastInboundAt: string | null | undefined, now: number): string {
    if (!lastInboundAt) return 'No customer message';
    const remaining = new Date(lastInboundAt).getTime() + 7 * 24 * 60 * 60 * 1000 - now;
    if (remaining <= 0) return 'Expired';
    const hours = Math.floor(remaining / (60 * 60 * 1000));
    return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h left` : `${hours}h left`;
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
    const [listPage, setListPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
    const [text, setText] = useState('');
    const [file, setFile] = useState<File | null>(null);
    const [now, setNow] = useState(Date.now());
    const [loading, setLoading] = useState(false);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [refreshKey, setRefreshKey] = useState(0);

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

    useEffect(() => {
        if (!pageId) return;
        const controller = new AbortController();
        const params = new URLSearchParams({
            page: String(listPage), pageSize: '25', humanAgentWindow: 'true',
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
                setContacts(data.items || []);
                setTotal(data.total || 0);
                setSelectedContact((current) => current
                    ? (data.items || []).find((contact) => contact.id === current.id) || null
                    : null);
                setError('');
            })
            .catch((fetchError) => { if (fetchError.name !== 'AbortError') setError(fetchError.message); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [pageId, listPage, debouncedSearch, includeTagIds, excludeTagIds, refreshKey]);

    async function sendReply() {
        if (!pageId || !selectedContact || (!text.trim() && !file) || sending) return;
        setSending(true);
        setError('');
        setNotice('');
        try {
            let mediaPath = '';
            let mediaType = '';
            if (file) {
                if (file.size <= 0 || file.size > MAX_MESSENGER_MEDIA_BYTES) {
                    throw new Error('Choose a file up to 10 MB.');
                }
                const prepareResponse = await fetch(`/api/pages/${encodeURIComponent(pageId)}/human-agent-media`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mimeType: file.type, size: file.size })
                });
                const prepared: PreparedUpload & { message?: string } = await prepareResponse.json();
                if (!prepareResponse.ok) throw new Error(prepared.message || 'Could not prepare upload.');
                const { error: uploadError } = await getSupabaseClient().storage
                    .from(prepared.bucket)
                    .uploadToSignedUrl(prepared.path, prepared.token, file, { contentType: file.type });
                if (uploadError) throw new Error(`Media upload failed: ${uploadError.message}`);
                mediaPath = prepared.path;
                mediaType = prepared.type;
            }

            const response = await fetch(`/api/pages/${encodeURIComponent(pageId)}/human-agent-send`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contactId: selectedContact.id, text: text.trim(), mediaPath, mediaType })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || 'Messenger did not confirm the send.');
            setNotice(`Sent to ${selectedContact.name || 'this contact'} as a ${result.messagingType === 'HUMAN_AGENT' ? 'Human Agent' : 'standard'} reply.`);
            setText('');
            setFile(null);
            refreshContacts();
        } catch (sendError) {
            setError(sendError instanceof Error ? sendError.message : 'Could not send the reply.');
        } finally {
            setSending(false);
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
                Human Agent is for a staff member replying to one customer&apos;s inquiry, not a bulk campaign or automated follow-up. Meta must approve Human Agent access for the connected app.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 border border-black p-4">
                <label className="text-xs font-semibold">Facebook Page
                    <select value={pageId} onChange={(event) => {
                        setPageId(event.target.value); setListPage(1); setSelectedContact(null);
                        setIncludeTagIds([]); setExcludeTagIds([]); setText(''); setFile(null);
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
                <TagFilter label="Has any of these tags" tags={tags} selected={includeTagIds} onChange={(ids) => { setIncludeTagIds(ids); setListPage(1); }} />
                <TagFilter label="Exclude any of these tags" tags={tags} selected={excludeTagIds} onChange={(ids) => { setExcludeTagIds(ids); setListPage(1); }} />
            </div>

            {error && <p role="alert" className="border border-red-600 bg-red-50 text-red-800 p-3 text-sm">{error}</p>}
            {notice && <p role="status" className="border border-green-700 bg-green-50 text-green-800 p-3 text-sm">{notice}</p>}

            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] gap-5 items-start">
                <section className="border border-black min-w-0">
                    <div className="border-b border-black bg-[#f0f0f0] px-4 py-3 flex justify-between text-sm font-semibold">
                        <span>Eligible contacts</span><span>{total.toLocaleString()}</span>
                    </div>
                    {loading && <p className="p-4 text-sm text-gray-600">Loading contacts…</p>}
                    {!loading && contacts.length === 0 && <p className="p-4 text-sm text-gray-600">No contacts currently match this 7-day window and filter. Sync contacts if older conversations have not been imported yet.</p>}
                    {!loading && contacts.map((contact) => (
                        <button
                            key={contact.id}
                            type="button"
                            onClick={() => { setSelectedContact(contact); setError(''); setNotice(''); }}
                            className={`w-full text-left p-4 border-b border-black last:border-b-0 hover:bg-gray-50 ${selectedContact?.id === contact.id ? 'bg-gray-100 border-l-4 border-l-black' : ''}`}
                        >
                            <div className="flex justify-between gap-2">
                                <span className="font-semibold text-sm truncate">{contact.name || 'Unnamed contact'}</span>
                                <span className="text-xs whitespace-nowrap">{formatRemaining(contact.last_inbound_at, now)}</span>
                            </div>
                            <p className="text-xs text-gray-600 mt-1">Last customer message: {contact.last_inbound_at ? new Date(contact.last_inbound_at).toLocaleString() : 'Unknown'}</p>
                            <div className="flex flex-wrap gap-1 mt-2">
                                {(contact.tags || []).map((tag) => <span key={tag.id} className="border border-gray-400 px-1.5 py-0.5 text-xs">{tag.name}</span>)}
                            </div>
                        </button>
                    ))}
                    {total > 25 && <div className="p-3"><Pagination page={listPage} pageSize={25} total={total} onPageChange={setListPage} /></div>}
                </section>

                <section className="border border-black p-4 space-y-4 lg:sticky lg:top-4">
                    <h2 className="font-bold text-lg">Manual reply</h2>
                    <p className="text-sm">{selectedContact ? `To ${selectedContact.name || 'Unnamed contact'}` : 'Select one contact from the list.'}</p>
                    <label className="block text-xs font-semibold">Message text (optional when media is selected)
                        <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={2000} rows={5} placeholder="Reply to this customer’s inquiry…" className="mt-1 w-full border border-black p-2 text-sm font-normal resize-y" />
                    </label>
                    <div>
                        <label className="inline-flex items-center gap-2 border border-black px-3 py-2 text-sm cursor-pointer hover:bg-gray-100">
                            <Paperclip className="w-4 h-4" />Upload media
                            <input type="file" className="sr-only" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,audio/mpeg,audio/mp4,audio/wav,audio/ogg,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => setFile(event.target.files?.[0] || null)} />
                        </label>
                        {file && <div className="flex items-center justify-between gap-2 mt-2 text-xs border border-gray-400 p-2"><span className="truncate">{file.name} ({(file.size / (1024 * 1024)).toFixed(1)} MB)</span><button type="button" onClick={() => setFile(null)} aria-label="Remove media"><X className="w-4 h-4" /></button></div>}
                        <p className="text-xs text-gray-600 mt-2">Images, videos, audio, PDF, Word, or Excel files up to 10 MB. Media is a normal Messenger attachment, not a template header.</p>
                    </div>
                    {file && text.trim() && <p className="text-xs text-gray-600">Text and media will arrive as two Messenger messages from one send action.</p>}
                    <button
                        type="button"
                        disabled={!selectedContact || (!text.trim() && !file) || sending || (selectedContact ? formatRemaining(selectedContact.last_inbound_at, now) === 'Expired' : false)}
                        onClick={sendReply}
                        className="w-full flex items-center justify-center gap-2 bg-black text-white px-4 py-3 text-sm font-semibold disabled:opacity-50"
                    >
                        <Send className="w-4 h-4" />{sending ? 'Sending…' : 'Send to this contact'}
                    </button>
                </section>
            </div>
        </div>
    );
}
