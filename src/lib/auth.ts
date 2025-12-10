import { NextAuthOptions } from 'next-auth';
import FacebookProvider from 'next-auth/providers/facebook';
import { getSupabaseAdmin } from './supabase';

export const authOptions: NextAuthOptions = {
    providers: [
        FacebookProvider({
            clientId: process.env.FACEBOOK_CLIENT_ID!,
            clientSecret: process.env.FACEBOOK_CLIENT_SECRET!,
            authorization: {
                params: {
                    scope: 'email,public_profile,pages_show_list,pages_messaging,pages_read_engagement,pages_manage_metadata,business_management'
                }
            },
            checks: ['state'],
            profile(profile) {
                return {
                    id: profile.id,
                    name: profile.name,
                    email: profile.email,
                    image: profile.picture?.data?.url
                };
            }
        })
    ],
    callbacks: {
        async signIn({ user, account }) {
            if (account?.provider === 'facebook') {
                if (process.env.NODE_ENV !== 'production') {
                    console.log('Facebook sign-in attempt:', {
                        email: user.email,
                        name: user.name,
                        facebookId: account.providerAccountId
                    });
                }

                try {
                    const supabase = getSupabaseAdmin();

                    // Handle null email - use Facebook ID as fallback for email
                    // Some Facebook users don't have emails, so we use a generated email format
                    const userEmail = user.email || `fb_${account.providerAccountId}@facebook.local`;
                    const userName = user.name || `Facebook User ${account.providerAccountId}`;

                    const { data: upsertedUser, error } = await supabase
                        .from('users')
                        .upsert(
                            {
                                email: userEmail,
                                name: userName,
                                image: user.image,
                                facebook_id: account.providerAccountId,
                                updated_at: new Date().toISOString()
                            },
                            { onConflict: 'email' }
                        )
                        .select('id')
                        .single();

                    if (error) {
                        console.error('Error upserting user:', error);
                        if (process.env.NODE_ENV !== 'production') {
                            console.error('Full error details:', JSON.stringify(error, null, 2));
                            console.warn('Continuing sign-in despite database error (development mode)');
                        }
                        if (process.env.NODE_ENV === 'production') {
                            return false;
                        }
                    } else if (process.env.NODE_ENV !== 'production') {
                        console.log('User successfully saved to database:', upsertedUser?.id);
                    }

                    if (upsertedUser?.id) {
                        (account as any).userId = upsertedUser.id;
                    }
                } catch (dbError) {
                    console.error('Database connection error:', dbError);
                    if (process.env.NODE_ENV !== 'production') {
                        console.warn('Continuing sign-in despite database error (development mode)');
                    }
                    if (process.env.NODE_ENV === 'production') {
                        return false;
                    }
                }
            }
            return true;
        },
        async jwt({ token, account }) {
            if (account) {
                token.accessToken = account.access_token;
                token.facebookId = account.providerAccountId;
                if ((account as any).userId) {
                    (token as any).userId = (account as any).userId;
                }
            }
            return token;
        },
        async session({ session, token }) {
            try {
                const supabase = getSupabaseAdmin();
                const { data: user, error } = await supabase
                    .from('users')
                    .select('id')
                    .eq('email', session.user?.email)
                    .single();

                if (error && error.code !== 'PGRST116') {
                    console.error('Error fetching user in session callback:', error);
                }

                const userId = (token as any).userId || user?.id;

                return {
                    ...session,
                    accessToken: token.accessToken as string,
                    user: {
                        ...session.user,
                        id: userId || null,
                        facebookId: token.facebookId as string
                    }
                };
            } catch (error) {
                console.error('Error in session callback:', error);
                return {
                    ...session,
                    accessToken: token.accessToken as string,
                    user: {
                        ...session.user,
                        id: null,
                        facebookId: token.facebookId as string
                    }
                };
            }
        }
    },
    pages: {
        signIn: '/',
        error: '/'
    },
    session: {
        strategy: 'jwt',
        maxAge: 30 * 24 * 60 * 60,
        updateAge: 24 * 60 * 60
    },
    debug: process.env.NODE_ENV !== 'production' || process.env.NEXTAUTH_DEBUG === 'true',
    logger: {
        error(code, metadata) {
            console.error('NextAuth error:', code);
            if (metadata) {
                console.error('Error metadata:', JSON.stringify(metadata, null, 2));
            }

            if (code === 'OAuthSignin' || code === 'OAuthCallback' || code === 'Callback') {
                const metaRecord = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : null;
                const oauthError = metaRecord && 'error' in metaRecord ? metaRecord.error : metadata;
                const errorDescription = metaRecord && 'error_description' in metaRecord ? metaRecord.error_description : undefined;
                const errorUri = metaRecord && 'error_uri' in metaRecord ? metaRecord.error_uri : undefined;

                console.error('OAuth Error Details:', {
                    provider: 'facebook',
                    error: oauthError,
                    errorDescription,
                    errorUri,
                    errorCode: code,
                    fullMetadata: metadata
                });
                console.error('Check Facebook App Settings:');
                console.error('Redirect URI should be: https://mae-squarish-sid.ngrok-free.dev/api/auth/callback/facebook');
                console.error('NEXTAUTH_URL should be: https://mae-squarish-sid.ngrok-free.dev');
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
