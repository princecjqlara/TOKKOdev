import { NextAuthOptions, type Session } from 'next-auth';
import FacebookProvider from 'next-auth/providers/facebook';
import CredentialsProvider from 'next-auth/providers/credentials';
import { getSupabaseAdmin } from './supabase';
import { FACEBOOK_PERMISSION_SCOPE } from './facebook-permissions';
import { authenticateEmail, getActiveAccount } from './account-auth';
import { getServerAuthToken } from './server-auth-token';

export const authOptions: NextAuthOptions = {
    providers: [
        FacebookProvider({
            clientId: process.env.FACEBOOK_CLIENT_ID!, clientSecret: process.env.FACEBOOK_CLIENT_SECRET!,
            authorization: { params: { scope: FACEBOOK_PERMISSION_SCOPE } }
        }),
        CredentialsProvider({
            name: 'Email', credentials: { email: { label: 'Email', type: 'email' }, password: { label: 'Password', type: 'password' } },
            async authorize(credentials, request) {
                try {
                    const ip = String(request.headers?.['x-forwarded-for'] || 'unknown').split(',')[0].trim();
                    return await authenticateEmail(credentials, ip);
                } catch { return null; }
            }
        })
    ],
    callbacks: {
        async jwt({ token, account, user }) {
            if (account && user) {
                if (account.provider === 'credentials') {
                    token.id = user.id; token.sessionVersion = user.sessionVersion; token.provider = 'credentials';
                    delete token.accessToken; delete token.facebookId;
                    delete token.pendingFacebookLinkAt;
                    delete token.authenticationError;
                } else if (account.provider === 'facebook') {
                    // Reuse an existing signed binding for this same Facebook subject.
                    const previous = await getServerAuthToken();
                    const legacyId = previous?.facebookId === account.providerAccountId ? previous.id : null;
                    const { data, error } = await getSupabaseAdmin().rpc('tokko_resolve_facebook_user', {
                        p_subject: account.providerAccountId, p_email: user.email || null,
                        p_name: user.name || null, p_image: user.image || null, p_legacy_id: legacyId || null
                    });
                    if (error?.code === '28000' && ['Subaccounts use email and password', 'Account inactive or expired'].includes(error.message)) {
                        delete token.id; delete token.sessionVersion; delete token.pendingFacebookLinkAt;
                        token.provider = 'facebook'; token.facebookId = account.providerAccountId;
                        token.authenticationError = error.message === 'Subaccounts use email and password' ? 'subaccount_credentials_required' : 'account_unavailable';
                        return token;
                    }
                    const row = error ? null : Array.isArray(data) ? data[0] : data;
                    if (!row?.user_id) throw new Error('Facebook sign-in is temporarily unavailable.');
                    token.id = row.user_id; token.sessionVersion = Number(row.version); token.provider = 'facebook';
                    token.facebookId = account.providerAccountId; token.accessToken = account.access_token;
                    delete token.pendingFacebookLinkAt;
                    delete token.authenticationError;
                }
            }
            return token;
        },
        async session({ session, token }) {
            const provider = token.provider || (token.facebookId ? 'facebook' : 'credentials');
            let active; let authenticationError: Session['authenticationError'] = token.authenticationError;
            try {
                active = token.id && await getActiveAccount(token.id, Number(token.sessionVersion || 0), provider);
                if (token.id && !active) authenticationError = 'account_unavailable';
            } catch { authenticationError = 'service_unavailable'; }
            return { ...session, user: { ...session.user, id: active ? token.id : undefined,
                facebookId: active && provider === 'facebook' ? token.facebookId : undefined,
                provider: active ? provider : undefined }, accountActive: Boolean(active),
                accountType: active ? !active.created_by && (active.account_kind === 'facebook' || provider === 'facebook' && active.account_kind === 'legacy') ? 'parent' : 'subaccount' : undefined,
                signInProvider: provider, authenticationError,
                requiresFacebookVerification: false };
        }
    },
    pages: { signIn: '/login', error: '/facebook-signin' },
    session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
    debug: false,
    logger: { error(code) { console.error('Authentication error:', code); }, warn(code) { console.warn('Authentication warning:', code); } }
};

declare module 'next-auth' {
    interface User { sessionVersion?: number; }
    interface Session {
        accountActive?: boolean;
        requiresFacebookVerification?: boolean;
        signInProvider?: string;
        authenticationError?: 'service_unavailable' | 'account_unavailable' | 'subaccount_credentials_required';
        accountType?: 'parent' | 'subaccount';
        /** @deprecated Provider tokens are server-only. */
        accessToken?: string;
        user: { id?: string; name?: string | null; email?: string | null; image?: string | null;
            facebookId?: string; provider?: string; };
    }
}
declare module 'next-auth/jwt' {
    interface JWT { id?: string; accessToken?: string; facebookId?: string; provider?: string; sessionVersion?: number; pendingFacebookLinkAt?: number; authenticationError?: 'account_unavailable' | 'subaccount_credentials_required'; }
}
