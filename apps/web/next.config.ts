import type { NextConfig } from 'next';
import path from 'node:path';

const config: NextConfig = {
  transpilePackages: ['@salonos/core', '@salonos/db'],
  serverExternalPackages: ['@prisma/client', '.prisma/client'],
  experimental: { serverActions: { bodySizeLimit: '12mb' }, authInterrupts: true },
  poweredByHeader: false,
  // standalone output for Docker/self-hosting (ignored by Vercel); trace from the monorepo root
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  outputFileTracingRoot: path.join(__dirname, '../../'),
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
