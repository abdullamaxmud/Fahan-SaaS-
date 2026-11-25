/** @type {import('next').NextConfig} */
const API = process.env.API_ORIGIN ?? 'http://localhost:4000';

export default {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@hospitalos/policy'],
  // Same-origin proxy so the API's HttpOnly, SameSite=Strict session cookie works in the browser.
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${API}/api/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};
