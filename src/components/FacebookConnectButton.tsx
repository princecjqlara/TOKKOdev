'use client';

import { signIn } from 'next-auth/react';
import { Facebook, Loader2 } from 'lucide-react';
import { useState } from 'react';

interface FacebookConnectButtonProps {
    onSuccess?: () => void;
}

export default function FacebookConnectButton({ onSuccess }: FacebookConnectButtonProps) {
    const [loading, setLoading] = useState(false);

    const handleConnect = async () => {
        setLoading(true);
        try {
            // Redirect to Facebook OAuth - NextAuth will handle the redirect
            signIn('facebook', {
                callbackUrl: '/dashboard'
            });
            // Note: signIn with redirect will navigate away, so onSuccess won't be called
            // The redirect happens automatically
        } catch (error) {
            console.error('Facebook connect error:', error);
            setLoading(false);
        }
    };

    return (
        <button
            onClick={handleConnect}
            disabled={loading}
            className="btn bg-[#1877F2] hover:bg-[#166FE5] text-white font-medium px-6 py-3 rounded-xl transition-all duration-200 flex items-center gap-3"
        >
            {loading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
                <Facebook className="w-5 h-5" />
            )}
            {loading ? 'Connecting...' : 'Connect with Facebook'}
        </button>
    );
}
