import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { verifyWebhookSignature, generateVerifyToken } from '@/lib/facebook';

// GET /api/facebook/webhook - Verify webhook
export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const mode = searchParams.get('hub.mode');
    const token = searchParams.get('hub.verify_token');
    const challenge = searchParams.get('hub.challenge');
    const showToken = searchParams.get('show_token') === 'true';

    const appSecret = process.env.FACEBOOK_APP_SECRET;
    const appId = process.env.FACEBOOK_CLIENT_ID;

    if (!appSecret || !appId) {
        return NextResponse.json({ error: 'Facebook app credentials not configured' }, { status: 500 });
    }

    // Auto-generate verify token from app secret and app id
    const verifyToken = generateVerifyToken(appSecret, appId);

    // Show token in development mode for Facebook webhook setup
    const isDevelopment = process.env.NODE_ENV !== 'production';
    if (showToken && isDevelopment) {
        console.log('🔵 Webhook verify token requested (development mode)');
        return NextResponse.json({
            verify_token: verifyToken,
            message: 'Use this token when setting up your Facebook webhook',
            webhook_url: `${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/api/facebook/webhook`,
            app_id: appId,
            environment: 'development'
        });
    }

    if (mode === 'subscribe' && token === verifyToken) {
        console.log('✅ Webhook verified successfully');
        if (isDevelopment) {
            console.log('🔵 Webhook verification details:', {
                mode,
                challenge_length: challenge?.length,
                app_id: appId
            });
        }
        return new NextResponse(challenge, { status: 200 });
    }

    if (isDevelopment) {
        console.warn('⚠️ Webhook verification failed:', {
            mode,
            token_provided: !!token,
            token_match: token === verifyToken
        });
    }
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

// POST /api/facebook/webhook - Receive webhook events
export async function POST(request: NextRequest) {
    try {
        const body = await request.text();
        const signature = request.headers.get('x-hub-signature-256') || '';
        const appSecret = process.env.FACEBOOK_APP_SECRET!;

        // Verify signature in production only (skip in development for easier testing)
        const isDevelopment = process.env.NODE_ENV !== 'production';
        if (!isDevelopment && appSecret) {
            if (!verifyWebhookSignature(body, signature, appSecret)) {
                console.error('🔴 Webhook signature verification failed');
                return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
            }
        } else if (isDevelopment) {
            console.log('🔵 Webhook signature verification skipped (development mode)');
        }

        const data = JSON.parse(body);
        const supabase = getSupabaseAdmin();

        // Process messaging events
        if (data.object === 'page') {
            for (const entry of data.entry) {
                const pageId = entry.id;

                // Get our page record
                const { data: page } = await supabase
                    .from('pages')
                    .select('id, access_token')
                    .eq('fb_page_id', pageId)
                    .single();

                if (!page) continue;

                // Process messaging events
                if (entry.messaging) {
                    for (const event of entry.messaging) {
                        const senderId = event.sender?.id;
                        const isFromContact = senderId !== pageId;

                        // Skip if sender is the page itself (for contact upsert)
                        if (!isFromContact) continue;

                        const interactionTime = new Date(event.timestamp);
                        const interactionAt = interactionTime.toISOString();

                        // Upsert contact
                        const { data: contact } = await supabase
                            .from('contacts')
                            .upsert({
                                page_id: page.id,
                                psid: senderId,
                                last_interaction_at: interactionAt,
                                updated_at: new Date().toISOString()
                            }, {
                                onConflict: 'page_id,psid'
                            })
                            .select('id')
                            .single();

                        // Record interaction for best time to contact analysis
                        if (contact) {
                            const hourOfDay = interactionTime.getUTCHours();
                            const dayOfWeek = interactionTime.getUTCDay();

                            await supabase
                                .from('contact_interactions')
                                .insert({
                                    contact_id: contact.id,
                                    page_id: page.id,
                                    interaction_at: interactionAt,
                                    hour_of_day: hourOfDay,
                                    day_of_week: dayOfWeek,
                                    is_from_contact: true
                                });

                            // Automatically recalculate best time to contact
                            const { data: interactions } = await supabase
                                .from('contact_interactions')
                                .select('hour_of_day')
                                .eq('contact_id', contact.id)
                                .eq('is_from_contact', true);

                            const interactionCount = interactions?.length || 0;
                            const hourDistribution: Record<number, number> = {};

                            for (const interaction of interactions || []) {
                                const hour = interaction.hour_of_day;
                                hourDistribution[hour] = (hourDistribution[hour] || 0) + 1;
                            }

                            // Find most common hour
                            let bestHour: number | null = null;
                            let maxCount = 0;
                            for (const [hour, count] of Object.entries(hourDistribution)) {
                                if (count > maxCount) {
                                    maxCount = count;
                                    bestHour = parseInt(hour);
                                }
                            }

                            // Determine confidence level
                            let confidence: string;
                            if (interactionCount >= 5) {
                                confidence = 'high';
                            } else if (interactionCount >= 2) {
                                confidence = 'medium';
                            } else if (interactionCount === 1) {
                                confidence = 'inferred';
                                // For single interaction, use neighbor inference (simplified - use this hour)
                                bestHour = hourOfDay;
                            } else {
                                confidence = 'none';
                            }

                            // Update contact with best time data
                            await supabase
                                .from('contacts')
                                .update({
                                    best_contact_hour: bestHour,
                                    best_contact_confidence: confidence
                                })
                                .eq('id', contact.id);
                        }
                    }
                }
            }
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Webhook error:', error);
        return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
    }
}
