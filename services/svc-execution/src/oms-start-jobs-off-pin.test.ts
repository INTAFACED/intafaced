/**
 * Unit card — EXECUTION_ALGO_JOBS_ENABLED stays default OFF
 * 1. Promise: start does not mark a parent running unless an operator denylist-enables jobs
 * 2. Break: `.default(true)` or `algoJobs: { enabled: true }` on the host would start on a clean deploy
 * 3. Done bar: env default false + denylist; the booted host hands the router the env flag; router default enabled false
 * 4. Class N
 * 5. Paths: svc-execution/src env.ts / index.ts (booted through testing/boot.ts) / router.ts
 * 6. RED: EXECUTION_ALGO_JOBS_ENABLED default true, or index/router default jobs on
 * 7. Collision: none — does not invent a schedule, interval, or tick host
 */

import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import { bootExecution, loadExecutionEnv } from './testing/boot.js';
import { createExecutionRouter } from './router.js';

const SECRET = 'a-execution-jobs-off-test-edge-secret-long';
const OP = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });

/** An operator call as svc-execution itself makes it (the OMS write door). */
function asExecution() {
  const raw = encodePrincipal({
    sub: OP,
    userId: OP,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['admin:read', 'admin:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return {
    ...edgeContext({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-jobs-off',
    }),
    service: 'svc-execution' as const,
  };
}

/** createExecutionRouter's algoJobs gate (parameter 18), as the booted host hands it over, and the timers it started. */
async function bootedJobs(vars: Record<string, string>) {
  const booted = await bootExecution(vars);
  try {
    return { algoJobs: booted.routerArgs[17], intervalsStarted: booted.intervalsStarted };
  } finally {
    await booted.close();
  }
}

describe('EXECUTION_ALGO_JOBS_ENABLED cannot sneak default ON', () => {
  it('env schema defaults the jobs flag false (unset deploy starts no parent)', async () => {
    expect((await loadExecutionEnv({ EXECUTION_ALGO_JOBS_ENABLED: undefined })).EXECUTION_ALGO_JOBS_ENABLED).toBe(false);
  });

  it('only denylist strings enable jobs — empty / 0 / false stay off', async () => {
    for (const on of ['1', 'true', 'on', 'yes', 'TRUE', 'Yes']) {
      expect((await loadExecutionEnv({ EXECUTION_ALGO_JOBS_ENABLED: on })).EXECUTION_ALGO_JOBS_ENABLED, on).toBe(true);
    }
    for (const off of ['', '0', 'false', 'off', 'no', 'enabled', ' true']) {
      expect((await loadExecutionEnv({ EXECUTION_ALGO_JOBS_ENABLED: off })).EXECUTION_ALGO_JOBS_ENABLED, off).toBe(false);
    }
  });

  it('live host wires createExecutionRouter from the env flag, not a literal true', async () => {
    expect(await bootedJobs({})).toEqual({ algoJobs: { enabled: false }, intervalsStarted: 0 });
    expect(await bootedJobs({ EXECUTION_ALGO_JOBS_ENABLED: 'false' })).toEqual({ algoJobs: { enabled: false }, intervalsStarted: 0 });
    // On is the operator's word only, and even then the host starts no job ticker of its own.
    expect(await bootedJobs({ EXECUTION_ALGO_JOBS_ENABLED: 'true' })).toEqual({ algoJobs: { enabled: true }, intervalsStarted: 0 });
  });

  it('createExecutionRouter default algoJobs.enabled is false', async () => {
    const caller = createExecutionRouter(new SealedHouseTenantRegistry()).createCaller(asExecution());
    await expect(caller.execution.oms.start({ parentClientOrderId: 'parent-1' })).resolves.toMatchObject({
      ok: false,
      reason: 'jobs_off',
    });
  });
});
