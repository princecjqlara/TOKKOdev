import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import bcrypt from 'bcryptjs';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';

// GET - List all users (admin only)
export async function GET() {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.role || session.user.role !== 'admin') {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const supabase = getSupabaseAdmin();
        const { data: users, error } = await supabase
            .from('users')
            .select('id, email, name, role, is_active, created_at')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching users:', error);
            return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 });
        }

        return NextResponse.json({ users });
    } catch (error) {
        console.error('Error in GET /api/admin/users:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// POST - Create new user (admin only)
export async function POST(request: Request) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.role || session.user.role !== 'admin') {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { email, password, name, role = 'user' } = await request.json();

        if (!email || !password) {
            return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
        }

        if (password.length < 6) {
            return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 });
        }

        // Hash password
        const password_hash = await bcrypt.hash(password, 10);

        const supabase = getSupabaseAdmin();

        // Check if user already exists
        const { data: existingUser } = await supabase
            .from('users')
            .select('id')
            .eq('email', email)
            .single();

        if (existingUser) {
            return NextResponse.json({ error: 'User with this email already exists' }, { status: 409 });
        }

        // Create user
        const { data: newUser, error } = await supabase
            .from('users')
            .insert({
                email,
                name: name || email.split('@')[0],
                password_hash,
                role,
                is_active: true
            })
            .select('id, email, name, role, is_active, created_at')
            .single();

        if (error) {
            console.error('Error creating user:', error);
            return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
        }

        return NextResponse.json({ user: newUser }, { status: 201 });
    } catch (error) {
        console.error('Error in POST /api/admin/users:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// DELETE - Deactivate user (admin only)
export async function DELETE(request: Request) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.role || session.user.role !== 'admin') {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { searchParams } = new URL(request.url);
        const userId = searchParams.get('id');

        if (!userId) {
            return NextResponse.json({ error: 'User ID is required' }, { status: 400 });
        }

        // Prevent self-deactivation
        if (userId === session.user.id) {
            return NextResponse.json({ error: 'Cannot deactivate your own account' }, { status: 400 });
        }

        const supabase = getSupabaseAdmin();
        const { error } = await supabase
            .from('users')
            .update({ is_active: false })
            .eq('id', userId);

        if (error) {
            console.error('Error deactivating user:', error);
            return NextResponse.json({ error: 'Failed to deactivate user' }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error in DELETE /api/admin/users:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
