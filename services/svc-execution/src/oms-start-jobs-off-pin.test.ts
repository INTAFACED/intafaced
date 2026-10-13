/**
 * Unit card — EXECUTION_ALGO_JOBS_ENABLED stays default OFF
 * 1. Promise: start does not mark a parent running unless an operator denylist-enables jobs
 * 2. Break: `.default(true)` or `algoJobs: { enabled: true }` on the host would start on a clean deploy
 * 3. Done bar: env default false + denylist; index wires the env flag; router default enabled false
 * 4. Class N
 * 5. Paths: svc-execution/src env.ts / index.ts / router.ts source pins (read-only)
 * 6. RED: EXECUTION_ALGO_JOBS_ENABLED default true, or index/router default jobs on
 * 7. Collision: none — does not invent a schedule, interval, or tick host
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const joinChains = (source: string) => source.replace(/\n\s*\./g, '.');
const envSrc = joinChains(readFileSync(join(here, 'env.ts'), 'utf8'));
const indexSrc = readFileSync(join(here, 'index.ts'), 'utf8');
const routerSrc = readFileSync(join(here, 'router.ts'), 'utf8');

describe('EXECUTION_ALGO_JOBS_ENABLED cannot sneak default ON', () => {
  it('env schema defaults the jobs flag false (unset deploy starts no parent)', () => {
    const decl = /EXECUTION_ALGO_JOBS_ENABLED:\s*(z\.[^\n]*)/.exec(envSrc);
    expect(decl, 'EXECUTION_ALGO_JOBS_ENABLED is not declared in svc-execution/src/env.ts').not.toBeNull();
    expect(decl![1]).toContain('.default(false)');
    expect(decl![1]).not.toContain('.default(true)');
  });

  it('only denylist strings enable jobs — empty / 0 / false stay off', () => {
    const decl = /EXECUTION_ALGO_JOBS_ENABLED:\s*(z\.[^\n]*)/.exec(envSrc);
    expect(decl![1]).toMatch(
      /\.transform\(\(v\)\s*=>\s*\(typeof v === 'boolean' \? v : \['1', 'true', 'on', 'yes'\]\.includes\(String\(v\)\.toLowerCase\(\)\)\)\)/,
    );
  });

  it('live host wires createExecutionRouter from the env flag, not a literal true', () => {
    expect(indexSrc).toMatch(/\{\s*enabled:\s*env\.EXECUTION_ALGO_JOBS_ENABLED\s*\}/);
    expect(indexSrc).not.toMatch(/\{\s*enabled:\s*true\s*\}/);
    expect(indexSrc).not.toMatch(/startAlgoJobs|tickAllAlgos/);
  });

  it('createExecutionRouter default algoJobs.enabled is false', () => {
    expect(routerSrc).toMatch(/algoJobs:\s*AlgoJobsGate\s*=\s*\{\s*enabled:\s*false\s*\}/);
    expect(routerSrc).not.toMatch(/algoJobs:\s*AlgoJobsGate\s*=\s*\{\s*enabled:\s*true\s*\}/);
    expect(routerSrc).toMatch(/execution\.oms\.start/);
  });
});
