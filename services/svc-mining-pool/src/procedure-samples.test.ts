import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { SANCTIONS_REGIONS_ENV, SANCTIONS_SOURCE_ENV } from '@intafaced/config';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MINING_PROCEDURES } from '@intafaced/contracts/mining-procedures';
import type { ProcedureSample } from '@intafaced/contracts/procedure';
import { miningHealthHonesty } from './health-honesty.js';
import { createMiningRequestHandler } from './http.js';

/**
 * The mounted side of each svc-mining-pool record's samples: sent through the production request handler (`http.ts`) by
 * a caller the record admits, a refused sample is answered 400 (the input is malformed), an accepted one never is. The
 * record's zod schema and its JSON export run the same samples in `@intafaced/contracts` (`procedure-registry.test.ts`).
 */

const SECRET = 'a-mining-samples-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';

function signedIn(): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['ledger:read', 'trade:write', 'admin:read'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return { 'x-intafaced-principal': raw, 'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'), 'x-intafaced-region': 'DE' };
}

let server: Server;
let base: string;

beforeAll(async () => {
  // The screening list fixed as the wire replay fixes it: KP is screened out, DE (the caller's region) is served.
  vi.stubEnv('APP_ENV', 'test');
  vi.stubEnv(SANCTIONS_REGIONS_ENV, 'KP');
  vi.stubEnv(SANCTIONS_SOURCE_ENV, 'procedure-samples-fixture');
  const handler = createMiningRequestHandler({
    health: () => miningHealthHonesty({ ledgerConfigured: false, pgConfigured: false, jobs: [] }),
    sql: null,
    internalSecret: 'a-mining-samples-internal-secret-long-enough',
    edgeSecret: SECRET,
    edgeTrust: {},
    ledger: null,
  });
  server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((done) => server.close(() => done()));
});

const cases = MINING_PROCEDURES.flatMap((record) =>
  record.samples.map((sample: ProcedureSample, i) => ({
    record,
    sample,
    label: `${record.name} #${i} ${sample.verdict} ${JSON.stringify(sample.input)}`,
  })),
);

describe("svc-mining-pool's mounted routes reach each record sample's verdict", () => {
  it.each(cases)('$label', async ({ record, sample }) => {
    if (record.transport !== 'trpc') throw new Error(`${record.name} is not a tRPC record`);
    const input = sample.input;
    const url = `${base}/trpc/${record.path}${record.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
    const res =
      record.kind === 'query'
        ? await fetch(url, { headers: signedIn() })
        : await fetch(url, {
            method: 'POST',
            headers: { ...signedIn(), 'content-type': 'application/json' },
            body: input === undefined ? '' : JSON.stringify(input),
          });
    const body = await res.text();
    if (sample.verdict === 'refuse') expect(res.status, body).toBe(400);
    else expect(res.status, body).not.toBe(400);
  });
});
