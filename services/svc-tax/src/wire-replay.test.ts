import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { readFileSync, writeFileSync } from 'node:fs';
import { createTestDatabase, postgresAvailable, rowsChange, storedRows, type TestDatabase } from '@intafaced/db/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import type { Principal, Scope } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, procedureCallers, signPrincipalHeader } from '@intafaced/contracts';
import { TAX_DATA_LAKE_UNAVAILABLE, TAX_INDEXER_UNAVAILABLE } from './codes.js';
import { createPgBasisStore } from './basis-store.js';
import { createPgChoiceStore } from './choices.js';
import type { TaxLedgerReads } from './ledger-reads.js';
import { createTaxRouter } from './router.js';
import { TaxService } from './tax-service.js';

/**
 * The wire replay. `wire-replay.golden.json` holds what svc-tax's hand-written router answered (main 2026-11-19, before
 * its calls were mounted from their records) to a matrix of requests: every call, seven inputs, four callers, a blank
 * and a set jurisdiction map, sent through the production Fastify adapter. Today's router must answer each one byte for
 * byte the same. A wrong scope, a widened enum, a renamed path or a changed refusal shows here as a difference.
 *
 * The rows replay. `wire-replay.rows.golden.json` holds the same matrix (set map) sent to svc-tax wired to its real
 * Postgres stores, as main answered on 2026-11-19: each request's status and body, and the rows it added to or removed from
 * the `tax` tables (`storedRows`, `@intafaced/db/testing`). Today's code must leave the same rows after the same inputs.
 * A second row where a save should replace, a value stored differently, or a read that writes shows here as a difference.
 *
 * `WIRE_REPLAY_WRITE=1` rewrites both golden files. Only for a change that is meant to change the wire or the stored
 * rows, named in its PR.
 */

const GOLDEN = new URL('./wire-replay.golden.json', import.meta.url);
const ROWS_GOLDEN = new URL('./wire-replay.rows.golden.json', import.meta.url);
const SECRET = 'a-tax-wire-replay-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-tax' });

function headers(scopes: Scope[] | null, region: string): Record<string, string> {
  if (scopes === null) return {};
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'none',
    mfa: false,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  } as Principal;
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, region),
    'x-intafaced-region': region,
  };
}

const NO_READS: TaxLedgerReads = { balances: async () => [], history: async () => [] };

/** One deposit with no cost, so the rows replay has a lot whose basis a customer may enter. TEST figures. */
const DEPOSIT = {
  txId: 'tx-1',
  postedAt: new Date('2024-01-01T00:00:00.000Z'),
  assetId: 'BTC',
  amount: parseAmount('1'),
  reason: 'deposit.credited',
};
const ONE_UNKNOWN_LOT: TaxLedgerReads = {
  balances: async () => [
    { account: { ownerType: 'user', ownerId: USER, assetId: 'BTC', kind: 'available' }, accountId: 'a-0', amount: parseAmount('1') },
  ],
  history: async () => [],
  tradeFills: async () => ({
    fills: [],
    truncated: false,
    outsideInflows: new Set(['BTC']),
    inflows: [DEPOSIT],
    outflows: [],
    withdrawalHolds: [],
  }),
};

function tax(mapRaw: string, db?: TestDatabase) {
  return new TaxService({
    mapRaw,
    reads: db ? ONE_UNKNOWN_LOT : NO_READS,
    ...(db ? { basis: createPgBasisStore(db.sql), choices: createPgChoiceStore(db.sql) } : {}),
    lake: { status: 'absent', code: TAX_DATA_LAKE_UNAVAILABLE },
    indexer: { status: 'absent', code: TAX_INDEXER_UNAVAILABLE },
    historyYears: 10,
    // A fixed clock: exportPack writes the date into its filename, and the golden file must not change with the calendar.
    now: () => new Date('2026-11-19T00:00:00Z'),
  });
}

async function serve(mapRaw: string, db?: TestDatabase) {
  const app = Fastify();
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router: createTaxRouter(tax(mapRaw, db)), createContext: ({ req }: { req: unknown }) => edgeContext(req as never) },
  });
  return app;
}

const CALLS: ReadonlyArray<{ path: string; kind: 'query' | 'mutation'; valid: unknown }> = [
  { path: 'health', kind: 'query', valid: undefined },
  { path: 'lotBook', kind: 'query', valid: { method: 'FIFO' } },
  { path: 'pnlOverTime', kind: 'query', valid: { from: '2026-01-01T00:00:00Z', utcOffsetMinutes: 60 } },
  { path: 'missingBasis', kind: 'query', valid: {} },
  { path: 'basisOverride.set', kind: 'mutation', valid: { lotId: 'l1', pricePerUnit: '1.5', date: '2026-01-01', sourceNote: 'n' } },
  { path: 'basisOverride.remove', kind: 'mutation', valid: { lotId: 'l1' } },
  { path: 'setLotMethod', kind: 'mutation', valid: { assetId: null, method: 'FIFO' } },
  { path: 'setDayMethod', kind: 'mutation', valid: { day: '2026-01-01', assetId: 'BTC', method: 'LIFO' } },
  { path: 'pickSaleLot', kind: 'mutation', valid: { saleTxId: 's1', assetId: 'BTC', lotId: null } },
  { path: 'setIncludeTransfers', kind: 'mutation', valid: { include: true } },
  { path: 'exportPreview', kind: 'query', valid: { lotMethod: 'HIFO' } },
  { path: 'exportPack', kind: 'mutation', valid: { lotMethod: 'FIFO' } },
];

const INPUTS = (valid: unknown): Array<[string, unknown]> => [
  ['valid', valid],
  ['absent', undefined],
  ['wrong-type', 7],
  ['extra-key', valid !== null && typeof valid === 'object' ? { ...(valid as object), extra: 1 } : { extra: 1 }],
  ['bad-day', { day: '2026-02-30', assetId: null, method: 'FIFO' }],
  ['complete-true', { lotMethod: 'FIFO', complete: true }],
  ['average', { lotMethod: 'AVERAGE' }],
];

const CALLERS: Array<[string, Scope[] | null, string]> = [
  ['anon', null, 'DE'],
  ['read', ['tax:read'], 'DE'],
  ['write', ['tax:read', 'tax:write'], 'DE'],
  ['write-US', ['tax:read', 'tax:write'], 'US'],
];

async function hit(app: Awaited<ReturnType<typeof serve>>, call: (typeof CALLS)[number], input: unknown, h: Record<string, string>) {
  const url = `/trpc/${call.path}${call.kind === 'query' && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`;
  const res =
    call.kind === 'query'
      ? await app.inject({ method: 'GET', url, headers: h })
      : await app.inject({
          method: 'POST',
          url,
          headers: { ...h, 'content-type': 'application/json' },
          payload: input === undefined ? '' : JSON.stringify(input),
        });
  // tRPC's dev stack trace carries file paths and line numbers, which move with any edit.
  return { status: res.statusCode, body: res.body.replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"') };
}

interface Golden {
  readonly callers: unknown;
  readonly answers: Record<string, { status: number; body: string }>;
}

async function replay(): Promise<Golden> {
  const answers: Golden['answers'] = {};
  for (const mapRaw of ['', '["DE"]']) {
    const app = await serve(mapRaw);
    try {
      for (const call of CALLS)
        for (const [inputName, input] of INPUTS(call.valid))
          for (const [callerName, scopes, region] of CALLERS) {
            answers[`${mapRaw || 'blank-map'} ${call.path} ${inputName} ${callerName}`] = await hit(
              app,
              call,
              input,
              headers(scopes, region),
            );
          }
    } finally {
      await app.close();
    }
  }
  return { callers: procedureCallers(createTaxRouter(tax('')) as never), answers };
}

describe('the wire replay: svc-tax answers as main did before its calls were mounted from records', () => {
  it('every request in the matrix gets the recorded status and body, byte for byte', async () => {
    const now = await replay();
    if (process.env.WIRE_REPLAY_WRITE === '1') writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden;
    expect(Object.keys(golden.answers)).toHaveLength(672);
    expect(now.callers).toEqual(golden.callers);
    const diffs = Object.entries(golden.answers)
      .filter(([key, was]) => now.answers[key]?.status !== was.status || now.answers[key]?.body !== was.body)
      .map(
        ([key, was]) =>
          `${key}: ${was.status} ${was.body.slice(0, 160)} != ${now.answers[key]?.status} ${now.answers[key]?.body.slice(0, 160)}`,
      );
    expect(diffs).toEqual([]);
  });
});

/** The rows replay's own valid inputs where the wire replay's name no lot that exists: here the one unknown lot does. */
const ROWS_VALID: Record<string, unknown> = {
  'basisOverride.set': { lotId: 'lot:tx-1:BTC', pricePerUnit: '1.5', date: '2026-01-01', sourceNote: 'n' },
  'basisOverride.remove': { lotId: 'lot:tx-1:BTC' },
};

interface RowsGolden {
  readonly answers: Record<string, { status: number; body: string; added?: string[]; removed?: string[] }>;
}

async function replayRows(db: TestDatabase): Promise<RowsGolden> {
  const answers: RowsGolden['answers'] = {};
  const app = await serve('["DE"]', db);
  try {
    for (const call of CALLS)
      for (const [inputName, input] of INPUTS(ROWS_VALID[call.path] ?? call.valid))
        for (const [callerName, scopes, region] of CALLERS) {
          const before = await storedRows(db.sql, db.schema);
          const answer = await hit(app, call, input, headers(scopes, region));
          const { added, removed } = rowsChange(before, await storedRows(db.sql, db.schema));
          answers[`${call.path} ${inputName} ${callerName}`] = {
            ...answer,
            ...(added.length ? { added } : {}),
            ...(removed.length ? { removed } : {}),
          };
        }
  } finally {
    await app.close();
  }
  return { answers };
}

const adminUrl = process.env.TEST_DATABASE_URL_TAX?.trim() || process.env.TEST_DATABASE_URL?.trim();
if (!adminUrl && (process.env.REQUIRE_POSTGRES === '1' || process.env.CI === 'true' || process.env.CI === '1')) {
  throw new Error('TEST_DATABASE_URL_TAX or TEST_DATABASE_URL is required');
}
const available = adminUrl ? await postgresAvailable(adminUrl) : false;
const migration = (file: string) => readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');

if (!available || !adminUrl) {
  describe.skip('the rows replay (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('the rows replay: svc-tax leaves the rows main left, after the same inputs', () => {
    let db: TestDatabase | undefined;
    afterAll(async () => {
      await db?.drop();
    });

    it('every request in the matrix gets the recorded answer and adds and removes the recorded rows', async () => {
      db = await createTestDatabase({
        url: adminUrl,
        service: 'tax',
        migrations: [
          '0000_basis_override.sql',
          '0001_basis_override_numeric.sql',
          '20261024110000_cost_basis_choices.sql',
          '20261024150000_pnl_settings.sql',
        ].map(migration),
      });
      const now = await replayRows(db);
      if (process.env.WIRE_REPLAY_WRITE === '1') writeFileSync(ROWS_GOLDEN, `${JSON.stringify(now, null, 2)}\n`);
      const golden = JSON.parse(readFileSync(ROWS_GOLDEN, 'utf8')) as RowsGolden;
      expect(Object.keys(golden.answers)).toHaveLength(336);
      // Some request must have written, or this replay compares nothing.
      expect(Object.values(golden.answers).some((a) => a.added?.length)).toBe(true);
      const shown = (a: RowsGolden['answers'][string] | undefined) =>
        a === undefined
          ? 'absent'
          : `${a.status} ${a.body.slice(0, 120)} +${JSON.stringify(a.added ?? [])} -${JSON.stringify(a.removed ?? [])}`;
      const diffs = Object.entries(golden.answers)
        .filter(([key, was]) => JSON.stringify(now.answers[key]) !== JSON.stringify(was))
        .map(([key, was]) => `${key}: ${shown(was)} != ${shown(now.answers[key])}`);
      expect(diffs).toEqual([]);
    });
  });
}
