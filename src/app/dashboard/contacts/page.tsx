'use client';

import { useSession } from 'next-auth/react';
import { useEffect, useState, useCallback, useRef } from 'react';
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
    CheckSquare,
    Link2,
    Plus,
    Calendar,
    Download,
    Image as ImageIcon
} from 'lucide-react';
import Pagination from '@/components/Pagination';
import Modal from '@/components/Modal';
import { Contact, Tag as TagType, Page, PaginatedResponse } from '@/types';
import {
    isRetryableSendError,
    mergeSendErrors,
    SendError,
    summarizeSendErrors
} from '@/lib/send-errors';
import { createRequestGate } from '@/lib/request-gate';
import { getSupabaseClient } from '@/lib/supabase';
import { UTILITY_TEMPLATES, getBaseTemplateName, getMediaTemplateName } from '@/lib/facebook-templates';
import type { TemplateMediaType } from '@/lib/facebook-templates';
import { runContactSyncToCompletion } from '@/lib/contact-sync-client';

// Map envelope wrapper values to template names
const ENVELOPE_TEMPLATE_MAP: Record<string, string> = {
    // Legacy Templates
    msg: 'general_msg_v1',
    notice: 'general_notice_v1',
    alert: 'general_alert_v1',
    btn_join: 'instant_meeting_btn_v1',
    btn_details: 'instant_meeting_btn_v2',
    btn_book: 'instant_meeting_btn_v3',
    // New Natural Templates
    friendly_1: 'friendly_msg_v1',
    friendly_2: 'friendly_msg_v2',
    friendly_3: 'friendly_msg_v3',
    friendly_4: 'friendly_msg_v4',
    friendly_5: 'friendly_msg_v5',
    friendly_6: 'friendly_msg_v6',
    casual_1: 'casual_update_v1',
    casual_2: 'casual_update_v3',
    casual_3: 'casual_update_v4',
    simple_1: 'simple_msg_v4',
};

// Map wrapper keys to human-readable names
function getEnvelopeName(key: string): string {
    switch (key) {
        case 'msg': return 'Standard Message';
        case 'notice': return 'System Notice';
        case 'alert': return 'System Alert';
        case 'btn_join': return 'Join Meeting Button';
        case 'btn_details': return 'Update Details Button';
        case 'btn_book': return 'Book Now Button';
        case 'friendly_1': return 'Friendly 1 (Just let you know)';
        case 'friendly_2': return 'Friendly 2 (Hi there)';
        case 'friendly_3': return 'Friendly 3 (Quick heads up)';
        case 'friendly_4': return 'Friendly 4 (Quick update)';
        case 'friendly_5': return 'Friendly 5 (In the loop)';
        case 'friendly_6': return 'Friendly 6 (Thought you should know)';
        case 'casual_1': return 'Casual 1 (Good news)';
        case 'casual_2': return 'Casual 2 (Checking in)';
        case 'casual_3': return 'Casual 3 (Quick reminder)';
        case 'simple_1': return 'Simple 1 (Just a note)';
        default: return key;
    }
}

function getTemplateBodyText(envelopeKey: string): string | null {
    const templateName = ENVELOPE_TEMPLATE_MAP[envelopeKey];
    if (!templateName) return null;
    const tmpl = UTILITY_TEMPLATES.find(t => t.name === templateName);
    if (!tmpl) return null;
    const bodyComponent = tmpl.components.find(c => c.type === 'BODY');
    return bodyComponent && 'text' in bodyComponent ? (bodyComponent.text ?? null) : null;
}

type DatePreset = 'today' | 'yesterday' | 'last7' | 'last30';
type DateFilterMode = 'include' | 'exclude';
type BulkDeliveryMode = 'now' | 'best_time_next_day';

type BestTimeScheduledCampaign = {
    id: string;
    messageNumber: number;
    scheduledAt: string;
    scheduledAtPh: string;
    recipients: number;
};

type BestTimeScheduleStatus = {
    campaignIds: string[];
    total: number;
    sent: number;
    failed: number;
    pending: number;
    notYetSent: number;
    allBestTimesSent: boolean;
};

const CONTACT_MEDIA_DRAFT_STORAGE_PREFIX = 'tokko:contact-bulk-media-draft:';
const CAMPAIGN_MEDIA_STORAGE_PREFIX = 'tokko:campaign-media:';
const MAX_LOCAL_MEDIA_BYTES = 3 * 1024 * 1024;

type StoredCampaignMedia = {
    url: string;
    type?: TemplateMediaType;
    templateName: string;
    savedAt: string;
};

function getContactMediaDraftStorageKey(pageId: string) {
    return `${CONTACT_MEDIA_DRAFT_STORAGE_PREFIX}${pageId}`;
}

function getCampaignMediaStorageKey(campaignId: string) {
    return `${CAMPAIGN_MEDIA_STORAGE_PREFIX}${campaignId}`;
}

const DATE_PRESETS: Array<{ value: DatePreset; label: string }> = [
    { value: 'today', label: 'Today' },
    { value: 'yesterday', label: 'Yesterday' },
    { value: 'last7', label: 'Last 7 days' },
    { value: 'last30', label: 'Last 30 days' }
];

function formatDateInputValue(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getDatePresetRange(preset: DatePreset): { from: string; to: string } {
    const today = new Date();
    const from = new Date(today);
    const to = new Date(today);

    if (preset === 'yesterday') {
        from.setDate(today.getDate() - 1);
        to.setDate(today.getDate() - 1);
    } else if (preset === 'last7') {
        from.setDate(today.getDate() - 6);
    } else if (preset === 'last30') {
        from.setDate(today.getDate() - 29);
    }

    return {
        from: formatDateInputValue(from),
        to: formatDateInputValue(to)
    };
}

async function readApiResponse(response: Response) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        return response.json();
    }

    const text = await response.text();
    return {
        message: text || `Request failed with status ${response.status}`
    };
}

type MessageButton = {
    type: 'URL' | 'QUICK_REPLY';
    text: string;
    url: string;
    payload: string;
};

type AvailableTemplate = {
    name: string;
    status: string;
    language?: string;
    category?: string;
    bodyText?: string;
    hasMediaHeader?: boolean;
    mediaHeaderType?: TemplateMediaType | null;
};

const URL_SCHEME_REGEX = /^[a-z][a-z\d+\-.]*:/i;

function normalizeButtonUrlForUi(rawUrl: string): string | null {
    const trimmed = rawUrl.trim();
    if (!trimmed) {
        return null;
    }

    const withScheme = URL_SCHEME_REGEX.test(trimmed) ? trimmed : `https://${trimmed}`;

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(withScheme);
    } catch {
        return null;
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return null;
    }

    const hostname = parsedUrl.hostname.trim().toLowerCase();
    if (!hostname) {
        return null;
    }

    if (hostname !== 'localhost' && !hostname.includes('.')) {
        return null;
    }

    return parsedUrl.toString();
}

function getMessageButtonError(
    button: MessageButton,
    _index: number,
    _options: { usePart2AsButtonValue: boolean; messagePart2: string }
): string | null {
    const text = button.text.trim();
    if (!text) {
        return 'Button text is required.';
    }

    if (button.type === 'URL') {
        if (!button.url.trim()) {
            return 'Link URL is required.';
        }

        if (!normalizeButtonUrlForUi(button.url)) {
            return 'Link must be a valid URL (e.g. https://example.com).';
        }
    }

    return null;
}

function normalizeButtonsForSend(
    buttons: MessageButton[],
    _options: { usePart2AsButtonValue: boolean; messagePart2: string }
): { buttons: MessageButton[]; errors: string[] } {
    const errors: string[] = [];

    const normalizedButtons = buttons.map((button, index) => {
        const text = button.text.trim();

        if (!text) {
            errors.push(`Button ${index + 1}: text is required.`);
            return null;
        }

        if (button.type === 'URL') {
            const normalizedUrl = normalizeButtonUrlForUi(button.url.trim());
            if (!normalizedUrl) {
                errors.push(`Button ${index + 1}: link URL is invalid.`);
                return null;
            }

            return {
                type: 'URL' as const,
                text,
                url: normalizedUrl,
                payload: ''
            };
        }

        return {
            type: 'QUICK_REPLY' as const,
            text,
            payload: button.payload.trim(),
            url: ''
        };
    });

    return {
        buttons: normalizedButtons.filter((button): button is MessageButton => button !== null),
        errors
    };
}

export default function ContactsPage() {
    const { data: session } = useSession();
    const [pages, setPages] = useState<Page[]>([]);
    const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [tags, setTags] = useState<TagType[]>([]);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [exportingConversations, setExportingConversations] = useState(false);
    const [availableTemplates, setAvailableTemplates] = useState<AvailableTemplate[]>([]);
    const [selectedTemplateName, setSelectedTemplateName] = useState<string | null>(null);
    const [selectedTemplateLanguage, setSelectedTemplateLanguage] = useState('en_US');
    const [templateSearch, setTemplateSearch] = useState('');

    // Pagination
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(25);
    const [total, setTotal] = useState(0);

    // Filters
    const [search, setSearch] = useState('');
    const [selectedTagFilters, setSelectedTagFilters] = useState<Set<string>>(new Set());
    const [excludedTagFilters, setExcludedTagFilters] = useState<Set<string>>(new Set());
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');
    const [dateFilterMode, setDateFilterMode] = useState<DateFilterMode>('include');

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
    const [messagePart1, setMessagePart1] = useState('');
    const [messagePart2, setMessagePart2] = useState('');
    const [bulkDeliveryMode, setBulkDeliveryMode] = useState<BulkDeliveryMode>('now');
    const [bulkMediaEnabled, setBulkMediaEnabled] = useState(false);
    const [bulkMediaUrl, setBulkMediaUrl] = useState('');
    const [scheduledMessages, setScheduledMessages] = useState(['', '', '']);
    const [bestTimeCampaigns, setBestTimeCampaigns] = useState<BestTimeScheduledCampaign[]>([]);
    const [bestTimeScheduleStatus, setBestTimeScheduleStatus] = useState<BestTimeScheduleStatus | null>(null);
    const [bestTimeStatusLoading, setBestTimeStatusLoading] = useState(false);
    const [messageButtons, setMessageButtons] = useState<MessageButton[]>([]);
    const [usePart2AsButtonValue, setUsePart2AsButtonValue] = useState(false);
    const [envelopeWrapper, setEnvelopeWrapper] = useState<string>('msg');
    const [actionLoading, setActionLoading] = useState(false);
    const [bulkSendProgress, setBulkSendProgress] = useState<string | null>(null);
    const [manualBatchEnabled, setManualBatchEnabled] = useState(false);
    const [manualBatchSize, setManualBatchSize] = useState(5000);
    const [manualBatchNumber, setManualBatchNumber] = useState(1);

    const messageText = `${messagePart1}|||${messagePart2}`;
    const [failedContactIds, setFailedContactIds] = useState<string[]>([]);
    const [failedContactErrors, setFailedContactErrors] = useState<SendError[]>([]);
    const [lastSendResults, setLastSendResults] = useState<{ sent: number; failed: number } | null>(null);
    const customButtonsDisabled = envelopeWrapper === 'template' || envelopeWrapper.startsWith('btn_');
    const firstMessageButtonError =
        customButtonsDisabled
            ? null
            : messageButtons
                .map((button, index) =>
                    getMessageButtonError(button, index, {
                        usePart2AsButtonValue,
                        messagePart2
                    })
                )
                .find((error): error is string => Boolean(error)) || null;
    const hasMessageButtonErrors = !customButtonsDisabled && firstMessageButtonError !== null;
    const dynamicModeMissingButton =
        !customButtonsDisabled && usePart2AsButtonValue && messageButtons.length === 0;
    const scheduledMessagesComplete = scheduledMessages.every((message) => message.trim().length > 0);
    const messageSubmitDisabled =
        actionLoading ||
        hasMessageButtonErrors ||
        dynamicModeMissingButton ||
        (bulkMediaEnabled && bulkDeliveryMode !== 'now') ||
        (bulkMediaEnabled && !bulkMediaUrl.trim()) ||
        (bulkDeliveryMode === 'best_time_next_day' ? !scheduledMessagesComplete : !messagePart1.trim());
    const realtimeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const realtimeFallbackIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const realtimeSubscribeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const webhookRefreshAttemptedRef = useRef<Set<string>>(new Set());
    const contactsRequestGateRef = useRef(createRequestGate());
    const activeDatePreset =
        DATE_PRESETS.find((preset) => {
            const range = getDatePresetRange(preset.value);
            return range.from === dateFrom && range.to === dateTo;
        })?.value || null;

    const applyDatePreset = (preset: DatePreset) => {
        const range = getDatePresetRange(preset);
        setDateFrom(range.from);
        setDateTo(range.to);
        setPage(1);
        clearSelection();
    };

    const clearDateFilter = () => {
        setDateFrom('');
        setDateTo('');
        setDateFilterMode('include');
        setPage(1);
        clearSelection();
    };

    useEffect(() => {
        fetchPages();
    }, []);

    useEffect(() => {
        if (selectedPageId) {
            fetchContacts();
            fetchTags();
        }
    }, [selectedPageId, page, pageSize, search, selectedTagFilters, excludedTagFilters, dateFrom, dateTo, dateFilterMode]);

    useEffect(() => {
        if (!selectedPageId) return;
        const stored = window.localStorage.getItem(getContactMediaDraftStorageKey(selectedPageId));
        if (!stored) {
            setBulkMediaUrl('');
            return;
        }

        try {
            const parsed = JSON.parse(stored) as { url?: string; type?: TemplateMediaType };
            setBulkMediaUrl(typeof parsed.url === 'string' ? parsed.url : '');
        } catch {
            setBulkMediaUrl(stored);
        }
    }, [selectedPageId]);

    useEffect(() => {
        if (bulkDeliveryMode === 'best_time_next_day') {
            setBulkMediaEnabled(false);
        }
    }, [bulkDeliveryMode]);

    useEffect(() => {
        if (selectedPageId) {
            const fetchTemplates = async () => {
                try {
                    const res = await fetch(`/api/facebook/templates/status?pageId=${selectedPageId}`);
                    const data = await readApiResponse(res);
                    if (!res.ok) {
                        throw new Error(data.message || data.detail || 'Failed to fetch templates');
                    }
                    const templates = ((data.templates || []) as AvailableTemplate[]).filter(
                        (template) =>
                            typeof template.name === 'string' &&
                            template.name.trim().length > 0 &&
                            typeof template.status === 'string' &&
                            template.status.trim().length > 0
                    );
                    setAvailableTemplates(templates);
                    const approvedTemplates = templates.filter((template: AvailableTemplate) =>
                        (template.status === 'APPROVED' || template.status === 'ACTIVE') &&
                        template.hasMediaHeader !== true
                    );
                    setSelectedTemplateName((current) => {
                        if (current && approvedTemplates.some((template: AvailableTemplate) => template.name === current)) {
                            return current;
                        }
                        const firstApproved = approvedTemplates[0];
                        if (firstApproved) {
                            setSelectedTemplateLanguage(firstApproved.language || 'en_US');
                            return firstApproved.name;
                        }
                        setSelectedTemplateLanguage('en_US');
                        return null;
                    });
                    
                    setEnvelopeWrapper(current => {
                        if (current === 'template' || current === 'none') return current;
                        const templateName = ENVELOPE_TEMPLATE_MAP[current];
                        if (!templateName) return 'template';
                        const isApproved = templates.some((t: any) => 
                            t.name === templateName && (t.status === 'APPROVED' || t.status === 'ACTIVE')
                        );
                        return isApproved ? current : 'template';
                    });
                } catch (error) {
                    console.error('Error fetching templates:', error);
                    setAvailableTemplates([]);
                    setSelectedTemplateName(null);
                    setSelectedTemplateLanguage('en_US');
                }
            };
            fetchTemplates();
        }
    }, [selectedPageId]);

    useEffect(() => {
        if (!selectedPageId) return;
        if (webhookRefreshAttemptedRef.current.has(selectedPageId)) return;

        webhookRefreshAttemptedRef.current.add(selectedPageId);

        const refreshWebhookSubscription = async () => {
            try {
                const response = await fetch(`/api/pages/${selectedPageId}/webhook`, {
                    method: 'POST'
                });

                if (!response.ok) {
                    const data = await response.json().catch(() => ({} as { message?: string }));
                    console.warn('[CONTACTS_WEBHOOK] Failed to refresh page webhook subscription', {
                        pageId: selectedPageId,
                        status: response.status,
                        message: data.message || null
                    });
                    return;
                }

                console.log('[CONTACTS_WEBHOOK] Page webhook subscription refreshed', {
                    pageId: selectedPageId
                });
            } catch (error) {
                console.warn('[CONTACTS_WEBHOOK] Error refreshing page webhook subscription', {
                    pageId: selectedPageId,
                    error: (error as Error).message
                });
            }
        };

        void refreshWebhookSubscription();
    }, [selectedPageId]);

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

    const fetchContacts = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
        if (!selectedPageId) return;

        const requestToken = contactsRequestGateRef.current.next();

        if (!silent) {
            setLoading(true);
        }
        try {
            const params = new URLSearchParams({
                page: page.toString(),
                pageSize: pageSize.toString(),
                ...(search && { search }),
                ...(selectedTagFilters.size > 0 && { tagIds: [...selectedTagFilters].join(',') }),
                ...(excludedTagFilters.size > 0 && { excludeTagIds: [...excludedTagFilters].join(',') }),
                ...(dateFrom && { dateFrom }),
                ...(dateTo && { dateTo }),
                ...((dateFrom || dateTo) && { dateFilterMode })
            });

            const res = await fetch(`/api/pages/${selectedPageId}/contacts?${params}`);
            const data: PaginatedResponse<Contact> = await res.json();

            if (!contactsRequestGateRef.current.isLatest(requestToken)) {
                return;
            }

            setContacts(data.items || []);
            setTotal(data.total || 0);
        } catch (error) {
            if (!contactsRequestGateRef.current.isLatest(requestToken)) {
                return;
            }
            console.error('Error fetching contacts:', error);
        } finally {
            if (!silent) {
                setLoading(false);
            }
        }
    }, [selectedPageId, page, pageSize, search, selectedTagFilters, excludedTagFilters, dateFrom, dateTo, dateFilterMode]);

    useEffect(() => {
        if (!selectedPageId) return;

        const supabase = getSupabaseClient();
        const stopFallbackPolling = () => {
            if (realtimeFallbackIntervalRef.current) {
                clearInterval(realtimeFallbackIntervalRef.current);
                realtimeFallbackIntervalRef.current = null;
            }
        };

        const startFallbackPolling = () => {
            if (realtimeFallbackIntervalRef.current) {
                return;
            }

            void fetchContacts({ silent: true });
            realtimeFallbackIntervalRef.current = setInterval(() => {
                void fetchContacts({ silent: true });
            }, 5000);
        };

        realtimeSubscribeTimeoutRef.current = setTimeout(() => {
            console.warn('Realtime subscription not ready; enabling contacts refresh fallback.');
            startFallbackPolling();
        }, 5000);

        const channel = supabase
            .channel(`contacts-page-${selectedPageId}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'contacts',
                    filter: `page_id=eq.${selectedPageId}`
                },
                (payload) => {
                    console.log('[CONTACTS_REALTIME] postgres_changes event received', {
                        pageId: selectedPageId,
                        eventType: payload.eventType,
                        table: payload.table,
                        schema: payload.schema
                    });

                    if (realtimeRefreshTimerRef.current) {
                        clearTimeout(realtimeRefreshTimerRef.current);
                    }

                    realtimeRefreshTimerRef.current = setTimeout(() => {
                        void fetchContacts({ silent: true });
                        realtimeRefreshTimerRef.current = null;
                    }, 250);
                }
            )
            .subscribe((status) => {
                console.log('[CONTACTS_REALTIME] subscription status', {
                    pageId: selectedPageId,
                    status
                });

                if (status === 'SUBSCRIBED') {
                    if (realtimeSubscribeTimeoutRef.current) {
                        clearTimeout(realtimeSubscribeTimeoutRef.current);
                        realtimeSubscribeTimeoutRef.current = null;
                    }
                    stopFallbackPolling();
                    return;
                }

                if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                    startFallbackPolling();
                }
            });

        return () => {
            if (realtimeRefreshTimerRef.current) {
                clearTimeout(realtimeRefreshTimerRef.current);
                realtimeRefreshTimerRef.current = null;
            }

            if (realtimeSubscribeTimeoutRef.current) {
                clearTimeout(realtimeSubscribeTimeoutRef.current);
                realtimeSubscribeTimeoutRef.current = null;
            }

            stopFallbackPolling();

            void supabase.removeChannel(channel);
        };
    }, [selectedPageId, fetchContacts]);

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
                    sendable: 'true', // Only fetch contacts with valid PSIDs for messaging
                    ...(search && { search }),
                    ...(selectedTagFilters.size > 0 && { tagIds: [...selectedTagFilters].join(',') }),
                    ...(excludedTagFilters.size > 0 && { excludeTagIds: [...excludedTagFilters].join(',') }),
                    ...(dateFrom && { dateFrom }),
                    ...(dateTo && { dateTo }),
                    ...((dateFrom || dateTo) && { dateFilterMode })
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

            const beforeExcludeCount = allIds.length;
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
            const result = await runContactSyncToCompletion(selectedPageId, {
                onProgress: ({ attempt, totalSynced, totalFailed, remainingPsids, cursor }) => {
                    if (remainingPsids.length > 0) {
                        console.warn(`Sync slice ${attempt} finished. Continuing ${remainingPsids.length} remaining contacts automatically.`);
                        return;
                    }

                    if (cursor) {
                        console.log(`Sync slice ${attempt} finished. Continuing with the next Facebook page: ${totalSynced} synced, ${totalFailed} failed.`);
                        return;
                    }

                    console.log(`Sync completed after ${attempt} slice(s): ${totalSynced} synced, ${totalFailed} failed.`);
                }
            });

            const data = {
                ...result.data,
                synced: result.totalSynced,
                failed: result.totalFailed
            };
            if (!result.completed) {
                throw new Error('Sync stopped before Facebook returned the final contacts page.');
            }
            if (data.success) {
                if (data.incremental) {
                    console.log(`✅ Incremental sync: ${data.synced} new/updated contacts synced${(data.restored || 0) > 0 ? `, ${data.restored} deleted contacts restored` : ''}`);
                } else {
                    console.log(`✅ Full sync: ${data.synced} contacts synced${(data.restored || 0) > 0 ? `, ${data.restored} deleted contacts restored` : ''}`);
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

    const mediaAvailableForBulk = bulkDeliveryMode === 'now';
    const mediaRequiredForBulk = bulkMediaEnabled && mediaAvailableForBulk;
    const mediaTemplateRequiredForBulk = mediaRequiredForBulk;
    const isApprovedTemplate = (template: AvailableTemplate) =>
        template.status === 'APPROVED' || template.status === 'ACTIVE';
    const findApprovedTemplate = (templateName: string, requireMedia: boolean = mediaTemplateRequiredForBulk) => {
        const expectedName = requireMedia ? getMediaTemplateName(templateName, 'image') : getBaseTemplateName(templateName);
        return availableTemplates.find((template) =>
            isApprovedTemplate(template) &&
            template.name === expectedName &&
            (requireMedia ? template.mediaHeaderType === 'image' : !template.hasMediaHeader)
        );
    };
    const approvedTemplates = availableTemplates.filter(
        (template) => isApprovedTemplate(template) && (mediaTemplateRequiredForBulk ? template.mediaHeaderType === 'image' : !template.hasMediaHeader)
    );
    const approvedImageTemplateCount = availableTemplates.filter(
        (template) => isApprovedTemplate(template) && template.mediaHeaderType === 'image'
    ).length;
    const normalizedTemplateSearch = templateSearch.trim().toLowerCase();
    const visibleApprovedTemplates = normalizedTemplateSearch
        ? approvedTemplates.filter((template) =>
            [
                template.name,
                template.language || 'en_US',
                template.category || '',
                template.bodyText || ''
            ]
                .join(' ')
                .toLowerCase()
                .includes(normalizedTemplateSearch)
        )
        : approvedTemplates;
    const selectedApprovedTemplate = selectedTemplateName
        ? approvedTemplates.find((template) =>
            template.name === selectedTemplateName &&
            (template.language || 'en_US') === (selectedTemplateLanguage || 'en_US')
        )
        : null;
    const approvedTemplateOptions =
        selectedApprovedTemplate &&
        !visibleApprovedTemplates.some((template) =>
            template.name === selectedApprovedTemplate.name &&
            (template.language || 'en_US') === (selectedApprovedTemplate.language || 'en_US')
        )
            ? [selectedApprovedTemplate, ...visibleApprovedTemplates]
            : visibleApprovedTemplates;
    const getApprovedTemplateOptionValue = (template: AvailableTemplate) =>
        `approved-template:${encodeURIComponent(template.name)}:${encodeURIComponent(template.language || 'en_US')}`;
    const selectedMessageStyleValue =
        envelopeWrapper === 'template' && selectedTemplateName
            ? `approved-template:${encodeURIComponent(selectedTemplateName)}:${encodeURIComponent(selectedTemplateLanguage || 'en_US')}`
            : envelopeWrapper;

    const handleMessageStyleChange = (value: string) => {
        if (value.startsWith('approved-template:')) {
            const [, encodedName = '', encodedLanguage = 'en_US'] = value.split(':');
            const name = decodeURIComponent(encodedName);
            const language = decodeURIComponent(encodedLanguage);

            setEnvelopeWrapper('template');
            setSelectedTemplateName(name || null);
            setSelectedTemplateLanguage(language || 'en_US');
            return;
        }

        setEnvelopeWrapper(value);
    };

    const updateBulkMediaUrl = (value: string) => {
        setBulkMediaUrl(value);
        if (!selectedPageId) return;

        if (value.trim()) {
            window.localStorage.setItem(
                getContactMediaDraftStorageKey(selectedPageId),
                JSON.stringify({ url: value, type: 'image' })
            );
        } else {
            window.localStorage.removeItem(getContactMediaDraftStorageKey(selectedPageId));
        }
    };

    const handleBulkMediaFile = (file: File | null) => {
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            alert('Please choose an image file.');
            return;
        }
        if (file.size > MAX_LOCAL_MEDIA_BYTES) {
            alert('Please choose a media file under 3 MB so it can fit in browser local storage.');
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result === 'string') {
                updateBulkMediaUrl(reader.result);
            }
        };
        reader.onerror = () => alert('Could not read that media file.');
        reader.readAsDataURL(file);
    };

    const getAvailableTemplateBody = (templateName: string | null): string | null => {
        if (!templateName) return null;
        return availableTemplates.find((template) => template.name === templateName)?.bodyText || null;
    };

    const updateScheduledMessage = (index: number, value: string) => {
        setScheduledMessages((current) => current.map((message, messageIndex) => (
            messageIndex === index ? value : message
        )));
    };

    const resetBestTimeScheduleState = () => {
        setBestTimeCampaigns([]);
        setBestTimeScheduleStatus(null);
        setBestTimeStatusLoading(false);
    };

    const refreshBestTimeBulkStatus = async (campaignIds = bestTimeCampaigns.map((campaign) => campaign.id)) => {
        if (!selectedPageId || campaignIds.length === 0) return;

        setBestTimeStatusLoading(true);
        try {
            const params = new URLSearchParams({
                campaignIds: campaignIds.join(',')
            });
            const response = await fetch(`/api/pages/${selectedPageId}/contacts/tracked-bulk-message?${params.toString()}`);
            const data = await readApiResponse(response);
            if (!response.ok) {
                throw new Error(data.message || 'Failed to refresh best-time schedule status');
            }
            setBestTimeScheduleStatus(data.status as BestTimeScheduleStatus);
        } catch (error) {
            console.error('Error refreshing best-time bulk status:', error);
            alert(`Failed to refresh best-time schedule status: ${(error as Error).message}`);
        } finally {
            setBestTimeStatusLoading(false);
        }
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

    const handleTrackedBulkMessage = async () => {
        if (getSelectionCount() === 0 || !selectedPageId) return;
        if (bulkDeliveryMode === 'now' && !messagePart1.trim()) return;

        const {
            buttons: normalizedMessageButtons,
            errors: messageButtonErrors
        } = normalizeButtonsForSend(messageButtons, {
            usePart2AsButtonValue,
            messagePart2
        });

        if (messageButtonErrors.length > 0) {
            alert(`Please fix button errors before sending:\n- ${messageButtonErrors.join('\n- ')}`);
            return;
        }

        if (!customButtonsDisabled && normalizedMessageButtons.length > 0) {
            alert('Safe 100k bulk sending does not support custom inline buttons yet. Use an approved template that already has buttons, or remove the custom buttons before sending.');
            return;
        }

        if (bulkDeliveryMode === 'best_time_next_day' && !scheduledMessagesComplete) {
            alert('Fill up all 3 scheduled messages before using best-time scheduling.');
            return;
        }

        if (bulkMediaEnabled && bulkDeliveryMode === 'best_time_next_day') {
            alert('Media attachments are not available for best-time scheduled bulk messages yet.');
            return;
        }

        if (mediaRequiredForBulk && !bulkMediaUrl.trim()) {
            alert('Add an image before sending.');
            return;
        }

        if (envelopeWrapper === 'template' && !selectedTemplateName) {
            alert('Pick an approved template before sending.');
            return;
        }

        const normalizedBulkMediaUrl = bulkMediaUrl.trim();
        const templateMediaHeader = mediaTemplateRequiredForBulk
            ? { type: 'image' as const, url: normalizedBulkMediaUrl }
            : undefined;

        setActionLoading(true);
        setBulkSendProgress(
            bulkDeliveryMode === 'best_time_next_day'
                ? 'Preparing best-time schedule for tomorrow PH time...'
                : 'Preparing tracked bulk send...'
        );
        setFailedContactIds([]);
        setFailedContactErrors([]);
        setLastSendResults(null);
        resetBestTimeScheduleState();

        try {
            const normalizedManualBatchSize = Math.max(1, Math.floor(Number(manualBatchSize) || 5000));
            const normalizedManualBatchNumber = Math.max(1, Math.floor(Number(manualBatchNumber) || 1));
            const selection = selectAllMode
                ? {
                    mode: 'all',
                    excludedContactIds: Array.from(excludedIds),
                    filters: {
                        search,
                        tagIds: Array.from(selectedTagFilters),
                        excludeTagIds: Array.from(excludedTagFilters),
                        dateFrom,
                        dateTo,
                        dateFilterMode
                    },
                    ...(manualBatchEnabled
                        ? {
                            slice: {
                                limit: normalizedManualBatchSize,
                                batchNumber: normalizedManualBatchNumber
                            }
                        }
                        : {})
                }
                : {
                    mode: 'specific',
                    contactIds: Array.from(selectedIds),
                    ...(manualBatchEnabled
                        ? {
                            slice: {
                                limit: normalizedManualBatchSize,
                                batchNumber: normalizedManualBatchNumber
                            }
                        }
                        : {})
                };

            const createResponse = await fetch(`/api/pages/${selectedPageId}/contacts/tracked-bulk-message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: `Bulk message ${new Date().toLocaleString()}`,
                    messagePart1,
                    messagePart2,
                    deliveryMode: bulkDeliveryMode,
                    scheduledMessages: bulkDeliveryMode === 'best_time_next_day' ? scheduledMessages : undefined,
                    envelopeWrapper,
                    templateName: envelopeWrapper === 'template' ? selectedTemplateName : undefined,
                    templateLanguage: envelopeWrapper === 'template' ? selectedTemplateLanguage : undefined,
                    templateMediaHeader,
                    selection
                })
            });

            const createData = await readApiResponse(createResponse);
            if (!createResponse.ok) {
                throw new Error(createData.message || 'Failed to create tracked bulk send');
            }

            if (createData.mode === 'best_time_next_day') {
                const selectedRange = createData.selectedRange;
                const batchLabel = selectedRange
                    ? `Batch ${selectedRange.batchNumber}: contacts ${selectedRange.start}-${selectedRange.end} of ${selectedRange.totalMatched}. `
                    : '';
                const campaigns = (createData.campaigns || []) as BestTimeScheduledCampaign[];
                const status = createData.status as BestTimeScheduleStatus;
                const skippedContacts = Number(createData.skippedContacts || 0);

                setBestTimeCampaigns(campaigns);
                setBestTimeScheduleStatus(status);
                setBulkSendProgress(
                    `${batchLabel}Scheduled ${status.total} best-time messages for ${createData.recipients} contact(s). ` +
                    `${status.sent} sent, ${status.pending} not yet sent, ${status.failed} failed.`
                );

                alert(
                    `Best-time bulk schedule created.\n\n` +
                    `${batchLabel}Eligible contacts: ${createData.recipients}\n` +
                    `Skipped without 3 best times: ${skippedContacts}\n` +
                    `Scheduled messages: ${status.total}\n` +
                    `Sent: ${status.sent}\n` +
                    `Not yet sent: ${status.pending}\n` +
                    `Failed: ${status.failed}\n\n` +
                    `cron-jobs.org should call /api/cron/campaign-scheduled to send them when due.`
                );
                await fetchContacts();
                return;
            }

            const campaignId = createData.campaign?.id;
            if (!campaignId) {
                throw new Error('Tracked campaign was created without an ID.');
            }

            if (templateMediaHeader && createData.campaign?.template_name) {
                window.localStorage.setItem(
                    getCampaignMediaStorageKey(campaignId),
                    JSON.stringify({
                        url: normalizedBulkMediaUrl,
                        type: 'image',
                        templateName: createData.campaign.template_name,
                        savedAt: new Date().toISOString()
                    } satisfies StoredCampaignMedia)
                );
            }

            let sendData = createData.send || {};
            let sent = Number(sendData.sent || 0);
            let failed = Number(sendData.failed || 0);
            let remaining = Number(sendData.remaining || Math.max((createData.recipients || 0) - sent - failed, 0));
            const selectedRange = createData.selectedRange;
            const batchLabel = selectedRange
                ? `Batch ${selectedRange.batchNumber}: contacts ${selectedRange.start}-${selectedRange.end} of ${selectedRange.totalMatched}. `
                : '';
            setBulkSendProgress(`${batchLabel}Campaign ${campaignId.slice(0, 8)}: ${sent} sent, ${failed} failed, ${remaining} pending`);

            while (sendData.partial && remaining > 0) {
                await new Promise(resolve => setTimeout(resolve, 100));

                const response = await fetch(`/api/campaigns/${campaignId}/send`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sendBatchSize: 20,
                        delayBetweenBatchesMs: 50,
                        maxProcessingTimeMs: 240000,
                        templateMediaHeader
                    })
                });

                sendData = await readApiResponse(response);
                if (!response.ok) {
                    throw new Error(sendData.message || `Failed to continue tracked send (HTTP ${response.status})`);
                }

                sent = Number(sendData.sent || sent);
                failed = Number(sendData.failed || failed);
                remaining = Number(sendData.remaining || Math.max((createData.recipients || 0) - sent - failed, 0));
                setBulkSendProgress(`${batchLabel}Campaign ${campaignId.slice(0, 8)}: ${sent} sent, ${failed} failed, ${remaining} pending`);
            }

            setLastSendResults({ sent, failed });
            setShowMessageModal(false);
            setMessagePart1('');
            setMessagePart2('');
            setMessageButtons([]);
            setBulkSendProgress(null);
            resetBestTimeScheduleState();
            clearSelection();

            alert(`Tracked bulk send finished.\n\n${batchLabel}Recipients in this campaign: ${createData.recipients}\nSent: ${sent}\nFailed: ${failed}\nCampaign ID: ${campaignId}`);
            await fetchContacts();
        } catch (error) {
            console.error('Error sending tracked bulk messages:', error);
            alert(`Tracked bulk send stopped: ${(error as Error).message}\n\nOpen Campaigns and press Send on the created campaign to resume pending recipients without resending completed ones.`);
        } finally {
            setActionLoading(false);
        }
    };

    const handleExportConversations = async () => {
        if (!selectedPageId || exportingConversations) return;

        setExportingConversations(true);
        try {
            const response = await fetch(`/api/pages/${selectedPageId}/conversations/export?format=csv`);

            if (!response.ok) {
                const data = await readApiResponse(response);
                throw new Error(data.message || 'Failed to export conversations');
            }

            const blob = await response.blob();
            const contentDisposition = response.headers.get('content-disposition') || '';
            const filenameMatch = contentDisposition.match(/filename="([^"]+)"/);
            const filename = filenameMatch?.[1] || 'facebook-conversations.csv';
            const downloadUrl = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = downloadUrl;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.URL.revokeObjectURL(downloadUrl);
        } catch (error) {
            console.error('Error exporting conversations:', error);
            alert((error as Error).message || 'Failed to export conversations');
        } finally {
            setExportingConversations(false);
        }
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

        const {
            buttons: normalizedMessageButtons,
            errors: messageButtonErrors
        } = normalizeButtonsForSend(messageButtons, {
            usePart2AsButtonValue,
            messagePart2
        });
        if (messageButtonErrors.length > 0) {
            alert(`Please fix button errors before sending:\n- ${messageButtonErrors.join('\n- ')}`);
            return;
        }

        if (!customButtonsDisabled && usePart2AsButtonValue && normalizedMessageButtons.length === 0) {
            alert('Dynamic button mode requires at least one button. Add a Link or Quick Reply button first.');
            return;
        }

        if (envelopeWrapper === 'template' && !selectedTemplateName) {
            alert('Pick an approved template before sending.');
            return;
        }

        if (bulkMediaEnabled && bulkDeliveryMode !== 'now') {
            alert('Media attachments are not available for scheduled bulk messages yet.');
            return;
        }

        if (mediaRequiredForBulk && !bulkMediaUrl.trim()) {
            alert('Add an image before sending.');
            return;
        }

        setActionLoading(true);
        try {
            setFailedContactIds([]);
            setFailedContactErrors([]);
            setLastSendResults(null);
            const allContactIds = await getSelectedContactIds();
            console.log(`📤 ========== STARTING BULK MESSAGE SEND ==========`);
            console.log(`📤 Total contacts selected: ${allContactIds.length}`);
            console.log(`📤 Selected page ID: ${selectedPageId}`);
            console.log(`📤 Selection mode: ${selectAllMode ? 'Select All' : 'Individual Selection'}`);
            if (selectAllMode) {
                console.log(`📤 Excluded contacts: ${excludedIds.size}`);
                console.log(`📤 Total contacts on page: ${total}`);
                console.log(`📤 Expected selected: ${total - excludedIds.size}`);
            } else {
                console.log(`📤 Individually selected: ${selectedIds.size}`);
            }
            console.log(`📤 Selected contact IDs sample (first 10):`, allContactIds.slice(0, 10));
            console.log(`📤 Selected contact IDs sample (last 10):`, allContactIds.slice(-10));
            console.log(`📤 ===============================================`);

            // CRITICAL VALIDATION: Ensure we actually have the expected number
            const expectedCount = selectAllMode ? (total - excludedIds.size) : selectedIds.size;
            if (allContactIds.length !== expectedCount) {
                console.error(`\n❌❌❌ CRITICAL SELECTION BUG DETECTED ❌❌❌`);
                console.error(`❌ Expected ${expectedCount} contacts but got ${allContactIds.length}!`);
                console.error(`❌ Missing: ${expectedCount - allContactIds.length} contacts`);
                console.error(`❌ This indicates a bug in contact selection logic`);
                console.error(`❌ Selection mode: ${selectAllMode ? 'Select All' : 'Individual'}`);
                if (selectAllMode) {
                    console.error(`❌ Total on page: ${total}, Excluded: ${excludedIds.size}, Expected: ${expectedCount}`);
                } else {
                    console.error(`❌ Selected IDs count: ${selectedIds.size}`);
                }
                console.error(`❌❌❌ END CRITICAL SELECTION BUG ❌❌❌\n`);
            }

            if (allContactIds.length === 0) {
                alert('No contacts selected. Please select contacts first.');
                setActionLoading(false);
                return;
            }


            // Store the original count for validation at the end
            const originalContactCount = allContactIds.length;
            console.log(`📤 Will attempt to send ${originalContactCount} contacts`);



            // Warn if selecting a very large number
            if (allContactIds.length > 1000) {
                console.warn(`⚠️ Large batch detected: ${allContactIds.length} contacts. This may take several minutes.`);
            }

            console.log(`📤 About to send ${allContactIds.length} contacts in ${Math.ceil(allContactIds.length / 5000)} chunk(s)`);
            console.log(`📤 Selected page ID: ${selectedPageId}`);
            console.log(`📤 IMPORTANT: Only contacts belonging to page ${selectedPageId} can be sent.`);
            console.log(`📤 If you selected contacts from multiple pages, only contacts from the selected page will be sent.`);

            // Chunk contacts into batches to avoid request body size limits and timeouts
            // Send in batches of 5000 contacts at a time
            const CHUNK_SIZE = 5000;
            let totalSent = 0;
            let totalFailed = 0;
            let totalFiltered = 0; // Track filtered contacts (wrong page_id or missing psid)
            let totalNotFound = 0; // Track contacts not found in database
            const allFailedIds: string[] = [];
            const errorGroups: SendError[][] = [];

            // Track which contacts we've attempted to send
            const contactsAttempted = new Set<string>();

            for (let i = 0; i < allContactIds.length; i += CHUNK_SIZE) {
                const chunk = allContactIds.slice(i, i + CHUNK_SIZE);
                const chunkNumber = Math.floor(i / CHUNK_SIZE) + 1;
                const totalChunks = Math.ceil(allContactIds.length / CHUNK_SIZE);

                console.log(`📤 Processing chunk ${chunkNumber}/${totalChunks} (${chunk.length} contacts)`);
                console.log(`📤 Chunk ${chunkNumber} contact IDs (first 5):`, chunk.slice(0, 5));

                // Track that we're attempting to send these contacts
                chunk.forEach(id => contactsAttempted.add(id));



                try {


                    const response = await fetch('/api/facebook/messages/send', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            pageId: selectedPageId,
                            contactIds: chunk,
                            messageText: messageText.trim(),
                            messagePart1,
                            messagePart2,
                            buttons: customButtonsDisabled ? [] : normalizedMessageButtons,
                            buttonMode: usePart2AsButtonValue ? 'RESPONSE_DYNAMIC' : 'TEMPLATE_STATIC',
                            buttonPlaceholderMode: false,
                            envelopeWrapper,
                            templateName: envelopeWrapper === 'template' ? selectedTemplateName : undefined,
                            templateLanguage: envelopeWrapper === 'template' ? selectedTemplateLanguage : undefined,
                            templateMediaHeader: mediaTemplateRequiredForBulk
                                ? { type: 'image' as const, url: bulkMediaUrl.trim() }
                                : undefined
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
                        // Log response details immediately
                        console.log(`📥 Chunk ${chunkNumber} response:`, {
                            requested: data.results.requested || chunk.length,
                            found: data.results.found || 'N/A',
                            valid: data.results.valid || chunk.length,
                            sent: data.results.sent || 0,
                            failed: data.results.failed || 0,
                            filtered: data.results.filtered || 0,
                            notFound: data.results.notFound || 0,
                            partial: data.partial || false
                        });

                        totalSent += data.results.sent || 0;
                        totalFailed += data.results.failed || 0;

                        // Track filtered contacts (contacts that were filtered out during lookup)
                        const filteredCount = data.results.filtered || 0;
                        const notFoundCount = data.results.notFound || 0;
                        totalFiltered += filteredCount; // Track filtered separately
                        totalNotFound += notFoundCount; // Track not found separately
                        const totalChunkFiltered = filteredCount + notFoundCount;



                        if (totalChunkFiltered > 0) {
                            console.error(`❌❌❌ Chunk ${chunkNumber}: ${totalChunkFiltered} contacts CANNOT be sent!`);
                            if (filteredCount > 0) {
                                console.error(`❌   - ${filteredCount} filtered out (wrong page_id or missing psid)`);
                            }
                            if (notFoundCount > 0) {
                                console.error(`❌   - ${notFoundCount} not found in database (may have been deleted)`);
                            }
                            console.error(`❌ Chunk ${chunkNumber} breakdown: ${data.results.requested || chunk.length} requested → ${data.results.valid || chunk.length} valid`);
                            console.error(`❌ SOLUTION: Sync the page again to fix page_id/psid issues, or re-add deleted contacts`);
                            console.error(`❌ Running total filtered so far: ${totalFiltered} contacts`);
                        }

                        // Collect failed contact IDs
                        if (data.results.errors?.length) {
                            allFailedIds.push(...data.results.errors.map((e: { contactId: string }) => e.contactId));
                            errorGroups.push(data.results.errors);
                        }

                        // If partial (timeout), automatically retry remaining contacts in smaller chunks
                        if (data.partial && data.remainingContactIds?.length > 0) {

                            console.warn(`⚠️⚠️⚠️ TIMEOUT DETECTED: Chunk ${chunkNumber} timed out!`);
                            console.warn(`⚠️ Processed: ${data.results.processed}/${chunk.length} contacts`);
                            console.warn(`⚠️ Remaining: ${data.remainingContactIds.length} contacts need to be retried`);
                            console.warn(`⚠️ Starting auto-retry for ${data.remainingContactIds.length} remaining contacts...`);
                            console.log(`📊 Chunk ${chunkNumber} results before retry: ${data.results.sent} sent, ${data.results.failed} failed`);

                            // Retry remaining contacts in smaller chunks to avoid repeated timeouts
                            const RETRY_CHUNK_SIZE = 2000; // Smaller chunks for retries
                            let remainingToRetry = [...data.remainingContactIds];
                            let retryChunkIndex = 0;

                            while (remainingToRetry.length > 0) {
                                const retryChunk = remainingToRetry.slice(0, RETRY_CHUNK_SIZE);
                                retryChunkIndex++;


                                console.log(`🔄 Auto-retry chunk ${retryChunkIndex} for ${retryChunk.length} contacts (${remainingToRetry.length} total remaining)`);

                                try {
                                    const retryResponse = await fetch('/api/facebook/messages/send', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            pageId: selectedPageId,
                                            contactIds: retryChunk,
                                            messageText: messageText.trim(),
                                            messagePart1,
                                            messagePart2,
                                            buttons: customButtonsDisabled ? [] : normalizedMessageButtons,
                                            buttonMode: usePart2AsButtonValue ? 'RESPONSE_DYNAMIC' : 'TEMPLATE_STATIC',
                                            buttonPlaceholderMode: false,
                                            envelopeWrapper,
                                            templateName: envelopeWrapper === 'template' ? selectedTemplateName : undefined,
                                            templateLanguage: envelopeWrapper === 'template' ? selectedTemplateLanguage : undefined
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

                                        // Track filtered and not found contacts from retry
                                        const retryFilteredCount = retryData.results.filtered || 0;
                                        const retryNotFoundCount = retryData.results.notFound || 0;
                                        totalFiltered += retryFilteredCount; // Track filtered separately
                                        totalNotFound += retryNotFoundCount; // Track not found separately
                                        if (retryFilteredCount > 0 || retryNotFoundCount > 0) {
                                            console.error(`❌ Retry chunk ${retryChunkIndex}: ${retryFilteredCount + retryNotFoundCount} contacts cannot be sent!`);
                                            if (retryFilteredCount > 0) {
                                                console.error(`❌   - ${retryFilteredCount} filtered out (wrong page_id or missing psid)`);
                                            }
                                            if (retryNotFoundCount > 0) {
                                                console.error(`❌   - ${retryNotFoundCount} not found in database`);
                                            }
                                        }

                                        // Collect failed contact IDs from retry
                                        if (retryData.results.errors?.length) {
                                            allFailedIds.push(...retryData.results.errors.map((e: { contactId: string }) => e.contactId));
                                            errorGroups.push(retryData.results.errors);
                                        }

                                        // If retry also timed out, update remaining list with still-remaining contacts
                                        if (retryData.partial && retryData.remainingContactIds?.length > 0) {
                                            // Calculate which contacts from this retry chunk were successfully processed
                                            const processedFromRetry = retryChunk.filter(id =>
                                                !retryData.remainingContactIds.includes(id)
                                            );
                                            // Remove processed contacts from remaining list
                                            const processedSet = new Set(processedFromRetry);
                                            remainingToRetry = remainingToRetry.filter(id => !processedSet.has(id));
                                            // Add back only the still-remaining contacts from this retry
                                            remainingToRetry = [...remainingToRetry, ...retryData.remainingContactIds];
                                            console.warn(`⚠️ Retry chunk ${retryChunkIndex} also timed out. ${retryData.remainingContactIds.length} contacts still remaining from this chunk.`);
                                        } else {
                                            // Successfully completed this retry chunk - remove from remaining list
                                            console.log(`✅ Auto-retry chunk ${retryChunkIndex} completed: ${retryData.results.sent} sent, ${retryData.results.failed} failed`);
                                            // Remove all contacts from this retry chunk
                                            const retryChunkSet = new Set(retryChunk);
                                            remainingToRetry = remainingToRetry.filter(id => !retryChunkSet.has(id));
                                        }
                                    } else {
                                        throw new Error(retryData.message || 'Retry failed');
                                    }
                                } catch (retryError) {
                                    console.error(`❌ Auto-retry chunk ${retryChunkIndex} failed:`, retryError);
                                    // Mark this chunk as failed and continue with next chunk
                                    totalFailed += retryChunk.length;
                                    allFailedIds.push(...retryChunk);
                                    const retryErrorMessage = retryError instanceof Error ? retryError.message : 'Retry failed';
                                    errorGroups.push(retryChunk.map(contactId => ({ contactId, error: retryErrorMessage })));
                                    remainingToRetry = remainingToRetry.slice(RETRY_CHUNK_SIZE);
                                }

                                // Safety check: if we've been retrying for too long, stop
                                if (retryChunkIndex > 50) {
                                    console.error(`❌ Too many retry chunks (${retryChunkIndex}). Stopping auto-retry. ${remainingToRetry.length} contacts will be marked as failed.`);
                                    totalFailed += remainingToRetry.length;
                                    allFailedIds.push(...remainingToRetry);
                                    break;
                                }
                            }

                            if (remainingToRetry.length === 0) {
                                console.log(`✅ All remaining contacts from chunk ${chunkNumber} have been processed.`);
                            }
                        } else if (data.partial) {
                            console.warn(`⚠️ Chunk ${chunkNumber} was partially processed: ${data.results.processed}/${chunk.length}`);
                        }

                        console.log(`✅ Chunk ${chunkNumber}/${totalChunks} complete: ${data.results.sent} sent, ${data.results.failed} failed`);
                    } else {
                        throw new Error(data.message || 'Failed to send messages');
                    }
                } catch (error) {
                    console.error(`❌❌❌ CRITICAL ERROR sending chunk ${chunkNumber}:`, error);
                    console.error(`❌ Error details:`, error);
                    console.error(`❌ This chunk (${chunk.length} contacts) will be marked as failed`);
                    console.error(`❌ Continuing with next chunk...`);
                    // Mark all contacts in this chunk as failed
                    totalFailed += chunk.length;
                    allFailedIds.push(...chunk);
                    const chunkErrorMessage = error instanceof Error ? error.message : 'Failed to send chunk';
                    errorGroups.push(chunk.map(contactId => ({ contactId, error: chunkErrorMessage })));
                    // Continue with next chunk instead of stopping
                    console.log(`📤 Continuing to next chunk...`);
                }
            }

            // Store failed contact IDs for resend option (retryable only)
            const mergedFailedErrors = mergeSendErrors(errorGroups);
            const retryableFailedIds = mergedFailedErrors
                .filter((entry) => isRetryableSendError(entry.error))
                .map((entry) => entry.contactId);
            const failedErrorSummary = summarizeSendErrors(mergedFailedErrors);

            setFailedContactIds(retryableFailedIds);
            setFailedContactErrors(mergedFailedErrors);
            setLastSendResults({ sent: totalSent, failed: totalFailed });

            // Calculate final totals
            // Calculate final totals - ensure we're tracking everything correctly
            const totalProcessed = totalSent + totalFailed;
            const totalUnsendable = totalFiltered + totalNotFound;
            const totalAccountedFor = totalProcessed + totalUnsendable;
            const unaccounted = originalContactCount - totalAccountedFor;

            // Validate that we attempted to send all contacts
            const contactsNotAttempted = originalContactCount - contactsAttempted.size;
            if (contactsNotAttempted > 0) {
                console.error(`❌❌❌ CRITICAL BUG: ${contactsNotAttempted} contacts were NEVER sent to the API!`);
                console.error(`❌ Original selected: ${originalContactCount}, Attempted: ${contactsAttempted.size}`);
                console.error(`❌ This indicates a bug in the chunking or loop logic - contacts were skipped`);
                // Add these to the unaccounted count
                // They should be marked as failed since they were never attempted
                totalFailed += contactsNotAttempted;
            }

            // Log intermediate totals for debugging
            console.log(`📊 Intermediate totals: sent=${totalSent}, failed=${totalFailed}, filtered=${totalFiltered}, notFound=${totalNotFound}`);
            console.log(`📊 Original selected: ${originalContactCount}, Attempted: ${contactsAttempted.size}, Accounted for: ${totalAccountedFor}, Unaccounted: ${unaccounted}`);

            // Print a very visible final summary
            console.log(`\n\n`);
            console.log(`╔════════════════════════════════════════════════════════════╗`);
            console.log(`║           FINAL BULK MESSAGE SEND SUMMARY                  ║`);
            console.log(`╠════════════════════════════════════════════════════════════╣`);
            console.log(`║ Total contacts selected:        ${originalContactCount.toString().padStart(10)} ║`);
            console.log(`║ Successfully sent:               ${totalSent.toString().padStart(10)} ║`);
            console.log(`║ Failed to send:                  ${totalFailed.toString().padStart(10)} ║`);
            console.log(`║ Filtered (wrong page/missing psid): ${totalFiltered.toString().padStart(10)} ║`);
            console.log(`║ Not found in database:          ${totalNotFound.toString().padStart(10)} ║`);
            console.log(`║ Total unsendable:                ${totalUnsendable.toString().padStart(10)} ║`);
            if (unaccounted > 0) {
                console.log(`║ Unaccounted for (BUG):            ${unaccounted.toString().padStart(10)} ║`);
            }
            console.log(`║ Total accounted for:              ${totalAccountedFor.toString().padStart(10)} ║`);
            console.log(`╠════════════════════════════════════════════════════════════╣`);

            if (totalUnsendable > 0) {
                const percentage = Math.round((totalUnsendable / allContactIds.length) * 100);
                console.log(`║ ❌❌❌ CRITICAL ISSUE DETECTED ❌❌❌                        ║`);
                console.log(`║ ${totalUnsendable} contacts (${percentage}%) were NOT sent!                    ║`);
                console.log(`║                                                          ║`);
                if (totalFiltered > 0) {
                    console.log(`║ ${totalFiltered} contacts filtered (wrong page_id or missing psid)      ║`);
                    console.log(`║   • Wrong page_id: contacts belong to different page                  ║`);
                    console.log(`║   • Missing psid: contacts need to be synced                          ║`);
                }
                if (totalNotFound > 0) {
                    console.log(`║ ${totalNotFound} contacts not found in database                        ║`);
                    console.log(`║   • May have been deleted or never synced                             ║`);
                }
                console.log(`║                                                          ║`);
                console.log(`║ SOLUTION: Sync the page again to fix page_id and psid   ║`);
                console.log(`║           issues. This will ensure all contacts can be   ║`);
                console.log(`║           sent in future operations.                     ║`);
            } else if (totalSent === allContactIds.length) {
                console.log(`║ ✅ SUCCESS: All ${totalSent} contacts were sent successfully!      ║`);
            } else {
                console.log(`║ ⚠️  PARTIAL: ${totalSent}/${allContactIds.length} contacts sent        ║`);
            }

            if (unaccounted > 0) {
                console.log(`║                                                          ║`);
                console.log(`║ ❌ COUNT MISMATCH BUG: ${unaccounted} contacts unaccounted for! ║`);
                console.log(`║    This indicates a bug - please report this issue.       ║`);
            }

            console.log(`╚════════════════════════════════════════════════════════════╝`);
            console.log(`\n\n`);

            // Use the already-calculated totalAccountedFor and unaccounted from above (lines 661-664)

            // Build comprehensive alert message
            let message = '';
            if (totalSent === allContactIds.length && totalFailed === 0 && totalUnsendable === 0) {
                // Perfect success
                message = `✅ All messages sent successfully!\n\nSuccess: ${totalSent}\nFailed: ${totalFailed}`;
                setFailedContactIds([]);
                setFailedContactErrors([]);
                setLastSendResults(null);
                setShowMessageModal(false);
                setMessagePart1('');
                setMessagePart2('');
                setMessageButtons([]);
                clearSelection();
            } else {
                // Partial success or issues
                message = `Messages sent!\n\n`;
                message += `✅ Successfully sent: ${totalSent}\n`;
                message += `❌ Failed to send: ${totalFailed}\n`;
                if (totalFiltered > 0) {
                    message += `⚠️ Filtered (wrong page/missing psid): ${totalFiltered}\n`;
                }
                if (totalNotFound > 0) {
                    message += `⚠️ Not found in database: ${totalNotFound}\n`;
                }
                message += `📊 Total selected: ${allContactIds.length}\n`;

                if (totalUnsendable > 0) {
                    message += `\n\n⚠️ IMPORTANT: ${totalUnsendable} contacts were NOT sent!\n`;
                    if (totalFiltered > 0) {
                        message += `\n${totalFiltered} contacts filtered (wrong page_id or missing psid)\n`;
                    }
                    if (totalNotFound > 0) {
                        message += `${totalNotFound} contacts not found in database\n`;
                    }
                    message += `\nSOLUTION: Sync the page again to fix page_id and psid issues.`;
                }

                if (unaccounted > 0) {
                    message += `\n\n❌ ERROR: ${unaccounted} contacts are unaccounted for (this is a bug).`;
                }

                if (failedErrorSummary.utilityPermissionMissing > 0) {
                    message += `\n\n⚠️ ${failedErrorSummary.utilityPermissionMissing} failed due to missing pages_utility_messaging permission.`;
                }

                if (failedErrorSummary.utilityTemplateMissing > 0) {
                    message += `\n⚠️ ${failedErrorSummary.utilityTemplateMissing} failed because utility template is not approved/available (#100).`;
                }

                if (failedErrorSummary.recipientUnavailable > 0) {
                    message += `\n⚠️ ${failedErrorSummary.recipientUnavailable} recipients are unavailable right now (#551).`;
                }

                if (retryableFailedIds.length > 0) {
                    message += `\n\nYou can resend to failed contacts using the "Resend to Failed" button.`;
                } else if (totalFailed > 0) {
                    message += `\n\nNo retryable failures remain.`;
                }
            }

            alert(message);

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

        const {
            buttons: normalizedMessageButtons,
            errors: messageButtonErrors
        } = normalizeButtonsForSend(messageButtons, {
            usePart2AsButtonValue,
            messagePart2
        });
        if (messageButtonErrors.length > 0) {
            alert(`Please fix button errors before sending:\n- ${messageButtonErrors.join('\n- ')}`);
            return;
        }

        if (!customButtonsDisabled && usePart2AsButtonValue && normalizedMessageButtons.length === 0) {
            alert('Dynamic button mode requires at least one button. Add a Link or Quick Reply button first.');
            return;
        }

        if (envelopeWrapper === 'template' && !selectedTemplateName) {
            alert('Pick an approved template before sending.');
            return;
        }

        if (bulkMediaEnabled && bulkDeliveryMode !== 'now') {
            alert('Media attachments are not available for scheduled bulk messages yet.');
            return;
        }

        if (mediaRequiredForBulk && !bulkMediaUrl.trim()) {
            alert('Add an image before resending.');
            return;
        }

        setActionLoading(true);
        try {
            const response = await fetch('/api/facebook/messages/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pageId: selectedPageId,
                    contactIds: failedContactIds,
                    messageText: messageText.trim(),
                    messagePart1,
                    messagePart2,
                    buttons: customButtonsDisabled ? [] : normalizedMessageButtons,
                    buttonMode: usePart2AsButtonValue ? 'RESPONSE_DYNAMIC' : 'TEMPLATE_STATIC',
                    buttonPlaceholderMode: false,
                    envelopeWrapper,
                    templateName: envelopeWrapper === 'template' ? selectedTemplateName : undefined,
                    templateLanguage: envelopeWrapper === 'template' ? selectedTemplateLanguage : undefined,
                    templateMediaHeader: mediaTemplateRequiredForBulk
                        ? { type: 'image' as const, url: bulkMediaUrl.trim() }
                        : undefined
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
                const mergedRetryErrors = mergeSendErrors([data.results.errors || []]);
                const retryableFailedIds = mergedRetryErrors
                    .filter((entry) => isRetryableSendError(entry.error))
                    .map((entry) => entry.contactId);
                const retryErrorSummary = summarizeSendErrors(mergedRetryErrors);

                setFailedContactIds(retryableFailedIds);
                setFailedContactErrors(mergedRetryErrors);
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
                        if (retryableFailedIds.length > 0) {
                            message += `\n\nYou can try resending to the failed contacts again.`;
                        }
                    }

                    if (retryErrorSummary.utilityPermissionMissing > 0) {
                        message += `\n\n⚠️ ${retryErrorSummary.utilityPermissionMissing} failed due to missing pages_utility_messaging permission.`;
                    }

                    if (retryErrorSummary.utilityTemplateMissing > 0) {
                        message += `\n⚠️ ${retryErrorSummary.utilityTemplateMissing} failed because utility template is not approved/available (#100).`;
                    }

                    if (retryErrorSummary.recipientUnavailable > 0) {
                        message += `\n⚠️ ${retryErrorSummary.recipientUnavailable} recipients are unavailable right now (#551).`;
                    }

                    if (retryableFailedIds.length === 0) {
                        message += `\n\nNo retryable failures remain.`;
                    }
                    alert(message);
                } else {
                    alert(`Resend complete! All ${data.results.sent} messages sent successfully!`);
                    setFailedContactIds([]);
                    setFailedContactErrors([]);
                    setLastSendResults(null);
                    setShowMessageModal(false);
                    setMessagePart1('');
                    setMessagePart2('');
                    setMessageButtons([]);
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
    const failedErrorSummary = summarizeSendErrors(failedContactErrors);

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

                    <button
                        onClick={handleExportConversations}
                        disabled={!selectedPageId || exportingConversations}
                        className="btn-wireframe"
                    >
                        <Download className={`w-4 h-4 mr-2 ${exportingConversations ? 'animate-pulse' : ''}`} />
                        {exportingConversations ? 'Exporting' : 'Export CSV'}
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

                    {/* Include Tags Filter */}
                    <div className="flex items-center gap-2 flex-wrap">
                        <Filter className="w-4 h-4 flex-shrink-0" />
                        <span className="text-[10px] font-bold uppercase text-gray-500 flex-shrink-0">Include:</span>
                        {tags.map((tag) => {
                            const isActive = selectedTagFilters.has(tag.id);
                            return (
                                <button
                                    key={tag.id}
                                    onClick={() => {
                                        const next = new Set(selectedTagFilters);
                                        if (isActive) next.delete(tag.id); else next.add(tag.id);
                                        // Remove from exclude if being added to include
                                        if (!isActive) {
                                            const nextExcl = new Set(excludedTagFilters);
                                            nextExcl.delete(tag.id);
                                            setExcludedTagFilters(nextExcl);
                                        }
                                        setSelectedTagFilters(next);
                                        setPage(1);
                                        clearSelection();
                                    }}
                                    className={`text-[10px] font-bold uppercase px-2 py-0.5 border transition-colors ${isActive
                                        ? 'bg-black text-white border-black'
                                        : 'bg-white text-gray-600 border-gray-300 hover:border-black'
                                        }`}
                                    style={isActive ? { backgroundColor: tag.color, borderColor: tag.color } : {}}
                                >
                                    {tag.name}
                                </button>
                            );
                        })}
                        {selectedTagFilters.size > 0 && (
                            <button
                                onClick={() => { setSelectedTagFilters(new Set()); setPage(1); clearSelection(); }}
                                className="text-[10px] font-bold uppercase text-gray-400 hover:text-black underline px-1"
                            >
                                Clear
                            </button>
                        )}
                    </div>

                    {/* Exclude Tags Filter */}
                    <div className="flex items-center gap-2 flex-wrap">
                        <X className="w-4 h-4 flex-shrink-0 text-red-500" />
                        <span className="text-[10px] font-bold uppercase text-gray-500 flex-shrink-0">Exclude:</span>
                        {tags.map((tag) => {
                            const isActive = excludedTagFilters.has(tag.id);
                            return (
                                <button
                                    key={tag.id}
                                    onClick={() => {
                                        const next = new Set(excludedTagFilters);
                                        if (isActive) next.delete(tag.id); else next.add(tag.id);
                                        // Remove from include if being added to exclude
                                        if (!isActive) {
                                            const nextIncl = new Set(selectedTagFilters);
                                            nextIncl.delete(tag.id);
                                            setSelectedTagFilters(nextIncl);
                                        }
                                        setExcludedTagFilters(next);
                                        setPage(1);
                                        clearSelection();
                                    }}
                                    className={`text-[10px] font-bold uppercase px-2 py-0.5 border transition-colors ${isActive
                                        ? 'bg-red-600 text-white border-red-600 line-through'
                                        : 'bg-white text-gray-600 border-gray-300 hover:border-red-400'
                                        }`}
                                >
                                    {tag.name}
                                </button>
                            );
                        })}
                        {excludedTagFilters.size > 0 && (
                            <button
                                onClick={() => { setExcludedTagFilters(new Set()); setPage(1); clearSelection(); }}
                                className="text-[10px] font-bold uppercase text-gray-400 hover:text-black underline px-1"
                            >
                                Clear
                            </button>
                        )}
                    </div>

                    {/* Date Range Filter */}
                    <div className="flex items-center gap-2 flex-wrap">
                        <Calendar className="w-4 h-4 flex-shrink-0 text-gray-500" />
                        <span className="text-[10px] font-bold uppercase text-gray-500 flex-shrink-0">Date:</span>
                        <div className="flex items-center border border-gray-300">
                            <button
                                type="button"
                                onClick={() => { setDateFilterMode('include'); setPage(1); clearSelection(); }}
                                className={`text-[10px] font-bold uppercase px-2 py-0.5 transition-colors ${dateFilterMode === 'include'
                                    ? 'bg-black text-white'
                                    : 'bg-white text-gray-600 hover:bg-gray-50'
                                    }`}
                            >
                                Include
                            </button>
                            <button
                                type="button"
                                onClick={() => { setDateFilterMode('exclude'); setPage(1); clearSelection(); }}
                                className={`text-[10px] font-bold uppercase px-2 py-0.5 border-l border-gray-300 transition-colors ${dateFilterMode === 'exclude'
                                    ? 'bg-red-600 text-white'
                                    : 'bg-white text-gray-600 hover:bg-red-50'
                                    }`}
                            >
                                Exclude
                            </button>
                        </div>
                        <div className="flex items-center gap-1 flex-wrap">
                            {DATE_PRESETS.map((preset) => {
                                const isActive = activeDatePreset === preset.value;
                                return (
                                    <button
                                        key={preset.value}
                                        type="button"
                                        onClick={() => applyDatePreset(preset.value)}
                                        className={`text-[10px] font-bold uppercase px-2 py-0.5 border transition-colors ${isActive
                                            ? 'bg-black text-white border-black'
                                            : 'bg-white text-gray-600 border-gray-300 hover:border-black'
                                            }`}
                                    >
                                        {preset.label}
                                    </button>
                                );
                            })}
                        </div>
                        <input
                            type="date"
                            value={dateFrom}
                            onChange={(e) => { setDateFrom(e.target.value); setPage(1); clearSelection(); }}
                            className="input-wireframe text-[10px] h-7 px-1.5 w-[120px]"
                            placeholder="From"
                        />
                        <span className="text-[10px] text-gray-400">to</span>
                        <input
                            type="date"
                            value={dateTo}
                            onChange={(e) => { setDateTo(e.target.value); setPage(1); clearSelection(); }}
                            className="input-wireframe text-[10px] h-7 px-1.5 w-[120px]"
                            placeholder="To"
                        />
                        {(dateFrom || dateTo) && (
                            <button
                                onClick={clearDateFilter}
                                className="text-[10px] font-bold uppercase text-gray-400 hover:text-black underline px-1"
                            >
                                Clear
                            </button>
                        )}
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
                            <th>Best Time</th>
                            <th>Last Active</th>
                            <th>First Message</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white">
                        {loading ? (
                            <tr>
                                <td colSpan={6} className="text-center py-12">
                                    <div className="animate-spin w-8 h-8 border-2 border-black border-t-transparent rounded-full mx-auto" />
                                </td>
                            </tr>
                        ) : contacts.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="text-center py-20">
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
                                                    {contact.name || 'Unnamed Contact'}
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
                                                <div
                                                    key={tag.id}
                                                    className="flex items-center gap-2 border border-black bg-white px-2 py-1"
                                                >
                                                    <span
                                                        className="badge-wireframe"
                                                        style={{
                                                            backgroundColor: tag.color,
                                                            color: '#fff',
                                                            borderColor: 'black'
                                                        }}
                                                    >
                                                        {tag.name}
                                                    </span>
                                                    <span className="font-mono text-[10px] text-gray-500 whitespace-nowrap">
                                                        by {tag.tagged_by_name || 'unknown'}
                                                    </span>
                                                </div>
                                            ))}
                                            {(contact.tags?.length || 0) > 3 && (
                                                <span className="badge-wireframe bg-gray-100 text-black">
                                                    +{(contact.tags?.length || 0) - 3}
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td>
                                        {contact.best_contact_hour !== null && contact.best_contact_hour !== undefined ? (
                                            <div className="flex flex-col gap-1">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    {(() => {
                                                        const hours = contact.best_contact_hours || [];
                                                        const displayHours = hours.slice(0, 3);

                                                        if (displayHours.length === 0) {
                                                            // Fallback to single hour display
                                                            const hour = contact.best_contact_hour;
                                                            const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
                                                            const ampm = hour < 12 ? 'AM' : 'PM';
                                                            return <span className="font-mono text-xs">{displayHour}:00 {ampm}</span>;
                                                        }

                                                        return displayHours.map((h, idx) => {
                                                            const displayHour = h.hour === 0 ? 12 : h.hour > 12 ? h.hour - 12 : h.hour;
                                                            const ampm = h.hour < 12 ? 'AM' : 'PM';
                                                            return (
                                                                <span
                                                                    key={h.hour}
                                                                    className={`font-mono text-xs px-1.5 py-0.5 border ${idx === 0 ? 'bg-black text-white border-black font-bold' : 'bg-gray-100 border-gray-300'}`}
                                                                    title={`${h.count} messages at this time`}
                                                                >
                                                                    {displayHour}{ampm.toLowerCase()} ({h.count})
                                                                </span>
                                                            );
                                                        });
                                                    })()}
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <span className={`text-[10px] px-1.5 py-0.5 border font-bold uppercase ${contact.best_contact_confidence === 'high' ? 'bg-green-100 border-green-500 text-green-700' :
                                                        contact.best_contact_confidence === 'medium' ? 'bg-yellow-100 border-yellow-500 text-yellow-700' :
                                                            contact.best_contact_confidence === 'inferred' ? 'bg-blue-100 border-blue-500 text-blue-700' :
                                                                contact.best_contact_confidence === 'low' ? 'bg-gray-100 border-gray-400 text-gray-600' :
                                                                    'bg-gray-50 border-gray-300 text-gray-400'
                                                        }`}>
                                                        {contact.best_contact_confidence || 'none'}
                                                    </span>
                                                    {(contact.interaction_count ?? 0) > 0 && (
                                                        <span className="text-[10px] text-gray-400 font-mono">
                                                            {contact.interaction_count} msgs
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        ) : (
                                            <span className="font-mono text-xs text-gray-400">—</span>
                                        )}
                                    </td>
                                    <td className="font-mono text-xs text-gray-500">
                                        {contact.last_interaction_at
                                            ? new Date(contact.last_interaction_at).toLocaleDateString()
                                            : 'NEVER'}
                                    </td>
                                    <td className="font-mono text-xs text-gray-500">
                                        <div className="flex items-center gap-1">
                                            <Calendar className="w-3 h-3 text-gray-400" />
                                            {contact.first_interaction_at
                                                ? new Date(contact.first_interaction_at).toLocaleDateString()
                                                : contact.created_at
                                                    ? new Date(contact.created_at).toLocaleDateString()
                                                    : '—'}
                                        </div>
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
                        setFailedContactErrors([]);
                        setLastSendResults(null);
                        setMessageButtons([]);
                        setUsePart2AsButtonValue(false);
                        setBulkSendProgress(null);
                        resetBestTimeScheduleState();
                    }
                }}
                title="Send Message"
            >
                <div className="space-y-4">
                    {bulkSendProgress && (
                        <div className="bg-blue-50 border-2 border-blue-300 p-3 rounded">
                            <p className="font-mono text-sm text-blue-800">{bulkSendProgress}</p>
                        </div>
                    )}
                    {bestTimeScheduleStatus && (
                        <div className="border-2 border-black bg-white p-3 rounded space-y-3">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <p className="text-xs font-bold uppercase text-gray-600">Best-Time Schedule Status</p>
                                    <p className="font-mono text-sm text-black">
                                        {bestTimeScheduleStatus.sent} sent / {bestTimeScheduleStatus.pending} not yet sent / {bestTimeScheduleStatus.failed} failed
                                    </p>
                                </div>
                                <span className={`text-[10px] px-2 py-1 border font-bold uppercase ${
                                    bestTimeScheduleStatus.allBestTimesSent
                                        ? 'bg-green-100 text-green-700 border-green-500'
                                        : 'bg-yellow-100 text-yellow-800 border-yellow-500'
                                }`}>
                                    {bestTimeScheduleStatus.allBestTimesSent ? 'All 3 Sent' : 'Pending'}
                                </span>
                            </div>
                            <div className="h-2 bg-gray-100 border border-gray-300">
                                <div
                                    className="h-full bg-black"
                                    style={{
                                        width: `${bestTimeScheduleStatus.total > 0
                                            ? Math.min(100, Math.round((bestTimeScheduleStatus.sent / bestTimeScheduleStatus.total) * 100))
                                            : 0}%`
                                    }}
                                />
                            </div>
                            {bestTimeCampaigns.length > 0 && (
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                    {bestTimeCampaigns.map((campaign) => (
                                        <div key={campaign.id} className="border border-gray-200 bg-gray-50 p-2">
                                            <p className="text-[10px] font-bold uppercase text-gray-500">Message {campaign.messageNumber}</p>
                                            <p className="text-xs font-mono text-gray-700">{campaign.scheduledAtPh} PH</p>
                                            <p className="text-[10px] font-mono text-gray-500">{campaign.recipients} recipients</p>
                                        </div>
                                    ))}
                                </div>
                            )}
                            <button
                                type="button"
                                onClick={() => refreshBestTimeBulkStatus()}
                                disabled={bestTimeStatusLoading || bestTimeCampaigns.length === 0}
                                className="btn-ghost-wireframe text-xs flex items-center gap-2"
                            >
                                <RefreshCw className={`w-3.5 h-3.5 ${bestTimeStatusLoading ? 'animate-spin' : ''}`} />
                                Refresh Status
                            </button>
                        </div>
                    )}
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

                    {failedContactIds.length === 0 && (
                        <div className="border border-gray-200 bg-gray-50 p-3 rounded space-y-3">
                            <label className="flex items-center gap-2 text-xs font-mono text-gray-700">
                                <input
                                    type="checkbox"
                                    checked={manualBatchEnabled}
                                    onChange={(event) => setManualBatchEnabled(event.target.checked)}
                                    disabled={actionLoading}
                                    className="h-4 w-4 border border-black"
                                />
                                Send only one manual batch from this selection
                            </label>

                            {manualBatchEnabled && (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div>
                                        <label className="block text-[10px] font-bold uppercase text-gray-500 mb-1">
                                            Contacts Per Batch
                                        </label>
                                        <input
                                            type="number"
                                            min={1}
                                            step={100}
                                            value={manualBatchSize}
                                            onChange={(event) => setManualBatchSize(Math.max(1, Math.floor(Number(event.target.value) || 1)))}
                                            disabled={actionLoading}
                                            className="input-wireframe"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-[10px] font-bold uppercase text-gray-500 mb-1">
                                            Batch Number
                                        </label>
                                        <input
                                            type="number"
                                            min={1}
                                            step={1}
                                            value={manualBatchNumber}
                                            onChange={(event) => setManualBatchNumber(Math.max(1, Math.floor(Number(event.target.value) || 1)))}
                                            disabled={actionLoading}
                                            className="input-wireframe"
                                        />
                                    </div>
                                    <p className="sm:col-span-2 text-[11px] font-mono text-gray-600">
                                        {(() => {
                                            const selectionCount = getSelectionCount();
                                            const size = Math.max(1, Math.floor(Number(manualBatchSize) || 1));
                                            const batch = Math.max(1, Math.floor(Number(manualBatchNumber) || 1));
                                            const start = (batch - 1) * size + 1;
                                            const end = Math.min(batch * size, selectionCount);

                                            if (start > selectionCount) {
                                                return `Batch ${batch} is outside this selection. ${selectionCount} contacts are selected.`;
                                            }

                                            return `Batch ${batch} will create a campaign for contacts ${start}-${end} of ${selectionCount}.`;
                                        })()}
                                    </p>
                                </div>
                            )}
                        </div>
                    )}

                    {failedContactIds.length === 0 && (
                        <div className="border border-gray-200 bg-gray-50 p-3 rounded space-y-3">
                            <label className="text-xs font-bold uppercase text-gray-700 block">Delivery Timing</label>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setBulkDeliveryMode('now');
                                        resetBestTimeScheduleState();
                                    }}
                                    disabled={actionLoading}
                                    className={`border px-3 py-3 text-left ${
                                        bulkDeliveryMode === 'now'
                                            ? 'border-black bg-white'
                                            : 'border-gray-300 bg-transparent'
                                    }`}
                                >
                                    <p className="font-bold uppercase text-sm">Send Now</p>
                                    <p className="text-xs text-gray-500 font-mono mt-1">Create and send the tracked bulk campaign immediately.</p>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setBulkDeliveryMode('best_time_next_day');
                                        setBulkMediaEnabled(false);
                                        resetBestTimeScheduleState();
                                    }}
                                    disabled={actionLoading}
                                    className={`border px-3 py-3 text-left ${
                                        bulkDeliveryMode === 'best_time_next_day'
                                            ? 'border-black bg-white'
                                            : 'border-gray-300 bg-transparent'
                                    }`}
                                >
                                    <p className="font-bold uppercase text-sm">Best Time Tomorrow</p>
                                    <p className="text-xs text-gray-500 font-mono mt-1">Schedule 3 messages for each contact&apos;s top 3 best times on the next PH day.</p>
                                </button>
                            </div>
                            {bulkDeliveryMode === 'best_time_next_day' && (
                                <p className="text-[11px] font-mono text-gray-600">
                                    Contacts without 3 saved best-time hours are skipped. Sending is handled when cron-jobs.org calls the scheduled campaign cron.
                                </p>
                            )}
                        </div>
                    )}

                    <div className="border border-gray-200 bg-gray-50 p-4 space-y-3">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                            <div>
                                <span className="font-bold uppercase text-sm flex items-center gap-1.5">
                                    <ImageIcon className="w-4 h-4" />
                                    Send Type
                                </span>
                                <p className="text-xs text-gray-500 font-mono mt-1">
                                    Media is stored in this browser only. Photos use approved image header templates.
                                </p>
                            </div>
                            <span className="text-xs font-mono text-gray-500">
                                {approvedImageTemplateCount} approved photo templates
                            </span>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <button
                                type="button"
                                onClick={() => {
                                    setBulkMediaEnabled(false);
                                    setSelectedTemplateName((current) => current ? getBaseTemplateName(current) : current);
                                }}
                                disabled={actionLoading}
                                className={`border px-3 py-3 text-left ${
                                    !bulkMediaEnabled
                                        ? 'border-black bg-white'
                                        : 'border-gray-300 bg-transparent'
                                }`}
                            >
                                <p className="font-bold uppercase text-sm">Message only</p>
                                <p className="text-xs text-gray-500 font-mono mt-1">Send text using the normal approved template set.</p>
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setBulkMediaEnabled(true);
                                    updateBulkMediaUrl('');
                                    setSelectedTemplateName((current) => current ? getMediaTemplateName(current, 'image') : current);
                                    if (envelopeWrapper === 'none') {
                                        setEnvelopeWrapper('msg');
                                    }
                                }}
                                disabled={!mediaAvailableForBulk || actionLoading}
                                className={`border px-3 py-3 text-left ${
                                    bulkMediaEnabled && mediaAvailableForBulk
                                        ? 'border-black bg-white'
                                        : 'border-gray-300 bg-transparent'
                                }`}
                            >
                                <p className="font-bold uppercase text-sm">Photo as header</p>
                                <p className="text-xs text-gray-500 font-mono mt-1">Attach an image and use approved image template copies.</p>
                            </button>
                        </div>

                        {bulkMediaEnabled && mediaAvailableForBulk && (
                            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3">
                                <input
                                    type="text"
                                    value={bulkMediaUrl}
                                    onChange={(event) => updateBulkMediaUrl(event.target.value)}
                                    placeholder="Paste an image URL, or choose a small image file below"
                                    className="input-wireframe"
                                />
                                <label className="btn-wireframe bg-white cursor-pointer justify-center">
                                    <ImageIcon className="w-4 h-4 mr-2" />
                                    Choose Photo
                                    <input
                                        type="file"
                                        accept="image/*"
                                        className="hidden"
                                        onChange={(event) => handleBulkMediaFile(event.target.files?.[0] || null)}
                                    />
                                </label>
                                {bulkMediaUrl && (
                                    <div className="md:col-span-2 border border-gray-300 bg-white p-3 flex items-center gap-3">
                                        <div className="w-16 h-16 border border-gray-300 bg-gray-100 overflow-hidden flex-shrink-0">
                                            <img
                                                src={bulkMediaUrl}
                                                alt="Selected bulk media"
                                                className="w-full h-full object-cover"
                                            />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <p className="text-xs font-bold uppercase">Browser-local media ready</p>
                                            <p className="text-xs font-mono text-gray-500 truncate">
                                                Saved in localStorage, not the database.
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => updateBulkMediaUrl('')}
                                            className="btn-wireframe text-xs h-8 px-3 bg-white"
                                        >
                                            Clear
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {!mediaAvailableForBulk && (
                            <p className="text-xs font-mono text-gray-500">
                                Media is available for send-now bulk messages only. Scheduled media is not enabled yet.
                            </p>
                        )}
                    </div>

                    <div className="p-4 border border-gray-200 bg-gray-50 rounded-md">
                        <label className="text-xs font-bold uppercase mb-2 block text-gray-700">Message Style (Envelope)</label>
                        {approvedTemplates.length > 0 && (
                            <div className="mb-2">
                                <input
                                    type="search"
                                    value={templateSearch}
                                    onChange={(event) => setTemplateSearch(event.target.value)}
                                    placeholder="Search approved templates by name, language, category, or text..."
                                    className="input-wireframe"
                                />
                                <p className="mt-1 text-[11px] text-gray-500 font-mono">
                                    {normalizedTemplateSearch
                                        ? `${visibleApprovedTemplates.length} matching approved template${visibleApprovedTemplates.length === 1 ? '' : 's'}`
                                        : `${approvedTemplates.length} approved template${approvedTemplates.length === 1 ? '' : 's'} available`}
                                </p>
                            </div>
                        )}
                        <select 
                            className="input-wireframe mb-2"
                            value={selectedMessageStyleValue}
                            onChange={(e) => handleMessageStyleChange(e.target.value)}
                        >
                            {approvedTemplates.length > 0 && (
                                <>
                                    <option disabled>------ Approved Facebook Templates ------</option>
                                    {approvedTemplateOptions.map((template) => (
                                        <option
                                            key={`${template.name}-${template.language || 'en_US'}`}
                                            value={getApprovedTemplateOptionValue(template)}
                                        >
                                            Template: {template.name.replace(/_/g, ' ')} ({template.language || 'en_US'})
                                        </option>
                                    ))}
                                    {normalizedTemplateSearch && visibleApprovedTemplates.length === 0 && (
                                        <option disabled>No templates match "{templateSearch.trim()}"</option>
                                    )}
                                </>
                            )}

                            <option value="template">Pick Approved Template...</option>
                            
                            {(() => {
                                const isTemplateApprovedForWrapper = (wrapperKey: string) => {
                                    if (wrapperKey === 'template' || wrapperKey === 'none') return true;
                                    const templateName = ENVELOPE_TEMPLATE_MAP[wrapperKey];
                                    if (!templateName) return false;
                                    return !!findApprovedTemplate(templateName, mediaTemplateRequiredForBulk);
                                };

                                const naturalConversations = [
                                    { value: 'friendly_1', label: 'Friendly (Just wanted to let you know)' },
                                    { value: 'friendly_2', label: 'Friendly (Hi there)' },
                                    { value: 'friendly_3', label: 'Friendly (Quick heads up)' },
                                    { value: 'friendly_4', label: 'Friendly (Quick update)' },
                                    { value: 'friendly_5', label: 'Friendly (Keeping you in the loop)' },
                                    { value: 'friendly_6', label: 'Friendly (Thought you should know)' },
                                    { value: 'casual_1', label: 'Casual (Good news)' },
                                    { value: 'casual_2', label: 'Casual (Just checking in)' },
                                    { value: 'casual_3', label: 'Casual (Quick reminder)' },
                                    { value: 'simple_1', label: 'Simple (Just a note)' }
                                ].filter(t => isTemplateApprovedForWrapper(t.value));
                                
                                const legacyWrappers = [
                                    { value: 'msg', label: 'Standard Message ("Message from our team: [Your Text]")' },
                                    { value: 'notice', label: 'System Notice ("Important notice: [Your Text]")' },
                                    { value: 'alert', label: 'System Alert ("[Your Text]. This is an automated notification.")' }
                                ].filter(t => isTemplateApprovedForWrapper(t.value));
                                
                                const actionButtons = [
                                    { value: 'btn_join', label: 'Join Meeting + [Join Meeting Button]' },
                                    { value: 'btn_details', label: 'Update Request + [View Details Button]' },
                                    { value: 'btn_book', label: 'New Notification + [Book Now Button]' }
                                ].filter(t => isTemplateApprovedForWrapper(t.value));
                                
                                return (
                                    <>
                                        {naturalConversations.length > 0 && (
                                            <>
                                                <option disabled>────── Natural Conversations ──────</option>
                                                {naturalConversations.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                                            </>
                                        )}
                                        {legacyWrappers.length > 0 && (
                                            <>
                                                <option disabled>────── Legacy Wrappers ──────</option>
                                                {legacyWrappers.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                                            </>
                                        )}
                                        {actionButtons.length > 0 && (
                                            <>
                                                <option disabled>────── With Action Buttons ──────</option>
                                                {actionButtons.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                                            </>
                                        )}
                                    </>
                                );
                            })()}
                            
                            <option disabled>─────────────────────────────────</option>
                            <option value="none" disabled={mediaTemplateRequiredForBulk}>No Wrapper (Strict 24h limit applies!)</option>
                        </select>
                        <p className="text-xs text-gray-500 font-mono">
                            {envelopeWrapper === 'none' 
                                ? 'Warning: Unwrapped messages will ONLY reach contacts who interacted with you in the last 24 hours.'
                                : envelopeWrapper === 'template'
                                ? 'Pick one approved template from this page for this bulk send.'
                                : 'This wrapper bypasses the 24-hour limit, allowing you to blast all contacts anytime.'}
                        </p>
                        {envelopeWrapper === 'template' && (
                            <div className="mt-3 space-y-3">
                                {approvedTemplates.length === 0 ? (
                                    <div className="text-xs font-mono text-red-700 bg-red-50 border border-red-200 p-3">
                                        No approved templates were returned for this page. Reconnect the page with messaging permissions, then refresh templates.
                                    </div>
                                ) : (
                                    <>
                                        <select
                                            className="input-wireframe"
                                            value={selectedTemplateName || ''}
                                            onChange={(event) => {
                                                const name = event.target.value || null;
                                                setSelectedTemplateName(name);
                                                if (name) {
                                                    const template = approvedTemplates.find((item) => item.name === name);
                                                    setSelectedTemplateLanguage(template?.language || 'en_US');
                                                } else {
                                                    setSelectedTemplateLanguage('en_US');
                                                }
                                            }}
                                        >
                                            <option value="">-- Pick a template --</option>
                                            {approvedTemplateOptions.map((template) => (
                                                <option
                                                    key={`${template.name}-${template.language || 'en_US'}`}
                                                    value={template.name}
                                                >
                                                    {template.name.replace(/_/g, ' ')} ({template.language || 'en_US'})
                                                </option>
                                            ))}
                                            {normalizedTemplateSearch && visibleApprovedTemplates.length === 0 && (
                                                <option disabled>No templates match "{templateSearch.trim()}"</option>
                                            )}
                                        </select>

                                        {selectedTemplateName && getAvailableTemplateBody(selectedTemplateName) && (
                                            <div className="p-3 bg-white border border-dashed border-gray-400 rounded">
                                                <p className="text-[10px] font-bold uppercase text-gray-500 mb-1.5">Selected Template</p>
                                                <p className="text-xs font-mono text-gray-700 leading-relaxed">
                                                    {getAvailableTemplateBody(selectedTemplateName)!.split(/\{\{(\d+)\}\}/).map((part, idx) =>
                                                        idx % 2 === 0 ? (
                                                            <span key={idx}>{part}</span>
                                                        ) : (
                                                            <span key={idx} className="inline-block bg-blue-100 text-blue-700 border border-blue-300 px-1.5 py-0.5 mx-0.5 rounded font-bold text-[11px]">
                                                                {'{{' + part + '}}'}
                                                            </span>
                                                        )
                                                    )}
                                                </p>
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        )}
                        {/* Show original template body when a template-backed wrapper is selected */}
                        {envelopeWrapper !== 'none' && envelopeWrapper !== 'template' && getTemplateBodyText(envelopeWrapper) && (
                            <div className="mt-3 p-3 bg-white border border-dashed border-gray-400 rounded">
                                <p className="text-[10px] font-bold uppercase text-gray-500 mb-1.5">Original Template</p>
                                <p className="text-xs font-mono text-gray-700 leading-relaxed">
                                    {getTemplateBodyText(envelopeWrapper)!.split(/\{\{(\d+)\}\}/).map((part, idx) =>
                                        idx % 2 === 0 ? (
                                            <span key={idx}>{part}</span>
                                        ) : (
                                            <span key={idx} className="inline-block bg-blue-100 text-blue-700 border border-blue-300 px-1.5 py-0.5 mx-0.5 rounded font-bold text-[11px]">
                                                {'{{' + part + '}}'}
                                            </span>
                                        )
                                    )}
                                </p>
                            </div>
                        )}
                    </div>
                    {failedContactErrors.length > 0 && (
                        <div className="bg-red-50 border-2 border-red-300 p-3 rounded">
                            <p className="font-mono text-xs text-red-800 mb-2">
                                Failed error details (showing {Math.min(failedContactErrors.length, 10)} of {failedContactErrors.length})
                            </p>
                            {failedErrorSummary.utilityPermissionMissing > 0 && (
                                <p className="font-mono text-xs text-red-800 mb-1">
                                    {failedErrorSummary.utilityPermissionMissing} failed due to missing pages_utility_messaging permission.
                                </p>
                            )}
                            {failedErrorSummary.utilityTemplateMissing > 0 && (
                                <p className="font-mono text-xs text-red-800 mb-1">
                                    {failedErrorSummary.utilityTemplateMissing} failed because utility template is not approved/available (#100).
                                </p>
                            )}
                            {failedErrorSummary.recipientUnavailable > 0 && (
                                <p className="font-mono text-xs text-red-800 mb-1">
                                    {failedErrorSummary.recipientUnavailable} recipients are unavailable right now (#551).
                                </p>
                            )}
                            {failedContactIds.length > 0 && (
                                <p className="font-mono text-xs text-red-700 mb-2">
                                    {failedContactIds.length} contact(s) are retryable.
                                </p>
                            )}
                            <div className="max-h-40 overflow-y-auto space-y-2">
                                {failedContactErrors.slice(0, 10).map((entry, index) => (
                                    <div key={`${entry.contactId}-${index}`} className="text-xs font-mono text-red-900">
                                        <span className="font-bold">{entry.contactId.slice(0, 8)}...</span> {entry.error}
                                    </div>
                                ))}
                            </div>
                            {failedContactErrors.length > 10 && (
                                <p className="mt-2 text-xs font-mono text-red-700">
                                    +{failedContactErrors.length - 10} more failed contacts
                                </p>
                            )}
                        </div>
                    )}
                    <div className="space-y-3">
                        {bulkDeliveryMode === 'best_time_next_day' ? (
                            <div className="space-y-3">
                                <div>
                                    <label className="block text-xs font-bold uppercase mb-1">Scheduled Messages</label>
                                    <p className="text-[11px] text-gray-500 font-mono mb-2">
                                        Fill all 3 messages. Each contact receives message 1, 2, and 3 at their top 3 best-time hours tomorrow in PH time.
                                    </p>
                                </div>
                                {scheduledMessages.map((message, index) => (
                                    <div key={index}>
                                        <label className="block text-xs font-bold uppercase mb-1">
                                            Message {index + 1} of 3
                                        </label>
                                        <textarea
                                            value={message}
                                            onChange={(event) => updateScheduledMessage(index, event.target.value)}
                                            placeholder={`Hi {name}, scheduled message ${index + 1}...`}
                                            rows={3}
                                            className="input-wireframe w-full h-auto p-3 resize-none"
                                        />
                                    </div>
                                ))}
                                {!scheduledMessagesComplete && (
                                    <p className="text-xs font-mono text-red-700">
                                        All 3 scheduled messages are required for best-time scheduling.
                                    </p>
                                )}
                            </div>
                        ) : envelopeWrapper !== 'none' && envelopeWrapper !== 'template' && envelopeWrapper !== 'msg' && getTemplateBodyText(envelopeWrapper) ? (
                            /* Template-backed wrapper: show a single input for {{1}} with the template preview above */
                            <div>
                                <label className="block text-xs font-bold uppercase mb-1">
                                    Your Message (replaces {'{{1}}'})
                                </label>
                                <textarea
                                    value={messagePart1}
                                    onChange={(e) => setMessagePart1(e.target.value)}
                                    placeholder="Hi {name}, type your message here..."
                                    rows={4}
                                    className="input-wireframe w-full h-auto p-3 resize-none"
                                />
                                <p className="text-[11px] text-gray-400 font-mono mt-1">
                                    Your text will replace the <span className="bg-blue-100 text-blue-700 px-1 rounded">{'{{1}}'}</span> placeholder in the template above.
                                </p>
                            </div>
                        ) : ['msg', 'template', 'none'].includes(envelopeWrapper) ? (
                            <>
                                <div>
                                    <label className="block text-xs font-bold uppercase mb-1">Message (Part 1)</label>
                                    <textarea
                                        value={messagePart1}
                                        onChange={(e) => setMessagePart1(e.target.value)}
                                        placeholder="Hi {name}, your message starts here..."
                                        rows={3}
                                        className="input-wireframe w-full h-auto p-3 resize-none"
                                    />
                                </div>
                                <div className="text-center text-xs text-gray-400 font-mono">
                                    — Message from {pages.find(p => p.id === selectedPageId)?.name || 'Page'} support team —
                                </div>
                                <div>
                                    <label className="block text-xs font-bold uppercase mb-1">Message (Part 2)</label>
                                    <textarea
                                        value={messagePart2}
                                        onChange={(e) => setMessagePart2(e.target.value)}
                                        placeholder="Optional closing message..."
                                        rows={2}
                                        className="input-wireframe w-full h-auto p-3 resize-none"
                                    />
                                </div>
                            </>
                        ) : (
                            <div>
                                <label className="block text-xs font-bold uppercase mb-1">Your Message</label>
                                <textarea
                                    value={messagePart1}
                                    onChange={(e) => setMessagePart1(e.target.value)}
                                    placeholder="Hi {name}, type your full message here..."
                                    rows={4}
                                    className="input-wireframe w-full h-auto p-3 resize-none"
                                />
                                <p className="text-[11px] text-gray-400 font-mono mt-1">
                                    This message will be wrapped inside the <b>{envelopeWrapper === 'notice' ? 'System Notice' : envelopeWrapper === 'alert' ? 'System Alert' : envelopeWrapper.startsWith('btn_') ? 'Action Button' : ''}</b> template as its {'{{1}}'} placeholder.
                                </p>
                            </div>
                        )}
                    </div>
                    {/* Button Card Section */}
                    <div className="border border-gray-300 p-3 rounded">
                        {bulkDeliveryMode === 'best_time_next_day' ? (
                            <div className="bg-blue-50 text-blue-800 p-3 border border-blue-200">
                                <p className="text-xs font-mono">
                                    <b>Note:</b> Best-time scheduled bulk messages use the selected envelope/template for all 3 scheduled messages. Custom inline buttons are disabled for this scheduled flow.
                                </p>
                            </div>
                        ) : envelopeWrapper.startsWith('btn_') ? (
                            <div className="bg-blue-50 text-blue-800 p-3 border border-blue-200">
                                <p className="text-xs font-mono">
                                    <b>Note:</b> You selected a pre-approved Button Wrapper. Custom inline link buttons are disabled because Facebook requires hardcoded action buttons outside the 24-hour messaging window.
                                </p>
                            </div>
                        ) : envelopeWrapper === 'template' ? (
                            <div className="bg-blue-50 text-blue-800 p-3 border border-blue-200">
                                <p className="text-xs font-mono">
                                    <b>Note:</b> Custom inline buttons are disabled when sending with a selected approved template. Use a template that already includes its own buttons.
                                </p>
                            </div>
                        ) : (
                            <>
                                <div className="flex items-center justify-between">
                                    <label className="font-mono text-xs font-bold uppercase text-gray-500 flex items-center gap-1.5">
                                <Link2 className="w-3.5 h-3.5" />
                                Buttons
                            </label>
                            {messageButtons.length < 3 && (
                                <div className="flex gap-1">
                                    <button
                                        type="button"
                                        onClick={() => setMessageButtons([...messageButtons, { type: 'URL', text: '', url: '', payload: '' }])}
                                        className="btn-ghost-wireframe text-[10px] uppercase font-bold px-2 py-1 flex items-center gap-1"
                                    >
                                        <Link2 className="w-3 h-3" />
                                        + Link
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setMessageButtons([...messageButtons, { type: 'QUICK_REPLY', text: '', url: '', payload: '' }])}
                                        className="btn-ghost-wireframe text-[10px] uppercase font-bold px-2 py-1 flex items-center gap-1"
                                    >
                                        <MessageSquare className="w-3 h-3" />
                                        + Quick Reply
                                    </button>
                                </div>
                            )}
                        </div>
                        <label className="mt-2 mb-2 flex items-center gap-2 text-[11px] font-mono text-gray-600">
                            <input
                                type="checkbox"
                                checked={usePart2AsButtonValue}
                                onChange={(e) => {
                                    const checked = e.target.checked;
                                    setUsePart2AsButtonValue(checked);

                                    if (checked && messageButtons.length === 0) {
                                        setMessageButtons([{ type: 'URL', text: '', url: '', payload: '' }]);
                                    }
                                }}
                                className="h-3.5 w-3.5 border border-black"
                            />
                            Enable dynamic first-button mode (optional, not default)
                        </label>
                        {usePart2AsButtonValue && (
                            <p className="text-[11px] text-amber-700 font-mono mb-2">
                                In this mode, the first button is sent in dynamic RESPONSE format. Fill button text and button content below.
                            </p>
                        )}
                        {dynamicModeMissingButton && (
                            <p className="text-[11px] text-red-700 font-mono mb-2">
                                Add at least one button to use dynamic first-button mode.
                            </p>
                        )}
                        {messageButtons.length === 0 && (
                            <p className="text-xs text-gray-400 font-mono">No buttons added. Add up to 3 link or quick reply buttons.</p>
                        )}
                        {messageButtons.length > 0 && (
                            <p className="text-[11px] text-gray-500 font-mono mb-2">
                                Link buttons accept `example.com` or `https://example.com`. We auto-format valid links.
                            </p>
                        )}
                        <div className="space-y-2">
                            {messageButtons.map((btn, idx) => (
                                <div key={idx} className="flex items-start gap-2 p-2 border border-gray-200 bg-gray-50">
                                    <div className="flex-1 space-y-1">
                                        <div className="flex items-center gap-2">
                                            <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${btn.type === 'URL'
                                                ? 'bg-blue-100 text-blue-700'
                                                : 'bg-green-100 text-green-700'
                                                }`}>
                                                {btn.type === 'URL' ? '🔗 Link' : '💬 Reply'}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    const updated = [...messageButtons];
                                                    updated[idx] = {
                                                        ...updated[idx],
                                                        type: btn.type === 'URL' ? 'QUICK_REPLY' : 'URL',
                                                        url: '',
                                                        payload: ''
                                                    };
                                                    setMessageButtons(updated);
                                                }}
                                                className="text-[10px] text-gray-400 hover:text-black underline cursor-pointer"
                                            >
                                                Switch to {btn.type === 'URL' ? 'Quick Reply' : 'Link'}
                                            </button>
                                        </div>
                                        <input
                                            type="text"
                                            value={btn.text}
                                            onChange={(e) => {
                                                const updated = [...messageButtons];
                                                updated[idx] = { ...updated[idx], text: e.target.value };
                                                setMessageButtons(updated);
                                            }}
                                            placeholder="Button text (e.g. View Details)"
                                            className="input-wireframe w-full text-xs h-8"
                                        />
                                        {btn.type === 'URL' ? (
                                            <input
                                                type="url"
                                                value={btn.url}
                                                onChange={(e) => {
                                                    const updated = [...messageButtons];
                                                    updated[idx] = { ...updated[idx], url: e.target.value };
                                                    setMessageButtons(updated);
                                                }}
                                                onBlur={() => {
                                                    const normalizedUrl = normalizeButtonUrlForUi(btn.url);
                                                    if (!normalizedUrl || normalizedUrl === btn.url) {
                                                        return;
                                                    }

                                                    const updated = [...messageButtons];
                                                    updated[idx] = { ...updated[idx], url: normalizedUrl };
                                                    setMessageButtons(updated);
                                                }}
                                                placeholder="https://example.com"
                                                className="input-wireframe w-full text-xs h-8"
                                            />
                                        ) : (
                                            <input
                                                type="text"
                                                value={btn.payload}
                                                onChange={(e) => {
                                                    const updated = [...messageButtons];
                                                    updated[idx] = { ...updated[idx], payload: e.target.value };
                                                    setMessageButtons(updated);
                                                }}
                                                placeholder="Message contact will send (e.g. I'm interested!)"
                                                className="input-wireframe w-full text-xs h-8"
                                            />
                                        )}
                                        {(() => {
                                            const buttonError = getMessageButtonError(btn, idx, {
                                                usePart2AsButtonValue,
                                                messagePart2
                                            });

                                            if (!buttonError) {
                                                return null;
                                            }

                                            return <p className="text-[11px] font-mono text-red-600">{buttonError}</p>;
                                        })()}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setMessageButtons(messageButtons.filter((_, i) => i !== idx))}
                                        className="btn-ghost-wireframe p-1 text-red-500 hover:bg-red-50 mt-1"
                                    >
                                        <X className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            ))}
                        </div>
                        {firstMessageButtonError && (
                            <p className="mt-2 text-xs font-mono text-red-700">Fix button errors before sending.</p>
                        )}
                            </>
                        )}
                    </div>
                    <div className="bg-gray-50 border border-gray-200 p-3 rounded text-xs">
                        <p className="font-bold text-gray-700 mb-1">💡 Personalize your message:</p>
                        <div className="flex flex-wrap gap-2 font-mono">
                            <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded">{'{name}'}</span>
                            <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded">{'{first_name}'}</span>
                            <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded">{'{last_name}'}</span>
                        </div>
                        <p className="text-gray-500 mt-1">Use these to personalize each message with the contact&apos;s name</p>
                    </div>
                    <div className="flex justify-end gap-3 pt-4 border-t border-black">
                        <button
                            onClick={() => {
                                setShowMessageModal(false);
                                setFailedContactIds([]);
                                setFailedContactErrors([]);
                                setLastSendResults(null);
                                setMessageButtons([]);
                                setUsePart2AsButtonValue(false);
                                resetBestTimeScheduleState();
                            }}
                            className="btn-wireframe bg-white"
                            disabled={actionLoading}
                        >
                            {failedContactIds.length > 0 ? 'Close' : 'Cancel'}
                        </button>
                        {failedContactIds.length > 0 && (
                            <button
                                onClick={handleResendToFailed}
                                disabled={!messagePart1.trim() || actionLoading || hasMessageButtonErrors || dynamicModeMissingButton}
                                className="btn-wireframe bg-yellow-600 text-white hover:bg-yellow-700"
                            >
                                {actionLoading ? 'Resending...' : `Resend to ${failedContactIds.length} Failed`}
                            </button>
                        )}
                        <button
                            onClick={handleTrackedBulkMessage}
                            disabled={messageSubmitDisabled}
                            className="btn-wireframe bg-black text-white hover:bg-gray-800"
                        >
                            {actionLoading
                                ? bulkDeliveryMode === 'best_time_next_day'
                                    ? 'Scheduling...'
                                    : 'Sending tracked...'
                                : failedContactIds.length > 0
                                ? 'Send to New Selection'
                                : bulkDeliveryMode === 'best_time_next_day'
                                ? 'Schedule Best Times'
                                : 'Send Safely'}
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
