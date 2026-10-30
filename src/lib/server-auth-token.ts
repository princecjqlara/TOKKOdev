import { cookies, headers } from 'next/headers';
import { getToken } from 'next-auth/jwt';

// Provider tokens never appear in the browser-visible session response.
export async function getServerAuthToken() {
    const incoming = await headers();
    const cookieStore = await cookies();
    // NextAuth reads session cookies from req.cookies, including chunked JWTs.
    // A raw Cookie header alone is not consumed by its SessionStore.
    return getToken({ req: { headers: Object.fromEntries(incoming.entries()), cookies: cookieStore } as any, secret: process.env.NEXTAUTH_SECRET });
}
export async function getFacebookServerToken(): Promise<string | null> {
    const token = await getServerAuthToken();
    return token?.provider === 'facebook' || (!token?.provider && token?.facebookId)
        ? typeof token.accessToken === 'string' ? token.accessToken : null : null;
}
