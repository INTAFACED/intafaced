import { afterEach, describe, expect, it } from 'vitest';
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from 'next/constants.js';
import config from '../next.config.mjs';

// The console's build on a shared machine: with INTAFACED_LOCAL_JOBS unset, a production build peaked
// at 2.59 GB on a 16-core box with Next's defaults (a Turbopack thread per core, its build cache and source maps) and
// 1.59 GB with it set to 2. The bound reaches the build only through this config; unset (CI, the image), nothing changes.
const saved = { jobs: process.env.INTAFACED_LOCAL_JOBS, threads: process.env.TURBO_TASKS_AVAILABLE_PARALLELISM };
afterEach(() => {
  for (const [key, value] of [
    ['INTAFACED_LOCAL_JOBS', saved.jobs],
    ['TURBO_TASKS_AVAILABLE_PARALLELISM', saved.threads],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('next.config.mjs on a shared machine', () => {
  it('a production build with the bound set takes fewer threads, no build cache and no source maps', () => {
    process.env.INTAFACED_LOCAL_JOBS = '2';
    delete process.env.TURBO_TASKS_AVAILABLE_PARALLELISM;
    const built = config(PHASE_PRODUCTION_BUILD);
    expect(built.experimental).toMatchObject({ cpus: 1, turbopackFileSystemCacheForBuild: false, turbopackSourceMaps: false });
    expect(process.env.TURBO_TASKS_AVAILABLE_PARALLELISM).toBe('2');
  });

  it('unset, or any phase but a production build, keeps the config as it is', () => {
    delete process.env.INTAFACED_LOCAL_JOBS;
    delete process.env.TURBO_TASKS_AVAILABLE_PARALLELISM;
    expect(config(PHASE_PRODUCTION_BUILD).experimental).toEqual({ cpus: 1 });
    process.env.INTAFACED_LOCAL_JOBS = '2';
    expect(config(PHASE_DEVELOPMENT_SERVER).experimental).toEqual({ cpus: 1 });
    expect(process.env.TURBO_TASKS_AVAILABLE_PARALLELISM).toBeUndefined();
  });
});
