// Delete rejected templates from Facebook and resubmit with the new {{1}} - static - {{2}} format
// Run: node fix-templates.mjs

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FB_URL = 'https://graph.facebook.com/v21.0';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// New templates with the proven {{1}} - static text - {{2}} format
const FIXED_TEMPLATES = [
    {
        name: 'account_general_notification',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: '{{1}} - Message from our support team - {{2}}',
            example: { body_text: [['Your account information has been updated successfully.', 'Thank you for choosing us.']] }
        }]
    },
    {
        name: 'account_security_alert',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: '{{1}} - Security notice from our team - {{2}}',
            example: { body_text: [['We detected a new login to your account from an unrecognized device.', 'If this was not you, please secure your account immediately.']] }
        }]
    },
    {
        name: 'account_update_notification',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: '{{1}} - Account update from our team - {{2}}',
            example: { body_text: [['Your account settings have been changed successfully.', 'Please review your updated preferences.']] }
        }]
    },
    {
        name: 'account_verification_alert',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: '{{1}} - Verification notice from our team - {{2}}',
            example: { body_text: [['Please verify your email address to complete your account setup.', 'Check your inbox for the verification link.']] }
        }]
    },
    {
        name: 'account_billing_notice',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: '{{1}} - Billing notification from our team - {{2}}',
            example: { body_text: [['Your billing statement for this month is now ready.', 'Please review the details in your account dashboard.']] }
        }]
    },
    {
        name: 'account_payment_confirmation',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: '{{1}} - Payment confirmation from our team - {{2}}',
            example: { body_text: [['Your payment has been received and processed successfully.', 'Thank you for your purchase.']] }
        }]
    },
    {
        name: 'account_promo_offer_notice',
        category: 'UTILITY',
        language: 'en_US',
        components: [
            {
                type: 'BODY',
                text: '{{1}} - Special offer from our team - {{2}}',
                example: { body_text: [['You have a new promotional offer available on your account.', 'Check it out before the offer expires!']] }
            },
            {
                type: 'BUTTONS',
                buttons: [{ type: 'URL', text: 'View Offer', url: 'https://example.com/offer' }]
            }
        ]
    },
    {
        name: 'account_appointment_reminder',
        category: 'UTILITY',
        language: 'en_US',
        components: [
            {
                type: 'BODY',
                text: '{{1}} - Appointment reminder from our team - {{2}}',
                example: { body_text: [['You have an upcoming appointment scheduled.', 'Please confirm your attendance or reschedule if needed.']] }
            },
            {
                type: 'BUTTONS',
                buttons: [
                    { type: 'POSTBACK', text: 'Confirm', payload: 'CONFIRM_APPOINTMENT' },
                    { type: 'POSTBACK', text: 'Reschedule', payload: 'RESCHEDULE_APPOINTMENT' }
                ]
            }
        ]
    },
    {
        name: 'account_order_status_update',
        category: 'UTILITY',
        language: 'en_US',
        components: [
            {
                type: 'BODY',
                text: '{{1}} - Order update from our team - {{2}}',
                example: { body_text: [['Your order status has been updated.', 'Track your delivery for the latest shipping information.']] }
            },
            {
                type: 'BUTTONS',
                buttons: [{ type: 'URL', text: 'Track Order', url: 'https://example.com/track' }]
            }
        ]
    },
    {
        name: 'account_feedback_request',
        category: 'UTILITY',
        language: 'en_US',
        components: [
            {
                type: 'BODY',
                text: '{{1}} - Feedback request from our team - {{2}}',
                example: { body_text: [['We would love to hear your feedback.', 'Please take a moment to share your experience with us.']] }
            },
            {
                type: 'BUTTONS',
                buttons: [
                    { type: 'POSTBACK', text: 'Leave Review', payload: 'LEAVE_REVIEW' },
                    { type: 'URL', text: 'Rate Us', url: 'https://example.com/rate' }
                ]
            }
        ]
    },
    {
        name: 'account_welcome_followup',
        category: 'UTILITY',
        language: 'en_US',
        components: [
            {
                type: 'BODY',
                text: '{{1}} - Welcome message from our team - {{2}}',
                example: { body_text: [['Welcome! We are glad to have you on board.', 'Get started with your account today and explore all features.']] }
            },
            {
                type: 'BUTTONS',
                buttons: [{ type: 'POSTBACK', text: 'Get Started', payload: 'GET_STARTED' }]
            }
        ]
    },
    {
        name: 'account_event_invitation',
        category: 'UTILITY',
        language: 'en_US',
        components: [
            {
                type: 'BODY',
                text: '{{1}} - Event invitation from our team - {{2}}',
                example: { body_text: [['You are invited to an upcoming event.', 'Reserve your spot now before seats fill up!']] }
            },
            {
                type: 'BUTTONS',
                buttons: [
                    { type: 'URL', text: 'RSVP Now', url: 'https://example.com/rsvp' },
                    { type: 'POSTBACK', text: 'Maybe Later', payload: 'EVENT_MAYBE_LATER' }
                ]
            }
        ]
    }
];

async function deleteTemplate(pageId, accessToken, templateName) {
    const url = `${FB_URL}/${pageId}/message_templates?name=${templateName}&access_token=${accessToken}`;
    const res = await fetch(url, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
        console.log(`  ❌ DELETE ${templateName}: ${data.error?.message || 'Unknown error'}`);
        return false;
    }
    console.log(`  ✅ DELETE ${templateName}: success`);
    return true;
}

async function main() {
    // Get all pages with tokens
    const { data: pages } = await supabase
        .from('pages')
        .select('id, name, fb_page_id, access_token');

    if (!pages?.length) {
        console.log('No pages found');
        return;
    }

    for (const page of pages) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Page: ${page.name} (${page.fb_page_id})`);
        console.log('='.repeat(60));

        // 1. Check existing templates
        const checkUrl = `${FB_URL}/${page.fb_page_id}/message_templates?fields=name,status,category&limit=100&access_token=${page.access_token}`;
        const checkRes = await fetch(checkUrl);

        if (!checkRes.ok) {
            const err = await checkRes.json().catch(() => ({}));
            console.log(`  ⚠️ Cannot fetch templates: ${err.error?.message || 'Unknown'}`);
            continue;
        }

        const existing = await checkRes.json();
        const existingTemplates = existing.data || [];
        const accountTemplates = existingTemplates.filter(t => t.name?.startsWith('account_'));

        console.log(`\n📋 Existing account_* templates: ${accountTemplates.length}`);
        for (const t of accountTemplates) {
            const emoji = t.status === 'APPROVED' ? '✅' : t.status === 'PENDING' ? '⏳' : '❌';
            console.log(`  ${emoji} ${t.name} — ${t.status}`);
        }

        // 2. Delete REJECTED templates
        const rejectedTemplates = accountTemplates.filter(t => t.status === 'REJECTED');
        if (rejectedTemplates.length > 0) {
            console.log(`\n🗑️ Deleting ${rejectedTemplates.length} rejected templates...`);
            for (const t of rejectedTemplates) {
                await deleteTemplate(page.fb_page_id, page.access_token, t.name);
            }
        } else {
            console.log('\n✅ No rejected templates to delete');
        }

        // 3. Re-check what exists now (after deletions)
        const recheckRes = await fetch(checkUrl);
        const recheckData = recheckRes.ok ? await recheckRes.json() : { data: [] };
        const remainingNames = new Set((recheckData.data || []).map(t => t.name));

        // 4. Submit new templates (skip already existing ones)
        console.log(`\n📤 Submitting ${FIXED_TEMPLATES.length} fixed templates...`);
        let submitted = 0;
        let skipped = 0;
        let failed = 0;

        for (const template of FIXED_TEMPLATES) {
            if (remainingNames.has(template.name)) {
                console.log(`  ⏭️ SKIP ${template.name} — already exists`);
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
                console.log(`  ❌ FAIL ${template.name}: ${data.error?.message || 'Unknown error'}`);
                failed++;
            } else {
                console.log(`  ✅ OK   ${template.name}: id=${data.id}, status=${data.status || 'PENDING'}`);
                submitted++;
            }
        }

        console.log(`\n📊 Summary: ${submitted} submitted, ${skipped} skipped, ${failed} failed`);

        // 5. Final status check
        console.log('\n--- Final Template Status ---');
        const finalRes = await fetch(checkUrl);
        if (finalRes.ok) {
            const finalData = await finalRes.json();
            const finalAccountTemplates = (finalData.data || []).filter(t => t.name?.startsWith('account_'));
            for (const t of finalAccountTemplates) {
                const emoji = t.status === 'APPROVED' ? '✅' : t.status === 'PENDING' ? '⏳' : '❌';
                console.log(`  ${emoji} ${t.name} — ${t.status}`);
            }
        }
    }

    console.log('\n\nDone!');
}

main().catch(console.error);
