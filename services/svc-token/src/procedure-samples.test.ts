import { TRPCError } from '@trpc/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { SANCTIONS_REGIONS_ENV, SANCTIONS_SOURCE_ENV } from '@intafaced/config';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { ProcedureRecord, ProcedureSample } from '@intafaced/contracts/procedure';
import { TOKEN_PROCEDURES } from '@intafaced/contracts/token-procedures';
import { createTokenRouter } from './router.js';
import type { TokenService } from './token-service.js';

/**
 * The mounted side of each svc-token record's samples: called on the production router by a caller every record admits,
 * a refused sample is answered BAD_REQUEST (the input is malformed), an accepted one never is. No service behind it:
 * any call that gets past the input reaches a stub that refuses with a plain error. The record's zod schema and its JSON
 * export run the same samples in `@intafaced/contracts` (`procedure-registry.test.ts`).
 */

const SECRET = 'a-token-samples-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-token' });

function signed() {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['token:read', 'token:stake'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-samples',
  });
}

/** A token service nobody wired: every method refuses with a plain error, never a BAD_REQUEST. */
const unwired = new Proxy({} as TokenService, { get: () => () => Promise.reject(new Error('samples stub')) });

beforeAll(() => {
  // The screening list fixed as the mining samples fix it: KP is screened out, DE (the caller's region) is served.
  vi.stubEnv('APP_ENV', 'test');
  vi.stubEnv(SANCTIONS_REGIONS_ENV, 'KP');
  vi.stubEnv(SANCTIONS_SOURCE_ENV, 'procedure-samples-fixture');
});
afterAll(() => vi.unstubAllEnvs());

const RECORDS: readonly ProcedureRecord[] = TOKEN_PROCEDURES;
const cases = RECORDS.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i: number) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);

/** The procedure at a record's dotted path on a caller. */
function at(caller: unknown, path: string): (input: unknown) => Promise<unknown> {
  return path.split('.').reduce((node, key) => (node as Record<string, unknown>)[key], caller) as (input: unknown) => Promise<unknown>;
}

describe("svc-token's mounted calls reach each record sample's verdict", () => {
  it('covers every record', () => expect(RECORDS.length).toBeGreaterThan(0));

  it.each(cases)('$label', async ({ record, sample }) => {
    if (record.transport !== 'trpc') throw new Error(`${record.name} is not a tRPC record`);
    const caller = createTokenRouter(unwired).createCaller(signed());
    const code = await at(
      caller,
      record.path,
    )(sample.input).then(
      () => 'OK',
      (err: unknown) => (err instanceof TRPCError ? err.code : 'THROWN'),
    );
    if (sample.verdict === 'refuse') expect(code).toBe('BAD_REQUEST');
    else expect(code).not.toBe('BAD_REQUEST');
  });
});
