import Fastify from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import type { AuthorityEvidence, MarketAdmissionDossier } from '@intafaced/exchange-contract';
import { describe, expect, it } from 'vitest';
import { fakeMarket } from './public-rest.js';
import {
  MarketLifecycleLocalTestFixtureError,
  SqlMarketLifecycleAuthority,
  SqlMarketLifecycleEvidenceStore,
  assertNoLocalTestLifecycleRows,
  lifecycleLocalTestMarkerFields,
  marketLifecyclePublicationSchema,
} from './market-lifecycle.js';
import { registerMarketLifecycleRoutes } from './market-lifecycle-routes.js';

type Env = Record<string, string | undefined>;

/** [label, APP_ENV, stand-ins allowed?]. Unset and empty count as NOT dev. */
const ENV_MATRIX: ReadonlyArray<readonly [string, string | undefined, boolean]> = [
  ['dev', 'dev', true],
  ['test', 'test', true],
  ['staging', 'staging', false],
  ['prod', 'prod', false],
  ['unset', undefined, false],
  ['empty', '', false],
];
const envOf = (appEnv: string | undefined): Env => (appEnv === undefined ? {} : { APP_ENV: appEnv });

const ready = (ref: string) => ({ status: 'READY' as const, evidenceRefs: [ref] });
const NOW = '2026-08-24T12:01:00.000Z';

function dossier(marketId: string, dossierId = `dossier:${marketId}`): MarketAdmissionDossier {
  return {
    dossierId,
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

function authority(actorId = 'actor', grantId = 'grant'): AuthorityEvidence {
  return {
    decision: 'AUTHORIZED',
    reasonCode: null,
    legalOwnerId: 'owner',
    accountId: 'account',
    subAccountId: 'subaccount',
    actorId,
    origin: 'OPERATOR',
    sessionId: 'session',
    credentialId: null,
    grantId,
    grantVersion: 'grant:v1',
    mandateId: 'mandate',
    decidedAt: '2026-08-24T12:00:00.000Z',
    freshnessAt: '2026-08-24T12:00:00.000Z',
  };
}

function publication(marketId: string, marker: 'none' | 'actorId' | 'grantId' | 'dossierId') {
  const a = authority(marker === 'actorId' ? 'local-test:operator' : 'actor', marker === 'grantId' ? 'local-test:grant' : 'grant');
  return marketLifecyclePublicationSchema.parse({
    marketId,
    idempotencyKey: 'publish:1',
    causalPredecessorId: null,
    authoritySubject: a.actorId,
    authorityScope: `market:${marketId}:place`,
    ruleVersion: 'rules:v1',
    instrumentVersion: 'instrument:v1',
    observedAt: '2026-08-24T12:00:00.000Z',
    effectiveAt: '2026-08-24T12:00:00.000Z',
    expiresAt: '2026-08-24T12:05:00.000Z',
    authority: a,
    dossier: dossier(marketId, marker === 'dossierId' ? 'local-test:dossier-1' : `dossier:${marketId}`),
  });
}

const MARKERS = ['actorId', 'grantId', 'dossierId'] as const;

/** Records every query; serves `row` for SELECT publication and nothing else. */
function recordingSql(row: unknown = null) {
  const calls: string[] = [];
  const fn = ((strings: TemplateStringsArray) => {
    const q = strings.join('');
    calls.push(q);
    if (q.includes('SELECT publication')) return Promise.resolve(row == null ? [] : [{ publication: row }]);
    return Promise.resolve([]);
  }) as never;
  return { sql: fn, calls };
}

/** Accepting store SQL: first publish succeeds and reads back. */
function acceptingSql() {
  const calls: string[] = [];
  let stored: unknown = null;
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('');
    calls.push(q);
    if (q.includes('SELECT publication')) return Promise.resolve(stored == null ? [] : [{ publication: stored }]);
    if (q.includes('SELECT evidence_id')) return Promise.resolve([]);
    if (q.includes('INSERT INTO')) {
      stored = JSON.parse(String(values[2]));
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as never;
  return { sql: fn, calls };
}

const matching = (id: string) => ({ listMarkets: async () => ({ markets: [id] }) }) as never;

describe('lifecycleLocalTestMarkerFields', () => {
  it('finds each marked field and nothing on a clean record', () => {
    expect(lifecycleLocalTestMarkerFields(publication('m', 'none'))).toEqual([]);
    expect(lifecycleLocalTestMarkerFields(publication('m', 'actorId'))).toEqual(['authority.actorId']);
    expect(lifecycleLocalTestMarkerFields(publication('m', 'grantId'))).toEqual(['authority.grantId']);
    expect(lifecycleLocalTestMarkerFields(publication('m', 'dossierId'))).toEqual(['dossier.dossierId']);
  });
});

describe.each(ENV_MATRIX)('lifecycle local-test guard under APP_ENV=%s', (_label, appEnv, allowed) => {
  const env = envOf(appEnv);

  it.each(MARKERS)('publish with a local-test: %s', async (marker) => {
    const { sql, calls } = acceptingSql();
    const store = new SqlMarketLifecycleEvidenceStore(sql, { env });
    const attempt = store.publish(publication('market-1', marker));
    if (allowed) {
      await expect(attempt).resolves.toMatchObject({ marketId: 'market-1' });
      expect(calls.some((q) => q.includes('INSERT INTO'))).toBe(true);
    } else {
      await expect(attempt).rejects.toBeInstanceOf(MarketLifecycleLocalTestFixtureError);
      expect(calls).toEqual([]); // nothing read, nothing written
    }
  });

  it('publish of a clean record is accepted in every env', async () => {
    const { sql } = acceptingSql();
    const store = new SqlMarketLifecycleEvidenceStore(sql, { env });
    await expect(store.publish(publication('market-1', 'none'))).resolves.toMatchObject({ marketId: 'market-1' });
  });

  it.each(MARKERS)('order gate reading a local-test: %s', async (marker) => {
    const market = fakeMarket({ id: 'market-1' });
    const { sql } = recordingSql(publication(market.id, marker));
    const port = new SqlMarketLifecycleAuthority(sql, matching(market.id), { spotEnabled: true, futuresEnabled: false, env });
    const snapshot = await port.snapshot(market, { now: NOW });
    if (allowed) {
      expect(snapshot.state).toBe('OPEN');
      expect(port.admit(snapshot, 'PLACE').decision).toBe('ELIGIBLE');
    } else {
      expect(snapshot).toMatchObject({ state: 'REFUSED', reasonCode: 'trade.lifecycle_authority_unavailable' });
      expect(port.admit(snapshot, 'PLACE').decision).toBe('REFUSED');
    }
  });

  it('order gate reading a clean record is OPEN in every env', async () => {
    const market = fakeMarket({ id: 'market-1' });
    const { sql } = recordingSql(publication(market.id, 'none'));
    const port = new SqlMarketLifecycleAuthority(sql, matching(market.id), { spotEnabled: true, futuresEnabled: false, env });
    await expect(port.snapshot(market, { now: NOW })).resolves.toMatchObject({ state: 'OPEN' });
  });

  it('store readLatest hides a marked record outside dev/test', async () => {
    const { sql } = recordingSql(publication('market-1', 'actorId'));
    const store = new SqlMarketLifecycleEvidenceStore(sql, { env });
    const read = await store.readLatest('market-1');
    if (allowed) expect(read).not.toBeNull();
    else expect(read).toBeNull();
  });

  it('boot guard: marked rows stored', async () => {
    const calls: unknown[][] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push([strings.join(''), ...values]);
      return Promise.resolve([{ evidence_id: 'trade.lifecycle.publication:abc' }]);
    }) as never;
    const attempt = assertNoLocalTestLifecycleRows(sql, env);
    if (allowed) {
      await expect(attempt).resolves.toBeUndefined();
      expect(calls).toEqual([]); // dev/test does not even look
    } else {
      await expect(attempt).rejects.toThrow(/refuses to start.*local-test:/);
      expect(calls[0]).toContain('local-test:%');
    }
  });

  it('boot guard: no marked rows is clean in every env', async () => {
    const sql = (() => Promise.resolve([])) as never;
    await expect(assertNoLocalTestLifecycleRows(sql, env)).resolves.toBeUndefined();
  });
});

describe('lifecycle publish route', () => {
  const SECRET = 'lifecycle-route-secret-32-characters';
  const post = async (appEnv: string | undefined, body: unknown) => {
    const { sql, calls } = acceptingSql();
    const app = Fastify();
    registerMarketLifecycleRoutes(app, {
      internalSecret: SECRET,
      store: new SqlMarketLifecycleEvidenceStore(sql, { env: envOf(appEnv) }),
    });
    const payload = JSON.stringify(body);
    const response = await app.inject({
      method: 'POST',
      url: '/internal/market-lifecycle',
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-authority', SECRET, payload) },
      payload,
    });
    return { response, calls };
  };

  it.each(ENV_MATRIX)('APP_ENV=%s: marked publication -> 409 and nothing written unless dev/test', async (_label, appEnv, allowed) => {
    const { response, calls } = await post(appEnv, publication('market-1', 'actorId'));
    if (allowed) {
      expect(response.statusCode).toBe(200);
    } else {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'trade.lifecycle_local_test_fixture_refused' });
      expect(calls).toEqual([]);
    }
  });

  it('clean publication is accepted when APP_ENV is prod', async () => {
    const { response } = await post('prod', publication('market-1', 'none'));
    expect(response.statusCode).toBe(200);
  });
});
