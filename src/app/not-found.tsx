import Link from 'next/link';
import { Home, ArrowLeft, SearchX } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-md w-full bg-white border-2 border-black p-8 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
        <div className="flex items-center gap-3 mb-6">
          <SearchX className="w-8 h-8 text-gray-500" />
          <h1 className="text-2xl font-bold uppercase">Page Not Found</h1>
        </div>
        
        <div className="mb-6">
          <p className="text-sm text-gray-700 mb-2">
            The page you're looking for doesn't exist or has been moved.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <Link
            href="/dashboard"
            className="flex items-center justify-center gap-2 px-4 py-2 bg-black text-white font-semibold uppercase hover:bg-gray-800 transition-colors border-2 border-black"
          >
            <ArrowLeft className="w-4 h-4" />
            Go to Dashboard
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

