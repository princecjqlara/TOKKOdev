import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FB_URL = 'https://graph.facebook.com/v21.0';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const FREEFORM_TEMPLATES = [
    'friendly_msg_v1', 'friendly_msg_v2', 'friendly_msg_v3', 'friendly_msg_v4', 'friendly_msg_v5', 'friendly_msg_v6',
    'casual_update_v1', 'casual_update_v2', 'casual_update_v3', 'casual_update_v4',
    'simple_msg_v1', 'simple_msg_v2', 'simple_msg_v3', 'simple_msg_v4',
    'friendly_2p_v1', 'friendly_2p_v2', 'friendly_2p_v3', 'simple_2p_v1', 'simple_2p_v2',
    'friendly_btn_v1', 'friendly_btn_v2', 'casual_btn_v1'
];

async function main() {
    console.log('Fetching pages matching "jp luxxe"...');
    // Get all pages to filter
    const { data: pages } = await supabase
        .from('pages')
        .select('id, name, fb_page_id, access_token');

    console.log('Available pages:');
    pages.forEach(p => console.log(' - ' + p.name));

    const matchedPages = pages.filter(p => p.name.toLowerCase().includes('jp') || p.name.toLowerCase().includes('luxxe'));

    if (!matchedPages?.length) {
        console.log('No pages found matching "jp" or "luxxe"');
        return;
    }

    const freeformNames = new Set(FREEFORM_TEMPLATES);

    for (const page of matchedPages) {
        console.log(`\n======================================================`);
        console.log(`PAGE: ${page.name} (FB ID: ${page.fb_page_id})`);
        console.log(`======================================================`);

        const checkUrl = `${FB_URL}/${page.fb_page_id}/message_templates?fields=name,status,category&limit=200&access_token=${page.access_token}`;
        const checkRes = await fetch(checkUrl);

        if (!checkRes.ok) {
            const err = await checkRes.json().catch(() => ({}));
            console.log(`⚠️ Cannot access templates: ${err.error?.message || 'Unknown'}`);
            continue;
        }

        const data = await checkRes.json();
        const allTemplates = data.data || [];
        
        const ourTemplates = allTemplates.filter(t => freeformNames.has(t.name));

        console.log(`\n📋 FREE-FORM TEMPLATE STATUS for ${page.name}:`);
        console.log(`------------------------------------------------------`);
        
        let approved = 0, pending = 0, rejected = 0;
        ourTemplates.forEach(t => {
            const emoji = t.status === 'APPROVED' ? '✅' :
                          t.status === 'PENDING' ? '⏳' : 
                          t.status === 'REJECTED' ? '❌' : '❓';
            
            console.log(`${emoji} ${t.status.padEnd(10)} ${t.name}`);
            
            if (t.status === 'APPROVED') approved++;
            else if (t.status === 'PENDING') pending++;
            else rejected++;
        });

        console.log(`\n✨ Summary: ${approved} APPROVED, ${pending} PENDING, ${rejected} REJECTED/OTHER`);
        
        if (approved === 0 && pending === 0 && rejected === 0) {
            console.log("\n⚠️ NOTE: It appears the new templates haven't been submitted for this page yet.");
            console.log("If this page was added recently, you might need to run the full template submission script again.");
        }
    }
}

main().catch(console.error);
