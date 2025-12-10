import { getServerSession } from 'next-auth';
import { NextRequest } from 'next/server';
import { authOptions } from './auth';
import { getSupabaseAdmin } from './supabase';
import { cookies } from 'next/headers';

/**
 * Get session from request with proper App Router handling
 */
export async function getSessionFromRequest(request: NextRequest) {
    try {
        // In App Router, getServerSession should automatically read cookies
        // But we can also check cookies explicitly for debugging
        const cookieStore = await cookies();
        const sessionToken = cookieStore.get('next-auth.session-token') || cookieStore.get('__Secure-next-auth.session-token');
        
        if (process.env.NODE_ENV !== 'production') {
            console.log('🔵 Cookie check:', {
                hasSessionToken: !!sessionToken,
                cookieNames: Array.from(cookieStore.getAll().map(c => c.name))
            });
        }

        // Get session using NextAuth
        const session = await getServerSession(authOptions);

        if (!session) {
            if (process.env.NODE_ENV !== 'production') {
                console.error('🔴 No session found - cookies:', {
                    hasSessionToken: !!sessionToken,
                    allCookies: cookieStore.getAll().map(c => c.name)
                });
            }
            return null;
        }

        // If user.id is not set, try to get it from database or create user
        let userId = session.user?.id;
        if (!userId && session.user?.email) {
            const supabase = getSupabaseAdmin();
            
            // Try to get user from database
            let { data: user, error: fetchError } = await supabase
                .from('users')
                .select('id')
                .eq('email', session.user.email)
                .single();
            
            // If user doesn't exist, create them
            if (!user && fetchError?.code === 'PGRST116') {
                if (process.env.NODE_ENV !== 'production') {
                    console.log('🔵 User not found in database, creating user:', session.user.email);
                }
                
                const { data: newUser, error: createError } = await supabase
                    .from('users')
                    .insert({
                        email: session.user.email,
                        name: session.user.name,
                        image: session.user.image,
                        facebook_id: (session as any).user?.facebookId || null,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString()
                    })
                    .select('id')
                    .single();
                
                if (createError) {
                    console.error('🔴 Error creating user:', createError);
                } else {
                    user = newUser;
                    if (process.env.NODE_ENV !== 'production') {
                        console.log('✅ User created:', newUser?.id);
                    }
                }
            } else if (fetchError && fetchError.code !== 'PGRST116') {
                console.error('🔴 Error fetching user:', fetchError);
            }
            
            userId = user?.id;
        }

        // Return session with userId
        return {
            ...session,
            user: {
                ...session.user,
                id: userId || null
            }
        };
    } catch (error) {
        console.error('Error getting session:', error);
        return null;
    }
}

