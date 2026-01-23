'use client';

import { useState, FormEvent } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Square, Lock, Mail, ArrowRight, X, AlertCircle } from 'lucide-react';

export default function LoginPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Check for error from NextAuth
    const callbackError = searchParams.get('error');

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setIsLoading(true);
        setError(null);

        try {
            const result = await signIn('credentials', {
                email,
                password,
                redirect: false
            });

            if (result?.error) {
                setError(result.error);
                setIsLoading(false);
            } else if (result?.ok) {
                router.push('/dashboard');
            }
        } catch (err) {
            setError('An unexpected error occurred');
            setIsLoading(false);
        }
    };

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
                <div className="w-full max-w-md">
                    {/* Login Card */}
                    <div className="border-2 border-black bg-white p-8 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
                        <div className="flex items-center gap-3 mb-8">
                            <div className="w-12 h-12 border-2 border-black flex items-center justify-center">
                                <Lock className="w-6 h-6" />
                            </div>
                            <div>
                                <h1 className="text-2xl font-black uppercase">Sign In</h1>
                                <p className="text-sm text-gray-600 font-mono">Access your dashboard</p>
                            </div>
                        </div>

                        {/* Error Display */}
                        {(error || callbackError) && (
                            <div className="mb-6 p-4 border-2 border-red-500 bg-red-50 flex items-start gap-3">
                                <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                                <div>
                                    <p className="font-bold text-red-700 text-sm">Login Failed</p>
                                    <p className="text-red-600 text-sm font-mono">
                                        {error || callbackError}
                                    </p>
                                </div>
                            </div>
                        )}

                        <form onSubmit={handleSubmit} className="space-y-6">
                            {/* Email Field */}
                            <div>
                                <label className="block text-xs font-bold uppercase tracking-wider mb-2">
                                    Email Address
                                </label>
                                <div className="relative">
                                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                                    <input
                                        type="email"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        className="w-full border-2 border-black px-4 py-3 pl-11 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-black focus:ring-offset-2"
                                        placeholder="you@example.com"
                                        required
                                        autoComplete="email"
                                    />
                                </div>
                            </div>

                            {/* Password Field */}
                            <div>
                                <label className="block text-xs font-bold uppercase tracking-wider mb-2">
                                    Password
                                </label>
                                <div className="relative">
                                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                                    <input
                                        type="password"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        className="w-full border-2 border-black px-4 py-3 pl-11 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-black focus:ring-offset-2"
                                        placeholder="••••••••"
                                        required
                                        autoComplete="current-password"
                                    />
                                </div>
                            </div>

                            {/* Submit Button */}
                            <button
                                type="submit"
                                disabled={isLoading}
                                className="w-full btn-wireframe-dark text-lg px-8 py-4 flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isLoading ? (
                                    <>
                                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                        Signing in...
                                    </>
                                ) : (
                                    <>
                                        Sign In <ArrowRight className="w-5 h-5" />
                                    </>
                                )}
                            </button>
                        </form>

                        <p className="mt-6 text-center text-xs text-gray-500 font-mono">
                            Contact your administrator for access
                        </p>
                    </div>
                </div>
            </main>

            {/* Footer */}
            <footer className="border-t border-black p-6 flex justify-center items-center text-xs font-mono uppercase">
                <span>&copy; 2024 Tokko</span>
            </footer>
        </div>
    );
}
