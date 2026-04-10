// One-time migration script to add template_name and template_language columns
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://pnhzpeyzpwsmwcuafgpw.supabase.co';
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBuaHpwZXl6cHdzbXdjdWFmZ3B3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTI3NzkyMCwiZXhwIjoyMDgwODUzOTIwfQ.ZjqZesBGClf2Pw-bybb1Kn-F9KpA0D6jj-m76xUImTg';

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const sql = `
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS template_name TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS template_language TEXT;
`;

async function run() {
  console.log('Running migration: adding template_name and template_language to campaigns...');
  const { data, error } = await supabase.rpc('exec_sql', { sql });
  
  if (error) {
    // rpc exec_sql may not exist, try direct SQL via REST
    console.log('rpc exec_sql not available, trying pg_net or direct approach...');
    
    // Alternative: use the Supabase Management API or just test if columns exist
    // Let's test by trying to select these columns
    const { data: testData, error: testError } = await supabase
      .from('campaigns')
      .select('template_name, template_language')
      .limit(1);
    
    if (testError) {
      console.log('Columns do NOT exist yet. Error:', testError.message);
      console.log('\n⚠️  You need to run this SQL in the Supabase SQL Editor:');
      console.log('------------------------------------------------------');
      console.log(sql);
      console.log('------------------------------------------------------');
      console.log('\nGo to: https://supabase.com/dashboard/project/pnhzpeyzpwsmwcuafgpw/sql/new');
    } else {
      console.log('✅ Columns already exist! No migration needed.');
      console.log('Test result:', testData);
    }
  } else {
    console.log('✅ Migration successful!', data);
  }
}

run().catch(console.error);
