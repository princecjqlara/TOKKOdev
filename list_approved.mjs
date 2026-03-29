import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://pnhzpeyzpwsmwcuafgpw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBuaHpwZXl6cHdzbXdjdWFmZ3B3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTI3NzkyMCwiZXhwIjoyMDgwODUzOTIwfQ.ZjqZesBGClf2Pw-bybb1Kn-F9KpA0D6jj-m76xUImTg';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
    // Check local database for approved templates
    console.log("=== APPROVED TEMPLATES IN DATABASE ===");
    const { data: dbTemplates, error: dbError } = await supabase
        .from('campaign_templates')
        .select('*')
        .eq('status', 'APPROVED');
    
    if (dbError) {
        console.error("Database error:", dbError);
    } else if (dbTemplates && dbTemplates.length > 0) {
        dbTemplates.forEach(t => {
            console.log(`- Page ID: ${t.page_id} | Template: ${t.name} (${t.language})`);
        });
    } else {
        console.log("No approved templates found in the database. (They might be in Facebook but not synced locally)");
    }
    
    // Check Facebook directly
    console.log("\n=== APPROVED TEMPLATES ON FACEBOOK ===");
    const { data: pages } = await supabase
        .from('pages')
        .select('id, name, fb_page_id, access_token');
        
    for (const page of pages || []) {
        console.log(`\nChecking Facebook for page: ${page.name} (${page.fb_page_id})`);
        try {
            const url = `https://graph.facebook.com/v21.0/${page.fb_page_id}/message_templates?fields=name,status,language&limit=100&access_token=${page.access_token}`;
            const res = await fetch(url);
            const data = await res.json();
            
            if (data.error) {
                console.log(`  API Error: ${data.error.message}`);
                continue;
            }
            
            const approved = (data.data || []).filter(t => t.status === 'APPROVED');
            if (approved.length > 0) {
                approved.forEach(t => {
                    console.log(`  - ${t.name} (${t.language}) [${t.status}]`);
                });
            } else {
                console.log("  No approved templates found on Facebook for this page.");
            }
            
            // Let's also list rejected ones just to see the status
            const other = (data.data || []).filter(t => t.status !== 'APPROVED');
            if (other.length > 0) {
                 console.log(`  (${other.length} other templates in status like: ${[...new Set(other.map(t=>t.status))].join(', ')})`);
            }
            
        } catch (e) {
            console.error(`  Error checking ${page.name}:`, e.message);
        }
    }
}

main().catch(console.error);
