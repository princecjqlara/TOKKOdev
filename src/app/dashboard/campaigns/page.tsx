'use client';

import { useSession } from 'next-auth/react';

import { useEffect, useState } from 'react';
import { Plus, Send, Trash2, Users, Clock, CheckCircle, XCircle, MessageSquare, StopCircle, FileText, Calendar, Image as ImageIcon } from 'lucide-react';
import Pagination from '@/components/Pagination';
import Modal from '@/components/Modal';
import { Campaign, Page, Contact, PaginatedResponse } from '@/types';
import { getCampaignMessagePreview } from '@/lib/campaign-message-sequence';
import {
    UTILITY_TEMPLATES,
    getBaseTemplateName,
    getMediaTemplateName,
    isMediaTemplateName
} from '@/lib/facebook-templates';
import type { TemplateMediaType } from '@/lib/facebook-templates';

// Map freeform wrapper values to template names
const CAMPAIGN_ENVELOPE_MAP: Record<string, string> = {
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

const CAMPAIGN_MEDIA_STORAGE_PREFIX = 'tokko:campaign-media:';
const PAGE_MEDIA_DRAFT_STORAGE_PREFIX = 'tokko:page-media-draft:';
const MAX_LOCAL_MEDIA_BYTES = 3 * 1024 * 1024;

type StoredCampaignMedia = {
    url: string;
    type?: TemplateMediaType;
    templateName: string;
    savedAt: string;
};

function getCampaignMediaStorageKey(campaignId: string) {
    return `${CAMPAIGN_MEDIA_STORAGE_PREFIX}${campaignId}`;
}

function getPageMediaDraftStorageKey(pageId: string) {
    return `${PAGE_MEDIA_DRAFT_STORAGE_PREFIX}${pageId}`;
}

function readStoredCampaignMedia(campaignId: string): StoredCampaignMedia | null {
    if (typeof window === 'undefined') return null;

    const raw = window.localStorage.getItem(getCampaignMediaStorageKey(campaignId));
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw) as StoredCampaignMedia;
        if (typeof parsed.url === 'string' && parsed.url.trim()) {
            return {
                ...parsed,
                type: 'image'
            };
        }
        return null;
    } catch {
        return raw.trim()
            ? {
                url: raw,
                type: 'image',
                templateName: '',
                savedAt: ''
            }
            : null;
    }
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

function getNextDailyScheduledAt(timeValue: string): string | null {
    const match = /^(\d{2}):(\d{2})$/.exec(timeValue);
    if (!match) return null;

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;

    const nextRun = new Date();
    nextRun.setHours(hours, minutes, 0, 0);
    if (nextRun.getTime() <= Date.now()) {
        nextRun.setDate(nextRun.getDate() + 1);
    }

    return nextRun.toISOString();
}

function getEndOfLocalDate(dateValue: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return null;

    const endDate = new Date(`${dateValue}T23:59:59.999`);
    if (Number.isNaN(endDate.getTime())) return null;

    return endDate.toISOString();
}

function getTomorrowPhilippinesDateInputValue(now = new Date()): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Manila',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const year = Number(values.year);
    const month = Number(values.month);
    const day = Number(values.day);

    return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function getCampaignTemplateBodyText(key: string): string | null {
    const templateName = CAMPAIGN_ENVELOPE_MAP[key];
    if (!templateName) return null;
    const tmpl = UTILITY_TEMPLATES.find(t => t.name === templateName);
    if (!tmpl) return null;
    const bodyComponent = tmpl.components.find(c => c.type === 'BODY');
    return bodyComponent && 'text' in bodyComponent ? (bodyComponent.text ?? null) : null;
}

function getTemplateBodyByName(name: string): string | null {
    const tmpl = UTILITY_TEMPLATES.find(t => t.name === getBaseTemplateName(name));
    if (!tmpl) return null;
    const bodyComponent = tmpl.components.find(c => c.type === 'BODY');
    return bodyComponent && 'text' in bodyComponent ? (bodyComponent.text ?? null) : null;
}

type CampaignRecipientError = {
    id: string;
    contactId: string;
    contactName: string | null;
    contactPsid: string | null;
    error: string;
};

type TemplateStatus = {
    id: string | null;
    name: string;
    status: string;
    category: string;
    language: string;
    hasMediaHeader?: boolean;
    mediaHeaderType?: TemplateMediaType | null;
};

type MessagePartTemplateSelection = {
    templateName: string | null;
    templateLanguage: string;
};

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
    const [showErrorsModal, setShowErrorsModal] = useState(false);

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
    const [useAiMessage, setUseAiMessage] = useState(false); // AI personalization for non-loop campaigns

    // Error modal state
    const [errorsCampaignId, setErrorsCampaignId] = useState<string | null>(null);
    const [campaignErrors, setCampaignErrors] = useState<CampaignRecipientError[]>([]);
    const [errorsLoading, setErrorsLoading] = useState(false);
    const [errorsPage, setErrorsPage] = useState(1);
    const [errorsPageSize, setErrorsPageSize] = useState(25);
    const [errorsTotal, setErrorsTotal] = useState(0);

    // Contacts pagination and filtering for modal
    const [contactsPage, setContactsPage] = useState(1);
    const [contactsTotal, setContactsTotal] = useState(0);
    const [tags, setTags] = useState<{ id: string; name: string; color: string }[]>([]);
    const [selectedTagFilter, setSelectedTagFilter] = useState('');
    const [isSelectAllMode, setIsSelectAllMode] = useState(false);
    const [deliveryMode, setDeliveryMode] = useState<'now' | 'schedule'>('now');
    const [scheduledAt, setScheduledAt] = useState('');
    const [useBestTimeTomorrow, setUseBestTimeTomorrow] = useState(false);
    const [dailySendTime, setDailySendTime] = useState('');
    const [recurrence, setRecurrence] = useState<'none' | 'daily'>('none');
    const [recurrenceEndAt, setRecurrenceEndAt] = useState('');
    const [audienceMode, setAudienceMode] = useState<'specific' | 'dynamic'>('specific');
    const [audienceStartDate, setAudienceStartDate] = useState('');
    const [includedAudienceTagIds, setIncludedAudienceTagIds] = useState<Set<string>>(new Set());
    const [excludedAudienceTagIds, setExcludedAudienceTagIds] = useState<Set<string>>(new Set());

    // Template picker state
    const [availableTemplates, setAvailableTemplates] = useState<TemplateStatus[]>([]);
    const [selectedTemplateName, setSelectedTemplateName] = useState<string | null>(null);
    const [selectedTemplateLanguage, setSelectedTemplateLanguage] = useState<string>('en_US');
    const [templatesLoading, setTemplatesLoading] = useState(false);
    const [messageMode, setMessageMode] = useState<'freeform' | 'template'>('freeform');
    const [freeformWrapper, setFreeformWrapper] = useState<string>('msg');
    const [campaignMediaEnabled, setCampaignMediaEnabled] = useState(false);
    const [campaignMediaUrl, setCampaignMediaUrl] = useState('');
    const [messageParts, setMessageParts] = useState<string[]>(['']);
    const [messagePartTemplates, setMessagePartTemplates] = useState<MessagePartTemplateSelection[]>([
        { templateName: null, templateLanguage: 'en_US' }
    ]);
    const [submittingTemplates, setSubmittingTemplates] = useState(false);
    const [templateSubmitResults, setTemplateSubmitResults] = useState<{
        summary: { total: number; approved: number; pending: number; errors: number; alreadyExisted: number };
        results: { name: string; status: string; action: string; error?: string; hasButtons: boolean }[];
    } | null>(null);
    const [showTemplateResultsModal, setShowTemplateResultsModal] = useState(false);

    // Date filter state
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');

    useEffect(() => {
        fetchPages();
    }, []);

    useEffect(() => {
        if (selectedPageId) {
            fetchCampaigns();
        }
    }, [selectedPageId, page, pageSize, dateFrom, dateTo]);

    useEffect(() => {
        if (!showErrorsModal || !errorsCampaignId) return;
        fetchCampaignErrors(errorsCampaignId, errorsPage, errorsPageSize);
    }, [showErrorsModal, errorsCampaignId, errorsPage, errorsPageSize]);

    useEffect(() => {
        if (!selectedPageId) return;
        const stored = window.localStorage.getItem(getPageMediaDraftStorageKey(selectedPageId));
        if (!stored) {
            setCampaignMediaUrl('');
            return;
        }

        try {
            const parsed = JSON.parse(stored) as { url?: string; type?: TemplateMediaType };
            setCampaignMediaUrl(typeof parsed.url === 'string' ? parsed.url : '');
        } catch {
            setCampaignMediaUrl(stored);
        }
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

    const fetchCampaigns = async () => {
        if (!selectedPageId) return;

        setLoading(true);
        try {
            const params = new URLSearchParams({
                page: page.toString(),
                pageSize: pageSize.toString(),
                pageId: selectedPageId
            });

            if (dateFrom) params.set('dateFrom', dateFrom);
            if (dateTo) params.set('dateTo', dateTo);

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

    const fetchCampaignErrors = async (
        campaignId: string,
        targetPage: number = errorsPage,
        targetPageSize: number = errorsPageSize
    ) => {
        setErrorsLoading(true);
        try {
            const params = new URLSearchParams({
                status: 'failed',
                page: targetPage.toString(),
                pageSize: targetPageSize.toString()
            });

            const res = await fetch(`/api/campaigns/${campaignId}/recipients?${params}`);
            const data: PaginatedResponse<CampaignRecipientError> = await res.json();

            setCampaignErrors(data.items || []);
            setErrorsTotal(data.total || 0);
        } catch (error) {
            console.error('Error fetching campaign errors:', error);
        } finally {
            setErrorsLoading(false);
        }
    };

    const fetchContacts = async (tagFilter = selectedTagFilter, targetPage = contactsPage) => {
        if (!selectedPageId) return;

        try {
            const params = new URLSearchParams({
                page: targetPage.toString(),
                pageSize: '50',
                sendable: 'true'
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
            setTags(data.items || data.tags || []);
        } catch (error) {
            console.error('Error fetching tags:', error);
        }
    };

    const toggleIncludedAudienceTag = (tagId: string) => {
        setIncludedAudienceTagIds((current) => {
            const next = new Set(current);
            if (next.has(tagId)) {
                next.delete(tagId);
            } else {
                next.add(tagId);
            }
            return next;
        });

        setExcludedAudienceTagIds((current) => {
            if (!current.has(tagId)) {
                return current;
            }
            const next = new Set(current);
            next.delete(tagId);
            return next;
        });
    };

    const toggleExcludedAudienceTag = (tagId: string) => {
        setExcludedAudienceTagIds((current) => {
            const next = new Set(current);
            if (next.has(tagId)) {
                next.delete(tagId);
            } else {
                next.add(tagId);
            }
            return next;
        });

        setIncludedAudienceTagIds((current) => {
            if (!current.has(tagId)) {
                return current;
            }
            const next = new Set(current);
            next.delete(tagId);
            return next;
        });
    };

    const fetchTemplates = async () => {
        if (!selectedPageId) return;
        setTemplatesLoading(true);
        try {
            const res = await fetch(`/api/facebook/templates/status?pageId=${selectedPageId}`);
            const data = await readApiResponse(res);
            if (!res.ok) {
                throw new Error(data.message || data.detail || 'Failed to fetch templates');
            }
            const templates = data.templates || [];
            setAvailableTemplates(templates);
            
            // Auto-select first approved wrapper if current is not approved
            setFreeformWrapper(current => {
                if (current === 'none') return current;
                const templateName = CAMPAIGN_ENVELOPE_MAP[current];
                if (!templateName) return 'none';
                const isApproved = templates.some((t: any) => 
                    t.name === templateName && (t.status === 'APPROVED' || t.status === 'ACTIVE')
                );
                
                if (isApproved) return current;
                
                // If the current wrapper is not approved, we find another one
                const allWrappers = ['msg', 'friendly_1', 'friendly_2', 'friendly_3', 'friendly_4', 'friendly_5', 'friendly_6', 'casual_1', 'casual_2', 'casual_3', 'simple_1', 'notice', 'alert'];
                for (const w of allWrappers) {
                    const tName = CAMPAIGN_ENVELOPE_MAP[w];
                    if (tName && templates.some((t: any) => t.name === tName && (t.status === 'APPROVED' || t.status === 'ACTIVE'))) {
                        return w;
                    }
                }
                return 'none';
            });
        } catch (error) {
            console.error('Error fetching templates:', error);
            setAvailableTemplates([]);
        } finally {
            setTemplatesLoading(false);
        }
    };

    const isTemplateApproved = (template: TemplateStatus) =>
        template.status === 'APPROVED' || template.status === 'ACTIVE';

    const findApprovedTemplate = (templateName: string, requireMedia: boolean = false) => {
        const expectedName = requireMedia ? getMediaTemplateName(templateName, 'image') : getBaseTemplateName(templateName);
        return availableTemplates.find((template) => {
            if (!isTemplateApproved(template)) return false;
            if (template.name !== expectedName) return false;
            return requireMedia ? template.mediaHeaderType === 'image' : !template.hasMediaHeader;
        });
    };

    const findApprovedUtilityTemplate = (requireMedia: boolean = false) => {
        return availableTemplates.find((template) => {
            if (!isTemplateApproved(template) || template.category !== 'UTILITY') return false;
            return requireMedia ? template.mediaHeaderType === 'image' : !template.hasMediaHeader;
        });
    };

    const updateCampaignMediaUrl = (value: string) => {
        setCampaignMediaUrl(value);
        if (selectedPageId) {
            if (value.trim()) {
                window.localStorage.setItem(
                    getPageMediaDraftStorageKey(selectedPageId),
                    JSON.stringify({ url: value, type: 'image' })
                );
            } else {
                window.localStorage.removeItem(getPageMediaDraftStorageKey(selectedPageId));
            }
        }
    };

    const handleCampaignMediaFile = (file: File | null) => {
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
                updateCampaignMediaUrl(reader.result);
            }
        };
        reader.onerror = () => alert('Could not read that media file.');
        reader.readAsDataURL(file);
    };

    const updateMessagePart = (index: number, value: string) => {
        setMessageParts((parts) => parts.map((part, partIndex) => partIndex === index ? value : part));
        if (index === 0) {
            setMessageText(value);
        }
    };

    const updateMessagePartTemplate = (index: number, templateName: string | null) => {
        const template = templateName
            ? availableTemplates.find(t => t.name === templateName)
            : null;

        setMessagePartTemplates((current) => {
            const next = [...current];
            while (next.length <= index) {
                next.push({ templateName: null, templateLanguage: 'en_US' });
            }
            next[index] = {
                templateName,
                templateLanguage: template && typeof template.language === 'string'
                    ? template.language
                    : 'en_US'
            };
            return next;
        });
    };

    const getMessagePartTemplate = (index: number): MessagePartTemplateSelection => {
        const perPart = messagePartTemplates[index];
        if (perPart?.templateName) {
            return perPart;
        }

        return {
            templateName: selectedTemplateName,
            templateLanguage: selectedTemplateLanguage
        };
    };

    const addMessagePart = () => {
        setMessageParts((parts) => [...parts, '']);
        setMessagePartTemplates((parts) => [...parts, { templateName: null, templateLanguage: 'en_US' }]);
    };

    const removeMessagePart = (index: number) => {
        setMessageParts((parts) => {
            const nextParts = parts.filter((_, partIndex) => partIndex !== index);
            return nextParts.length > 0 ? nextParts : [''];
        });
        setMessagePartTemplates((parts) => {
            const nextParts = parts.filter((_, partIndex) => partIndex !== index);
            return nextParts.length > 0 ? nextParts : [{ templateName: null, templateLanguage: 'en_US' }];
        });
    };

    const handleOpenCreateModal = async () => {
        setCampaignName('');
        setMessageText('');
        setMessageParts(['']);
        setSelectedContactIds(new Set());
        setContactsPage(1);
        setIsLoop(false);
        setAiPrompt('');
        setUseAiMessage(false);
        setSelectedTagFilter('');
        setIsSelectAllMode(false);
        setDeliveryMode('now');
        setScheduledAt('');
        setUseBestTimeTomorrow(false);
        setDailySendTime('');
        setRecurrence('none');
        setRecurrenceEndAt('');
        setAudienceMode('specific');
        setAudienceStartDate('');
        setIncludedAudienceTagIds(new Set());
        setExcludedAudienceTagIds(new Set());
        setSelectedTemplateName(null);
        setSelectedTemplateLanguage('en_US');
        setMessagePartTemplates([{ templateName: null, templateLanguage: 'en_US' }]);
        setMessageMode('freeform');
        setCampaignMediaEnabled(false);
        if (selectedPageId) {
            setCampaignMediaUrl(window.localStorage.getItem(getPageMediaDraftStorageKey(selectedPageId)) || '');
        }
        await Promise.all([fetchContacts('', 1), fetchTags()]);
        fetchTemplates();
        setShowCreateModal(true);
    };

    const handleSubmitTemplates = async () => {
        if (!selectedPageId || submittingTemplates) return;
        setSubmittingTemplates(true);
        setTemplateSubmitResults(null);
        try {
            const allResults: { name: string; status: string; action: string; error?: string; hasButtons: boolean }[] = [];
            const templateNames = UTILITY_TEMPLATES.map((template) => template.name);
            const batchSize = 10;

            for (let index = 0; index < templateNames.length; index += batchSize) {
                const batchTemplateNames = templateNames.slice(index, index + batchSize);
                const res = await fetch('/api/facebook/templates/submit-all', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        pageId: selectedPageId,
                        limit: batchSize,
                        templateNames: batchTemplateNames
                    })
                });
                const data = await readApiResponse(res);
                if (!res.ok || !data.success) {
                    throw new Error(data.message || data.detail || 'Unknown error');
                }
                allResults.push(...(data.results || []));
            }

            setTemplateSubmitResults({
                summary: {
                    total: allResults.length,
                    approved: allResults.filter((result) => result.status === 'APPROVED' || result.status === 'ACTIVE').length,
                    pending: allResults.filter((result) => result.status === 'PENDING').length,
                    errors: allResults.filter((result) => result.action === 'error').length,
                    alreadyExisted: allResults.filter((result) => result.action === 'already_exists').length
                },
                results: allResults
            });
            setShowTemplateResultsModal(true);
            fetchTemplates();
        } catch (error) {
            alert(`Error submitting templates: ${(error as Error).message}`);
        } finally {
            setSubmittingTemplates(false);
        }
    };

    const handleCreate = async () => {
        const usesDynamicAudience = !isLoop && audienceMode === 'dynamic';
        const hasRecipients = usesDynamicAudience
            ? true
            : (isSelectAllMode ? contactsTotal > 0 : selectedContactIds.size > 0);
        const cleanedMessageParts = messageParts
            .map((part, index) => ({
                text: part.trim(),
                template: getMessagePartTemplate(index)
            }))
            .filter((part) => part.text.length > 0);
        const useCampaignMedia = !isLoop && !useAiMessage && deliveryMode === 'now' && campaignMediaEnabled;
        const useTemplateMedia = useCampaignMedia;
        const normalizedCampaignMediaUrl = campaignMediaUrl.trim();
        const usesBestTimeTomorrow = !isLoop && deliveryMode === 'schedule' && useBestTimeTomorrow;
        const scheduledBestTimeDate = usesBestTimeTomorrow ? getTomorrowPhilippinesDateInputValue() : null;
        if (!campaignName.trim() || !hasRecipients) return;

        // For loop campaigns, need aiPrompt
        // For regular campaigns with AI: need aiPrompt
        // For regular campaigns without AI: need messageText
        if (isLoop && !aiPrompt.trim()) return;
        if (!isLoop && useAiMessage && !aiPrompt.trim()) return;
        if (!isLoop && !useAiMessage && messageMode === 'template' && cleanedMessageParts.some((part) => !part.template.templateName)) return;
        if (!isLoop && !useAiMessage && cleanedMessageParts.length === 0) return;
        if (useCampaignMedia && !normalizedCampaignMediaUrl) return;
        if (useCampaignMedia && messageMode === 'freeform' && freeformWrapper === 'none') return;

        const resolvedScheduledAt =
            usesBestTimeTomorrow
                ? null
                : !isLoop && deliveryMode === 'schedule' && recurrence === 'daily'
                ? getNextDailyScheduledAt(dailySendTime)
                : !isLoop && deliveryMode === 'schedule' && scheduledAt
                ? new Date(scheduledAt).toISOString()
                : null;

        if (!isLoop && deliveryMode === 'schedule' && !usesBestTimeTomorrow && !resolvedScheduledAt) return;
        if (usesDynamicAudience && deliveryMode !== 'schedule') return;

        setActionLoading(true);
        try {
            let contactIds = usesDynamicAudience ? [] : Array.from(selectedContactIds);

            if (!usesDynamicAudience && isSelectAllMode) {
                // Supabase caps a single query at 1000 rows, so paginate through
                // every page of contacts to gather all IDs when "Select All" is used.
                const PAGE_SIZE = 1000;
                const collected: string[] = [];
                let currentPage = 1;
                while (true) {
                    const params = new URLSearchParams({
                        page: currentPage.toString(),
                        pageSize: PAGE_SIZE.toString(),
                        sendable: 'true'
                    });
                    if (selectedTagFilter) {
                        params.set('tagId', selectedTagFilter);
                    }
                    const res = await fetch(`/api/pages/${selectedPageId}/contacts?${params}`);
                    const data: PaginatedResponse<Contact> = await res.json();
                    const items = data.items || [];
                    for (const c of items) collected.push(c.id);

                    const total = data.total ?? collected.length;
                    if (items.length < PAGE_SIZE || collected.length >= total) break;
                    currentPage++;
                }
                contactIds = collected;
            }

            const useTemplateInPayload = !isLoop && !useAiMessage && messageMode === 'template' && cleanedMessageParts.length > 0;

            let payloadTemplateName: string | undefined = undefined;
            let payloadTemplateLanguage: string | undefined = undefined;
            let payloadMessageParts: Array<string | { text: string; templateName?: string; templateLanguage?: string }> = cleanedMessageParts.map((part) => part.text);

            if (!isLoop && !useAiMessage) {
                if (useTemplateInPayload) {
                    const resolvedParts = cleanedMessageParts.map((part, index) => {
                        const templateName = part.template.templateName;
                        if (!templateName) {
                            throw new Error(`Message ${index + 1} needs a template.`);
                        }

                        const selectedTemplate = findApprovedTemplate(templateName, useTemplateMedia);
                        if (!selectedTemplate) {
                            throw new Error(useTemplateMedia
                                ? `Message ${index + 1} template does not have an approved media copy yet.`
                                : `Message ${index + 1} template is not approved for message-only sending.`);
                        }

                        return {
                            text: part.text,
                            templateName: selectedTemplate.name,
                            templateLanguage: typeof selectedTemplate.language === 'string'
                                ? selectedTemplate.language
                                : part.template.templateLanguage
                        };
                    });

                    payloadMessageParts = resolvedParts;
                    const firstTemplate = resolvedParts[0];
                    if (firstTemplate) {
                        payloadTemplateName = firstTemplate.templateName;
                        payloadTemplateLanguage = firstTemplate.templateLanguage;
                    }
                } else if (messageMode === 'freeform') {
                    if (freeformWrapper !== 'none') {
                        // Map the wrapper choice to the exact template name
                        let targetTemplate = CAMPAIGN_ENVELOPE_MAP[freeformWrapper] || 'general_msg_v1';

                        const fallbackTemplate = findApprovedTemplate(targetTemplate, useTemplateMedia) ||
                            findApprovedUtilityTemplate(useTemplateMedia);

                        if (fallbackTemplate) {
                            payloadTemplateName = fallbackTemplate.name;
                            payloadTemplateLanguage = typeof fallbackTemplate.language === 'string' ? fallbackTemplate.language : 'en_US';
                        } else if (useTemplateMedia) {
                            throw new Error('No approved media template copy is available for this page.');
                        }
                    }
                }
            }

            const response = await fetch('/api/campaigns', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pageId: selectedPageId,
                    name: campaignName.trim(),
                    messageText: (isLoop || useAiMessage) ? null : cleanedMessageParts[0]?.text,
                    messageParts: (isLoop || useAiMessage) ? undefined : payloadMessageParts,
                    contactIds,
                    scheduledAt: resolvedScheduledAt,
                    useBestTime: usesBestTimeTomorrow,
                    scheduledDate: scheduledBestTimeDate,
                    audienceMode: usesDynamicAudience ? 'dynamic' : 'specific',
                    audienceRules: usesDynamicAudience ? {
                        startDate: audienceStartDate || null,
                        includeTagIds: [...includedAudienceTagIds],
                        excludeTagIds: [...excludedAudienceTagIds]
                    } : undefined,
                    isLoop,
                    useAiMessage,
                    aiPrompt: (isLoop || useAiMessage) ? aiPrompt.trim() : null,
                    templateName: payloadTemplateName,
                    templateLanguage: payloadTemplateLanguage,
                    recurrence: !isLoop && deliveryMode === 'schedule' && !usesBestTimeTomorrow ? recurrence : 'none',
                    recurrenceEndAt:
                        !isLoop && deliveryMode === 'schedule' && !usesBestTimeTomorrow && recurrence === 'daily' && recurrenceEndAt
                            ? getEndOfLocalDate(recurrenceEndAt)
                            : null
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.message || 'Failed to create campaign');
            }

            const data = await response.json();
            const createdCampaignId = data?.campaign?.id;
            if (useCampaignMedia && createdCampaignId && payloadTemplateName) {
                window.localStorage.setItem(
                    getCampaignMediaStorageKey(createdCampaignId),
                    JSON.stringify({
                        url: normalizedCampaignMediaUrl,
                        type: 'image',
                        templateName: payloadTemplateName,
                        savedAt: new Date().toISOString()
                    } satisfies StoredCampaignMedia)
                );
            }

            setShowCreateModal(false);
            await fetchCampaigns();
        } catch (error) {
            console.error('Error creating campaign:', error);
            alert((error as Error).message || 'Failed to create campaign');
        } finally {
            setActionLoading(false);
        }
    };

    const handleSend = async (campaign: Campaign) => {
        const campaignId = campaign.id;
        setSendingCampaignId(campaignId);
        try {
            const storedMedia = readStoredCampaignMedia(campaignId);
            if (isMediaTemplateName(campaign.template_name) && !storedMedia?.url) {
                alert('This campaign uses a media template, but the media is not available in this browser local storage.');
                return;
            }

            const sendPayload = {
                sendBatchSize: 20,
                delayBetweenBatchesMs: 50,
                maxProcessingTimeMs: 240000,
                templateMediaHeader: storedMedia?.url
                    ? { type: 'image' as const, url: storedMedia.url }
                    : undefined
            };
            let response = await fetch(`/api/campaigns/${campaignId}/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sendPayload)
            });

            let data = await response.json().catch(() => ({} as Record<string, unknown>));

            if (!response.ok) {
                const errorMessage = (data as any).message || `Failed to send campaign (HTTP ${response.status})`;
                console.error('Error sending campaign:', errorMessage, data);
                alert(`Failed to send campaign: ${errorMessage}`);
            } else {
                let remaining = Number((data as any).remaining || 0);
                while ((data as any).partial && remaining > 0) {
                    await new Promise(resolve => setTimeout(resolve, 100));

                    response = await fetch(`/api/campaigns/${campaignId}/send`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(sendPayload)
                    });

                    data = await response.json().catch(() => ({} as Record<string, unknown>));
                    if (!response.ok) {
                        const errorMessage = (data as any).message || `Failed to continue campaign send (HTTP ${response.status})`;
                        console.error('Error continuing campaign send:', errorMessage, data);
                        alert(`Failed to continue campaign send: ${errorMessage}`);
                        return;
                    }

                    remaining = Number((data as any).remaining || 0);
                }

                const sent = (data as any).sent ?? 0;
                const failed = (data as any).failed ?? 0;
                if (failed > 0) {
                    alert(`Campaign sent with issues.\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}`);
                } else if (sent > 0) {
                    alert(`✅ Campaign sent successfully! ${sent} messages delivered.`);
                }
            }

            await fetchCampaigns();
        } catch (error) {
            console.error('Error sending campaign:', error);
            alert(`Error sending campaign: ${(error as Error).message}`);
        } finally {
            setSendingCampaignId(null);
        }
    };

    const handleOpenErrorsModal = (campaignId: string) => {
        setErrorsCampaignId(campaignId);
        setErrorsPage(1);
        setErrorsPageSize(25);
        setCampaignErrors([]);
        setShowErrorsModal(true);
    };

    const handleCancel = async (campaignId: string) => {
        setCancellingCampaignId(campaignId);
        try {
            const response = await fetch(`/api/campaigns/${campaignId}/cancel`, {
                method: 'POST'
            });

            const data = await response.json().catch(() => ({} as Record<string, unknown>));

            if (!response.ok) {
                const errorMessage = (data as any).message || `Failed to cancel campaign (HTTP ${response.status})`;
                console.error('Error cancelling campaign:', errorMessage, data);
                alert(`Failed to cancel campaign: ${errorMessage}`);
            } else {
                alert('Campaign cancelled successfully.');
            }

            await fetchCampaigns();
        } catch (error) {
            console.error('Error cancelling campaign:', error);
            alert(`Error cancelling campaign: ${(error as Error).message}`);
        } finally {
            setCancellingCampaignId(null);
        }
    };

    const handleDelete = async () => {
        if (!editingCampaign) return;

        setActionLoading(true);
        try {
            const response = await fetch(`/api/campaigns?id=${editingCampaign.id}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                const data = await response.json().catch(() => ({} as Record<string, unknown>));
                const errorMessage = (data as any).message || `Failed to delete campaign (HTTP ${response.status})`;
                console.error('Error deleting campaign:', errorMessage, data);
                alert(`Failed to delete campaign: ${errorMessage}`);
            }

            setShowDeleteModal(false);
            setEditingCampaign(null);
            await fetchCampaigns();
        } catch (error) {
            console.error('Error deleting campaign:', error);
            alert(`Error deleting campaign: ${(error as Error).message}`);
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
        if (!campaign.is_loop) return null;
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

    const mediaAvailableForCampaign = !isLoop && !useAiMessage && deliveryMode === 'now';
    const mediaTemplateRequiredForCampaign = mediaAvailableForCampaign && campaignMediaEnabled;
    const approvedImageTemplateCount = availableTemplates.filter(
        (template) => isTemplateApproved(template) && template.mediaHeaderType === 'image'
    ).length;
    const approvedTemplatesForCampaign = availableTemplates.filter(
        (template) => isTemplateApproved(template) && (mediaTemplateRequiredForCampaign ? template.mediaHeaderType === 'image' : !template.hasMediaHeader)
    );
    const messagePartTemplateStatuses = messageParts.map((part, index) => {
        if (!part.trim()) return { hasTemplate: true, isApproved: true };
        const templateName = getMessagePartTemplate(index).templateName;
        return {
            hasTemplate: !!templateName,
            isApproved: !!templateName && !!findApprovedTemplate(templateName, mediaTemplateRequiredForCampaign)
        };
    });
    const hasTemplateForEveryMessagePart = messagePartTemplateStatuses.every((status) => status.hasTemplate);
    const selectedMessagePartTemplatesCanSend = messagePartTemplateStatuses.every((status) => status.isApproved);
    const scheduleNeedsSpecificTime = !isLoop && deliveryMode === 'schedule' && !useBestTimeTomorrow;

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

                    <button
                        onClick={handleSubmitTemplates}
                        disabled={submittingTemplates || !selectedPageId}
                        className="btn-wireframe bg-gray-100 text-xs"
                        title="Submit all predefined templates to Facebook for approval"
                    >
                        {submittingTemplates ? (
                            <>
                                <div className="animate-spin w-3 h-3 border-2 border-black border-t-transparent rounded-full mr-1" />
                                Submitting...
                            </>
                        ) : (
                            <>
                                <FileText className="w-3 h-3 mr-1" />
                                Submit Templates
                            </>
                        )}
                    </button>
                </div>
            </div>

            {/* Date Filter */}
            <div className="flex flex-wrap items-center gap-3 mb-6">
                <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-gray-500" />
                    <span className="font-mono text-xs uppercase tracking-wider text-gray-500">Filter by date:</span>
                </div>
                <div className="flex items-center gap-2">
                    <input
                        type="date"
                        value={dateFrom}
                        onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
                        className="input-wireframe h-9 text-sm w-40"
                        placeholder="From"
                    />
                    <span className="text-gray-400 font-mono text-xs">→</span>
                    <input
                        type="date"
                        value={dateTo}
                        onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
                        className="input-wireframe h-9 text-sm w-40"
                        placeholder="To"
                    />
                </div>
                {(dateFrom || dateTo) && (
                    <button
                        onClick={() => { setDateFrom(''); setDateTo(''); setPage(1); }}
                        className="btn-wireframe text-xs h-9 px-3"
                    >
                        Clear
                    </button>
                )}
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
                                        {campaign.is_loop
                                            ? `AI Prompt: "${campaign.ai_prompt}"`
                                            : campaign.template_name
                                                ? `Template: ${campaign.template_name.replace(/_/g, ' ')} - "${getCampaignMessagePreview(campaign.message_text)}"`
                                                : `"${getCampaignMessagePreview(campaign.message_text)}"`}
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
                                        {campaign.status !== 'draft' && campaign.failed_count > 0 && (
                                            <span className="flex items-center gap-1 text-red-600">
                                                <XCircle className="w-4 h-4" />
                                                {campaign.failed_count} Failed
                                            </span>
                                        )}
                                        <span className="flex items-center gap-1">
                                            <Clock className="w-4 h-4" />
                                            {new Date(campaign.created_at).toLocaleDateString()}
                                        </span>
                                        {campaign.scheduled_at && (
                                            <span className="flex items-center gap-1 text-blue-700">
                                                <Clock className="w-4 h-4" />
                                                Schedules {new Date(campaign.scheduled_at).toLocaleString()}
                                            </span>
                                        )}
                                        {campaign.audience_mode === 'dynamic' && (
                                            <span className="text-blue-700">Dynamic audience</span>
                                        )}
                                        {isMediaTemplateName(campaign.template_name) && (
                                            <span className="flex items-center gap-1 text-blue-700">
                                                <ImageIcon className="w-4 h-4" />
                                                Media
                                            </span>
                                        )}
                                    </div>
                                    {campaign.audience_mode === 'dynamic' && (
                                        <p className="text-xs font-mono text-gray-500">
                                            {campaign.audience_start_date ? `Start: ${campaign.audience_start_date}` : 'Start: any date'}
                                            {' | '}
                                            Include tags: {campaign.audience_include_tag_ids?.length || 0}
                                            {' | '}
                                            Exclude tags: {campaign.audience_exclude_tag_ids?.length || 0}
                                        </p>
                                    )}
                                </div>

                                <div className="flex items-center gap-2 w-full md:w-auto mt-2 md:mt-0">
                                    {campaign.status === 'draft' && (
                                        <button
                                            onClick={() => handleSend(campaign)}
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
                                    {campaign.failed_count > 0 && (
                                        <button
                                            onClick={() => handleOpenErrorsModal(campaign.id)}
                                            className="btn-wireframe border-red-300 text-red-600 hover:bg-red-50 flex-1 md:flex-none"
                                            title="View Failed Recipients"
                                        >
                                            <XCircle className="w-4 h-4 mr-2" />
                                            Errors
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

                    {!isLoop && (
                        <div className="space-y-4 border border-gray-200 p-4 bg-gray-50">
                            <div>
                                <label className="label-wireframe mb-2">Send Timing</label>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setDeliveryMode('now');
                                            setUseBestTimeTomorrow(false);
                                        }}
                                        className={`border px-3 py-3 text-left transition-colors ${deliveryMode === 'now' ? 'border-black bg-white' : 'border-gray-300 bg-transparent'
                                            }`}
                                    >
                                        <p className="font-bold uppercase text-sm">Send Now</p>
                                        <p className="text-xs text-gray-500 font-mono mt-1">
                                            Start sending as soon as you launch the campaign.
                                        </p>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setDeliveryMode('schedule');
                                            setCampaignMediaEnabled(false);
                                        }}
                                        className={`border px-3 py-3 text-left transition-colors ${deliveryMode === 'schedule' ? 'border-black bg-white' : 'border-gray-300 bg-transparent'
                                            }`}
                                    >
                                        <p className="font-bold uppercase text-sm">Schedule</p>
                                        <p className="text-xs text-gray-500 font-mono mt-1">
                                            Use cron-jobs.org to run the campaign at the chosen date and time.
                                        </p>
                                    </button>
                                </div>
                            </div>

                            {deliveryMode === 'schedule' && (
                                <div className="space-y-3">
                                    <div>
                                        <label className="label-wireframe mb-2">Repeat</label>
                                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setUseBestTimeTomorrow(false);
                                                    setRecurrence('none');
                                                }}
                                                className={`border px-3 py-2 text-left transition-colors ${recurrence === 'none' && !useBestTimeTomorrow ? 'border-black bg-white' : 'border-gray-300 bg-transparent'}`}
                                            >
                                                <p className="font-bold uppercase text-sm">One-time</p>
                                                <p className="text-xs text-gray-500 font-mono mt-1">Send once at the scheduled time.</p>
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setUseBestTimeTomorrow(false);
                                                    if (!dailySendTime && scheduledAt.includes('T')) {
                                                        setDailySendTime(scheduledAt.split('T')[1]?.slice(0, 5) || '');
                                                    }
                                                    setRecurrence('daily');
                                                }}
                                                className={`border px-3 py-2 text-left transition-colors ${recurrence === 'daily' ? 'border-black bg-white' : 'border-gray-300 bg-transparent'}`}
                                            >
                                                <p className="font-bold uppercase text-sm">Repeat Daily</p>
                                                <p className="text-xs text-gray-500 font-mono mt-1">Re-send every day at the same time.</p>
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    if (audienceMode === 'dynamic') return;
                                                    setUseBestTimeTomorrow(true);
                                                    setRecurrence('none');
                                                    setScheduledAt('');
                                                    setDailySendTime('');
                                                }}
                                                disabled={audienceMode === 'dynamic'}
                                                className={`border px-3 py-2 text-left transition-colors ${
                                                    useBestTimeTomorrow
                                                        ? 'border-black bg-white'
                                                        : 'border-gray-300 bg-transparent'
                                                } ${audienceMode === 'dynamic' ? 'opacity-50 cursor-not-allowed' : ''}`}
                                            >
                                                <p className="font-bold uppercase text-sm">Tomorrow Best Time</p>
                                                <p className="text-xs text-gray-500 font-mono mt-1">Use each contact&apos;s best hour tomorrow.</p>
                                            </button>
                                        </div>
                                    </div>
                                    {useBestTimeTomorrow ? (
                                        <div className="border border-dashed border-black bg-white p-3">
                                            <p className="text-xs font-bold uppercase">Scheduled Date</p>
                                            <p className="text-sm font-mono mt-1">{getTomorrowPhilippinesDateInputValue()} Asia/Manila</p>
                                        </div>
                                    ) : (
                                        <div>
                                            <label className="label-wireframe">
                                                {recurrence === 'daily' ? 'Daily Send Time' : 'Scheduled Time'}
                                            </label>
                                            <input
                                                type={recurrence === 'daily' ? 'time' : 'datetime-local'}
                                                value={recurrence === 'daily' ? dailySendTime : scheduledAt}
                                                onChange={(e) => {
                                                    if (recurrence === 'daily') {
                                                        setDailySendTime(e.target.value);
                                                    } else {
                                                        setScheduledAt(e.target.value);
                                                    }
                                                }}
                                                className="input-wireframe"
                                            />
                                        </div>
                                    )}
                                    {recurrence === 'daily' && !useBestTimeTomorrow && (
                                        <div>
                                            <label className="label-wireframe">Stop Repeating After (optional)</label>
                                            <input
                                                type="date"
                                                value={recurrenceEndAt}
                                                onChange={(e) => setRecurrenceEndAt(e.target.value)}
                                                className="input-wireframe"
                                            />
                                            <p className="text-xs text-gray-400 font-mono mt-2">
                                                Leave blank to keep repeating until you stop the campaign.
                                            </p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

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
                                AI will use this prompt to generate unique messages for each contact using their conversation history
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {/* AI Personalization Toggle */}
                            <div className="border border-gray-200 p-3 bg-gray-50">
                                <label className="flex items-center gap-3 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={useAiMessage}
                                        onChange={(e) => setUseAiMessage(e.target.checked)}
                                        className="w-4 h-4 accent-black"
                                    />
                                    <div>
                                        <span className="font-bold uppercase text-xs">Use AI Personalized Message</span>
                                        <p className="text-xs text-gray-500 font-mono">
                                            AI generates unique messages for each contact based on their conversation history
                                        </p>
                                    </div>
                                </label>
                            </div>

                            {useAiMessage ? (
                                <div>
                                    <label className="label-wireframe">AI Prompt</label>
                                    <textarea
                                        value={aiPrompt}
                                        onChange={(e) => setAiPrompt(e.target.value)}
                                        placeholder="E.G. Follow up on our previous conversation and mention our new arrivals..."
                                        rows={4}
                                        className="input-wireframe resize-none h-auto p-3"
                                    />
                                    <p className="text-xs text-gray-400 font-mono mt-2">
                                        AI will analyze each contact&apos;s conversation history and generate a personalized message
                                    </p>
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    {/* Message Mode Toggle */}
                                    <div>
                                        <label className="label-wireframe mb-2">Message Mode</label>
                                        <div className="grid grid-cols-2 gap-2">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setMessageMode('freeform');
                                                    setSelectedTemplateName(null);
                                                }}
                                                className={`border px-3 py-3 text-left transition-colors ${
                                                    messageMode === 'freeform'
                                                        ? 'border-black bg-white'
                                                        : 'border-gray-300 bg-transparent'
                                                }`}
                                            >
                                                <p className="font-bold uppercase text-sm">Freeform (All Contacts)</p>
                                                <p className="text-xs text-gray-500 font-mono mt-1">
                                                    Wrapped in an approved system format to deliver anytime.
                                                </p>
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setMessageMode('template')}
                                                className={`border px-3 py-3 text-left transition-colors ${
                                                    messageMode === 'template'
                                                        ? 'border-black bg-white'
                                                        : 'border-gray-300 bg-transparent'
                                                }`}
                                            >
                                                <p className="font-bold uppercase text-sm flex items-center gap-1.5">
                                                    <FileText className="w-3.5 h-3.5" />
                                                    Template
                                                </p>
                                                <p className="text-xs text-gray-500 font-mono mt-1">
                                                    Pick an approved Facebook template
                                                </p>
                                            </button>
                                        </div>
                                    </div>

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
                                                    setCampaignMediaEnabled(false);
                                                    setSelectedTemplateName((current) => current ? getBaseTemplateName(current) : current);
                                                }}
                                                className={`border px-3 py-3 text-left transition-colors ${
                                                    !campaignMediaEnabled
                                                        ? 'border-black bg-white'
                                                        : 'border-gray-300 bg-transparent'
                                                }`}
                                            >
                                                <p className="font-bold uppercase text-sm">Message only</p>
                                                <p className="text-xs text-gray-500 font-mono mt-1">Create a text campaign using normal approved templates.</p>
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setCampaignMediaEnabled(true);
                                                    updateCampaignMediaUrl('');
                                                    setSelectedTemplateName((current) => current ? getMediaTemplateName(current, 'image') : current);
                                                    if (freeformWrapper === 'none') {
                                                        setFreeformWrapper('msg');
                                                    }
                                                }}
                                                disabled={!mediaAvailableForCampaign}
                                                className={`border px-3 py-3 text-left transition-colors ${
                                                    campaignMediaEnabled && mediaAvailableForCampaign
                                                        ? 'border-black bg-white'
                                                        : 'border-gray-300 bg-transparent'
                                                }`}
                                            >
                                                <p className="font-bold uppercase text-sm">Photo as header</p>
                                                <p className="text-xs text-gray-500 font-mono mt-1">Attach an image and use approved image template copies.</p>
                                            </button>
                                        </div>

                                        {campaignMediaEnabled && mediaAvailableForCampaign && (
                                            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3">
                                                <input
                                                    type="text"
                                                    value={campaignMediaUrl}
                                                    onChange={(e) => updateCampaignMediaUrl(e.target.value)}
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
                                                        onChange={(e) => handleCampaignMediaFile(e.target.files?.[0] || null)}
                                                    />
                                                </label>
                                                {campaignMediaUrl && (
                                                    <div className="md:col-span-2 border border-gray-300 bg-white p-3 flex items-center gap-3">
                                                        <div className="w-16 h-16 border border-gray-300 bg-gray-100 overflow-hidden flex-shrink-0">
                                                            <img
                                                                src={campaignMediaUrl}
                                                                alt="Selected campaign media"
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
                                                            onClick={() => updateCampaignMediaUrl('')}
                                                            className="btn-wireframe text-xs h-8 px-3 bg-white"
                                                        >
                                                            Clear
                                                        </button>
                                                    </div>
                                                )}
                                                {messageMode === 'template' && !selectedMessagePartTemplatesCanSend && (
                                                    <p className="md:col-span-2 text-xs font-mono text-red-600">
                                                        One or more selected message templates do not have a matching approved media copy yet.
                                                    </p>
                                                )}
                                            </div>
                                        )}

                                        {!mediaAvailableForCampaign && (
                                            <p className="text-xs font-mono text-gray-500">
                                                Media is available for normal send-now campaigns only.
                                            </p>
                                        )}
                                    </div>

                                    {messageMode === 'freeform' && (
                                        <div className="p-4 border border-gray-200 bg-gray-50 rounded-md">
                                            <label className="text-xs font-bold uppercase mb-2 block text-gray-700">Message Style (Envelope)</label>
                                            <select 
                                                className="input-wireframe mb-2"
                                                value={freeformWrapper}
                                                onChange={(e) => setFreeformWrapper(e.target.value)}
                                            >
                                                {(() => {
                                                    const isCampaignTemplateApproved = (wrapperKey: string) => {
                                                        if (wrapperKey === 'none') return !campaignMediaEnabled;
                                                        const templateName = CAMPAIGN_ENVELOPE_MAP[wrapperKey];
                                                        if (!templateName) return false;
                                                        return !!findApprovedTemplate(templateName, campaignMediaEnabled);
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
                                                    ].filter(t => isCampaignTemplateApproved(t.value));
                                                    
                                                    const legacyWrappers = [
                                                        { value: 'msg', label: 'Standard Message ("Message from our team: [Your Text]")' },
                                                        { value: 'notice', label: 'System Notice ("Important notice: [Your Text]")' },
                                                        { value: 'alert', label: 'System Alert ("[Your Text]. This is an automated notification.")' }
                                                    ].filter(t => isCampaignTemplateApproved(t.value));
                                                    
                                                    const actionButtons = [
                                                        { value: 'btn_join', label: 'Join Meeting + [Join Meeting Button]' },
                                                        { value: 'btn_details', label: 'Update Request + [View Details Button]' },
                                                        { value: 'btn_book', label: 'New Notification + [Book Now Button]' }
                                                    ].filter(t => isCampaignTemplateApproved(t.value));
                                                    
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
                                                <option value="none" disabled={campaignMediaEnabled}>No Wrapper (Strict 24h limit applies!)</option>
                                            </select>
                                            <p className="text-xs text-gray-500 font-mono">
                                                {freeformWrapper === 'none' 
                                                    ? 'Warning: Unwrapped messages will ONLY reach contacts who interacted with you in the last 24 hours.' 
                                                    : 'This wrapper bypasses the 24-hour limit, allowing you to blast all contacts anytime.'}
                                            </p>
                                            {/* Show original template body when a wrapper is selected */}
                                            {freeformWrapper !== 'none' && getCampaignTemplateBodyText(freeformWrapper) && (
                                                <div className="mt-3 p-3 bg-white border border-dashed border-gray-400 rounded">
                                                    <p className="text-[10px] font-bold uppercase text-gray-500 mb-1.5">Original Template</p>
                                                    <p className="text-xs font-mono text-gray-700 leading-relaxed">
                                                        {getCampaignTemplateBodyText(freeformWrapper)!.split(/\{\{(\d+)\}\}/).map((part, idx) =>
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
                                    )}

                                    {/* Template Picker (shown when template mode) */}
                                    {messageMode === 'template' && (
                                        <div className="border border-dashed border-black bg-white p-4 space-y-3">
                                            <label className="label-wireframe mb-0">Default Template</label>
                                            {templatesLoading ? (
                                                <div className="flex items-center gap-2 text-xs font-mono text-gray-500">
                                                    <div className="animate-spin w-4 h-4 border-2 border-black border-t-transparent rounded-full" />
                                                    Loading templates...
                                                </div>
                                            ) : approvedTemplatesForCampaign.length === 0 ? (
                                                <div className="text-xs font-mono text-red-600 bg-red-50 border border-red-200 p-3">
                                                    {mediaTemplateRequiredForCampaign
                                                        ? 'No approved media templates found for this page. Submit image copies and wait for approval first.'
                                                        : 'No approved templates found for this page. Create and get templates approved on Facebook first.'}
                                                </div>
                                            ) : (
                                                <>
                                                    <select
                                                        value={selectedTemplateName || ''}
                                                        onChange={(e) => {
                                                            const name = e.target.value || null;
                                                            setSelectedTemplateName(name);
                                                            if (name) {
                                                                const tmpl = availableTemplates.find(t => t.name === name);
                                                                if (tmpl) {
                                                                    setSelectedTemplateLanguage(typeof tmpl.language === 'string' ? tmpl.language : 'en_US');
                                                                }
                                                            }
                                                        }}
                                                        className="input-wireframe"
                                                    >
                                                        <option value="">-- Pick a template --</option>
                                                        {approvedTemplatesForCampaign.map((tmpl) => (
                                                                <option key={`${tmpl.name}-${tmpl.language}`} value={tmpl.name}>
                                                                    {tmpl.name.replace(/_/g, ' ')} ({tmpl.language}) — {tmpl.category}
                                                                </option>
                                                        ))}
                                                    </select>
                                                    <p className="text-xs text-gray-400 font-mono">
                                                        Message rows use this template unless you pick a different one on that row.
                                                    </p>

                                                    {selectedTemplateName && (
                                                        <div className="space-y-2">
                                                            <div className="flex items-center gap-2 text-xs font-mono">
                                                                <span className="bg-green-100 text-green-800 border border-green-400 px-2 py-0.5 font-bold uppercase">
                                                                    APPROVED
                                                                </span>
                                                                <span className="text-gray-600">
                                                                    {selectedTemplateName.replace(/_/g, ' ')}
                                                                </span>
                                                                <span className="text-gray-400">|</span>
                                                                <span className="text-gray-500">
                                                                    Lang: {selectedTemplateLanguage}
                                                                </span>
                                                            </div>
                                                            {/* Show original template body */}
                                                            {getTemplateBodyByName(selectedTemplateName) && (
                                                                <div className="p-3 bg-gray-50 border border-dashed border-gray-400 rounded">
                                                                    <p className="text-[10px] font-bold uppercase text-gray-500 mb-1.5">Original Template</p>
                                                                    <p className="text-xs font-mono text-gray-700 leading-relaxed">
                                                                        {getTemplateBodyByName(selectedTemplateName)!.split(/\{\{(\d+)\}\}/).map((part, idx) =>
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
                                                    )}
                                                </>
                                            )}
                                        </div>
                                    )}

                                    {/* Message Text Input */}
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between gap-3">
                                            <label className="label-wireframe mb-0">
                                                {messageMode === 'template'
                                                    ? 'Template Body Sequence'
                                                    : 'Message Sequence'}
                                            </label>
                                            <button
                                                type="button"
                                                onClick={addMessagePart}
                                                className="btn-wireframe text-xs h-8 px-3"
                                            >
                                                <Plus className="w-3 h-3 mr-1" />
                                                Add Message
                                            </button>
                                        </div>
                                        {messageParts.map((part, index) => (
                                            <div key={index} className="border border-gray-200 bg-gray-50 p-3">
                                                <div className="flex items-center justify-between gap-3 mb-2">
                                                    <span className="text-xs font-bold uppercase tracking-wide">
                                                        Message {index + 1}
                                                    </span>
                                                    {messageParts.length > 1 && (
                                                        <button
                                                            type="button"
                                                            onClick={() => removeMessagePart(index)}
                                                            className="btn-wireframe text-xs h-7 px-2 bg-white"
                                                        >
                                                            <Trash2 className="w-3 h-3" />
                                                        </button>
                                                    )}
                                                </div>
                                                {messageMode === 'template' && (
                                                    <div className="mb-2">
                                                        <label className="text-[10px] font-bold uppercase text-gray-500 mb-1 block">
                                                            Template for Message {index + 1}
                                                        </label>
                                                        <select
                                                            value={messagePartTemplates[index]?.templateName || selectedTemplateName || ''}
                                                            onChange={(e) => updateMessagePartTemplate(index, e.target.value || null)}
                                                            className="input-wireframe text-xs"
                                                        >
                                                            <option value="">-- Pick a template --</option>
                                                            {approvedTemplatesForCampaign.map((tmpl) => (
                                                                <option key={`${index}-${tmpl.name}-${tmpl.language}`} value={tmpl.name}>
                                                                    {tmpl.name.replace(/_/g, ' ')} ({tmpl.language}) â€” {tmpl.category}
                                                                </option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                )}
                                                <textarea
                                                    value={part}
                                                    onChange={(e) => updateMessagePart(index, e.target.value)}
                                                    placeholder={messageMode === 'template'
                                                        ? `Text for template send #${index + 1}...`
                                                        : `TYPE MESSAGE #${index + 1} HERE...`}
                                                    rows={index === 0 ? 4 : 3}
                                                    className="input-wireframe resize-none h-auto p-3"
                                                />
                                            </div>
                                        ))}
                                        {messageMode === 'template' && (
                                            <p className="text-xs text-gray-400 font-mono">
                                                Each message is sent in order using the selected template and replaces the <span className="bg-blue-100 text-blue-700 px-1 rounded">{'{{1}}'}</span> placeholder.
                                            </p>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {!isLoop && (
                        <div className="space-y-3 border border-gray-200 p-4 bg-gray-50">
                            <div>
                                <label className="label-wireframe mb-2">Audience Type</label>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setAudienceMode('specific')}
                                        className={`border px-3 py-3 text-left transition-colors ${audienceMode === 'specific' ? 'border-black bg-white' : 'border-gray-300 bg-transparent'
                                            }`}
                                    >
                                        <p className="font-bold uppercase text-sm">Specific Contacts</p>
                                        <p className="text-xs text-gray-500 font-mono mt-1">
                                            Pick the exact contacts to receive this campaign.
                                        </p>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setAudienceMode('dynamic');
                                            setDeliveryMode('schedule');
                                            setUseBestTimeTomorrow(false);
                                        }}
                                        className={`border px-3 py-3 text-left transition-colors ${audienceMode === 'dynamic' ? 'border-black bg-white' : 'border-gray-300 bg-transparent'
                                            }`}
                                    >
                                        <p className="font-bold uppercase text-sm">Dynamic Audience</p>
                                        <p className="text-xs text-gray-500 font-mono mt-1">
                                            Resolve matching contacts at send time so new contacts can be included.
                                        </p>
                                    </button>
                                </div>
                            </div>

                            {audienceMode === 'dynamic' && (
                                <div className="border border-dashed border-black bg-white p-4 space-y-4">
                                    <p className="text-xs font-mono text-gray-500">
                                        cron-jobs.org will trigger the send and the audience will be resolved right before delivery.
                                    </p>

                                    <div>
                                        <label className="label-wireframe">Starting Date</label>
                                        <input
                                            type="date"
                                            value={audienceStartDate}
                                            onChange={(e) => setAudienceStartDate(e.target.value)}
                                            className="input-wireframe"
                                        />
                                        <p className="text-xs text-gray-400 font-mono mt-2">
                                            Only contacts first seen on or after this date will be included.
                                        </p>
                                    </div>

                                    <div className="space-y-2">
                                        <label className="label-wireframe mb-0">Include Tags</label>
                                        <div className="flex flex-wrap gap-2">
                                            {tags.length === 0 ? (
                                                <p className="text-xs text-gray-400 font-mono">No tags available yet.</p>
                                            ) : tags.map((tag) => (
                                                <button
                                                    key={`include-${tag.id}`}
                                                    type="button"
                                                    onClick={() => toggleIncludedAudienceTag(tag.id)}
                                                    className={`px-2.5 py-1.5 border text-xs font-bold uppercase ${includedAudienceTagIds.has(tag.id)
                                                        ? 'border-black bg-black text-white'
                                                        : 'border-gray-300 bg-white text-gray-700'
                                                        }`}
                                                >
                                                    + {tag.name}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="space-y-2">
                                        <label className="label-wireframe mb-0">Exclude Tags</label>
                                        <div className="flex flex-wrap gap-2">
                                            {tags.length === 0 ? (
                                                <p className="text-xs text-gray-400 font-mono">No tags available yet.</p>
                                            ) : tags.map((tag) => (
                                                <button
                                                    key={`exclude-${tag.id}`}
                                                    type="button"
                                                    onClick={() => toggleExcludedAudienceTag(tag.id)}
                                                    className={`px-2.5 py-1.5 border text-xs font-bold uppercase ${excludedAudienceTagIds.has(tag.id)
                                                        ? 'border-red-600 bg-red-50 text-red-700'
                                                        : 'border-gray-300 bg-white text-gray-700'
                                                        }`}
                                                >
                                                    - {tag.name}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {(isLoop || audienceMode === 'specific') && (
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
                                        fetchContacts(e.target.value, 1);
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
                                            const nextPage = Math.max(1, contactsPage - 1);
                                            setContactsPage(nextPage);
                                            fetchContacts(selectedTagFilter, nextPage);
                                        }}
                                        disabled={contactsPage === 1}
                                        className="btn-ghost-wireframe text-xs px-2 py-1 h-auto"
                                    >
                                        Prev
                                    </button>
                                    <button
                                        onClick={() => {
                                            const nextPage = contactsPage + 1;
                                            setContactsPage(nextPage);
                                            fetchContacts(selectedTagFilter, nextPage);
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
                    )}
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
                            actionLoading ||
                            (isLoop && !aiPrompt.trim()) ||
                            (!isLoop && useAiMessage && !aiPrompt.trim()) ||
                            (!isLoop && !useAiMessage && messageMode === 'template' && !hasTemplateForEveryMessagePart) ||
                            (!isLoop && !useAiMessage && !messageParts.some((part) => part.trim())) ||
                            (!isLoop && !useAiMessage && campaignMediaEnabled && (!mediaAvailableForCampaign || !campaignMediaUrl.trim())) ||
                            (!isLoop && !useAiMessage && campaignMediaEnabled && messageMode === 'freeform' && freeformWrapper === 'none') ||
                            (!isLoop && !useAiMessage && campaignMediaEnabled && messageMode === 'template' && !selectedMessagePartTemplatesCanSend) ||
                            ((isLoop || audienceMode === 'specific') &&
                                ((!isSelectAllMode && selectedContactIds.size === 0) ||
                                    (isSelectAllMode && contactsTotal === 0))) ||
                            (scheduleNeedsSpecificTime && (recurrence === 'daily' ? !dailySendTime : !scheduledAt)) ||
                            (!isLoop && audienceMode === 'dynamic' && deliveryMode !== 'schedule')
                        }
                        className="btn-wireframe bg-black text-white hover:bg-gray-800"
                    >
                        {actionLoading
                            ? 'Creating...'
                            : isLoop
                                ? 'Create Loop Campaign'
                                : deliveryMode === 'schedule'
                                    ? 'Create Scheduled Campaign'
                                    : useAiMessage
                                        ? 'Create AI Campaign'
                                        : messageMode === 'template'
                                            ? 'Create Template Campaign'
                                            : 'Create Campaign'}
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

            {/* Failed Recipients Modal */}
            <Modal
                isOpen={showErrorsModal}
                onClose={() => {
                    setShowErrorsModal(false);
                    setErrorsCampaignId(null);
                    setCampaignErrors([]);
                    setErrorsPage(1);
                    setErrorsPageSize(25);
                    setErrorsTotal(0);
                }}
                title="Failed Recipients"
                size="lg"
            >
                <div className="space-y-4">
                    <p className="font-mono text-sm text-gray-500">
                        {errorsTotal > 0
                            ? `${errorsTotal} failed recipients`
                            : 'No failed recipients found.'}
                    </p>

                    {errorsLoading ? (
                        <div className="flex items-center justify-center h-32 border border-black">
                            <div className="animate-spin w-6 h-6 border-2 border-black border-t-transparent rounded-full" />
                        </div>
                    ) : (
                        <div className="max-h-64 overflow-y-auto border border-black">
                            {campaignErrors.length === 0 ? (
                                <div className="p-6 text-center text-sm font-mono text-gray-500">
                                    No failed recipients in this page.
                                </div>
                            ) : (
                                campaignErrors.map((entry) => (
                                    <div key={entry.id} className="border-b border-gray-200 p-3 last:border-b-0">
                                        <p className="font-bold uppercase text-sm">
                                            {entry.contactName || 'Unknown'}
                                        </p>
                                        <p className="font-mono text-xs text-gray-500">
                                            ID: {entry.contactId.slice(0, 8)}...{entry.contactPsid ? ` | PSID: ${entry.contactPsid.slice(0, 8)}...` : ''}
                                        </p>
                                        <p className="text-xs text-red-700 mt-1">{entry.error}</p>
                                    </div>
                                ))
                            )}
                        </div>
                    )}

                    {errorsTotal > errorsPageSize && (
                        <div className="border border-black bg-white p-4">
                            <Pagination
                                page={errorsPage}
                                pageSize={errorsPageSize}
                                total={errorsTotal}
                                onPageChange={setErrorsPage}
                                onPageSizeChange={(size) => {
                                    setErrorsPageSize(size);
                                    setErrorsPage(1);
                                }}
                            />
                        </div>
                    )}
                </div>
            </Modal>

            {/* Template Submit Results Modal */}
            <Modal
                isOpen={showTemplateResultsModal}
                onClose={() => setShowTemplateResultsModal(false)}
                title="Template Submission Results"
            >
                {templateSubmitResults && (
                    <div className="space-y-4">
                        {/* Summary */}
                        <div className="grid grid-cols-4 gap-2 text-center">
                            <div className="border border-green-400 bg-green-50 p-3">
                                <p className="text-2xl font-black text-green-800">{templateSubmitResults.summary.approved}</p>
                                <p className="text-xs font-mono text-green-600 uppercase">Approved</p>
                            </div>
                            <div className="border border-yellow-400 bg-yellow-50 p-3">
                                <p className="text-2xl font-black text-yellow-800">{templateSubmitResults.summary.pending}</p>
                                <p className="text-xs font-mono text-yellow-600 uppercase">Pending</p>
                            </div>
                            <div className="border border-gray-400 bg-gray-50 p-3">
                                <p className="text-2xl font-black text-gray-800">{templateSubmitResults.summary.alreadyExisted}</p>
                                <p className="text-xs font-mono text-gray-600 uppercase">Existed</p>
                            </div>
                            <div className="border border-red-400 bg-red-50 p-3">
                                <p className="text-2xl font-black text-red-800">{templateSubmitResults.summary.errors}</p>
                                <p className="text-xs font-mono text-red-600 uppercase">Errors</p>
                            </div>
                        </div>

                        {/* Template List */}
                        <div className="space-y-2 max-h-[400px] overflow-y-auto">
                            {templateSubmitResults.results.map((result, idx) => (
                                <div
                                    key={idx}
                                    className={`border p-3 flex items-center justify-between ${
                                        result.status === 'APPROVED' || result.status === 'ACTIVE'
                                            ? 'border-green-400 bg-green-50'
                                            : result.status === 'ERROR'
                                                ? 'border-red-300 bg-red-50'
                                                : 'border-gray-300 bg-gray-50'
                                    }`}
                                >
                                    <div className="flex-1 min-w-0">
                                        <p className="font-bold text-sm truncate">
                                            {result.name.replace(/_/g, ' ')}
                                        </p>
                                        <div className="flex items-center gap-2 mt-1">
                                            {result.hasButtons && (
                                                <span className="text-xs font-mono bg-blue-100 text-blue-700 border border-blue-300 px-1.5 py-0.5">
                                                    HAS BUTTONS
                                                </span>
                                            )}
                                            <span className="text-xs font-mono text-gray-500">
                                                {result.action === 'already_exists' ? 'Already on page' : 'Newly submitted'}
                                            </span>
                                        </div>
                                        {result.error && (
                                            <p className="text-xs text-red-600 mt-1 truncate">{result.error}</p>
                                        )}
                                    </div>
                                    <span className={`badge-wireframe text-xs ml-3 whitespace-nowrap ${
                                        result.status === 'APPROVED' || result.status === 'ACTIVE'
                                            ? 'bg-green-100 text-green-800 border-green-400'
                                            : result.status === 'PENDING'
                                                ? 'bg-yellow-100 text-yellow-800 border-yellow-400'
                                                : result.status === 'ERROR'
                                                    ? 'bg-red-100 text-red-800 border-red-400'
                                                    : 'bg-gray-200 text-gray-700 border-gray-400'
                                    }`}>
                                        {result.status}
                                    </span>
                                </div>
                            ))}
                        </div>

                        <p className="text-xs font-mono text-gray-500 text-center">
                            Only APPROVED templates can be used for campaigns. Pending templates need Facebook review.
                        </p>
                    </div>
                )}
            </Modal>
        </div>
    );
}
