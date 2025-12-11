import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { sendMessage } from '@/lib/facebook';

interface ContactRecord {
    id: string;
    psid: string;
    page_id: string;
}

// Increase timeout for sending messages (up to 5 minutes)
export const maxDuration = 300;

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

        const { pageId, contactIds, messageText } = body as {
            pageId?: string;
            contactIds?: string[];
            messageText?: string;
        };

        if (!pageId || !contactIds?.length || !messageText) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Missing required fields' },
                { status: 400 }
            );
        }

        // Log total contacts to send
        console.log(`📤 Received request to send to ${contactIds.length} contacts`);
        
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

        // Get contacts - handle large arrays by batching
        // Note: We trust that contactIds were fetched correctly for this page
        // So we don't need to filter by page_id again - just query by IDs
        let allContacts: { id: string; psid: string }[] = [];
        const batchSize = 1000; // Supabase has limits on .in() array size

        console.log(`📤 Processing ${contactIds.length} contact IDs for page ${pageId}`);
        console.log(`📤 Sample contact IDs (first 5):`, contactIds.slice(0, 5));

        let totalRequested = contactIds.length;
        let totalFound = 0;
        let totalFiltered = 0;

        for (let i = 0; i < contactIds.length; i += batchSize) {
            const batchIds = contactIds.slice(i, i + batchSize);
            const { data: batchContacts, error: batchError } = await supabase
                .from('contacts')
                .select('id, psid, page_id')
                .in('id', batchIds);

            if (batchError) {
                console.error(`❌ Error fetching contacts batch ${i / batchSize + 1}:`, batchError);
                continue;
            }

            if (!batchContacts?.length) {
                console.warn(`⚠️ Batch ${i / batchSize + 1}: no contacts found for ${batchIds.length} requested IDs`);
                console.warn(`⚠️ Sample IDs from this batch:`, batchIds.slice(0, 5));
                continue;
            }

            totalFound += batchContacts.length;

            const validContacts = batchContacts.filter((contact): contact is ContactRecord => {
                const correctPage = contact.page_id === pageId;
                const validPsid = typeof contact.psid === 'string' && contact.psid.trim() !== '';
                return correctPage && validPsid;
            });

            const filteredCount = batchContacts.length - validContacts.length;
            totalFiltered += filteredCount;

            if (filteredCount > 0) {
                const wrongPage = batchContacts.filter(c => c.page_id !== pageId).length;
                const missingPsid = batchContacts.filter(c => typeof c.psid !== 'string' || c.psid.trim() === '').length;
                console.warn(
                    `⚠️ Batch ${i / batchSize + 1}: filtered ${filteredCount} contacts (wrong page: ${wrongPage}, missing psid: ${missingPsid})`
                );
                if (wrongPage > 0) {
                    console.warn(`⚠️ Example contacts with wrong page_id:`, 
                        batchContacts.filter(c => c.page_id !== pageId).slice(0, 3).map(c => ({ id: c.id, page_id: c.page_id, expected: pageId }))
                    );
                }
            }

            if (validContacts.length) {
                allContacts = allContacts.concat(validContacts.map(c => ({ id: c.id, psid: c.psid.trim() })));
            }
        }

        console.log(`📊 Contact lookup summary: ${totalRequested} requested, ${totalFound} found in DB, ${totalFiltered} filtered out, ${allContacts.length} valid for sending`);

        if (!allContacts.length) {
            // Fallback: fetch all contacts for the page and use those with valid psid
            const { data: pageContacts, error: pageContactsError } = await supabase
                .from('contacts')
                .select('id, page_id, psid')
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
                    allContacts = validPageContacts.map(c => ({ id: c.id, psid: c.psid.trim() }));
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
                            sampleContacts: anyContacts?.slice(0, 5) || []
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

        console.log(`✅ Found ${allContacts.length} valid contacts out of ${contactIds.length} requested (${totalFound} found in DB, ${totalFiltered} filtered)`);

        const results = {
            sent: 0,
            failed: 0,
            errors: [] as { contactId: string; error: string }[]
        };

        // Process messages in parallel batches to avoid timeout and respect rate limits
        const SEND_BATCH_SIZE = 10; // Send 10 messages in parallel
        const DELAY_BETWEEN_BATCHES = 100; // 100ms delay between batches to respect rate limits
        const MAX_PROCESSING_TIME = 240000; // 4 minutes (leave 1 minute buffer before 5 min timeout)
        const startTime = Date.now();

        for (let i = 0; i < allContacts.length; i += SEND_BATCH_SIZE) {
            // Check if we're approaching timeout
            const elapsed = Date.now() - startTime;
            if (elapsed > MAX_PROCESSING_TIME) {
                const remainingContacts = allContacts.slice(i);
                const remainingContactIds = remainingContacts.map(c => c.id);
                
                console.warn(`⏱️ Approaching timeout, processed ${i}/${allContacts.length} contacts. ${remainingContacts.length} contacts remaining.`);
                return NextResponse.json({
                    success: true,
                    partial: true,
                    message: `Processed ${i} of ${allContacts.length} contacts before timeout. ${remainingContacts.length} contacts remaining.`,
                    results: {
                        ...results,
                        processed: i,
                        total: allContacts.length,
                        remaining: remainingContacts.length
                    },
                    remainingContactIds: remainingContactIds // Return remaining contact IDs for automatic retry
                });
            }

            const batch = allContacts.slice(i, i + SEND_BATCH_SIZE);
            
            // Process batch in parallel - use allSettled to continue even if some fail
            const batchPromises = batch.map(async (contact) => {
                try {
                    const result = await sendMessage(page.fb_page_id, page.access_token, contact.psid, messageText);
                    console.log(`✅ Successfully sent message to contact ${contact.id} (PSID: ${contact.psid})`);
                    return { success: true as const, contactId: contact.id, error: undefined };
                } catch (error) {
                    const errorMessage = (error as Error).message || 'Unknown error';
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
                console.log(`Progress: ${Math.min(i + SEND_BATCH_SIZE, allContacts.length)}/${allContacts.length} contacts processed (Sent: ${results.sent}, Failed: ${results.failed})`);
            }
        }

        console.log(`Completed sending: ${results.sent} sent, ${results.failed} failed out of ${allContacts.length} total`);

        return NextResponse.json({
            success: true,
            results
        });
    } catch (error) {
        console.error('Error sending messages:', error);
        return NextResponse.json(
            { error: 'Failed to send messages', message: (error as Error).message },
            { status: 500 }
        );
    }
}
