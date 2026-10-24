/**
 * session.log omit must refuse — never invent a 100-row session dump.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { AgentError, assertSessionLogPageLimit } from './errors.js';
import { AuditLog } from './fleet/audit.js';
import { createAgentsRouter } from './router.js';
import type { AgentsRouterDeps } from './router.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 'an-agents-session-log-limit-unset-test-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });

function signed() {
  const p = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['agents:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

function stubDeps(sessionLog: (sessionId: string, limit: number) => Promise<never[]> = async () => []) {
  return {
    runtime: {
      session: async () => ({ id: SESSION, userId: USER }),
      sessionLog,
    } as unknown as AgentsRouterDeps['runtime'],
    gateway: { routingTable: { routes: [] } } as unknown as AgentsRouterDeps['gateway'],
    meter: {} as AgentsRouterDeps['meter'],
    feeAssetId: 'X',
  };
}

function captureSql() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join('?'), values: [...values] });
    return Promise.resolve([]);
  };
  return { sql: tag as unknown as Sql, calls };
}

describe('assertSessionLogPageLimit', () => {
  it('refuses omit / null / 0 / negative / garbage — never invent 100', () => {
    for (const bad of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '8', { n: 2 }] as const) {
      expect(() => assertSessionLogPageLimit(bad)).toThrow(AgentError);
    }
    try {
      assertSessionLogPageLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(AgentError);
      expect((e as AgentError).code).toBe('agents.session_log_limit_unset');
      expect((e as AgentError).userMessageKey).toBe('agents.refused.log_mine_limit_unset');
      expect((e as AgentError).message).not.toMatch(/default 100/i);
    }
  });

  it('accepts owner-published 2 and 500 slices', () => {
    expect(assertSessionLogPageLimit(2)).toBe(2);
    expect(assertSessionLogPageLimit(500)).toBe(500);
  });
});

describe('session.log public door', () => {
  it('omit limit refuses agents.session_log_limit_unset — never calls sessionLog', async () => {
    const calls: number[] = [];
    const deps = stubDeps(async (_sessionId, limit) => {
      calls.push(limit);
      return [];
    });
    const caller = createAgentsRouter(deps).createCaller(signed());
    await expect(caller.session.log({ sessionId: SESSION })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { code: 'agents.session_log_limit_unset' },
    });
    expect(calls).toEqual([]);
  });

  it('owner-published 2 and 500 reach sessionLog', async () => {
    const calls: Array<{ sessionId: string; limit: number }> = [];
    const deps = stubDeps(async (sessionId, limit) => {
      calls.push({ sessionId, limit });
      return [];
    });
    const caller = createAgentsRouter(deps).createCaller(signed());
    expect(await caller.session.log({ sessionId: SESSION, limit: 2 })).toEqual([]);
    expect(await caller.session.log({ sessionId: SESSION, limit: 500 })).toEqual([]);
    expect(calls).toEqual([
      { sessionId: SESSION, limit: 2 },
      { sessionId: SESSION, limit: 500 },
    ]);
  });

  it('source does not default 100 on session.log / sessionLog / forSession', () => {
    const routerTs = readFileSync(join(HERE, 'router.ts'), 'utf8');
    const runtimeTs = readFileSync(join(HERE, 'runtime.ts'), 'utf8');
    const auditTs = readFileSync(join(HERE, 'fleet/audit.ts'), 'utf8');
    expect(routerTs).not.toMatch(/sessionId: z\.string\(\)\.guid\(\).*default\(100\)/);
    expect(routerTs).toMatch(/assertSessionLogPageLimit\(input\.limit\)/);
    expect(runtimeTs).not.toMatch(/sessionLog\(sessionId: string, limit = 100\)/);
    expect(auditTs).not.toMatch(/forSession\(sessionId: string, limit = 100\)/);
    expect(auditTs).toMatch(/forSessionChain\(sessionId: string\)/);
  });
});

describe('session log SQL LIMIT vs verifyChain full chain', () => {
  it('public forSession sends LIMIT; forSessionChain / verifyChain do not', async () => {
    const { sql, calls } = captureSql();
    const audit = new AuditLog(sql);

    await audit.forSession(SESSION, 2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/LIMIT\s*\?/);
    expect(calls[0]!.values).toEqual([SESSION, 2]);

    calls.length = 0;
    await audit.forSessionChain(SESSION);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).not.toMatch(/LIMIT/i);
    expect(calls[0]!.values).toEqual([SESSION]);

    calls.length = 0;
    await expect(audit.verifyChain(SESSION)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).not.toMatch(/LIMIT/i);
    expect(calls[0]!.values).toEqual([SESSION]);
  });
});
