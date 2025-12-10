import { NextRequest, NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';

export async function GET(request: NextRequest) {
    try {
        const provider = authOptions.providers.find(p => p.id === 'facebook');
        
        if (!provider || provider.type !== 'oauth') {
            return NextResponse.json({ error: 'Facebook provider not found' }, { status: 500 });
        }

        const callbackUrl = `${process.env.NEXTAUTH_URL}/api/auth/callback/facebook`;
        const redirectUrl = `${process.env.NEXTAUTH_URL}/dashboard`;
        
        // Build the authorization URL that NextAuth would use
        const authUrl = new URL(`https://www.facebook.com/v18.0/dialog/oauth`);
        authUrl.searchParams.set('client_id', process.env.FACEBOOK_CLIENT_ID!);
        authUrl.searchParams.set('redirect_uri', callbackUrl);
        authUrl.searchParams.set('scope', 'email,public_profile,pages_show_list,pages_messaging,pages_read_engagement,pages_manage_metadata');
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('state', 'test-state');

        return NextResponse.json({
            facebook_oauth_url: authUrl.toString(),
            callback_url: callbackUrl,
            redirect_url: redirectUrl,
            app_id: process.env.FACEBOOK_CLIENT_ID,
            nextauth_url: process.env.NEXTAUTH_URL,
            config_check: {
                client_id_set: !!process.env.FACEBOOK_CLIENT_ID,
                client_secret_set: !!process.env.FACEBOOK_CLIENT_SECRET,
                nextauth_url_set: !!process.env.NEXTAUTH_URL
            }
        });
    } catch (error) {
        return NextResponse.json({ 
            error: 'Failed to generate OAuth URL',
            details: (error as Error).message 
        }, { status: 500 });
    }
}

