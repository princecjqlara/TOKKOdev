import { NextRequest, NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';

// GET /api/check-oauth-config - Check OAuth configuration
export async function GET(request: NextRequest) {
    try {
        const provider = authOptions.providers.find(p => p.id === 'facebook');
        
        if (!provider || provider.type !== 'oauth') {
            return NextResponse.json({ 
                error: 'Facebook provider not found',
                config: {
                    hasProvider: false
                }
            }, { status: 500 });
        }

        const nextAuthUrl = process.env.NEXTAUTH_URL || 'NOT SET';
        const callbackUrl = `${nextAuthUrl}/api/auth/callback/facebook`;
        
        // Build the authorization URL that NextAuth would use
        const authUrl = new URL(`https://www.facebook.com/v18.0/dialog/oauth`);
        authUrl.searchParams.set('client_id', process.env.FACEBOOK_CLIENT_ID || 'NOT SET');
        authUrl.searchParams.set('redirect_uri', callbackUrl);
        authUrl.searchParams.set('scope', 'email,public_profile,pages_show_list,pages_messaging,pages_read_engagement,pages_manage_metadata');
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('state', 'test-state');

        return NextResponse.json({
            success: true,
            config: {
                client_id_set: !!process.env.FACEBOOK_CLIENT_ID,
                client_secret_set: !!process.env.FACEBOOK_CLIENT_SECRET,
                nextauth_url_set: !!process.env.NEXTAUTH_URL,
                nextauth_url: nextAuthUrl,
                callback_url: callbackUrl,
                facebook_oauth_url: authUrl.toString(),
                required_redirect_uri: callbackUrl,
                instructions: {
                    step1: 'Go to Facebook App Settings',
                    step2: 'Add this EXACT URL to "Valid OAuth Redirect URIs":',
                    redirect_uri: callbackUrl,
                    step3: 'Save and wait 2-3 minutes',
                    step4: 'Try signing in again'
                }
            }
        });
    } catch (error) {
        return NextResponse.json({ 
            error: 'Failed to check OAuth config',
            details: (error as Error).message 
        }, { status: 500 });
    }
}


