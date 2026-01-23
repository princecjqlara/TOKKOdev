import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { getSupabaseAdmin } from './supabase';

export const authOptions: NextAuthOptions = {
    providers: [
        CredentialsProvider({
            name: 'credentials',
            credentials: {
                email: { label: 'Email', type: 'email' },
                password: { label: 'Password', type: 'password' }
            },
            async authorize(credentials) {
                if (!credentials?.email || !credentials?.password) {
                    throw new Error('Please enter email and password');
                }

                const supabase = getSupabaseAdmin();

                // Fetch user by email
                const { data: user, error } = await supabase
                    .from('users')
                    .select('id, email, name, image, password_hash, role, is_active')
                    .eq('email', credentials.email)
                    .single();

                if (error || !user) {
                    throw new Error('Invalid email or password');
                }

                if (!user.is_active) {
                    throw new Error('Account is disabled');
                }

                if (!user.password_hash) {
                    throw new Error('Invalid email or password');
                }

                // Verify password
                const isValid = await bcrypt.compare(credentials.password, user.password_hash);

                if (!isValid) {
                    throw new Error('Invalid email or password');
                }

                return {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    image: user.image,
                    role: user.role
                };
            }
        })
    ],
    callbacks: {
        async jwt({ token, user }) {
            if (user) {
                token.id = user.id;
                token.role = (user as any).role;
            }
            return token;
        },
        async session({ session, token }) {
            return {
                ...session,
                user: {
                    ...session.user,
                    id: token.id as string,
                    role: token.role as string
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
        maxAge: 30 * 24 * 60 * 60,
        updateAge: 24 * 60 * 60
    },
    debug: process.env.NODE_ENV !== 'production'
};

// Extended session type
declare module 'next-auth' {
    interface Session {
        user: {
            id?: string;
            name?: string | null;
            email?: string | null;
            image?: string | null;
            role?: string;
        };
    }
}

declare module 'next-auth/jwt' {
    interface JWT {
        id?: string;
        role?: string;
    }
}
