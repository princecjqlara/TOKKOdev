import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import {
    createUtilityTemplate,
    getPageTemplates,
    sendMessage,
    UtilityTemplate
} from '@/lib/facebook';
import { chunkArray } from '@/lib/chunking';
import { replaceTemplateVariablesForParts, ContactRecord } from '@/lib/placeholders';
import {
    buildSupportTeamTemplateBodyCandidates,
    buildUtilityBodyParameters,
    normalizeRequestedButtons,
    RequestedMessageButton,
    resolveMessageParts,
    templateMatchesRequestedButtons,
    toRequestedButtons
} from './helpers';
import fs from 'fs';
import path from 'path';

// Redefine locally if needed by other logic, but usually we can just use the import
// interface ContactRecord {
//     id: string;
//     psid: string;
//     page_id: string;
//     name: string | null;
//     last_interaction_at: string | null;
// }

function getMessagingType(): 'UTILITY' {
    return 'UTILITY';
}

function isUtilityPermissionError(errorMessage: string): boolean {
    const normalized = errorMessage.toLowerCase();
    return (
        normalized.includes('pages_utility_messaging') ||
        normalized.includes('requires pages_utility_messaging permission')
    );
}

function isUtilityTemplateMissingError(errorMessage: string): boolean {
    const normalized = errorMessage.toLowerCase();
    return normalized.includes('template cannot be found');
}

const DEFAULT_UTILITY_TEMPLATE_NAME = 'account_general_notification';
const DEFAULT_UTILITY_TEMPLATE_LANGUAGE = 'en_US';
const SENDABLE_TEMPLATE_STATUSES = new Set(['APPROVED', 'ACTIVE']);
const AUTO_TEMPLATE_HEADLINE_SUFFIX = 'status update';
const AUTO_TEMPLATE_MAX_ATTEMPTS = 80;
const AUTO_TEMPLATE_TIME_BUDGET_MS = 240000;
const AUTO_TEMPLATE_MESSAGES = ['{{1}}'];
const FACEBOOK_GRAPH_URL = 'https://graph.facebook.com/v21.0';

function normalizeTemplateStatus(status: unknown): string | null {
    if (typeof status !== 'string') return null;
    const normalized = status.trim().toUpperCase();
    return normalized || null;
}

function normalizeLanguageCode(language: string | null | undefined): string | null {
    if (!language) return null;
    const normalized = language.trim().replace('-', '_');
    return normalized || null;
}

function extractBodyPlaceholderCount(template: Record<string, unknown>): number {
    const components = template.components;
    if (!Array.isArray(components)) {
        return 1;
    }

    const bodyComponent = components.find((component) => {
        if (!component || typeof component !== 'object') return false;
        const type = (component as Record<string, unknown>).type;
        return typeof type === 'string' && type.toUpperCase() === 'BODY';
    }) as Record<string, unknown> | undefined;

    if (!bodyComponent) {
        return 0;
    }

    const text = typeof bodyComponent.text === 'string' ? bodyComponent.text : '';
    if (!text) {
        return 0;
    }

    const placeholderMatches = text.match(/\{\{\d+\}\}/g);
    return placeholderMatches ? placeholderMatches.length : 0;
}

function extractBodyTemplateText(template: Record<string, unknown>): string {
    const components = template.components;
    if (!Array.isArray(components)) {
        return '';
    }

    const bodyComponent = components.find((component) => {
        if (!component || typeof component !== 'object') return false;
        const type = (component as Record<string, unknown>).type;
        return typeof type === 'string' && type.toUpperCase() === 'BODY';
    }) as Record<string, unknown> | undefined;

    return typeof bodyComponent?.text === 'string' ? bodyComponent.text : '';
}

function isExactOfferBodyTemplate(template: Record<string, unknown>): boolean {
    const bodyText = extractBodyTemplateText(template)
        .replace(/\r\n/g, '\n')
        .trim()
        .toLowerCase();
    return /\{\{1\}\}\n.+\sstatus update$/.test(bodyText);
}

function isSupportTeamTemplate(template: Record<string, unknown>): boolean {
    const bodyText = extractBodyTemplateText(template)
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    return /\{\{1\}\}.*support\s*team.*\{\{2\}\}/.test(bodyText);
}

function hasEditablePlaceholder(template: Record<string, unknown>): boolean {
    const bodyText = extractBodyTemplateText(template);
    return /\{\{1\}\}/.test(bodyText);
}

function countPlaceholders(template: Record<string, unknown>): number {
    const bodyText = extractBodyTemplateText(template);
    const matches = bodyText.match(/\{\{\d+\}\}/g);
    return matches ? matches.length : 0;
}

function buildPageStatusHeadline(pageName?: string | null): string {
    const normalized = (pageName || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 48);

    if (!normalized) {
        return 'Page';
    }

    return normalized;
}

function buildAutoTemplateName(baseIndex: number): string {
    const dateKey = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return `offer_status_update_auto_${dateKey}_${baseIndex}`;
}

function buildAutoTemplateCandidate(
    name: string,
    language: string,
    bodyText: string,
    buttons?: RequestedMessageButton[]
): UtilityTemplate {
    const components: UtilityTemplate['components'] = [
        {
            type: 'BODY',
            text: bodyText,
            example: {
                body_text: [['Your order has shipped', 'Thank you for your purchase']]
            }
        }
    ];

    // Add buttons to template if provided
    if (buttons && buttons.length > 0) {
        components.push({
            type: 'BUTTONS',
            buttons: buttons.map(btn => {
                if (btn.type === 'QUICK_REPLY') {
                    return {
                        type: 'POSTBACK' as const,
                        text: btn.text,
                        payload: btn.payload || btn.text
                    };
                }
                return {
                    type: 'URL' as const,
                    text: btn.text,
                    url: btn.url || ''
                };
            })
        });
    }

    return {
        name,
        language,
        category: 'UTILITY',
        components
    };
}

function extractTemplateLanguageCode(template: Record<string, unknown>): string | null {
    const directLanguage = template.language;
    if (typeof directLanguage === 'string') {
        return normalizeLanguageCode(directLanguage);
    }

    if (directLanguage && typeof directLanguage === 'object') {
        const languageObject = directLanguage as Record<string, unknown>;
        const nestedCode =
            (typeof languageObject.code === 'string' && languageObject.code) ||
            (typeof languageObject.locale === 'string' && languageObject.locale) ||
            (typeof languageObject.name === 'string' && languageObject.name) ||
            null;
        return normalizeLanguageCode(nestedCode);
    }

    const locale = template.locale;
    if (typeof locale === 'string') {
        return normalizeLanguageCode(locale);
    }

    return null;
}

// Template variable replacements for personalized messages
// Removed local replaceTemplateVariables and replaceTemplateVariablesForParts as they are now in @/lib/placeholders

// Increase timeout for sending messages (up to 5 minutes)
export const maxDuration = 300;

// Helper function to write debug logs
function writeDebugLog(location: string, message: string, data: any, hypothesisId: string) {
    const logEntry = JSON.stringify({ location, message, data, timestamp: Date.now(), sessionId: 'debug-session', runId: 'run1', hypothesisId }) + '\n';

    // Try multiple log paths
    const logPaths = [
        path.join(process.cwd(), '.cursor', 'debug.log'),
        path.join(process.cwd(), 'debug.log'),
        path.join('/tmp', 'debug.log')
    ];

    for (const logPath of logPaths) {
        try {
            // Ensure directory exists
            const logDir = path.dirname(logPath);
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            fs.appendFileSync(logPath, logEntry);
            break; // Success, stop trying other paths
        } catch (e: any) {
            // Try next path
            continue;
        }
    }

    // Also log to console with special prefix for easy grepping
    console.log(`[DEBUG-LOG] ${JSON.stringify({ location, message, data, hypothesisId })}`);

    // Also try HTTP logging
    fetch('http://127.0.0.1:7242/ingest/6358f30b-ef0a-4ea4-8acc-50c08c025924', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: logEntry.trim()
    }).catch(() => { });
}

// POST /api/facebook/messages/send - Send messages to contacts
export async function POST(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);

        if (!session) {
            console.error('No session found in /api/facebook/messages/send');
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const userId = session.user?.id;
        if (!userId) {
            console.error('No user ID in session:', session.user);
            return NextResponse.json(
                { error: 'Unauthorized', message: 'User not found. Please sign in again.' },
                { status: 401 }
            );
        }

        // Parse request body with error handling
        let body;
        try {
            body = await request.json();
        } catch (parseError) {
            console.error('Error parsing request body:', parseError);
            return NextResponse.json(
                { error: 'Bad Request', message: 'Invalid JSON in request body' },
                { status: 400 }
            );
        }

        const {
            pageId,
            contactIds,
            messageText: rawMessageText,
            messagePart1: rawMessagePart1,
            messagePart2: rawMessagePart2,
            buttons: rawButtons
        } = body as {
            pageId?: string;
            contactIds?: string[];
            messageText?: string;
            messagePart1?: string;
            messagePart2?: string;
            buttons?: RequestedMessageButton[];
        };

        const resolvedMessage = resolveMessageParts(rawMessageText, rawMessagePart1, rawMessagePart2);
        const messageText = resolvedMessage.combined;

        if (!pageId || !contactIds?.length || !resolvedMessage.part1.trim()) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Missing required fields' },
                { status: 400 }
            );
        }

        const normalizedRequestedButtons = normalizeRequestedButtons(rawButtons);
        if (
            Array.isArray(rawButtons) &&
            rawButtons.length > 0 &&
            normalizedRequestedButtons.length !== rawButtons.length
        ) {
            return NextResponse.json(
                {
                    error: 'Bad Request',
                    message: 'Invalid button payload. Each button needs type, text, and url/payload. Link buttons must use a valid URL such as https://example.com.'
                },
                { status: 400 }
            );
        }

        const requestedButtons = toRequestedButtons(normalizedRequestedButtons);
        const requiresSupportTeamTemplate = resolvedMessage.isTwoPart;

        // Log total contacts to send
        console.log(`📤 ========== API: MESSAGE SEND REQUEST ==========`);
        console.log(`📤 Received request to send to ${contactIds.length} contacts`);
        console.log(`📤 Page ID: ${pageId}`);
        console.log(`📤 Sample contact IDs (first 5):`, contactIds.slice(0, 5));
        console.log(`📤 Sample contact IDs (last 5):`, contactIds.slice(-5));
        console.log(`📤 ===============================================`);

        // #region agent log
        writeDebugLog('api/facebook/messages/send/route.ts:68', 'API request received', { contactIdsCount: contactIds.length, pageId }, 'E');
        // #endregion

        // Ensure we process ALL contacts, not just first 1000
        // The batchSize is only for database queries, not for limiting sends

        const supabase = getSupabaseAdmin();

        // Verify user has access to page
        const { data: userPage } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', userId)
            .eq('page_id', pageId)
            .single();

        if (!userPage) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this page' },
                { status: 403 }
            );
        }

        // Get page access token
        const { data: page } = await supabase
            .from('pages')
            .select('fb_page_id, access_token')
            .eq('id', pageId)
            .single();

        if (!page) {
            return NextResponse.json(
                { error: 'Not Found', message: 'Page not found' },
                { status: 404 }
            );
        }

        let pageStatusHeadline = buildPageStatusHeadline();
        try {
            const pageNameResponse = await fetch(
                `${FACEBOOK_GRAPH_URL}/${page.fb_page_id}?fields=name&access_token=${encodeURIComponent(page.access_token)}`
            );
            if (pageNameResponse.ok) {
                const pageNameData = await pageNameResponse.json();
                pageStatusHeadline = buildPageStatusHeadline(
                    typeof pageNameData?.name === 'string' ? pageNameData.name : undefined
                );
            }
        } catch {
            // Keep default headline fallback when page-name lookup fails
        }

        // Get contacts - handle large arrays by batching
        // Note: We trust that contactIds were fetched correctly for this page
        // So we don't need to filter by page_id again - just query by IDs
        let allContacts: { id: string; psid: string; name: string | null; last_interaction_at: string | null }[] = [];
        const batchSize = 200; // Keep queries small to avoid URL size limits

        console.log(`📤 Processing ${contactIds.length} contact IDs for page ${pageId}`);
        console.log(`📤 Will process in ${Math.ceil(contactIds.length / batchSize)} batches of up to ${batchSize} contacts each`);
        console.log(`📤 Sample contact IDs (first 5):`, contactIds.slice(0, 5));
        console.log(`📤 Sample contact IDs (last 5):`, contactIds.slice(-5));

        let totalRequested = contactIds.length;
        let totalFound = 0;
        let totalFiltered = 0; // Contacts found but filtered (wrong page_id or missing psid)
        let totalNotFound = 0; // Contacts not found in database
        let batchesProcessed = 0;
        let batchesWithErrors = 0;
        let batchesWithFiltered = 0;
        const batchErrors: string[] = [];
        const emptyBatchSamples: string[][] = [];

        const lookupBatches = chunkArray(contactIds, batchSize);

        for (let index = 0; index < lookupBatches.length; index += 1) {
            batchesProcessed++;
            const batchNumber = index + 1;
            const totalBatches = lookupBatches.length;
            const batchStartIndex = index * batchSize;
            const batchEndIndex = Math.min(batchStartIndex + batchSize, contactIds.length) - 1;
            console.log(`📤 Processing batch ${batchNumber}/${totalBatches} (contacts ${batchStartIndex + 1} to ${batchEndIndex + 1})`);
            const batchIds = lookupBatches[index];

            // #region agent log
            writeDebugLog('api/facebook/messages/send/route.ts:166', 'Batch loop iteration', { batchNumber, totalBatches, batchStartIndex, batchEndIndex, batchSize: batchIds.length, totalRequested: contactIds.length, processedSoFar: batchStartIndex, remaining: contactIds.length - batchStartIndex }, 'B');
            // #endregion

            const { data: batchContacts, error: batchError } = await supabase
                .from('contacts')
                .select('id, psid, page_id, name, last_interaction_at')
                .in('id', batchIds);

            if (batchError) {
                batchesWithErrors++;
                const batchNum = batchNumber;
                console.error(`❌❌❌ ERROR fetching contacts batch ${batchNum}:`, batchError);
                console.error(`❌ This batch will be skipped - ${batchIds.length} contacts will not be sent!`);
                console.error(`❌ Batch error details:`, JSON.stringify(batchError, null, 2));
                if (batchErrors.length < 5) {
                    batchErrors.push(batchError.message || JSON.stringify(batchError));
                }
                // Mark as not found (database error)
                totalNotFound += batchIds.length;
                continue;
            }

            if (!batchContacts?.length) {
                batchesWithErrors++;
                const batchNum = batchNumber;
                console.error(`❌❌❌ Batch ${batchNum}: NO contacts found in database for ${batchIds.length} requested IDs!`);
                console.error(`❌ Sample IDs that don't exist:`, batchIds.slice(0, 5));
                if (emptyBatchSamples.length < 3) {
                    emptyBatchSamples.push(batchIds.slice(0, 5));
                }
                console.error(`❌ These contacts may have been deleted from the database`);
                // Mark as not found
                totalNotFound += batchIds.length;
                continue;
            }

            totalFound += batchContacts.length;

            // #region agent log
            writeDebugLog('api/facebook/messages/send/route.ts:160', 'Batch contacts fetched from DB', { batchNumber, requestedCount: batchIds.length, foundCount: batchContacts.length, totalFoundSoFar: totalFound }, 'F');
            // #endregion

            const validContacts = batchContacts.filter((contact): contact is ContactRecord => {
                const correctPage = contact.page_id === pageId;
                const validPsid = typeof contact.psid === 'string' && contact.psid.trim() !== '';
                const isValid = correctPage && validPsid;

                // #region agent log
                if (!isValid) {
                    writeDebugLog('api/facebook/messages/send/route.ts:205', 'Contact filtered out', { contactId: contact.id, correctPage, validPsid, actualPageId: contact.page_id, expectedPageId: pageId, psidValue: contact.psid, psidType: typeof contact.psid }, 'D');
                }
                // #endregion

                return isValid;
            });

            const filteredCount = batchContacts.length - validContacts.length;
            totalFiltered += filteredCount;

            // #region agent log
            writeDebugLog('api/facebook/messages/send/route.ts:168', 'Batch contacts filtered', { batchNumber, foundCount: batchContacts.length, validCount: validContacts.length, filteredCount, totalFilteredSoFar: totalFiltered }, 'G');
            // #endregion

            if (filteredCount > 0) {
                batchesWithFiltered++;
                const batchNum = batchNumber;
                const wrongPage = batchContacts.filter(c => c.page_id !== pageId).length;
                const missingPsid = batchContacts.filter(c => typeof c.psid !== 'string' || c.psid.trim() === '').length;
                console.error(`❌❌❌ Batch ${batchNum}: FILTERED ${filteredCount} contacts!`);
                console.error(`❌   - Wrong page_id: ${wrongPage} contacts (belong to different page)`);
                console.error(`❌   - Missing psid: ${missingPsid} contacts (need to be synced)`);
                console.error(`❌   - Valid contacts in this batch: ${validContacts.length}/${batchContacts.length}`);
                if (wrongPage > 0) {
                    const wrongPageContacts = batchContacts.filter(c => c.page_id !== pageId).slice(0, 5);
                    console.error(`❌ Example contacts with wrong page_id:`,
                        wrongPageContacts.map(c => ({
                            id: c.id,
                            actual_page_id: c.page_id,
                            expected_page_id: pageId,
                            has_psid: !!c.psid
                        }))
                    );
                    console.error(`❌ SOLUTION: These contacts belong to page ${wrongPageContacts[0]?.page_id} but you're trying to send from page ${pageId}`);
                    console.error(`❌ Either select the correct page, or these contacts need to be moved/re-synced`);
                }
                if (missingPsid > 0) {
                    console.error(`❌ SOLUTION: ${missingPsid} contacts are missing psid - sync the page again to fix this`);
                }
            }

            if (validContacts.length) {
                const beforeConcat = allContacts.length;
                allContacts = allContacts.concat(validContacts.map(c => ({ id: c.id, psid: c.psid.trim(), name: c.name, last_interaction_at: c.last_interaction_at || null })));
                // #region agent log
                writeDebugLog('api/facebook/messages/send/route.ts:245', 'Valid contacts added to allContacts', { batchNumber, validCount: validContacts.length, beforeConcat, afterConcat: allContacts.length, totalValidSoFar: allContacts.length }, 'B');
                // #endregion
                console.log(`✅ Batch ${batchNumber}: Added ${validContacts.length} valid contacts (total valid so far: ${allContacts.length})`);
            } else {
                // #region agent log
                writeDebugLog('api/facebook/messages/send/route.ts:250', 'Batch with no valid contacts', { batchNumber, foundCount: batchContacts.length, filteredCount, requestedCount: batchIds.length }, 'D');
                // #endregion
                console.warn(`⚠️ Batch ${batchNumber}: No valid contacts in this batch (all were filtered or not found)`);
            }
        }

        console.log(`📊 Finished processing all ${batchesProcessed} batches`);

        console.log(`📊 ========== CONTACT LOOKUP SUMMARY ==========`);
        console.log(`📊 Batches processed: ${batchesProcessed}`);
        console.log(`📊 Batches with errors: ${batchesWithErrors}`);
        console.log(`📊 Batches with filtered contacts: ${batchesWithFiltered}`);
        console.log(`📊 Requested: ${totalRequested} contacts`);
        console.log(`📊 Found in DB: ${totalFound} contacts`);
        console.log(`📊 Filtered out: ${totalFiltered} contacts (wrong page_id or missing psid)`);
        console.log(`📊 Not found in DB: ${totalNotFound} contacts`);
        console.log(`📊 Valid for sending: ${allContacts.length} contacts`);
        console.log(`📊 ===========================================`);

        if (!allContacts.length) {
            // Fallback: fetch all contacts for the page and use those with valid psid
            const { data: pageContacts, error: pageContactsError } = await supabase
                .from('contacts')
                .select('id, page_id, psid, name')
                .eq('page_id', pageId)
                .not('psid', 'is', null)
                .limit(10000);

            if (pageContactsError) {
                console.error('Error fetching page contacts fallback:', pageContactsError);
            } else if (pageContacts?.length) {
                const validPageContacts = pageContacts.filter(
                    c => typeof c.psid === 'string' && c.psid.trim() !== ''
                );
                if (validPageContacts.length) {
                    console.warn(
                        `No valid contacts matched provided IDs; falling back to ${validPageContacts.length} contacts on page ${pageId}`
                    );
                    allContacts = validPageContacts.map(c => ({ id: c.id, psid: c.psid.trim(), name: c.name || null, last_interaction_at: null }));
                }
            }

            if (!allContacts.length) {
                const { data: anyContacts } = await supabase
                    .from('contacts')
                    .select('id, page_id, psid')
                    .in('id', contactIds.slice(0, 20))
                    .limit(20);

                console.error(`No valid contacts found for ${contactIds.length} requested IDs`);
                console.error('Sample contact IDs (first 10):', contactIds.slice(0, 10));

                if (anyContacts?.length) {
                    const pageIds = Array.from(new Set(anyContacts.map(c => c.page_id)));
                    const contactsWithPsid = anyContacts.filter(c => typeof c.psid === 'string' && c.psid.trim() !== '');
                    const contactsWithCorrectPage = anyContacts.filter(c => c.page_id === pageId);
                    const contactsWithBoth = anyContacts.filter(
                        c => c.page_id === pageId && typeof c.psid === 'string' && c.psid.trim() !== ''
                    );

                    console.error('Pages found in sample:', pageIds);
                    console.error(`Contacts with correct page_id: ${contactsWithCorrectPage.length}/${anyContacts.length}`);
                    console.error(`Contacts with valid psid: ${contactsWithPsid.length}/${anyContacts.length}`);
                    console.error(`Contacts with both valid page and psid: ${contactsWithBoth.length}/${anyContacts.length}`);

                    const withoutPsid = anyContacts.filter(c => typeof c.psid !== 'string' || c.psid.trim() === '');
                    if (withoutPsid.length) {
                        console.error(
                            'Example contacts without psid:',
                            withoutPsid.slice(0, 5).map(c => ({ id: c.id, page_id: c.page_id, psid: c.psid }))
                        );
                    }
                } else {
                    console.error('No contacts found in database for the provided IDs');
                }

                return NextResponse.json(
                    {
                        error: 'Not Found',
                        message: `No valid contacts found. Requested ${contactIds.length} contacts, but none matched the page or had a valid psid. Please sync contacts first.`,
                        debug: {
                            requested: contactIds.length,
                            found: 0,
                            sampleContacts: anyContacts?.slice(0, 5) || [],
                            batchErrors,
                            emptyBatchSamples
                        }
                    },
                    { status: 404 }
                );
            }
        }

        if (allContacts.length === 0) {
            // Try to find out why - check if contacts exist at all
            const { data: sampleContacts } = await supabase
                .from('contacts')
                .select('id, page_id, psid')
                .in('id', contactIds.slice(0, 10))
                .limit(10);

            const errorDetails: any = {
                requested: contactIds.length,
                found: 0,
                totalFound: totalFound,
                totalFiltered: totalFiltered
            };

            if (sampleContacts?.length) {
                const wrongPage = sampleContacts.filter(c => c.page_id !== pageId).length;
                const missingPsid = sampleContacts.filter(c => !c.psid || typeof c.psid !== 'string' || c.psid.trim() === '').length;
                errorDetails.sample = {
                    found: sampleContacts.length,
                    wrongPage,
                    missingPsid,
                    correct: sampleContacts.filter(c => c.page_id === pageId && c.psid && typeof c.psid === 'string' && c.psid.trim() !== '').length
                };
                errorDetails.sampleContacts = sampleContacts.slice(0, 3);
            }

            console.error(`❌ No valid contacts found. Details:`, errorDetails);

            return NextResponse.json(
                {
                    error: 'Not Found',
                    message: `No valid contacts found. ${totalFound > 0 ? `${totalFiltered} contacts were filtered out (wrong page or missing PSID).` : 'Contacts may have been deleted or do not exist.'} Please sync contacts first or check if contacts still exist.`,
                    debug: errorDetails
                },
                { status: 404 }
            );
        }

        console.log(`✅ Found ${allContacts.length} valid contacts out of ${contactIds.length} requested (${totalFound} found in DB, ${totalFiltered} filtered, ${totalNotFound} not found)`);
        console.log(`📊 Contact lookup breakdown: ${contactIds.length} requested → ${totalFound} found in DB → ${allContacts.length} valid (${totalFiltered} filtered out, ${totalNotFound} not found)`);

        // Calculate and log the exact breakdown
        const totalUnsendable = totalFiltered + totalNotFound;
        const sendablePercentage = Math.round((allContacts.length / contactIds.length) * 100);
        const unsendablePercentage = Math.round((totalUnsendable / contactIds.length) * 100);

        console.log(`\n`);
        console.log(`╔════════════════════════════════════════════════════════════╗`);
        console.log(`║        API: CONTACT LOOKUP BREAKDOWN                        ║`);
        console.log(`╠════════════════════════════════════════════════════════════╣`);
        console.log(`║ Requested:                    ${contactIds.length.toString().padStart(10)} ║`);
        console.log(`║ Found in DB:                  ${totalFound.toString().padStart(10)} ║`);
        console.log(`║ Valid for sending:            ${allContacts.length.toString().padStart(10)} (${sendablePercentage}%) ║`);
        console.log(`║ Filtered (wrong page/missing psid): ${totalFiltered.toString().padStart(10)} ║`);
        console.log(`║ Not found in DB:              ${totalNotFound.toString().padStart(10)} ║`);
        console.log(`║ Total unsendable:             ${totalUnsendable.toString().padStart(10)} (${unsendablePercentage}%) ║`);
        console.log(`╚════════════════════════════════════════════════════════════╝`);
        console.log(`\n`);

        if (allContacts.length < contactIds.length) {
            const missing = contactIds.length - allContacts.length;
            console.error(`❌❌❌ CRITICAL: ${missing} contacts were not found or filtered out!`);
            console.error(`❌ Requested: ${contactIds.length}, Found in DB: ${totalFound}, Filtered: ${totalFiltered}, Not Found: ${totalNotFound}, Valid: ${allContacts.length}`);
            console.error(`❌ This means ${missing} contacts will NOT be sent!`);
            console.error(`❌ Possible reasons:`);
            console.error(`❌   1. Contacts have wrong page_id (belong to different page)`);
            console.error(`❌   2. Contacts are missing psid (need to be synced again)`);
            console.error(`❌   3. Contacts were deleted from database`);
            console.error(`❌ SOLUTION: Sync the page again to fix page_id and psid issues`);

            if (totalUnsendable > 0 && unsendablePercentage > 50) {
                console.error(`\n❌❌❌ MAJOR ISSUE: ${unsendablePercentage}% of contacts (${totalUnsendable}/${contactIds.length}) cannot be sent!`);
                console.error(`❌ This indicates a data quality issue - most contacts need to be synced again.`);
            }
        }

        if (allContacts.length === 0) {
            console.error(`❌❌❌ FATAL: No valid contacts found! Cannot send any messages.`);
        }

        // #region agent log
        writeDebugLog('api/facebook/messages/send/route.ts:338', 'Contact lookup complete', { requested: contactIds.length, found: totalFound, filtered: totalFiltered, notFound: totalNotFound, valid: allContacts.length, pageId }, 'H');
        // #endregion

        const results = {
            sent: 0,
            failed: 0,
            errors: [] as { contactId: string; error: string }[]
        };

        let utilityPermissionMissing = false;
        let utilityTemplateMissing = false;
        let utilityTemplateName = DEFAULT_UTILITY_TEMPLATE_NAME;
        let utilityTemplateLanguage = DEFAULT_UTILITY_TEMPLATE_LANGUAGE;
        let utilityTemplateBodyPlaceholderCount = 1;
        let utilityTemplateBodyText = '';
        let utilityTemplateLookupPromise: Promise<boolean> | null = null;
        let utilityTemplateBootstrapPromise: Promise<boolean> | null = null;
        let utilityTemplateBootstrapError: string | null = null;

        const applySelectedUtilityTemplate = (selectedTemplate: Record<string, unknown>) => {
            utilityTemplateName =
                typeof selectedTemplate.name === 'string'
                    ? selectedTemplate.name
                    : DEFAULT_UTILITY_TEMPLATE_NAME;

            const existingLanguage = extractTemplateLanguageCode(selectedTemplate);
            if (existingLanguage) {
                utilityTemplateLanguage = existingLanguage;
            }

            utilityTemplateBodyPlaceholderCount =
                extractBodyPlaceholderCount(selectedTemplate);
            utilityTemplateBodyText = extractBodyTemplateText(selectedTemplate);
        };

        const resolveExistingUtilityTemplate = async (): Promise<boolean> => {
            if (!utilityTemplateLookupPromise) {
                utilityTemplateLookupPromise = (async () => {
                    try {
                        const templates = await getPageTemplates(page.fb_page_id, page.access_token);

                        const utilityTemplates = templates.filter((template) => {
                            if (!template || typeof template !== 'object') return false;
                            const category = (template as Record<string, unknown>).category;
                            if (typeof category !== 'string') return true;
                            return category.toUpperCase() === 'UTILITY';
                        }) as Record<string, unknown>[];

                        const sendableTemplates = utilityTemplates.filter((template) => {
                            const status = normalizeTemplateStatus(template.status);
                            return status && SENDABLE_TEMPLATE_STATUSES.has(status);
                        });

                        const matchesRequestedButtons = (template: Record<string, unknown>) => {
                            return templateMatchesRequestedButtons(template, requestedButtons);
                        };

                        const supportTeamTemplate = sendableTemplates.find((template) => {
                            return (
                                isSupportTeamTemplate(template) &&
                                countPlaceholders(template) === 2 &&
                                matchesRequestedButtons(template)
                            );
                        });

                        const twoPlaceholderTemplate = sendableTemplates.find((template) => {
                            return countPlaceholders(template) === 2 && matchesRequestedButtons(template);
                        });

                        const anyApprovedWithPlaceholder = sendableTemplates.find((template) => {
                            return hasEditablePlaceholder(template) && matchesRequestedButtons(template);
                        });

                        const selectedTemplate = requiresSupportTeamTemplate
                            ? supportTeamTemplate
                            : supportTeamTemplate || twoPlaceholderTemplate || anyApprovedWithPlaceholder;

                        if (!selectedTemplate) {
                            if (utilityTemplates.length > 0) {
                                const statuses = utilityTemplates
                                    .map((template) => {
                                        const name =
                                            typeof template.name === 'string'
                                                ? template.name
                                                : 'unknown_template';
                                        const status =
                                            normalizeTemplateStatus(template.status) || 'UNKNOWN';
                                        return `${name}:${status}`;
                                    })
                                    .join(', ');
                                const buttonRequirement =
                                    requestedButtons.length > 0
                                        ? ' with matching buttons'
                                        : ' without buttons';
                                const bodyRequirement = requiresSupportTeamTemplate
                                    ? ' and 2-part support-team body'
                                    : ' and {{1}} placeholder';
                                utilityTemplateBootstrapError =
                                    `No approved utility template${buttonRequirement}${bodyRequirement} found. Existing statuses: ${statuses}`;
                                return false;
                            }

                            utilityTemplateBootstrapError =
                                'No utility templates found on this page. Create and approve one first.';
                            return false;
                        }

                        applySelectedUtilityTemplate(selectedTemplate);

                        utilityTemplateBootstrapError = null;
                        return true;
                    } catch (lookupError) {
                        utilityTemplateBootstrapError =
                            (lookupError as Error).message ||
                            'Failed to fetch utility templates for this page';
                        return false;
                    }
                })();
            }

            return utilityTemplateLookupPromise;
        };

        const attemptGenerateApprovedUtilityTemplate = async (): Promise<boolean> => {
            const startedAt = Date.now();
            let attempt = 0;
            const languageCandidates = Array.from(
                new Set([DEFAULT_UTILITY_TEMPLATE_LANGUAGE, 'en'])
            );
            const bodyTemplateCandidates = buildSupportTeamTemplateBodyCandidates(pageStatusHeadline);
            const generationCandidates = bodyTemplateCandidates.flatMap((bodyTemplate) =>
                languageCandidates.map((languageCandidate) => ({ bodyTemplate, languageCandidate }))
            );

            while (
                attempt < AUTO_TEMPLATE_MAX_ATTEMPTS &&
                Date.now() - startedAt < AUTO_TEMPLATE_TIME_BUDGET_MS
            ) {
                const candidate = generationCandidates[attempt % generationCandidates.length];
                const templateName = buildAutoTemplateName(attempt + 1);
                const templateCandidate = buildAutoTemplateCandidate(
                    templateName,
                    candidate.languageCandidate,
                    candidate.bodyTemplate,
                    requestedButtons
                );

                try {
                    const createdTemplate = await createUtilityTemplate(
                        page.fb_page_id,
                        page.access_token,
                        templateCandidate
                    );

                    const createdStatus = normalizeTemplateStatus(createdTemplate.status);
                    if (createdStatus && SENDABLE_TEMPLATE_STATUSES.has(createdStatus)) {
                        applySelectedUtilityTemplate({
                            name: templateCandidate.name,
                            language: candidate.languageCandidate,
                            status: createdTemplate.status,
                            category: 'UTILITY',
                            components: templateCandidate.components
                        });
                        utilityTemplateBootstrapError = null;
                        utilityTemplateLookupPromise = Promise.resolve(true);
                        return true;
                    }

                    utilityTemplateBootstrapError =
                        `Generated template '${templateCandidate.name}' created with status '${createdTemplate.status}'`;
                } catch (createError) {
                    const createErrorMessage =
                        (createError as Error).message ||
                        'Failed to auto-generate utility template';
                    utilityTemplateBootstrapError = createErrorMessage;

                    if (isUtilityPermissionError(createErrorMessage)) {
                        utilityPermissionMissing = true;
                        return false;
                    }
                }

                attempt += 1;

                utilityTemplateLookupPromise = null;
                const nowReady = await resolveExistingUtilityTemplate();
                if (nowReady) {
                    return true;
                }
            }

            if (!utilityTemplateBootstrapError) {
                utilityTemplateBootstrapError =
                    'No approved utility template found after multiple generation attempts';
            }

            return false;
        };

        const ensureUtilityTemplateExists = async (): Promise<boolean> => {
            if (utilityTemplateMissing) {
                return false;
            }

            const ready = await resolveExistingUtilityTemplate();
            if (ready) {
                return true;
            }

            if (!utilityTemplateBootstrapPromise) {
                utilityTemplateBootstrapPromise = attemptGenerateApprovedUtilityTemplate();
            }

            const generated = await utilityTemplateBootstrapPromise;
            if (generated) {
                utilityTemplateLookupPromise = Promise.resolve(true);
                return true;
            }

            utilityTemplateMissing = true;
            return false;
        };

        // Process messages in parallel batches to avoid timeout and respect rate limits
        const SEND_BATCH_SIZE = 15; // Send 15 messages in parallel (increased for faster processing)
        const DELAY_BETWEEN_BATCHES = 80; // 80ms delay between batches (reduced for faster processing)
        const MAX_PROCESSING_TIME = 270000; // 4.5 minutes (leave 30 seconds buffer before 5 min timeout)
        const startTime = Date.now();

        // #region agent log
        writeDebugLog('api/facebook/messages/send/route.ts:371', 'Send operation started', { totalContacts: allContacts.length, requestedCount: contactIds.length, foundCount: totalFound, filteredCount: totalFiltered, notFoundCount: totalNotFound, startTime }, 'I');
        // #endregion

        for (let i = 0; i < allContacts.length; i += SEND_BATCH_SIZE) {
            // Check if we're approaching timeout
            const elapsed = Date.now() - startTime;
            const sendBatchNumber = Math.floor(i / SEND_BATCH_SIZE) + 1;
            const totalSendBatches = Math.ceil(allContacts.length / SEND_BATCH_SIZE);
            // #region agent log
            writeDebugLog('api/facebook/messages/send/route.ts:377', 'Send batch loop iteration', { sendBatchNumber, totalSendBatches, batchIndex: i, processed: i, total: allContacts.length, batchSize: SEND_BATCH_SIZE, elapsed, MAX_PROCESSING_TIME, willTimeout: elapsed > MAX_PROCESSING_TIME }, 'B');
            // #endregion
            if (elapsed > MAX_PROCESSING_TIME) {
                const remainingContacts = allContacts.slice(i);
                const remainingContactIds = remainingContacts.map(c => c.id);

                // #region agent log
                writeDebugLog('api/facebook/messages/send/route.ts:383', 'Timeout triggered - partial response', { processed: i, total: allContacts.length, remaining: remainingContacts.length, remainingContactIdsCount: remainingContactIds.length, elapsed, sent: results.sent, failed: results.failed }, 'K');
                // #endregion
                console.warn(`⏱️ Approaching timeout, processed ${i}/${allContacts.length} contacts. ${remainingContacts.length} contacts remaining.`);
                const filteredCount = totalFiltered; // Contacts found but filtered (wrong page_id or missing psid)
                const notFoundCount = totalNotFound; // Contacts not found in database

                return NextResponse.json({
                    success: true,
                    partial: true,
                    message: `Processed ${i} of ${allContacts.length} contacts before timeout. ${remainingContacts.length} contacts remaining.`,
                    results: {
                        ...results,
                        processed: i,
                        total: allContacts.length,
                        remaining: remainingContacts.length,
                        filtered: filteredCount, // Contacts filtered during lookup
                        notFound: notFoundCount, // Contacts not found in database
                        requested: contactIds.length,
                        found: totalFound,
                        valid: allContacts.length
                    },
                    remainingContactIds: remainingContactIds // Return remaining contact IDs for automatic retry
                });
            }

            const batch = allContacts.slice(i, i + SEND_BATCH_SIZE);

            if (!utilityPermissionMissing && !utilityTemplateMissing) {
                const utilityTemplateReadyInBatch = await ensureUtilityTemplateExists();
                if (!utilityTemplateReadyInBatch && !utilityTemplateBootstrapError) {
                    utilityTemplateBootstrapError =
                        'No approved utility template is available for this page';
                }
            }

            // #region agent log
            writeDebugLog('api/facebook/messages/send/route.ts:475', 'Send batch extracted', { sendBatchNumber, batchSize: batch.length, batchStartIndex: i, batchEndIndex: i + batch.length - 1, totalContacts: allContacts.length }, 'B');
            // #endregion

            // Process batch in parallel - use allSettled to continue even if some fail
            const batchPromises = batch.map(async (contact) => {
                const msgType = getMessagingType();

                if (msgType === 'UTILITY' && utilityPermissionMissing) {
                    return {
                        success: false as const,
                        contactId: contact.id,
                        error: 'Skipped: missing pages_utility_messaging permission for utility messages'
                    };
                }

                if (msgType === 'UTILITY' && utilityTemplateMissing) {
                    return {
                        success: false as const,
                        contactId: contact.id,
                        error: utilityTemplateBootstrapError
                            ? `Skipped: utility template not ready for this page. ${utilityTemplateBootstrapError}`
                            : 'Skipped: utility template not ready for this page'
                    };
                }

                // Replace template variables with contact data for personalized messages
                const personalizedMessage = replaceTemplateVariablesForParts(messageText, {
                    id: contact.id,
                    psid: contact.psid,
                    page_id: pageId,
                    name: contact.name,
                    last_interaction_at: contact.last_interaction_at
                });

                try {
                    const utilityBodyParameters =
                        msgType === 'UTILITY'
                            ? buildUtilityBodyParameters(
                                utilityTemplateBodyPlaceholderCount,
                                personalizedMessage,
                                contact,
                                utilityTemplateBodyText
                            )
                            : undefined;

                    console.log(
                        `📤 Sending ${msgType} message to contact ${contact.id}. Template: ${utilityTemplateName} (${utilityTemplateLanguage}) params=${utilityBodyParameters?.length ?? 0}`
                    );
                    const messageToSend = msgType === 'UTILITY'
                        ? personalizedMessage.split('|||')[0] || personalizedMessage
                        : personalizedMessage.split('|||')[0] || personalizedMessage;
                    // Prepare button configs for utility messages
                    const utilityButtons = msgType === 'UTILITY' && requestedButtons.length > 0
                        ? requestedButtons.map(btn => {
                            if (btn.type === 'QUICK_REPLY') {
                                return { type: 'POSTBACK' as const, text: btn.text, payload: btn.payload || btn.text };
                            }
                            return { type: 'URL' as const, text: btn.text, url: btn.url || '' };
                        })
                        : undefined;

                    await sendMessage(
                        page.fb_page_id,
                        page.access_token,
                        contact.psid,
                        messageToSend,
                        msgType,
                        msgType === 'UTILITY' ? utilityTemplateName : undefined,
                        utilityTemplateLanguage,
                        utilityBodyParameters,
                        utilityButtons
                    );
                    console.log(`✅ Successfully sent message to contact ${contact.id} (PSID: ${contact.psid})`);

                    return { success: true as const, contactId: contact.id, error: undefined };
                } catch (error) {
                    let errorMessage = (error as Error).message || 'Unknown error';
                    console.error(`❌ Send failed for contact ${contact.id}: ${errorMessage}`);

                    if (msgType === 'UTILITY' && isUtilityTemplateMissingError(errorMessage)) {
                        utilityTemplateMissing = true;
                        utilityTemplateBootstrapError =
                            `Template '${utilityTemplateName}' is not sendable. ${errorMessage}`;
                        errorMessage = utilityTemplateBootstrapError;
                    }

                    if (msgType === 'UTILITY' && isUtilityPermissionError(errorMessage)) {
                        utilityPermissionMissing = true;
                    }

                    if (msgType === 'UTILITY' && isUtilityTemplateMissingError(errorMessage)) {
                        utilityTemplateMissing = true;
                    }

                    console.warn(`❌ Failed to send message to contact ${contact.id} (PSID: ${contact.psid}): ${errorMessage}`);
                    return { success: false as const, contactId: contact.id, error: errorMessage };
                }
            });

            // Wait for all promises to settle (complete or fail) - this ensures we continue even if some fail
            const batchResults = await Promise.allSettled(batchPromises);

            // Process results
            for (const result of batchResults) {
                if (result.status === 'fulfilled') {
                    if (result.value.success) {
                        results.sent += 1;
                    } else {
                        results.failed += 1;
                        results.errors.push({
                            contactId: result.value.contactId,
                            error: result.value.error || 'Unknown error'
                        });
                    }
                } else {
                    // Promise itself was rejected (shouldn't happen with our try/catch, but handle it)
                    results.failed += 1;
                    const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason || 'Unknown error');
                    results.errors.push({
                        contactId: 'unknown',
                        error: errorMsg
                    });
                }
            }

            // Add delay between batches to respect Facebook rate limits (except for last batch)
            if (i + SEND_BATCH_SIZE < allContacts.length) {
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
            }

            // Log progress every 50 contacts
            if ((i + SEND_BATCH_SIZE) % 50 === 0 || i + SEND_BATCH_SIZE >= allContacts.length) {
                const progress = Math.min(i + SEND_BATCH_SIZE, allContacts.length);
                const percentage = Math.round((progress / allContacts.length) * 100);
                const elapsed = Date.now() - startTime;
                const rate = progress / (elapsed / 1000); // contacts per second
                const remaining = allContacts.length - progress;
                const estimatedSeconds = remaining / rate;
                console.log(`📊 Progress: ${progress}/${allContacts.length} (${percentage}%) | Sent: ${results.sent}, Failed: ${results.failed} | Elapsed: ${Math.round(elapsed / 1000)}s | Est. remaining: ${Math.round(estimatedSeconds)}s`);
            }
        }

        console.log(`✅ Completed sending: ${results.sent} sent, ${results.failed} failed out of ${allContacts.length} valid contacts`);

        // Calculate final counts - use already calculated totalUnsendable from line 401
        const filteredCount = totalFiltered; // Contacts found but filtered (wrong page_id or missing psid)
        const notFoundCount = totalNotFound; // Contacts not found in database
        // totalUnsendable already declared at line 401 as (totalFiltered + totalNotFound)

        // #region agent log
        writeDebugLog('api/facebook/messages/send/route.ts:468', 'Send operation completed', { requested: contactIds.length, found: totalFound, filtered: filteredCount, notFound: notFoundCount, valid: allContacts.length, sent: results.sent, failed: results.failed, totalUnsendable, elapsed: Date.now() - startTime }, 'L');
        // #endregion

        // Validation: total should add up
        const expectedTotal = allContacts.length + totalUnsendable;
        if (expectedTotal !== contactIds.length) {
            console.warn(`⚠️ Count validation: Expected ${contactIds.length} but got ${expectedTotal} (valid: ${allContacts.length}, filtered: ${filteredCount}, not found: ${notFoundCount})`);
        }

        console.log(`\n`);
        console.log(`╔════════════════════════════════════════════════════════════╗`);
        console.log(`║        API: SEND OPERATION COMPLETE SUMMARY               ║`);
        console.log(`╠════════════════════════════════════════════════════════════╣`);
        console.log(`║ Requested:                    ${contactIds.length.toString().padStart(10)} ║`);
        console.log(`║ Found in DB:                  ${totalFound.toString().padStart(10)} ║`);
        console.log(`║ Valid for sending:            ${allContacts.length.toString().padStart(10)} ║`);
        console.log(`║ Filtered (wrong page/missing psid): ${filteredCount.toString().padStart(10)} ║`);
        console.log(`║ Not found in DB:              ${notFoundCount.toString().padStart(10)} ║`);
        console.log(`║ Total unsendable:              ${totalUnsendable.toString().padStart(10)} ║`);
        console.log(`║ Successfully sent:             ${results.sent.toString().padStart(10)} ║`);
        console.log(`║ Failed to send:                ${results.failed.toString().padStart(10)} ║`);
        console.log(`╠════════════════════════════════════════════════════════════╣`);

        if (totalUnsendable > 0) {
            const percentage = Math.round((totalUnsendable / contactIds.length) * 100);
            console.log(`║ ❌ ${totalUnsendable} contacts (${percentage}%) CANNOT be sent!        ║`);
            if (filteredCount > 0) {
                console.log(`║   - ${filteredCount} filtered (wrong page_id or missing psid)      ║`);
            }
            if (notFoundCount > 0) {
                console.log(`║   - ${notFoundCount} not found in database                      ║`);
            }
            console.log(`║                                                          ║`);
            console.log(`║ SOLUTION: Sync the page again to fix page_id/psid      ║`);
        } else if (results.sent === contactIds.length) {
            console.log(`║ ✅ All ${results.sent} contacts sent successfully!              ║`);
        }

        console.log(`╚════════════════════════════════════════════════════════════╝`);
        console.log(`\n`);

        if (totalUnsendable > 0) {
            console.error(`❌❌❌ CRITICAL: ${totalUnsendable} contacts were NOT sent!`);
            if (filteredCount > 0) {
                console.error(`❌   - ${filteredCount} contacts filtered (wrong page_id or missing psid)`);
                console.error(`❌   SOLUTION: Sync the page again to fix page_id and psid issues`);
            }
            if (notFoundCount > 0) {
                console.error(`❌   - ${notFoundCount} contacts not found in database (may have been deleted)`);
                console.error(`❌   SOLUTION: These contacts need to be re-synced or re-added`);
            }
            console.error(`❌   Total: ${filteredCount + notFoundCount} contacts cannot be sent out of ${contactIds.length} requested`);
        }

        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/6358f30b-ef0a-4ea4-8acc-50c08c025924', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: 'send/route.ts:360', message: 'Send complete', data: { sent: results.sent, failed: results.failed, total: allContacts.length, filtered: filteredCount, notFound: notFoundCount, elapsed: Date.now() - startTime }, timestamp: Date.now(), sessionId: 'debug-session', runId: 'run1', hypothesisId: 'A' }) }).catch(() => { });
        // #endregion

        // Final validation - ensure all contacts are accounted for
        const totalAccountedFor = results.sent + results.failed + filteredCount + notFoundCount;
        const missing = contactIds.length - totalAccountedFor;

        if (totalAccountedFor !== contactIds.length) {
            console.error(`❌❌❌ COUNT MISMATCH: ${contactIds.length} requested but only ${totalAccountedFor} accounted for!`);
            console.error(`❌   Sent: ${results.sent}, Failed: ${results.failed}, Filtered: ${filteredCount}, Not Found: ${notFoundCount}`);
            console.error(`❌   Missing: ${missing} contacts - this is a bug!`);
        } else {
            console.log(`✅ All contacts accounted for: ${totalAccountedFor}/${contactIds.length}`);
        }

        // Critical warning if many contacts were filtered
        if (filteredCount > 0 || notFoundCount > 0) {
            const totalUnsendable = filteredCount + notFoundCount;
            const percentage = Math.round((totalUnsendable / contactIds.length) * 100);
            if (percentage > 50) {
                console.error(`❌❌❌ CRITICAL: ${percentage}% of contacts (${totalUnsendable}/${contactIds.length}) cannot be sent!`);
                console.error(`❌   This is a major issue - most contacts are filtered or not found`);
                console.error(`❌   ACTION REQUIRED: Sync the page again to fix page_id and psid issues`);
            }
        }

        return NextResponse.json({
            success: true,
            results: {
                ...results,
                filtered: filteredCount, // Number of contacts filtered out during lookup (wrong page_id or missing psid)
                notFound: notFoundCount, // Number of contacts not found in database
                requested: contactIds.length, // Total requested
                found: totalFound, // Found in database
                valid: allContacts.length, // Valid contacts found
                accountedFor: totalAccountedFor // Total accounted for (for validation)
            },
            ...(batchErrors.length > 0 || emptyBatchSamples.length > 0
                ? { debug: { batchErrors, emptyBatchSamples } }
                : {})
        });
    } catch (error) {
        console.error('Error sending messages:', error);
        return NextResponse.json(
            { error: 'Failed to send messages', message: (error as Error).message },
            { status: 500 }
        );
    }
}
