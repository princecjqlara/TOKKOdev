import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';

interface BestTimeResult {
    contact_id: string;
    best_hour: number | null;
    confidence: 'high' | 'medium' | 'low' | 'inferred' | 'none';
    interaction_count: number;
    hour_distribution: Record<number, number>;
}

// GET /api/pages/[pageId]/contacts/best-time - Get best time to contact
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const { pageId } = await params;
        const searchParams = request.nextUrl.searchParams;
        const contactId = searchParams.get('contactId');

        const supabase = getSupabaseAdmin();

        // Verify user has access to page
        const { data: userPage } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', session.user.id)
            .eq('page_id', pageId)
            .single();

        if (!userPage) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this page' },
                { status: 403 }
            );
        }

        if (contactId) {
            // Get best time for a single contact
            const result = await calculateBestTimeForContact(supabase, pageId, contactId);
            return NextResponse.json(result);
        } else {
            // Get best times for all contacts on the page
            const { data: contacts } = await supabase
                .from('contacts')
                .select('id')
                .eq('page_id', pageId);

            const results: BestTimeResult[] = [];
            for (const contact of contacts || []) {
                const result = await calculateBestTimeForContact(supabase, pageId, contact.id);
                results.push(result);
            }

            return NextResponse.json({ results });
        }
    } catch (error) {
        console.error('Error calculating best time to contact:', error);
        return NextResponse.json(
            { error: 'Failed to calculate best time', message: (error as Error).message },
            { status: 500 }
        );
    }
}

// POST /api/pages/[pageId]/contacts/best-time - Recalculate and update all contacts
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const { pageId } = await params;
        const supabase = getSupabaseAdmin();

        // Verify user has access to page
        const { data: userPage } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', session.user.id)
            .eq('page_id', pageId)
            .single();

        if (!userPage) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this page' },
                { status: 403 }
            );
        }

        // Get all contacts for the page
        const { data: contacts } = await supabase
            .from('contacts')
            .select('id')
            .eq('page_id', pageId);

        let updated = 0;
        for (const contact of contacts || []) {
            const result = await calculateBestTimeForContact(supabase, pageId, contact.id);

            // Update the contact with best time data
            const { error } = await supabase
                .from('contacts')
                .update({
                    best_contact_hour: result.best_hour,
                    best_contact_confidence: result.confidence,
                    updated_at: new Date().toISOString()
                })
                .eq('id', contact.id);

            if (!error) updated++;
        }

        return NextResponse.json({
            success: true,
            message: `Updated best contact times for ${updated} contacts`,
            updated
        });
    } catch (error) {
        console.error('Error recalculating best times:', error);
        return NextResponse.json(
            { error: 'Failed to recalculate best times', message: (error as Error).message },
            { status: 500 }
        );
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function calculateBestTimeForContact(supabase: any, pageId: string, contactId: string): Promise<BestTimeResult> {
    // Get all interactions for this contact
    const { data: interactions } = await supabase
        .from('contact_interactions')
        .select('hour_of_day')
        .eq('contact_id', contactId)
        .eq('is_from_contact', true);

    const interactionCount = interactions?.length || 0;
    const hourDistribution: Record<number, number> = {};

    // Build hour distribution from contact's own interactions
    for (const interaction of interactions || []) {
        const hour = interaction.hour_of_day;
        hourDistribution[hour] = (hourDistribution[hour] || 0) + 1;
    }

    // Determine confidence and best hour based on interaction count
    if (interactionCount >= 5) {
        // High confidence: use direct calculation
        const bestHour = findMostCommonHour(hourDistribution);
        return {
            contact_id: contactId,
            best_hour: bestHour,
            confidence: 'high',
            interaction_count: interactionCount,
            hour_distribution: hourDistribution
        };
    } else if (interactionCount >= 2) {
        // Medium confidence: use direct calculation
        const bestHour = findMostCommonHour(hourDistribution);
        return {
            contact_id: contactId,
            best_hour: bestHour,
            confidence: 'medium',
            interaction_count: interactionCount,
            hour_distribution: hourDistribution
        };
    } else if (interactionCount === 1) {
        // Inferred: use neighboring contacts
        const contactHour = Object.keys(hourDistribution)[0];
        const inferredHour = await inferFromNeighbors(supabase, pageId, contactId, parseInt(contactHour));

        return {
            contact_id: contactId,
            best_hour: inferredHour,
            confidence: 'inferred',
            interaction_count: interactionCount,
            hour_distribution: hourDistribution
        };
    } else {
        // No data: use page-wide average
        const pageAverage = await getPageAverageHour(supabase, pageId);
        return {
            contact_id: contactId,
            best_hour: pageAverage,
            confidence: pageAverage !== null ? 'low' : 'none',
            interaction_count: 0,
            hour_distribution: {}
        };
    }
}

function findMostCommonHour(distribution: Record<number, number>): number | null {
    let maxCount = 0;
    let bestHour: number | null = null;

    for (const [hour, count] of Object.entries(distribution)) {
        if (count > maxCount) {
            maxCount = count;
            bestHour = parseInt(hour);
        }
    }

    return bestHour;
}

// Find neighboring contacts (those with interactions within ±2 hours) and infer best time
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function inferFromNeighbors(supabase: any, pageId: string, excludeContactId: string, referenceHour: number): Promise<number | null> {
    // Define the hour range (±2 hours, wrapping around midnight)
    const hourRange: number[] = [];
    for (let offset = -2; offset <= 2; offset++) {
        let hour = referenceHour + offset;
        if (hour < 0) hour += 24;
        if (hour >= 24) hour -= 24;
        hourRange.push(hour);
    }

    // Find contacts with interactions in the neighboring hours
    const { data: neighborInteractions } = await supabase
        .from('contact_interactions')
        .select('contact_id, hour_of_day')
        .eq('page_id', pageId)
        .neq('contact_id', excludeContactId)
        .in('hour_of_day', hourRange)
        .eq('is_from_contact', true);

    if (!neighborInteractions || neighborInteractions.length === 0) {
        // Fall back to page average
        return getPageAverageHour(supabase, pageId);
    }

    // Get the full interaction history of neighboring contacts
    const neighborContactIds = [...new Set(neighborInteractions.map((i: { contact_id: string }) => i.contact_id))];

    const { data: allNeighborInteractions } = await supabase
        .from('contact_interactions')
        .select('hour_of_day')
        .in('contact_id', neighborContactIds)
        .eq('is_from_contact', true);

    // Aggregate hour distribution from all neighbors
    const neighborDistribution: Record<number, number> = {};
    for (const interaction of allNeighborInteractions || []) {
        const hour = interaction.hour_of_day;
        neighborDistribution[hour] = (neighborDistribution[hour] || 0) + 1;
    }

    return findMostCommonHour(neighborDistribution);
}

// Get the average (most common) hour across all contacts on the page
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getPageAverageHour(supabase: any, pageId: string): Promise<number | null> {
    const { data: pageInteractions } = await supabase
        .from('contact_interactions')
        .select('hour_of_day')
        .eq('page_id', pageId)
        .eq('is_from_contact', true);

    if (!pageInteractions || pageInteractions.length === 0) {
        return null;
    }

    const distribution: Record<number, number> = {};
    for (const interaction of pageInteractions) {
        const hour = interaction.hour_of_day;
        distribution[hour] = (distribution[hour] || 0) + 1;
    }

    return findMostCommonHour(distribution);
}
