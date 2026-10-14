import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATIC_SECURITY_HEADERS } from './src/lib/security-headers.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * apps/admin — the operator console (§8.8, §14.6).
 *
 * Nothing here is cached and nothing here is exported statically: the console
 * reports the state of the platform as it is right now, and a stale kill-switch
 * reading is worse than no reading at all.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // pnpm workspace: trace from the repo root so the symlinked @intafaced/*
  // packages are resolved from packages/ rather than guessed at.
  outputFileTracingRoot: join(here, '..', '..'),
  // Lint is a repo-level turbo task, not a Next build step.
  eslint: { ignoreDuringBuilds: true },
  // Browser security headers on every path. The Content-Security-Policy is per request (it carries a nonce), so
  // `src/middleware.ts` sets it; see `src/lib/security-headers.mjs`.
  async headers() {
    return [{ source: '/:path*', headers: STATIC_SECURITY_HEADERS }];
  },
};

export default nextConfig;
