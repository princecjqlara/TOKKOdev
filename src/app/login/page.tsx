'use client';

import { signIn } from 'next-auth/react';
import { Square, ArrowRight } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function LoginForm() {
    const searchParams = useSearchParams();
    const error = searchParams.get('error');

    const handleFacebookLogin = () => {
        signIn('facebook', { callbackUrl: '/dashboard' });
    };

    return (
        <div className="w-full max-w-md">
            {/* Login Card */}
            <div className="border-2 border-black bg-white p-8 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
                <div className="flex items-center gap-3 mb-8">
                    <div className="w-12 h-12 border-2 border-black flex items-center justify-center">
                        <div className="w-6 h-6 bg-[#1877F2]"></div> {/* Facebook Blue Square */}
                    </div>
                    <div>
                        <h1 className="text-2xl font-black uppercase">Start Here</h1>
                        <p className="text-sm text-gray-600 font-mono">Connect with Facebook to continue</p>
                    </div>
                </div>

                {/* Error Display */}
                {error && (
                    <div className="mb-6 p-4 border-2 border-red-500 bg-red-50">
                        <p className="font-bold text-red-700 text-sm">Login Failed</p>
                        <p className="text-red-600 text-sm font-mono">
                            {error === 'OAuthSignin' && 'Error constructing OAuth URL.'}
                            {error === 'OAuthCallback' && 'Error handling OAuth callback.'}
                            {error === 'OAuthCreateAccount' && 'Could not create OAuth account.'}
                            {error === 'EmailCreateAccount' && 'Could not create email account.'}
                            {error === 'Callback' && 'Error in OAuth callback handler.'}
                            {!['OAuthSignin', 'OAuthCallback', 'OAuthCreateAccount', 'EmailCreateAccount', 'Callback'].includes(error) && error}
                        </p>
                    </div>
                )}

                <div className="space-y-4">
                    <button
                        onClick={handleFacebookLogin}
                        className="w-full bg-[#1877F2] text-white border-2 border-black hover:bg-[#1864D0] transition-colors p-4 flex items-center justify-between group"
                    >
                        <span className="font-bold text-lg uppercase tracking-wider">Sign In with Facebook</span>
                        <ArrowRight className="w-6 h-6 transform group-hover:translate-x-1 transition-transform" />
                    </button>

                    <p className="text-xs text-gray-500 font-mono text-center leading-relaxed">
                        By continuing, you agree to grant Tokko required permissions to manage your Facebook Pages and Messages.
                    </p>
                </div>
            </div>
        </div>
    );
}

export default function LoginPage() {
    return (
        <div className="min-h-screen bg-background text-foreground flex flex-col font-sans">
            {/* Header / Nav */}
            <nav className="border-b border-black px-6 py-4 flex justify-between items-center sticky top-0 bg-white z-50">
                <div className="flex items-center gap-2">
                    <Square className="w-5 h-5 fill-black" />
                    <span className="font-bold tracking-tighter text-lg">TOKKO</span>
                </div>
            </nav>

            <main className="flex-1 flex items-center justify-center p-6">
                <Suspense fallback={
                    <div className="w-full max-w-md flex items-center justify-center py-20">
                        <div className="animate-spin h-8 w-8 border-2 border-black border-t-transparent rounded-full" />
                    </div>
                }>
                    <LoginForm />
                </Suspense>
            </main>

            {/* Footer */}
            <footer className="border-t border-black p-6 flex justify-center items-center text-xs font-mono uppercase">
                <span>&copy; 2024 Tokko</span>
            </footer>
        </div>
    );
}
