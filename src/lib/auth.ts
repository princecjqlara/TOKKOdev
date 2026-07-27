import { NextAuthOptions } from 'next-auth';
import FacebookProvider from 'next-auth/providers/facebook';
import { getSupabaseAdmin } from './supabase';
import { FACEBOOK_PERMISSION_SCOPE } from './facebook-permissions';

export const authOptions: NextAuthOptions = {
    providers: [
        FacebookProvider({
            clientId: process.env.FACEBOOK_CLIENT_ID!,
            clientSecret: process.env.FACEBOOK_CLIENT_SECRET!,
            authorization: {
                params: {
                    scope: FACEBOOK_PERMISSION_SCOPE
                }
            }
        })
    ],
    callbacks: {
        async jwt({ token, account, user }) {
            if (account && user) {
                token.accessToken = account.access_token;
                token.facebookId = account.providerAccountId;

                // Sync user to Supabase to get UUID
                try {
                    const supabase = getSupabaseAdmin();

                    // Upsert user based on email or facebook_id
                    // Using email as primary key for matching for now, but falling back to insert
                    const userEmail = user.email || `fb_${account.providerAccountId}@facebook.local`;

                    const { data: dbUser, error } = await supabase
                        .from('users')
                        .select('id')
                        .eq('email', userEmail)
                        .single();

                    if (dbUser) {
                        token.id = dbUser.id;
                    } else if (!error || error.code === 'PGRST116') {
                        // PGRST116 = no rows found - safe to create
                        const { data: newUser, error: createError } = await supabase
                            .from('users')
                            .upsert({
                                email: userEmail,
                                name: user.name,
                                image: user.image,
                                is_active: true
                            }, { onConflict: 'email' })
                            .select('id')
                            .single();

                        if (newUser) {
                            token.id = newUser.id;
                        } else if (createError) {
                            console.error('Error creating user in Supabase:', createError);
                        }
                    } else {
                        console.error('Error looking up user in Supabase:', error);
                    }
                } catch (err) {
                    console.error('Error syncing user to Supabase:', err);
                }
            }
            return token;
        },
        async session({ session, token }) {
            return {
                ...session,
                accessToken: token.accessToken as string,
                user: {
                    ...session.user,
                    id: token.id as string, // This will now be the UUID from DB
                    facebookId: token.facebookId as string
                }
            };
        }
    },
    pages: {
        signIn: '/',
        error: '/'
    },
    session: {
        strategy: 'jwt',
        maxAge: 30 * 24 * 60 * 60,
        updateAge: 24 * 60 * 60,
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
        id?: string;
        accessToken?: string;
        facebookId?: string;
    }
}
