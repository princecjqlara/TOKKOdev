import { NextAuthOptions } from 'next-auth';
import FacebookProvider from 'next-auth/providers/facebook';

export const authOptions: NextAuthOptions = {
    providers: [
        FacebookProvider({
            clientId: process.env.FACEBOOK_CLIENT_ID!,
            clientSecret: process.env.FACEBOOK_CLIENT_SECRET!,
            authorization: {
                params: {
                    scope: 'email,public_profile,pages_show_list,pages_read_engagement,pages_manage_metadata,pages_read_user_content,pages_manage_posts,pages_manage_engagement,pages_messaging'
                }
            }
        })
    ],
    callbacks: {
        async jwt({ token, account, user }) {
            if (account && user) {
                token.accessToken = account.access_token;
                token.facebookId = account.providerAccountId; // Store Facebook ID
            }
            return token;
        },
        async session({ session, token }) {
            return {
                ...session,
                accessToken: token.accessToken as string, // Make access token available in session
                user: {
                    ...session.user,
                    id: token.sub, // Use NextAuth's internal ID
                    facebookId: token.facebookId as string // Make Facebook ID available in session
                }
            };
        }
    },
    pages: {
        signIn: '/login',
        error: '/login'
    },
    session: {
        strategy: 'jwt',
        maxAge: 30 * 24 * 60 * 60, // 30 days
        updateAge: 24 * 60 * 60, // 24 hours
    },
    debug: process.env.NODE_ENV !== 'production' || process.env.NEXTAUTH_DEBUG === 'true',
    logger: {
        error(code, metadata) {
            console.error('NextAuth error:', code);
            if (metadata) {
                console.error('Error metadata:', JSON.stringify(metadata, null, 2));
            }
        },
        warn(code) {
            if (process.env.NODE_ENV !== 'production') {
                console.warn('NextAuth warning:', code);
            }
        },
        debug(code, metadata) {
            if (process.env.NODE_ENV !== 'production') {
                console.log('NextAuth debug:', code, metadata);
            }
        }
    }
};

// Extended session type
declare module 'next-auth' {
    interface Session {
        accessToken?: string;
        user: {
            id?: string;
            name?: string | null;
            email?: string | null;
            image?: string | null;
            facebookId?: string;
        };
    }
}

declare module 'next-auth/jwt' {
    interface JWT {
        accessToken?: string;
        facebookId?: string;
    }
}
