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
                    scope: 'email,public_profile,pages_show_list,pages_read_engagement,pages_manage_metadata,pages_read_user_content,pages_manage_posts,pages_manage_engagement,pages_messaging,business_management'
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
                    const { data: dbUser, error } = await supabase
                        .from('users')
                        .select('id')
                        .eq('email', user.email)
                        .single();

                    if (dbUser) {
                        token.id = dbUser.id;
                    } else {
                        // Create new user
                        const { data: newUser, error: createError } = await supabase
                            .from('users')
                            .insert({
                                email: user.email,
                                name: user.name,
                                image: user.image,
                                is_active: true
                                // role column removed, defaults to user in DB if exists or undefined
                            })
                            .select('id')
                            .single();

                        if (newUser) {
                            token.id = newUser.id;
                        } else if (createError) {
                            console.error('Error creating user in Supabase:', createError);
                        }
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
