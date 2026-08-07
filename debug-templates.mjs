// Check what the approved templates look like vs rejected ones
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FB_URL = 'https://graph.facebook.com/v21.0';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
    const { data: pages } = await supabase
        .from('pages')
        .select('id, name, fb_page_id, access_token')
        .eq('fb_page_id', '754512431281378');

    const page = pages[0];
    
    // Get full template details including components
    const url = `${FB_URL}/${page.fb_page_id}/message_templates?fields=name,status,category,components,language,rejected_reason,quality_score&limit=100&access_token=${page.access_token}`;
    const res = await fetch(url);
    const data = await res.json();
    
    for (const t of data.data || []) {
        console.log(`\n${'='.repeat(50)}`);
        console.log(`Name: ${t.name}`);
        console.log(`Status: ${t.status}`);
        console.log(`Category: ${t.category}`);
        console.log(`Language: ${JSON.stringify(t.language)}`);
        if (t.rejected_reason) console.log(`Rejected Reason: ${t.rejected_reason}`);
        if (t.quality_score) console.log(`Quality Score: ${JSON.stringify(t.quality_score)}`);
        console.log(`Components: ${JSON.stringify(t.components, null, 2)}`);
    }
}

main().catch(console.error);
