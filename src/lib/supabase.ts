import { createClient, SupabaseClient } from '@supabase/supabase-js';

function getSupabaseUrl() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
    if (!url) {
        throw new Error('Missing Supabase URL. Set NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL for server-only usage).');
    }
    return url;
}

function getSupabaseAnonKey() {
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
    if (!key) {
        throw new Error('Missing Supabase anon key. Set NEXT_PUBLIC_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY for server-only usage).');
    }
    return key;
}

function getSupabaseServiceKey() {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) {
        throw new Error('Missing Supabase service role key. Set SUPABASE_SERVICE_ROLE_KEY.');
    }
    return key;
}

type GenericSupabaseClient = SupabaseClient<any, 'public', any>;

let supabaseBrowserClient: GenericSupabaseClient | null = null;
let supabaseAdminClient: GenericSupabaseClient | null = null;

export function getSupabaseClient(): GenericSupabaseClient {
    if (!supabaseBrowserClient) {
        supabaseBrowserClient = createClient(getSupabaseUrl(), getSupabaseAnonKey());
    }
    return supabaseBrowserClient;
}

export function getSupabaseAdmin(): GenericSupabaseClient {
    if (!supabaseAdminClient) {
        supabaseAdminClient = createClient(getSupabaseUrl(), getSupabaseServiceKey(), {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        });
    }
    return supabaseAdminClient;
}
