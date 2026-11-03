/** Server-only settings take priority over values compiled into the browser bundle. */
export function getSupabaseServerUrl(): string {
    const url = process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    if (!url) {
        throw new Error('Missing Supabase URL. Set SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL.');
    }
    return url;
}
