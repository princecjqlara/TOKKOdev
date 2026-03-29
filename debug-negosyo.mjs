import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://pnhzpeyzpwsmwcuafgpw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBuaHpwZXl6cHdzbXdjdWFmZ3B3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTI3NzkyMCwiZXhwIjoyMDgwODUzOTIwfQ.ZjqZesBGClf2Pw-bybb1Kn-F9KpA0D6jj-m76xUImTg';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
    // Check the stored token for Negosyo GPT
    const { data: pages } = await supabase
        .from('pages')
        .select('id, name, fb_page_id, access_token, created_at, updated_at')
        .ilike('name', '%negosyo%');

    if (!pages?.length) {
        console.log('Page not found');
        return;
    }

    for (const page of pages) {
        console.log(`Page: ${page.name}`);
        console.log(`  ID: ${page.id}`);
        console.log(`  FB Page ID: ${page.fb_page_id}`);
        console.log(`  Created: ${page.created_at}`);
        console.log(`  Updated: ${page.updated_at}`);
        console.log(`  Token (first 30 chars): ${page.access_token?.substring(0, 30)}...`);
        console.log(`  Token length: ${page.access_token?.length || 0}`);

        // Test the stored token
        const testUrl = `https://graph.facebook.com/v21.0/${page.fb_page_id}?fields=name&access_token=${page.access_token}`;
        const res = await fetch(testUrl);
        const data = await res.json();
        
        if (res.ok) {
            console.log(`  ✅ Token is VALID - page name from FB: ${data.name}`);
        } else {
            console.log(`  ❌ Token is INVALID: ${data.error?.message}`);
        }
    }
}

main().catch(console.error);
