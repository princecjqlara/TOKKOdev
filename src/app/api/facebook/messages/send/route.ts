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
        console.log(`📤 ========== API: MESSAGE SEND REQUEST ==========`);
        console.log(`📤 Received request to send to ${contactIds.length} contacts`);
        console.log(`📤 Page ID: ${pageId}`);
        console.log(`📤 Sample contact IDs (first 5):`, contactIds.slice(0, 5));
        console.log(`📤 Sample contact IDs (last 5):`, contactIds.slice(-5));
        console.log(`📤 ===============================================`);
        
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

        for (let i = 0; i < contactIds.length; i += batchSize) {
            batchesProcessed++;
            const batchNumber = Math.floor(i / batchSize) + 1;
            const totalBatches = Math.ceil(contactIds.length / batchSize);
            console.log(`📤 Processing batch ${batchNumber}/${totalBatches} (contacts ${i + 1} to ${Math.min(i + batchSize, contactIds.length)})`);
            const batchIds = contactIds.slice(i, i + batchSize);
            const { data: batchContacts, error: batchError } = await supabase
                .from('contacts')
                .select('id, psid, page_id')
                .in('id', batchIds);

            if (batchError) {
                batchesWithErrors++;
                const batchNum = Math.floor(i / batchSize) + 1;
                console.error(`❌❌❌ ERROR fetching contacts batch ${batchNum}:`, batchError);
                console.error(`❌ This batch will be skipped - ${batchIds.length} contacts will not be sent!`);
                console.error(`❌ Batch error details:`, JSON.stringify(batchError, null, 2));
                // Mark as not found (database error)
                totalNotFound += batchIds.length;
                continue;
            }

            if (!batchContacts?.length) {
                batchesWithErrors++;
                const batchNum = Math.floor(i / batchSize) + 1;
                console.error(`❌❌❌ Batch ${batchNum}: NO contacts found in database for ${batchIds.length} requested IDs!`);
                console.error(`❌ Sample IDs that don't exist:`, batchIds.slice(0, 5));
                console.error(`❌ These contacts may have been deleted from the database`);
                // Mark as not found
                totalNotFound += batchIds.length;
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
                batchesWithFiltered++;
                const batchNum = Math.floor(i / batchSize) + 1;
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
                allContacts = allContacts.concat(validContacts.map(c => ({ id: c.id, psid: c.psid.trim() })));
            }
        }

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
        console.log(`📊 Contact lookup breakdown: ${contactIds.length} requested → ${totalFound} found in DB → ${allContacts.length} valid (${totalFiltered} filtered out)`);
        
        if (allContacts.length < contactIds.length) {
            const missing = contactIds.length - allContacts.length;
            console.error(`❌❌❌ CRITICAL: ${missing} contacts were not found or filtered out!`);
            console.error(`❌ Requested: ${contactIds.length}, Found in DB: ${totalFound}, Filtered: ${totalFiltered}, Valid: ${allContacts.length}`);
            console.error(`❌ This means ${missing} contacts will NOT be sent!`);
            console.error(`❌ Possible reasons:`);
            console.error(`❌   1. Contacts have wrong page_id (belong to different page)`);
            console.error(`❌   2. Contacts are missing psid (need to be synced again)`);
            console.error(`❌   3. Contacts were deleted from database`);
            console.error(`❌ SOLUTION: Sync the page again to fix page_id and psid issues`);
        }
        
        if (allContacts.length === 0) {
            console.error(`❌❌❌ FATAL: No valid contacts found! Cannot send any messages.`);
        }
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/6358f30b-ef0a-4ea4-8acc-50c08c025924',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'send/route.ts:273',message:'Contact lookup complete',data:{requested:contactIds.length,found:totalFound,filtered:totalFiltered,valid:allContacts.length,pageId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
        // #endregion

        const results = {
            sent: 0,
            failed: 0,
            errors: [] as { contactId: string; error: string }[]
        };

        // Process messages in parallel batches to avoid timeout and respect rate limits
        const SEND_BATCH_SIZE = 15; // Send 15 messages in parallel (increased for faster processing)
        const DELAY_BETWEEN_BATCHES = 80; // 80ms delay between batches (reduced for faster processing)
        const MAX_PROCESSING_TIME = 270000; // 4.5 minutes (leave 30 seconds buffer before 5 min timeout)
        const startTime = Date.now();

        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/6358f30b-ef0a-4ea4-8acc-50c08c025924',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'send/route.ts:284',message:'Send start',data:{totalContacts:allContacts.length,requestedCount:contactIds.length,foundCount:totalFound,filteredCount:totalFiltered,startTime},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
        // #endregion

        for (let i = 0; i < allContacts.length; i += SEND_BATCH_SIZE) {
            // Check if we're approaching timeout
            const elapsed = Date.now() - startTime;
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/6358f30b-ef0a-4ea4-8acc-50c08c025924',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'send/route.ts:289',message:'Timeout check',data:{batchIndex:i,processed:i,total:allContacts.length,elapsed,MAX_PROCESSING_TIME,willTimeout:elapsed>MAX_PROCESSING_TIME},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
            // #endregion
            if (elapsed > MAX_PROCESSING_TIME) {
                const remainingContacts = allContacts.slice(i);
                const remainingContactIds = remainingContacts.map(c => c.id);
                
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/6358f30b-ef0a-4ea4-8acc-50c08c025924',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'send/route.ts:293',message:'Timeout triggered',data:{processed:i,total:allContacts.length,remaining:remainingContacts.length,remainingContactIdsCount:remainingContactIds.length,elapsed},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
                // #endregion
                console.warn(`⏱️ Approaching timeout, processed ${i}/${allContacts.length} contacts. ${remainingContacts.length} contacts remaining.`);
                const filteredCount = contactIds.length - allContacts.length;
                
                return NextResponse.json({
                    success: true,
                    partial: true,
                    message: `Processed ${i} of ${allContacts.length} contacts before timeout. ${remainingContacts.length} contacts remaining.`,
                    results: {
                        ...results,
                        processed: i,
                        total: allContacts.length,
                        remaining: remainingContacts.length,
                        filtered: filteredCount,
                        requested: contactIds.length,
                        valid: allContacts.length
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
                const progress = Math.min(i + SEND_BATCH_SIZE, allContacts.length);
                const percentage = Math.round((progress / allContacts.length) * 100);
                const elapsed = Date.now() - startTime;
                const rate = progress / (elapsed / 1000); // contacts per second
                const remaining = allContacts.length - progress;
                const estimatedSeconds = remaining / rate;
                console.log(`📊 Progress: ${progress}/${allContacts.length} (${percentage}%) | Sent: ${results.sent}, Failed: ${results.failed} | Elapsed: ${Math.round(elapsed/1000)}s | Est. remaining: ${Math.round(estimatedSeconds)}s`);
            }
        }

        console.log(`✅ Completed sending: ${results.sent} sent, ${results.failed} failed out of ${allContacts.length} valid contacts`);
        
        // Calculate final counts
        const filteredCount = totalFiltered; // Contacts found but filtered (wrong page_id or missing psid)
        const notFoundCount = totalNotFound; // Contacts not found in database
        const totalUnsendable = filteredCount + notFoundCount;
        
        // Validation: total should add up
        const expectedTotal = allContacts.length + totalUnsendable;
        if (expectedTotal !== contactIds.length) {
            console.warn(`⚠️ Count validation: Expected ${contactIds.length} but got ${expectedTotal} (valid: ${allContacts.length}, filtered: ${filteredCount}, not found: ${notFoundCount})`);
        }
        
        console.log(`📊 ========== SEND OPERATION COMPLETE ==========`);
        console.log(`📊 Requested: ${contactIds.length} contacts`);
        console.log(`📊 Found in DB: ${totalFound} contacts`);
        console.log(`📊 Valid for sending: ${allContacts.length} contacts`);
        console.log(`📊 Filtered out (wrong page_id/missing psid): ${filteredCount} contacts`);
        console.log(`📊 Not found in DB: ${notFoundCount} contacts`);
        console.log(`📊 Total unsendable: ${totalUnsendable} contacts`);
        console.log(`📊 Successfully sent: ${results.sent} contacts`);
        console.log(`📊 Failed to send: ${results.failed} contacts`);
        console.log(`📊 =============================================`);
        
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
        fetch('http://127.0.0.1:7242/ingest/6358f30b-ef0a-4ea4-8acc-50c08c025924',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'send/route.ts:360',message:'Send complete',data:{sent:results.sent,failed:results.failed,total:allContacts.length,filtered:filteredCount,notFound:notFoundCount,elapsed:Date.now()-startTime},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
        // #endregion
        
        // Final validation - ensure all contacts are accounted for
        const totalAccountedFor = results.sent + results.failed + filteredCount + notFoundCount;
        if (totalAccountedFor !== contactIds.length) {
            console.error(`❌❌❌ COUNT MISMATCH: ${contactIds.length} requested but only ${totalAccountedFor} accounted for!`);
            console.error(`❌   Sent: ${results.sent}, Failed: ${results.failed}, Filtered: ${filteredCount}, Not Found: ${notFoundCount}`);
            console.error(`❌   Missing: ${contactIds.length - totalAccountedFor} contacts`);
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
            }
        });
    } catch (error) {
        console.error('Error sending messages:', error);
        return NextResponse.json(
            { error: 'Failed to send messages', message: (error as Error).message },
            { status: 500 }
        );
    }
}
