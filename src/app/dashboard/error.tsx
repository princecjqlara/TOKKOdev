'use client';

import { useEffect } from 'react';
import { AlertCircle, RefreshCw, Home, ArrowLeft } from 'lucide-react';
import Link from 'next/link';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error to an error reporting service
    console.error('Dashboard error:', error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-md w-full bg-white border-2 border-black p-8 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
        <div className="flex items-center gap-3 mb-6">
          <AlertCircle className="w-8 h-8 text-red-500" />
          <h1 className="text-2xl font-bold uppercase">Dashboard Error</h1>
        </div>
        
        <div className="mb-6">
          <p className="text-sm text-gray-700 mb-2">
            {error.message || 'An unexpected error occurred in the dashboard'}
          </p>
          {error.digest && (
            <p className="text-xs text-gray-500 font-mono">
              Error ID: {error.digest}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <button
            onClick={reset}
            className="flex items-center justify-center gap-2 px-4 py-2 bg-black text-white font-semibold uppercase hover:bg-gray-800 transition-colors border-2 border-black"
          >
            <RefreshCw className="w-4 h-4" />
            Try again
          </button>
          
          <Link
            href="/dashboard"
            className="flex items-center justify-center gap-2 px-4 py-2 bg-white text-black font-semibold uppercase border-2 border-black hover:bg-gray-100 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </Link>
          
          <Link
            href="/"
            className="flex items-center justify-center gap-2 px-4 py-2 bg-white text-black font-semibold uppercase border-2 border-black hover:bg-gray-100 transition-colors"
          >
            <Home className="w-4 h-4" />
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

