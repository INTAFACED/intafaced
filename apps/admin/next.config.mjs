import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE_PRODUCTION_BUILD } from 'next/constants.js';
import { localNextBuild } from '../../tooling/scripts/local-jobs.mjs';
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
  // The build script checks types first, with the repo's one checker (tooling/scripts/tsc.mjs, on this tsconfig and the
  // route types `next typegen` writes, the files Next's own check reads). Next's check would repeat it with TypeScript
  // 7.0's tsc beside Turbopack: 1.63 to 1.76 GB against 0.62 GB on a shared machine. On CI tsc.mjs runs that same tsc.
  typescript: { ignoreBuildErrors: true },
  // One worker collects the routes' page data and renders the one static page. Next's default is a worker per core less
  // one: 15 on a 16-core machine, each loading the app, 2.7 GB together beside Turbopack's 2.2 GB, for the same wall
  // time (81 s with 15, 83 s with 1, back to back). Turbopack's own compile threads are not these workers.
  experimental: { cpus: 1 },
  // pnpm workspace: trace from the repo root so the symlinked @intafaced/*
  // packages are resolved from packages/ rather than guessed at.
  outputFileTracingRoot: join(here, '..', '..'),
  // Browser security headers on every path. The Content-Security-Policy is per request (it carries a nonce), and
  // Strict-Transport-Security is per deployment (read from the runtime env), so `src/middleware.ts` sets both; this list is
  // baked into the build, which is why neither is here. See `src/lib/security-headers.mjs`.
  async headers() {
    return [{ source: '/:path*', headers: STATIC_SECURITY_HEADERS }];
  },
};

/**
 * A production build on a shared machine (INTAFACED_LOCAL_JOBS set) takes that machine's bound: fewer Turbopack threads,
 * no build cache and no source maps (tooling/scripts/local-jobs.mjs, localNextBuild). Every other phase, and every build
 * with the setting unset, is the config above as it is.
 *
 * @param {string} phase
 * @returns {import('next').NextConfig}
 */
export default function config(phase) {
  if (phase !== PHASE_PRODUCTION_BUILD) return nextConfig;
  const local = localNextBuild();
  Object.assign(process.env, local.env);
  return { ...nextConfig, experimental: { ...nextConfig.experimental, ...local.experimental } };
}
