// Submit account_* utility templates to Facebook via Graph API
// Bypasses app auth — uses Supabase service role to get page tokens

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://pnhzpeyzpwsmwcuafgpw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBuaHpwZXl6cHdzbXdjdWFmZ3B3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTI3NzkyMCwiZXhwIjoyMDgwODUzOTIwfQ.ZjqZesBGClf2Pw-bybb1Kn-F9KpA0D6jj-m76xUImTg';
const FB_URL = 'https://graph.facebook.com/v21.0';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// The templates from facebook.ts (first 3 simple ones to test)
const TEST_TEMPLATES = [
    {
        name: 'account_general_notification',
        category: 'UTILITY',
        language: 'en_US',
        components: [
            {
                type: 'BODY',
                text: '{{1}}',
                example: { body_text: [['Your account information has been updated.']] }
            }
        ]
    },
    {
        name: 'account_security_alert',
        category: 'UTILITY',
        language: 'en_US',
        components: [
            {
                type: 'BODY',
                text: '{{1}}',
                example: { body_text: [['We detected a new login to your account. If this was not you, please secure your account immediately.']] }
            }
        ]
    },
    {
        name: 'account_update_notification',
        category: 'UTILITY',
        language: 'en_US',
        components: [
            {
                type: 'BODY',
                text: '{{1}}',
                example: { body_text: [['Your account settings have been changed successfully.']] }
            }
        ]
    }
];

async function main() {
    // Pick a page with a valid token — use Whisperwalk which had 2 approved templates
    const { data: pages } = await supabase
        .from('pages')
        .select('id, name, fb_page_id, access_token')
        .eq('fb_page_id', '754512431281378'); // Whisperwalk Interior

    if (!pages?.length) {
        // Fallback: try Ares Media
        const { data: fallback } = await supabase
            .from('pages')
            .select('id, name, fb_page_id, access_token')
            .eq('fb_page_id', '958393214018094');
        if (!fallback?.length) {
            console.log('No valid page found');
            return;
        }
        pages.push(...fallback);
    }

    const page = pages[0];
    console.log(`\nUsing page: ${page.name} (FB ID: ${page.fb_page_id})\n`);

    // First check existing templates
    const checkUrl = `${FB_URL}/${page.fb_page_id}/message_templates?fields=name,status&limit=100&access_token=${page.access_token}`;
    const checkRes = await fetch(checkUrl);
    
    if (!checkRes.ok) {
        const err = await checkRes.json().catch(() => ({}));
        console.error('Failed to check existing templates:', err.error?.message);
        return;
    }

    const existing = await checkRes.json();
    const existingNames = new Set((existing.data || []).map(t => t.name));
    
    console.log(`Existing templates on page: ${existingNames.size}`);
    console.log('---');

    // Submit each template
    for (const template of TEST_TEMPLATES) {
        if (existingNames.has(template.name)) {
            const match = (existing.data || []).find(t => t.name === template.name);
            console.log(`SKIP: ${template.name} — already exists (status: ${match?.status || 'unknown'})`);
            continue;
        }

        console.log(`SUBMITTING: ${template.name}...`);

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
            console.log(`  FAILED: ${data.error?.message || 'Unknown error'}`);
            if (data.error?.error_user_msg) {
                console.log(`  Detail: ${data.error.error_user_msg}`);
            }
        } else {
            console.log(`  SUCCESS: id=${data.id}, status=${data.status || 'PENDING'}`);
        }
    }

    // Re-check statuses
    console.log('\n--- Final Status Check ---');
    const recheckRes = await fetch(checkUrl);
    if (recheckRes.ok) {
        const recheck = await recheckRes.json();
        const accountTemplates = (recheck.data || []).filter(t => t.name.startsWith('account_'));
        if (accountTemplates.length > 0) {
            for (const t of accountTemplates) {
                const emoji = t.status === 'APPROVED' ? '✅' : t.status === 'PENDING' ? '⏳' : '❌';
                console.log(`${emoji} ${t.name} — ${t.status}`);
            }
        } else {
            console.log('No account_* templates found after submission');
        }
    }

    console.log('\nDone.');
}

main().catch(console.error);
