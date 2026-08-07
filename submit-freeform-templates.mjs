// Submit natural/free-form sounding templates to Facebook for approval
// These sound like a real person messaging, NOT automated system notifications
// Run: node submit-freeform-templates.mjs

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FB_URL = 'https://graph.facebook.com/v21.0';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===========================================================================
//  NEW FREE-FORM / NATURAL TEMPLATES
//  These are designed to sound like a real person messaging, not a robot.
//  {{1}} = your custom message
// ===========================================================================
const FREEFORM_TEMPLATES = [
    // --- Casual / conversational 1-param ---
    {
        name: 'friendly_msg_v1',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: 'Hey! Just wanted to let you know — {{1}}. Feel free to reply if you have any questions!',
            example: { body_text: [['we just restocked the items you were looking at and they are available again']] }
        }]
    },
    {
        name: 'friendly_msg_v2',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: 'Hi there! {{1}}. Let us know if there is anything else we can help with.',
            example: { body_text: [['Your order has been prepared and is ready for pickup at our main branch']] }
        }]
    },
    {
        name: 'friendly_msg_v3',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: 'Just a quick heads up: {{1}}. Thanks!',
            example: { body_text: [['we will be having a short maintenance window tonight from 10 PM to 11 PM']] }
        }]
    },
    {
        name: 'friendly_msg_v4',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: 'Hi! Quick update for you — {{1}}. Hope this helps!',
            example: { body_text: [['your refund has been processed and should appear in your account within 3 to 5 business days']] }
        }]
    },
    {
        name: 'friendly_msg_v5',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: '{{1}} — just keeping you in the loop!',
            example: { body_text: [['We have finished setting up your new account and everything is good to go']] }
        }]
    },
    {
        name: 'friendly_msg_v6',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: 'Hey, just thought you should know: {{1}}.',
            example: { body_text: [['the item you reserved has arrived and is waiting for you at the store']] }
        }]
    },
    {
        name: 'casual_update_v1',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: 'Good news! {{1}}. Reach out if you need anything else.',
            example: { body_text: [['Your replacement part has arrived early and we can schedule the repair at your convenience']] }
        }]
    },
    {
        name: 'casual_update_v2',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: 'Wanted to reach out — {{1}}. Reply to this message anytime.',
            example: { body_text: [['we noticed you had a question about our subscription plans and we are happy to help']] }
        }]
    },
    {
        name: 'casual_update_v3',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: 'Just checking in! {{1}}. Let us know how it goes.',
            example: { body_text: [['Your new setup should be working now and we wanted to make sure everything is running smoothly']] }
        }]
    },
    {
        name: 'casual_update_v4',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: 'Quick reminder — {{1}}. Talk soon!',
            example: { body_text: [['your appointment with our team is tomorrow at 3 PM so just reply if you need to reschedule']] }
        }]
    },

    // --- Simple / minimal templates (feel like a personal DM) ---
    {
        name: 'simple_msg_v1',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: 'Hi! {{1}}.',
            example: { body_text: [['Your request has been completed and you should see the changes reflected in your account']] }
        }]
    },
    {
        name: 'simple_msg_v2',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: 'Hey! {{1}}',
            example: { body_text: [['We just wanted to confirm that your delivery has been scheduled for tomorrow morning']] }
        }]
    },
    {
        name: 'simple_msg_v3',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: '{{1}} — thanks for choosing us!',
            example: { body_text: [['Your booking is all set and confirmed for next Friday at 2 PM']] }
        }]
    },
    {
        name: 'simple_msg_v4',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: 'Just a note: {{1}}. Have a great day!',
            example: { body_text: [['we have applied the discount to your next order as discussed']] }
        }]
    },

    // --- 2-param natural templates ---
    {
        name: 'friendly_2p_v1',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: 'Hey! {{1}}. {{2}}',
            example: { body_text: [['Your package is on its way', 'It should arrive by end of day tomorrow']] }
        }]
    },
    {
        name: 'friendly_2p_v2',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: 'Hi there! {{1}} — {{2}}. Let us know if you need anything!',
            example: { body_text: [['Everything is set for your appointment', 'just bring your ID and confirmation number']] }
        }]
    },
    {
        name: 'friendly_2p_v3',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: 'Quick update: {{1}}. Also, {{2}}.',
            example: { body_text: [['Your order has shipped from Manila', 'estimated arrival is 2 to 3 business days']] }
        }]
    },
    {
        name: 'simple_2p_v1',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: '{{1}}. {{2}}.',
            example: { body_text: [['Your subscription has been renewed', 'Next billing date is May 1']] }
        }]
    },
    {
        name: 'simple_2p_v2',
        category: 'UTILITY',
        language: 'en_US',
        components: [{
            type: 'BODY',
            text: '{{1}} — {{2}}',
            example: { body_text: [['Your account is all set up', 'you can now access all features from your dashboard']] }
        }]
    },

    // --- Free-form with action buttons ---
    {
        name: 'friendly_btn_v1',
        category: 'UTILITY',
        language: 'en_US',
        components: [
            {
                type: 'BODY',
                text: 'Hey! {{1}}. Tap below to check it out.',
                example: { body_text: [['We have something new for you based on your recent activity']] }
            },
            {
                type: 'BUTTONS',
                buttons: [{ type: 'URL', text: 'Check it out', url: 'https://example.com/view' }]
            }
        ]
    },
    {
        name: 'friendly_btn_v2',
        category: 'UTILITY',
        language: 'en_US',
        components: [
            {
                type: 'BODY',
                text: 'Hi! {{1}}. Interested? Tap below.',
                example: { body_text: [['Your personalized recommendations are ready and waiting for you']] }
            },
            {
                type: 'BUTTONS',
                buttons: [
                    { type: 'POSTBACK', text: 'Yes, tell me more', payload: 'INTERESTED_YES' },
                    { type: 'POSTBACK', text: 'Not right now', payload: 'INTERESTED_NO' }
                ]
            }
        ]
    },
    {
        name: 'casual_btn_v1',
        category: 'UTILITY',
        language: 'en_US',
        components: [
            {
                type: 'BODY',
                text: 'Just wanted to share: {{1}}. Take a look!',
                example: { body_text: [['We updated your account with some improvements based on your feedback']] }
            },
            {
                type: 'BUTTONS',
                buttons: [{ type: 'URL', text: 'View Now', url: 'https://example.com/details' }]
            }
        ]
    },
];

async function main() {
    // Get all pages
    const { data: pages } = await supabase
        .from('pages')
        .select('id, name, fb_page_id, access_token')
        .ilike('name', '%JP Luxe Estate%');

    if (!pages?.length) {
        console.log('No pages found');
        return;
    }

    const allResults = [];

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
        const existingNames = new Set((existing.data || []).map(t => t.name));
        console.log(`  📋 Total existing templates: ${existingNames.size}`);

        // 2. Submit new free-form templates
        console.log(`\n  📤 Submitting ${FREEFORM_TEMPLATES.length} free-form templates...`);
        let submitted = 0, skipped = 0, failed = 0;
        const pageResults = [];

        for (const template of FREEFORM_TEMPLATES) {
            if (existingNames.has(template.name)) {
                const match = (existing.data || []).find(t => t.name === template.name);
                const status = match?.status || '?';
                console.log(`    ⏭️  SKIP ${template.name} — exists (${status})`);
                skipped++;
                pageResults.push({ name: template.name, status, action: 'SKIPPED', page: page.name });
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
                pageResults.push({ name: template.name, status: 'FAILED', action: 'FAILED', error: errMsg, page: page.name });
            } else {
                const status = data.status || 'PENDING';
                const emoji = status === 'APPROVED' ? '✅' :
                              status === 'PENDING' ? '⏳' : '❌';
                console.log(`    ${emoji} OK   ${template.name}: id=${data.id}, status=${status}`);
                submitted++;
                pageResults.push({ name: template.name, status, action: 'SUBMITTED', id: data.id, page: page.name });
            }

            // Small delay to avoid rate limiting
            await new Promise(r => setTimeout(r, 200));
        }

        console.log(`\n  📊 Submission: ${submitted} submitted, ${skipped} skipped, ${failed} failed`);

        // 3. Wait a moment then check final status
        console.log('\n  ⏳ Checking final statuses...');
        await new Promise(r => setTimeout(r, 2000));

        const finalRes = await fetch(checkUrl);
        if (finalRes.ok) {
            const finalData = await finalRes.json();
            const allTemplates = finalData.data || [];
            
            // Only show our free-form templates
            const freeformNames = new Set(FREEFORM_TEMPLATES.map(t => t.name));
            const ourTemplates = allTemplates.filter(t => freeformNames.has(t.name));

            console.log(`\n  ${'─'.repeat(60)}`);
            console.log(`  📋 FREE-FORM TEMPLATE STATUS for ${page.name}:`);
            console.log(`  ${'─'.repeat(60)}`);

            let approved = 0, pending = 0, rejected = 0;
            for (const t of ourTemplates) {
                const emoji = t.status === 'APPROVED' ? '✅' :
                              t.status === 'PENDING' ? '⏳' : 
                              t.status === 'REJECTED' ? '❌' : '❓';
                const bodyComp = t.components?.find(c => c.type === 'BODY');
                const bodyText = bodyComp?.text || '';
                console.log(`    ${emoji} ${t.status.padEnd(10)} ${t.name}`);
                console.log(`       📝 "${bodyText}"`);
                
                if (t.status === 'APPROVED') approved++;
                else if (t.status === 'PENDING') pending++;
                else rejected++;
            }

            console.log(`\n  ✨ Summary: ${approved} APPROVED, ${pending} PENDING, ${rejected} REJECTED/OTHER`);
            
            allResults.push({
                page: page.name,
                approved: ourTemplates.filter(t => t.status === 'APPROVED').map(t => ({
                    name: t.name,
                    body: t.components?.find(c => c.type === 'BODY')?.text || ''
                })),
                pending: ourTemplates.filter(t => t.status === 'PENDING').map(t => t.name),
                rejected: ourTemplates.filter(t => t.status !== 'APPROVED' && t.status !== 'PENDING').map(t => t.name)
            });
        }
    }

    // Final summary across all pages
    console.log(`\n\n${'═'.repeat(70)}`);
    console.log('OVERALL SUMMARY');
    console.log('═'.repeat(70));
    for (const result of allResults) {
        console.log(`\n📄 ${result.page}:`);
        console.log(`   ✅ Approved (${result.approved.length}):`);
        for (const t of result.approved) {
            console.log(`      • ${t.name}`);
            console.log(`        "${t.body}"`);
        }
        if (result.pending.length > 0) {
            console.log(`   ⏳ Pending (${result.pending.length}): ${result.pending.join(', ')}`);
        }
        if (result.rejected.length > 0) {
            console.log(`   ❌ Rejected (${result.rejected.length}): ${result.rejected.join(', ')}`);
        }
    }

    console.log('\n\nDone! Review approved templates above before adding to system.');
}

main().catch(console.error);
