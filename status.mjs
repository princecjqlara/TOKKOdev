import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://pnhzpeyzpwsmwcuafgpw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBuaHpwZXl6cHdzbXdjdWFmZ3B3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTI3NzkyMCwiZXhwIjoyMDgwODUzOTIwfQ.ZjqZesBGClf2Pw-bybb1Kn-F9KpA0D6jj-m76xUImTg';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
    console.log("Fetching exact statuses of instant_meeting templates...");
    const { data: pages } = await supabase.from('pages').select('id, name, fb_page_id, access_token').limit(1);
    
    const page = pages[0];
    const url = `https://graph.facebook.com/v21.0/${page.fb_page_id}/message_templates?fields=name,status,language&limit=200&access_token=${page.access_token}`;
    const res = await fetch(url);
    const data = await res.json();
    
    if (data.error) {
        console.log(`API Error: ${data.error.message}`);
        return;
    }
    
    const instantTemplates = (data.data || []).filter(t => t.name.includes('instant_meeting'));
    
    if (instantTemplates.length === 0) {
        console.log("No instant_meeting templates found on Facebook!");
    } else {
        instantTemplates.forEach(t => {
            console.log(`[${t.status}] ${t.name} (${t.language})`);
        });
    }
}

main().catch(console.error);
