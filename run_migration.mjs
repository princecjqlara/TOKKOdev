// One-time migration script to add template_name and template_language columns
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this migration.');
}

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
      console.log('\nOpen your project in the Supabase SQL Editor and run the SQL above.');
    } else {
      console.log('✅ Columns already exist! No migration needed.');
      console.log('Test result:', testData);
    }
  } else {
    console.log('✅ Migration successful!', data);
  }
}

run().catch(console.error);
