'use client';

import { useSession, signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Square, X, ArrowRight, LayoutGrid, Users, MessageSquare } from 'lucide-react';

export default function HomePage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check for OAuth error in URL
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const errorParam = params.get('error');
      if (errorParam) {
        setError(`Sign-in failed: ${errorParam}`);
        window.history.replaceState({}, '', window.location.pathname);
      }
    }

    if (status === 'authenticated' && session) {
      router.push('/dashboard');
    }
  }, [status, session, router]);

  const handleFacebookLogin = () => {
    setIsLoading(true);
    setError(null);
    signIn('facebook', { callbackUrl: '/dashboard', redirect: true })
      .catch((err) => {
        setIsLoading(false);
        setError(err.message);
      });
  };

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin h-8 w-8 border-2 border-black border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans">
      {/* Header / Nav */}
      <nav className="border-b border-black px-6 py-4 flex justify-between items-center sticky top-0 bg-white z-50">
        <div className="flex items-center gap-2">
          <Square className="w-5 h-5 fill-black" />
          <span className="font-bold tracking-tighter text-lg">TOKKO</span>
        </div>
        <button
          onClick={handleFacebookLogin}
          className="btn-wireframe text-xs py-2 px-4"
        >
          {isLoading ? '...' : (status === 'authenticated' ? 'Dashboard' : 'Login')}
        </button>
      </nav>

      <main className="flex-1 flex flex-col">
        {/* Hero Section - Diagonal Split */}
        <div className="relative h-[600px] border-b border-black overflow-hidden bg-white">
          {/* Top Right Content */}
          <div className="absolute top-0 right-0 w-full h-full p-8 md:p-16 flex flex-col items-end text-right pointer-events-none z-10">
            <div className="mt-20 md:mt-10 mr-4 md:mr-20">
              <div className="flex items-center justify-end gap-2 mb-2 text-xs font-bold uppercase tracking-widest text-gray-500">
                <X className="w-3 h-3" />
                <span>Growth Platform</span>
              </div>
              <h2 className="text-4xl md:text-6xl font-black uppercase leading-tight">
                Manage<br />Page
              </h2>
            </div>
          </div>

          {/* Diagonal Divider */}
          <div className="absolute inset-0 bg-black transform -skew-y-12 origin-bottom-right translate-y-1/2 opacity-5 pointer-events-none"></div>
          <div className="absolute inset-0 border-b border-black transform -skew-y-[20deg] origin-bottom-left translate-y-1/2 pointer-events-none"></div>

          {/* Main Diagonal Line */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none" preserveAspectRatio="none">
            <line x1="0" y1="100%" x2="100%" y2="0" stroke="black" strokeWidth="1" />
          </svg>

          {/* Bottom Left Content */}
          <div className="absolute bottom-0 left-0 w-full h-full p-8 md:p-16 flex flex-col justify-end items-start pointer-events-none z-10">
            <div className="mb-10 ml-4 md:ml-10">
              <div className="flex items-center gap-2 mb-2 text-xs font-bold uppercase tracking-widest text-gray-500">
                <X className="w-3 h-3" />
                <span>Meta Integration</span>
              </div>
              <h1 className="text-5xl md:text-8xl font-black uppercase leading-none mb-6">
                TOKKO<br />BETA
              </h1>
              <div className="pointer-events-auto">
                <button
                  onClick={handleFacebookLogin}
                  className="btn-wireframe-dark text-lg px-8 py-4 flex items-center gap-3"
                >
                  Start Now <ArrowRight className="w-5 h-5" />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Features Grid */}
        <section className="grid md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-black border-b border-black">
          {/* Feature 1 */}
          <div className="p-8 md:p-12 hover:bg-gray-50 transition-colors">
            <div className="flex items-center gap-2 mb-6">
              <div className="border border-black p-2">
                <Users className="w-6 h-6" />
              </div>
              <span className="font-bold text-xs uppercase tracking-wider">Sync Contacts</span>
            </div>
            <h3 className="text-2xl font-bold uppercase mb-4">Audience Data</h3>
            <p className="text-sm text-gray-600 leading-relaxed font-mono">
              Automatically sync all your Facebook Page contacts into one unified spreadsheet-like view.
            </p>
          </div>

          {/* Feature 2 */}
          <div className="p-8 md:p-12 hover:bg-gray-50 transition-colors">
            <div className="flex items-center gap-2 mb-6">
              <div className="border border-black p-2">
                <MessageSquare className="w-6 h-6" />
              </div>
              <span className="font-bold text-xs uppercase tracking-wider">Messaging</span>
            </div>
            <h3 className="text-2xl font-bold uppercase mb-4">Bulk Send</h3>
            <p className="text-sm text-gray-600 leading-relaxed font-mono">
              Send personalized messages to thousands of contacts with smart delays and anti-spam protection.
            </p>
          </div>

          {/* Feature 3 */}
          <div className="p-8 md:p-12 hover:bg-gray-50 transition-colors">
            <div className="flex items-center gap-2 mb-6">
              <div className="border border-black p-2">
                <LayoutGrid className="w-6 h-6" />
              </div>
              <span className="font-bold text-xs uppercase tracking-wider">Organization</span>
            </div>
            <h3 className="text-2xl font-bold uppercase mb-4">Smart Tags</h3>
            <p className="text-sm text-gray-600 leading-relaxed font-mono">
              Organize leads with custom tags and filters. Export data to CSV for external processing.
            </p>
          </div>
        </section>

        {/* Bottom Call to Action */}
        <section className="py-24 px-6 text-center bg-gray-50">
          <div className="max-w-2xl mx-auto">
            <div className="flex justify-center mb-6">
              <X className="w-8 h-8" />
            </div>
            <h2 className="text-3xl md:text-5xl font-black uppercase mb-8">
              Ready to scale?
            </h2>
            <button
              onClick={handleFacebookLogin}
              className="btn-wireframe px-10 py-4 text-lg"
            >
              Connect Facebook
            </button>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-black p-6 md:p-12 flex flex-col md:flex-row justify-between items-center gap-6 text-xs font-mono uppercase">
        <div className="flex gap-4">
          <span>&copy; 2024 Tokko</span>
          <span>Beta Version 2.0</span>
        </div>
        <div className="flex gap-6">
          <a href="#" className="hover:underline">Privacy</a>
          <a href="#" className="hover:underline">Terms</a>
          <a href="#" className="hover:underline">Support</a>
        </div>
      </footer>

      {/* Error Modal */}
      {error && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white border-2 border-black p-8 max-w-md w-full relative shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
            <button
              onClick={() => setError(null)}
              className="absolute top-4 right-4 hover:bg-black hover:text-white p-1 transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
            <h3 className="text-xl font-bold uppercase mb-4 flex items-center gap-2">
              <span className="w-3 h-3 bg-red-500 inline-block" /> Error
            </h3>
            <p className="font-mono text-sm mb-6">{error}</p>
            <button
              onClick={() => { setError(null); handleFacebookLogin(); }}
              className="btn-wireframe w-full"
            >
              Try Again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
