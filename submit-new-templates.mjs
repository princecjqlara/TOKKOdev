// Delete all rejected/old templates and submit the new batch
// Run: node submit-new-templates.mjs

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://pnhzpeyzpwsmwcuafgpw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBuaHpwZXl6cHdzbXdjdWFmZ3B3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTI3NzkyMCwiZXhwIjoyMDgwODUzOTIwfQ.ZjqZesBGClf2Pw-bybb1Kn-F9KpA0D6jj-m76xUImTg';
const FB_URL = 'https://graph.facebook.com/v21.0';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// All new templates to submit — mix of 1-param and 2-param, varied structures
const TEMPLATES = [
    // === 1-PARAM: {{1}} in middle ===
    { name: 'acct_service_update_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Important update regarding your account: {{1}}. If you have any questions, please reply to this message.', example: { body_text: [['Your service plan has been upgraded to Premium effective immediately']] } }] },
    { name: 'acct_info_notice_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Notice: {{1}}. This message was sent to keep you informed about your account activity.', example: { body_text: [['A new device was used to access your account on March 15 2026']] } }] },
    { name: 'order_notification_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Order notification: {{1}}. Track your order status in your account at any time.', example: { body_text: [['Your package has been shipped via express delivery and the tracking number is PH1234567890']] } }] },
    { name: 'payment_notice_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Payment notification: {{1}}. View your complete billing history in your account.', example: { body_text: [['Your payment of PHP 5000 has been received and a receipt has been sent to your email']] } }] },
    { name: 'booking_update_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Booking update: {{1}}. If you need to make changes, please reply to this message or contact us.', example: { body_text: [['Your consultation scheduled for March 20 has been confirmed with our design specialist']] } }] },
    { name: 'support_response_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Update on your support request: {{1}}. Reply to this message if you need further assistance.', example: { body_text: [['Our technical team has resolved the issue you reported and your account should now be working normally']] } }] },

    // === 1-PARAM: {{1}} at start ===
    { name: 'general_alert_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: '{{1}}. This is an automated notification from our system. Reply STOP to opt out.', example: { body_text: [['Your weekly account summary is ready and shows 3 new transactions this week']] } }] },
    { name: 'general_alert_v2', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: '{{1}}. Thank you for being a valued customer. For assistance, reply to this message.', example: { body_text: [['Your account preferences have been updated based on your recent request']] } }] },

    // === 1-PARAM: {{1}} at end ===
    { name: 'acct_reminder_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Friendly reminder from our team: {{1}}.', example: { body_text: [['Your scheduled appointment is tomorrow at 2 PM and our team is ready to assist you']] } }] },
    { name: 'general_msg_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Message from our team: {{1}}.', example: { body_text: [['Your recent inquiry has been forwarded to the appropriate department for review']] } }] },
    { name: 'general_notice_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Important notice: {{1}}. Please review this information at your earliest convenience.', example: { body_text: [['Our terms of service have been updated effective April 1st 2026']] } }] },

    // === 1-PARAM: greeting prefix ===
    { name: 'acct_followup_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Hello! We have an update for you. {{1}}. Thank you for being a valued customer.', example: { body_text: [['Your request has been processed and the changes are now active on your account']] } }] },
    { name: 'general_msg_v2', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Hi! {{1}}. If you have questions, feel free to reach out to us anytime.', example: { body_text: [['We have updated our store hours and we are now open until 9 PM on weekdays']] } }] },
    { name: 'general_msg_v3', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Good day! Here is an update for you: {{1}}. Thank you for choosing our services.', example: { body_text: [['New service packages are now available and you can view them in your account dashboard']] } }] },

    // === 2-PARAM: various structures ===
    { name: 'acct_update_2p_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Account update: {{1}}. {{2}}.', example: { body_text: [['Your membership has been renewed for another year', 'Thank you for your continued support']] } }] },
    { name: 'service_notice_2p_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Service notice: {{1}}. For reference: {{2}}.', example: { body_text: [['Your service appointment has been rescheduled', 'New date is April 5 at 10 AM']] } }] },
    { name: 'order_update_2p_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Order update: {{1}}. Details: {{2}}. Contact us if you need help.', example: { body_text: [['Your order is on its way', 'Estimated delivery is March 25 between 9 AM and 5 PM']] } }] },
    { name: 'acct_greeting_2p_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Hello! {{1}}. {{2}}. If you have questions, please reply to this message.', example: { body_text: [['We wanted to let you know about an important change to your account settings', 'Your preferences have been saved successfully']] } }] },
    { name: 'acct_greeting_2p_v2', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Hi there! {{1}} - {{2}}. Thank you for your attention.', example: { body_text: [['Your billing cycle has been updated', 'Next payment is due on April 15']] } }] },
    { name: 'acct_detail_2p_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Important: {{1}}. Additional information: {{2}}.', example: { body_text: [['Your account security settings have been updated', 'Two-factor authentication is now enabled']] } }] },
    { name: 'acct_detail_2p_v2', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Notification: {{1}}. Note: {{2}}. Reply for assistance.', example: { body_text: [['Your subscription plan will change on your next billing date', 'You can cancel anytime before the renewal date']] } }] },
    { name: 'delivery_info_2p_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Delivery update: {{1}}. Tracking info: {{2}}.', example: { body_text: [['Your package has been dispatched from our warehouse', 'Tracking number PH9876543210 via LBC Express']] } }] },
    { name: 'quick_update_2p_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: '{{1}} - {{2}}', example: { body_text: [['Your appointment has been confirmed for April 3 at 2 PM', 'Please arrive 10 minutes early and bring your ID']] } }] },
    { name: 'quick_notice_2p_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: '{{1}}. {{2}}.', example: { body_text: [['Your recent transaction has been processed successfully', 'A confirmation email has been sent to your registered address']] } }] },

    // === WITH BUTTONS ===
    { name: 'acct_update_btn_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Account update: {{1}}. Tap below for more details.', example: { body_text: [['Your membership renewal options are now available for the upcoming period']] } }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'View Details', url: 'https://example.com/account' }] }] },
    { name: 'order_track_btn_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Your order has been updated. {{1}}. Track your order below.', example: { body_text: [['Your package is currently in transit and will arrive within 2 business days']] } }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Track Order', url: 'https://example.com/track' }] }] },
    { name: 'booking_confirm_btn_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Booking confirmation: {{1}}. Use the buttons below to manage your booking.', example: { body_text: [['Your design consultation has been scheduled for next Monday at 3 PM']] } }, { type: 'BUTTONS', buttons: [{ type: 'POSTBACK', text: 'Confirm', payload: 'CONFIRM_BOOKING' }, { type: 'POSTBACK', text: 'Reschedule', payload: 'RESCHEDULE_BOOKING' }] }] },
    { name: 'service_update_btn_2p_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Service update: {{1}}. Reference: {{2}}.', example: { body_text: [['Your support ticket has been updated with a new response', 'Ticket number SUP-20260328-001']] } }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'View Ticket', url: 'https://example.com/support' }, { type: 'POSTBACK', text: 'Mark Resolved', payload: 'TICKET_RESOLVED' }] }] },
    { name: 'promo_notice_btn_2p_v1', category: 'UTILITY', language: 'en_US', components: [{ type: 'BODY', text: 'Notification for you: {{1}}. Details: {{2}}.', example: { body_text: [['A special offer is now available on your account', 'Valid until April 30 2026 for all Premium members']] } }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Learn More', url: 'https://example.com/offers' }] }] },
];

async function deleteTemplate(pageId, accessToken, templateName) {
    const url = `${FB_URL}/${pageId}/message_templates?name=${templateName}&access_token=${accessToken}`;
    const res = await fetch(url, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
        console.log(`    ❌ DELETE ${templateName}: ${data.error?.message || 'Unknown error'}`);
        return false;
    }
    console.log(`    ✅ DELETE ${templateName}: success`);
    return true;
}

async function main() {
    // Get all pages
    const { data: pages } = await supabase
        .from('pages')
        .select('id, name, fb_page_id, access_token');

    if (!pages?.length) {
        console.log('No pages found');
        return;
    }

    for (const page of pages) {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`PAGE: ${page.name} (FB: ${page.fb_page_id})`);
        console.log('='.repeat(70));

        // 1. Check existing templates
        const checkUrl = `${FB_URL}/${page.fb_page_id}/message_templates?fields=name,status,category&limit=200&access_token=${page.access_token}`;
        const checkRes = await fetch(checkUrl);

        if (!checkRes.ok) {
            const err = await checkRes.json().catch(() => ({}));
            console.log(`  ⚠️ Cannot access templates: ${err.error?.message || 'Unknown'}`);
            continue;
        }

        const existing = await checkRes.json();
        const allExisting = existing.data || [];
        console.log(`\n  📋 Total existing templates: ${allExisting.length}`);

        // Show existing account/custom templates
        const customTemplates = allExisting.filter(t =>
            !t.name?.startsWith('sample_') && t.name !== 'hello_world'
        );
        for (const t of customTemplates) {
            const emoji = t.status === 'APPROVED' ? '✅' :
                          t.status === 'PENDING' ? '⏳' : '❌';
            console.log(`    ${emoji} ${t.name} — ${t.status} (${t.category || 'N/A'})`);
        }

        // 2. Delete REJECTED templates
        const rejected = allExisting.filter(t => t.status === 'REJECTED');
        if (rejected.length > 0) {
            console.log(`\n  🗑️ Deleting ${rejected.length} rejected templates...`);
            for (const t of rejected) {
                await deleteTemplate(page.fb_page_id, page.access_token, t.name);
            }
        }

        // 3. Re-check after deletions
        const recheckRes = await fetch(checkUrl);
        const recheckData = recheckRes.ok ? await recheckRes.json() : { data: [] };
        const remainingNames = new Set((recheckData.data || []).map(t => t.name));

        // 4. Submit new templates
        console.log(`\n  📤 Submitting ${TEMPLATES.length} templates...`);
        let submitted = 0, skipped = 0, failed = 0;

        for (const template of TEMPLATES) {
            if (remainingNames.has(template.name)) {
                const match = (recheckData.data || []).find(t => t.name === template.name);
                console.log(`    ⏭️  SKIP ${template.name} — exists (${match?.status || '?'})`);
                skipped++;
                continue;
            }

            const res = await fetch(
                `${FB_URL}/${page.fb_page_id}/message_templates?access_token=${page.access_token}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(template)
                }
            );

            const data = await res.json();
            if (!res.ok) {
                const errMsg = data.error?.message || 'Unknown error';
                const errDetail = data.error?.error_user_msg || '';
                console.log(`    ❌ FAIL ${template.name}: ${errMsg}${errDetail ? ` | ${errDetail}` : ''}`);
                failed++;
            } else {
                const status = data.status || 'PENDING';
                const emoji = status === 'APPROVED' ? '✅' :
                              status === 'PENDING' ? '⏳' : '❌';
                console.log(`    ${emoji} OK   ${template.name}: id=${data.id}, status=${status}`);
                submitted++;
            }

            // Small delay to avoid rate limiting
            await new Promise(r => setTimeout(r, 200));
        }

        console.log(`\n  📊 Results: ${submitted} submitted, ${skipped} skipped, ${failed} failed`);

        // 5. Final status check
        console.log('\n  --- Final Template Status ---');
        const finalRes = await fetch(checkUrl);
        if (finalRes.ok) {
            const finalData = await finalRes.json();
            const finalCustom = (finalData.data || []).filter(t =>
                !t.name?.startsWith('sample_') && t.name !== 'hello_world'
            );

            let approved = 0, pending = 0, rejectedCount = 0;
            for (const t of finalCustom) {
                const emoji = t.status === 'APPROVED' ? '✅' :
                              t.status === 'PENDING' ? '⏳' : '❌';
                console.log(`    ${emoji} ${t.name} — ${t.status}`);
                if (t.status === 'APPROVED') approved++;
                else if (t.status === 'PENDING') pending++;
                else rejectedCount++;
            }
            console.log(`\n  Summary: ${approved} APPROVED, ${pending} PENDING, ${rejectedCount} REJECTED`);
        }
    }

    console.log('\n\nDone!');
}

main().catch(console.error);
