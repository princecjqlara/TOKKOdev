import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FB_URL = 'https://graph.facebook.com/v21.0';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TEMPLATES = [
    { 
        name: 'instant_meeting_btn_v1', 
        category: 'UTILITY', 
        language: 'en_US', 
        components: [
            { type: 'BODY', text: 'Important update: {{1}}', example: { body_text: [['The host has joined the meeting room']] } }, 
            { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Join Meeting', url: 'https://instantmeeting.vercel.app/' }] }
        ] 
    },
    { 
        name: 'instant_meeting_btn_v2', 
        category: 'UTILITY', 
        language: 'en_US', 
        components: [
            { type: 'BODY', text: 'Update on your request: {{1}}', example: { body_text: [['Your meeting has been scheduled']] } }, 
            { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'View Details', url: 'https://instantmeeting.vercel.app/' }] }
        ] 
    },
    { 
        name: 'instant_meeting_btn_v3', 
        category: 'UTILITY', 
        language: 'en_US', 
        components: [
            { type: 'BODY', text: 'Notification: {{1}}', example: { body_text: [['You have a new meeting request pending']] } }, 
            { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Book Now', url: 'https://instantmeeting.vercel.app/' }] }
        ] 
    }
];

async function main() {
    const { data: pages } = await supabase.from('pages').select('id, name, fb_page_id, access_token');
    
    if (!pages?.length) return;

    for (const page of pages) {
        console.log(`\n======================================================`);
        console.log(`Submitting to PAGE: ${page.name} (${page.fb_page_id})`);
        
        for (const template of TEMPLATES) {
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
                console.log(`    ❌ FAIL ${template.name}: ${data.error?.message} | ${data.error?.error_user_msg || ''}`);
            } else {
                console.log(`    ✅ OK   ${template.name}: status=${data.status}`);
            }
            await new Promise(r => setTimeout(r, 200));
        }
    }
    console.log('\nDone submitting instant meeting templates!');
}

main().catch(console.error);
