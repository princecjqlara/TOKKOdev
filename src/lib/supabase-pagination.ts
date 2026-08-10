export const SUPABASE_PAGE_SIZE = 1000;

// PostgREST serializes `.in(...)` filters into the query string. Keeping UUID
// batches small avoids exceeding proxy/server URL limits on large selections.
export const SUPABASE_IN_FILTER_BATCH_SIZE = 100;

type SupabasePagedResult<T> = {
    data: T[] | null;
    error: { message?: string } | null;
};

type SupabasePagedQuery<T> = {
    range: (from: number, to: number) => PromiseLike<SupabasePagedResult<T>>;
};

export async function fetchAllSupabaseRows<T>(
    query: SupabasePagedQuery<T>,
    pageSize: number = SUPABASE_PAGE_SIZE
): Promise<T[]> {
    const rows: T[] = [];
    let offset = 0;

    while (true) {
        const { data, error } = await query.range(offset, offset + pageSize - 1);

        if (error) {
            throw new Error(error.message || 'Failed to fetch paginated rows');
        }

        const pageRows = data || [];
        rows.push(...pageRows);

        if (pageRows.length < pageSize) {
            break;
        }

        offset += pageSize;
    }

    return rows;
}
