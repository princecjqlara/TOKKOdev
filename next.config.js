/** @type {import('next').NextConfig} */
const nextConfig = {
  // Configure for ngrok
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Access-Control-Allow-Origin',
            value: '*',
          },
        ],
      },
    ];
  },
  trailingSlash: false,
  // Remove output: 'standalone' for development - it's only for production builds
  // and causes static asset 404 errors in dev mode
};

module.exports = nextConfig;
