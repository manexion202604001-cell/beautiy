import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@salonos/core', '@salonos/db'],
  serverExternalPackages: ['@prisma/client', '.prisma/client'],
  experimental: { serverActions: { bodySizeLimit: '12mb' }, authInterrupts: true },
  poweredByHeader: false,
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      ],
    }];
  },
};

export default config;
