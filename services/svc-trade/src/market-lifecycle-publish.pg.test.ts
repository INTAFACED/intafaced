/**
 * A lifecycle publication on real Postgres (TEST_DATABASE_URL): the same publication sent many times at once stores
 * one row and every call gets it back; a different publication racing for the same place in the chain still
 * refuses as a fork.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { AuthorityEvidence, MarketAdmissionDossier } from '@intafaced/exchange-contract';
import {
  lifecyclePublicationId,
  marketLifecyclePublicationSchema,
  MarketLifecyclePublicationChainError,
  SqlMarketLifecycleEvidenceStore,
  type MarketLifecyclePublication,
} from './market-lifecycle.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The lifecycle publication Postgres test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const ready = (ref: string) => ({ status: 'READY' as const, evidenceRefs: [ref] });

function dossier(marketId: string): MarketAdmissionDossier {
  return {
    dossierId: `dossier:${marketId}`,
    marketId,
    ruleVersion: 'rules:v1',
    instrumentVersion: 'instrument:v1',
    legalEntityAndJurisdiction: ready('legal'),
    counterpartyRole: ready('counterparty'),
    deterministicSettlement: ready('settlement'),
    custodyAndTransferSupport: ready('custody'),
    oracleIndexAndDisruption: ready('oracle'),
    liquidityAndMarketQuality: ready('liquidity'),
    surveillanceAndRetention: ready('surveillance'),
    riskAndLimits: ready('risk'),
    operationsAndIncidentOwner: ready('operations'),
    windDownAndResiduals: ready('winddown'),
    approvedAt: '2026-08-24T12:00:00.000Z',
    approvalRefs: ['approval'],
  };
}

const authority: AuthorityEvidence = {
  decision: 'AUTHORIZED',
  reasonCode: null,
  legalOwnerId: 'owner',
  accountId: 'account',
  subAccountId: 'subaccount',
  actorId: 'actor',
  origin: 'OPERATOR',
  sessionId: 'session',
  credentialId: null,
  grantId: 'grant',
  grantVersion: 'grant:v1',
  mandateId: 'mandate',
  decidedAt: '2026-08-24T12:00:00.000Z',
  freshnessAt: '2026-08-24T12:00:00.000Z',
};

function publication(marketId: string, idempotencyKey: string, causalPredecessorId: string | null): MarketLifecyclePublication {
  return marketLifecyclePublicationSchema.parse({
    marketId,
    idempotencyKey,
    causalPredecessorId,
    authoritySubject: authority.actorId,
    authorityScope: `market:${marketId}:place`,
    ruleVersion: 'rules:v1',
    instrumentVersion: 'instrument:v1',
    observedAt: '2026-08-24T12:00:00.000Z',
    effectiveAt: '2026-08-24T12:00:00.000Z',
    expiresAt: '2026-08-24T12:05:00.000Z',
    authority,
    dossier: dossier(marketId),
  });
}

async function listMarket(sql: TestDatabase['sql'], id: string): Promise<void> {
  await sql`
    INSERT INTO trade.markets (id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
      maker_bps, taker_bps, status, display_name, listed_at)
    VALUES (${id}, ${`TEST${id.slice(-4)}/USDT`}, ${`TEST${id.slice(-4)}`}, 'USDT', 'spot', '0.01', '0.0001', '0.0001', '1',
      10, 20, 'active', 'TEST market', now())
  `;
}

const rejections = (all: PromiseSettledResult<unknown>[]) =>
  all.filter((x): x is PromiseRejectedResult => x.status === 'rejected').map((x) => x.reason as unknown);

describe('lifecycle publications on Postgres', () => {
  let db: TestDatabase | undefined;
  let store: SqlMarketLifecycleEvidenceStore;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
    store = new SqlMarketLifecycleEvidenceStore(db.sql);
  }, 120_000);
  beforeEach(async () => {
    await db!.sql`TRUNCATE trade.market_lifecycle_evidence, trade.markets RESTART IDENTITY CASCADE`;
  });
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('the same publication sent many times at once stores one row and every call gets it back (#8879)', async () => {
    for (let round = 0; round < 25; round++) {
      const market = `b8790000-0000-4000-8000-${String(round).padStart(12, '0')}`;
      await listMarket(db!.sql, market);
      // Genesis: the race lands on genesis_unique or reconciliation_idx as well as the primary key.
      const genesis = publication(market, 'publish:1', null);
      const first = await Promise.allSettled(Array.from({ length: 8 }, () => store.publish(genesis)));
      expect(rejections(first).map(String)).toEqual([]);
      for (const x of first) expect((x as PromiseFulfilledResult<MarketLifecyclePublication>).value).toEqual(genesis);

      // A child of that genesis: the race lands on predecessor_unique too.
      const child = publication(market, 'publish:2', lifecyclePublicationId(market, 'publish:1'));
      const second = await Promise.allSettled(Array.from({ length: 8 }, () => store.publish(child)));
      expect(rejections(second).map(String)).toEqual([]);
      for (const x of second) expect((x as PromiseFulfilledResult<MarketLifecyclePublication>).value).toEqual(child);

      const [count] = await db!.sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM trade.market_lifecycle_evidence WHERE market_id = ${market}`;
      expect(count?.n).toBe(2);
    }
  }, 120_000);

  it('two different publications racing for the same place in the chain store one and refuse the other as a fork', async () => {
    for (let round = 0; round < 10; round++) {
      const market = `b8791111-0000-4000-8000-${String(round).padStart(12, '0')}`;
      await listMarket(db!.sql, market);
      const all = await Promise.allSettled([
        store.publish(publication(market, 'publish:a', null)),
        store.publish(publication(market, 'publish:b', null)),
      ]);
      const refused = rejections(all);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toBeInstanceOf(MarketLifecyclePublicationChainError);
      const [count] = await db!.sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM trade.market_lifecycle_evidence WHERE market_id = ${market}`;
      expect(count?.n).toBe(1);
    }
  }, 120_000);
});
