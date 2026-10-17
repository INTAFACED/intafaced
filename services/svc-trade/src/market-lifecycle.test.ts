import { describe, expect, it } from 'vitest';
import { fakeMarket } from './public-rest.js';
import {
  marketLifecycleStateSchema,
  type AuthorityEvidence,
  type MarketAdmissionDossier,
  type MarketLifecycleState,
  type MarketTransitionRecord,
} from '@intafaced/exchange-contract';
import {
  MarketLifecycleAuthority,
  deriveMarketLifecycleSnapshot,
  decideMarketAction,
  lifecyclePublicationId,
  marketLifecyclePublicationSchema,
  SqlMarketLifecycleAuthority,
  SqlMarketLifecycleEvidenceStore,
  MarketLifecyclePublicationChainError,
} from './market-lifecycle.js';

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

function readyEvidence(marketId: string) {
  return {
    dossier: dossier(marketId),
    authority,
    readiness: { schedule: ready('schedule'), risk: ready('risk-live'), matching: ready('matching') },
  };
}

function publication(marketId: string) {
  return marketLifecyclePublicationSchema.parse({
    marketId,
    idempotencyKey: 'publish:1',
    causalPredecessorId: null,
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

function fakeSql(row: unknown) {
  return ((strings: TemplateStringsArray) =>
    strings.join('').includes('SELECT publication')
      ? Promise.resolve(row == null ? [] : [{ publication: row }])
      : Promise.resolve([])) as never;
}

function fakePublicationStoreSql() {
  let claimed = false;
  let publicationRow: unknown = null;
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('');
    if (query.includes('SELECT publication')) return Promise.resolve(publicationRow == null ? [] : [{ publication: publicationRow }]);
    if (query.includes('SELECT evidence_id')) return Promise.resolve([]);
    if (query.includes('INSERT INTO')) {
      if (claimed) return Promise.reject({ code: '23505' });
      claimed = true;
      publicationRow = JSON.parse(String(values[2]));
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as never;
}

function fakeHeadStoreSql(head: ReturnType<typeof publication>) {
  const headId = lifecyclePublicationId(head.marketId, head.idempotencyKey);
  return ((strings: TemplateStringsArray) => {
    const query = strings.join('');
    if (query.includes('SELECT publication') && !query.includes('SELECT evidence_id')) return Promise.resolve([]);
    if (query.includes('SELECT evidence_id')) return Promise.resolve([{ evidence_id: headId, publication: head }]);
    return Promise.resolve([]);
  }) as never;
}

describe('svc-trade PX-S01 lifecycle authority', () => {
  it('maps published readiness into OPEN and permits the same PLACE action the gate uses', () => {
    const market = fakeMarket({ id: 'market-1' });
    const snapshot = deriveMarketLifecycleSnapshot(market, {
      now: '2026-08-24T12:01:00.000Z',
      evidence: readyEvidence(market.id),
    });
    expect(snapshot.state).toBe('OPEN');
    expect(decideMarketAction(snapshot, 'PLACE').decision).toBe('ELIGIBLE');
    expect(snapshot.allowedActions).toContain('PLACE');
  });

  it('refuses missing authority and dossier instead of inventing OPEN', () => {
    const market = fakeMarket({ id: 'market-2' });
    expect(deriveMarketLifecycleSnapshot(market, { now: '2026-08-24T12:01:00.000Z' })).toMatchObject({
      state: 'REFUSED',
      reasonCode: 'trade.lifecycle_authority_unavailable',
    });
    expect(deriveMarketLifecycleSnapshot(market, { now: '2026-08-24T12:01:00.000Z', evidence: { authority } })).toMatchObject({
      state: 'REFUSED',
      reasonCode: 'trade.lifecycle_dossier_required',
    });
  });

  it('keeps unknown schedule and failed readiness as named sockets', () => {
    const market = fakeMarket({ id: 'market-3', schedule: 'unknown-schedule' as never });
    const unknown = deriveMarketLifecycleSnapshot(market, { now: '2026-08-24T12:01:00.000Z', evidence: readyEvidence(market.id) });
    expect(unknown.reasonCode).toBe('trade.unknown_schedule');
    expect(decideMarketAction(unknown, 'PLACE').decision).toBe('REFUSED');

    const failed = deriveMarketLifecycleSnapshot(market, {
      now: '2026-08-24T12:01:00.000Z',
      evidence: {
        ...readyEvidence(market.id),
        readiness: {
          schedule: ready('schedule'),
          risk: { status: 'SOCKET', socketId: 'risk.socket', reasonCode: 'risk.down', evidenceRefs: [] },
          matching: ready('matching'),
        },
      },
    });
    expect(failed.reasonCode).toBe('trade.lifecycle_readiness_socket');
  });

  it('halts new risk while retaining reduction actions', () => {
    const market = fakeMarket({ id: 'market-4', status: 'halted' });
    const snapshot = deriveMarketLifecycleSnapshot(market, { now: '2026-08-24T12:01:00.000Z', evidence: readyEvidence(market.id) });
    expect(snapshot.state).toBe('HALTED');
    expect(snapshot.allowedActions).toEqual(['CANCEL', 'REDUCE', 'CLOSE']);
    expect(decideMarketAction(snapshot, 'PLACE').decision).toBe('REFUSED');
    expect(decideMarketAction(snapshot, 'CANCEL').decision).toBe('ELIGIBLE');
  });

  it('does not collapse partial or unknown reopen outcomes to OPEN', () => {
    const market = fakeMarket({ id: 'market-5' });
    const base = {
      transitionId: 'transition:5',
      idempotencyKey: 'market:5:reopen',
      marketId: market.id,
      expectedState: 'HALTED' as const,
      expectedRuleVersion: 'rules:v1',
      requestedState: 'OPEN' as const,
      resolvedState: null,
      reasonCategory: 'TECHNICAL' as const,
      reasonCode: 'matching.reopen.unknown',
      actorId: 'actor',
      authorityRef: 'grant',
      approvalRefs: [],
      requestedAt: '2026-08-24T12:00:00.000Z',
      effectiveAt: null,
      expiresAt: null,
      recoveryEvidenceRefs: ['recovery-check'],
    };
    for (const outcome of [
      { outcome: 'PARTIAL' as const, appliedTargets: ['market'], unresolvedTargets: ['matching'] },
      { outcome: 'OUTCOME_UNKNOWN' as const, appliedTargets: [], unresolvedTargets: ['matching'] },
    ]) {
      const snapshot = deriveMarketLifecycleSnapshot(market, {
        now: '2026-08-24T12:01:00.000Z',
        evidence: { transition: { ...base, outcome } as MarketTransitionRecord },
      });
      expect(snapshot.state).toBe('HALTED');
      expect(snapshot.allowedActions).not.toContain('PLACE');
      expect(snapshot.reasonCode).toMatch(/^trade\.lifecycle_transition_/);
    }
  });

  it('shares one authoritative snapshot between projection and order admission', () => {
    const market = fakeMarket({ id: 'market-6' });
    const authorityPort = new MarketLifecycleAuthority(() => readyEvidence(market.id));
    const snapshot = authorityPort.snapshot(market, { now: '2026-08-24T12:01:00.000Z' });
    expect(authorityPort.admit(snapshot, 'PLACE')).toEqual(decideMarketAction(snapshot, 'PLACE'));
  });

  it('binds externally published evidence to versions, causality, and deterministic idempotency', () => {
    const market = fakeMarket({ id: 'market-published' });
    const publication = {
      marketId: market.id,
      idempotencyKey: 'publish:1',
      causalPredecessorId: null,
      authoritySubject: authority.actorId,
      authorityScope: 'market:market-published:place',
      ruleVersion: 'rules:v1',
      instrumentVersion: 'instrument:v1',
      observedAt: '2026-08-24T12:00:00.000Z',
      effectiveAt: '2026-08-24T12:00:00.000Z',
      expiresAt: '2026-08-24T12:05:00.000Z',
      authority,
      dossier: dossier(market.id),
    };
    expect(marketLifecyclePublicationSchema.parse(publication)).toEqual(publication);
    expect(lifecyclePublicationId(market.id, publication.idempotencyKey)).toBe(
      lifecyclePublicationId(market.id, publication.idempotencyKey),
    );
    expect(
      marketLifecyclePublicationSchema.safeParse({ ...publication, dossier: { ...publication.dossier, marketId: 'other' } }).success,
    ).toBe(false);
    expect(marketLifecyclePublicationSchema.safeParse({ ...publication, observedAt: 'not-a-time' }).success).toBe(false);
    expect(marketLifecyclePublicationSchema.safeParse({ ...publication, expiresAt: '2026-08-24T11:59:00.000Z' }).success).toBe(false);
  });

  it('loads one SQL publication and derives real matching readiness for admission', async () => {
    const market = fakeMarket({ id: 'market-sql-ready' });
    const matching = { listMarkets: async () => ({ markets: [market.id] }) } as never;
    const authorityPort = new SqlMarketLifecycleAuthority(fakeSql(publication(market.id)), matching, {
      spotEnabled: true,
      futuresEnabled: false,
    });
    const snapshot = await authorityPort.snapshot(market, { now: '2026-08-24T12:01:00.000Z' });
    expect(snapshot.state).toBe('OPEN');
    expect(snapshot.evidenceRefs).toContain(lifecyclePublicationId(market.id, 'publish:1'));
    expect(snapshot.evidenceRefs).not.toContain(null);
  });

  it('distinguishes missing and unreachable matching from a ready book', async () => {
    const market = fakeMarket({ id: 'market-sql-matching' });
    const missing = new SqlMarketLifecycleAuthority(
      fakeSql(publication(market.id)),
      { listMarkets: async () => ({ markets: [] }) } as never,
      { spotEnabled: true, futuresEnabled: false },
    );
    await expect(missing.snapshot(market, { now: '2026-08-24T12:01:00.000Z' })).resolves.toMatchObject({
      state: 'REFUSED',
      reasonCode: 'trade.matching_market_missing',
    });
    const unreachable = new SqlMarketLifecycleAuthority(
      fakeSql(publication(market.id)),
      {
        listMarkets: async () => {
          throw new Error('matching down');
        },
      } as never,
      { spotEnabled: true, futuresEnabled: false },
    );
    await expect(unreachable.snapshot(market, { now: '2026-08-24T12:01:00.000Z' })).resolves.toMatchObject({
      state: 'REFUSED',
      reasonCode: 'trade.matching_unavailable',
    });
  });

  it('keeps a version-mismatched publication refused', async () => {
    const market = fakeMarket({ id: 'market-sql-stale' });
    const stale = { ...publication(market.id), dossier: { ...publication(market.id).dossier, ruleVersion: 'rules:v2' } };
    const authorityPort = new SqlMarketLifecycleAuthority(
      fakeSql(stale),
      { listMarkets: async () => ({ markets: [market.id] }) } as never,
      { spotEnabled: true, futuresEnabled: false },
    );
    await expect(authorityPort.snapshot(market, { now: '2026-08-24T12:01:00.000Z' })).resolves.toMatchObject({
      state: 'REFUSED',
      reasonCode: 'trade.lifecycle_authority_unavailable',
    });
  });

  it('refuses an externally expired authorized publication without a local max-age assumption', async () => {
    const market = fakeMarket({ id: 'market-sql-expired' });
    const expired = { ...publication(market.id), expiresAt: '2026-08-24T12:00:30.000Z' };
    const authorityPort = new SqlMarketLifecycleAuthority(
      fakeSql(expired),
      { listMarkets: async () => ({ markets: [market.id] }) } as never,
      { spotEnabled: true, futuresEnabled: false },
    );
    await expect(authorityPort.snapshot(market, { now: '2026-08-24T12:01:00.000Z' })).resolves.toMatchObject({
      state: 'REFUSED',
      reasonCode: 'trade.lifecycle_authority_stale',
    });
  });

  it('atomically refuses concurrent genesis forks and keeps null genesis refs out of snapshots', async () => {
    const market = fakeMarket({ id: 'market-chain' });
    const store = new SqlMarketLifecycleEvidenceStore(fakePublicationStoreSql());
    const first = publication(market.id);
    const fork = { ...first, idempotencyKey: 'publish:fork' };
    const results = await Promise.allSettled([store.publish(first), store.publish(fork)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.any(MarketLifecyclePublicationChainError),
    });
  });

  it('refuses a valid successor whose observed/effective timestamps regress before the head', async () => {
    const market = fakeMarket({ id: 'market-temporal-chain' });
    const head = publication(market.id);
    const child = {
      ...head,
      idempotencyKey: 'publish:child',
      causalPredecessorId: lifecyclePublicationId(market.id, head.idempotencyKey),
      observedAt: '2026-08-24T11:59:00.000Z',
      effectiveAt: '2026-08-24T11:59:00.000Z',
      expiresAt: '2026-08-24T12:05:00.000Z',
      authority: { ...head.authority, decidedAt: '2026-08-24T11:00:00.000Z', freshnessAt: '2026-08-24T11:00:00.000Z' },
      dossier: { ...head.dossier, approvedAt: '2026-08-24T11:00:00.000Z' },
    };
    const store = new SqlMarketLifecycleEvidenceStore(fakeHeadStoreSql(head));
    await expect(store.publish(child)).rejects.toMatchObject({ code: 'trade.lifecycle_publication_chain_conflict' });
  });
});

describe('svc-trade lifecycle evidence SQL (postgres.js jsonb binding)', () => {
  it('binds pre-serialised JSON through ::text::jsonb so the driver cannot store it as a JSON string', async () => {
    const queries: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      queries.push(strings.join('?'));
      return Promise.resolve([]);
    }) as never;
    const store = new SqlMarketLifecycleEvidenceStore(sql);
    // The read-back finds nothing in this stub, so publish refuses after the insert; the insert is what is asserted.
    await store.publish(publication('market-jsonb')).catch(() => undefined);
    await store.appendCorrection({
      correctionId: 'c-1',
      originalRecordId: 'o-1',
      causalPredecessorId: 'p-1',
      reasonCode: 'r',
      authorityRef: 'a',
      correctedAt: '2026-08-24T12:00:00.000Z',
      valueImpact: 'NONE',
      ledgerTransactionId: null,
    });
    await store.appendTransition({
      transitionId: 'transition:jsonb',
      idempotencyKey: 'market-jsonb:halt',
      marketId: 'market-jsonb',
      expectedState: 'OPEN',
      expectedRuleVersion: 'rules:v1',
      requestedState: 'HALTED',
      resolvedState: 'HALTED',
      reasonCategory: 'TECHNICAL',
      reasonCode: 'matching.halt',
      actorId: 'actor',
      authorityRef: 'grant',
      approvalRefs: [],
      requestedAt: '2026-08-24T12:00:00.000Z',
      effectiveAt: '2026-08-24T12:00:00.000Z',
      expiresAt: null,
      recoveryEvidenceRefs: [],
      outcome: { outcome: 'APPLIED', appliedTargets: ['market'], unresolvedTargets: [] },
    } as MarketTransitionRecord);
    const inserts = queries.filter((q) => q.includes('INSERT INTO trade.market_lifecycle_evidence'));
    expect(inserts).toHaveLength(3);
    expect(inserts.some((q) => q.includes("'TRANSITION'"))).toBe(true);
    for (const q of inserts) {
      expect(q).toContain('::text::jsonb');
      expect(q).not.toMatch(/\?::jsonb/);
    }
  });
});

function appliedTransition(marketId: string, state: MarketLifecycleState): MarketTransitionRecord {
  return {
    transitionId: `transition:${marketId}:${state}`,
    idempotencyKey: `${marketId}:${state}`,
    marketId,
    expectedState: 'OPEN',
    expectedRuleVersion: 'rules:v1',
    requestedState: state,
    resolvedState: state,
    reasonCategory: 'TECHNICAL',
    reasonCode: `trade.market_${state.toLowerCase()}`,
    actorId: 'actor-secret',
    authorityRef: 'grant',
    approvalRefs: [],
    requestedAt: '2026-08-24T12:00:00.000Z',
    effectiveAt: '2026-08-24T12:00:00.000Z',
    expiresAt: null,
    recoveryEvidenceRefs: [],
    outcome: { outcome: 'APPLIED', appliedTargets: ['market'], unresolvedTargets: [] },
  };
}

describe('named lifecycle state is the stored transition, not open-or-not', () => {
  it('keeps every applied state on an active listing and leaves the actor off the snapshot', () => {
    for (const state of marketLifecycleStateSchema.options) {
      const market = fakeMarket({ id: `market-${state}`, status: 'active' });
      const snapshot = deriveMarketLifecycleSnapshot(market, {
        now: '2026-08-24T12:01:00.000Z',
        evidence: { ...readyEvidence(market.id), transition: appliedTransition(market.id, state) },
      });
      expect(snapshot.state).toBe(state);
      expect(snapshot).not.toHaveProperty('actorId');
      expect(snapshot).not.toHaveProperty('operator');
      expect(snapshot).not.toHaveProperty('note');
      expect(JSON.stringify(snapshot)).not.toContain('actor-secret');
      if (state !== 'OPEN') expect(snapshot.reasonCode).toBe(`trade.market_${state.toLowerCase()}`);
    }
  });

  it('lets a listing halt win over a stored OPEN', () => {
    const market = fakeMarket({ id: 'market-halt-wins', status: 'halted' });
    const snapshot = deriveMarketLifecycleSnapshot(market, {
      now: '2026-08-24T12:01:00.000Z',
      evidence: { ...readyEvidence(market.id), transition: appliedTransition(market.id, 'OPEN') },
    });
    expect(snapshot.state).toBe('HALTED');
  });

  it('loads the stored transition through the SQL authority', async () => {
    const market = fakeMarket({ id: 'market-sql-post-only' });
    const transition = appliedTransition(market.id, 'POST_ONLY');
    const sql = ((strings: TemplateStringsArray) => {
      const query = strings.join('');
      if (query.includes('SELECT transition')) return Promise.resolve([{ transition }]);
      if (query.includes('SELECT publication')) return Promise.resolve([{ publication: publication(market.id) }]);
      return Promise.resolve([]);
    }) as never;
    const authorityPort = new SqlMarketLifecycleAuthority(sql, { listMarkets: async () => ({ markets: [market.id] }) } as never, {
      spotEnabled: true,
      futuresEnabled: false,
    });
    const snapshot = await authorityPort.snapshot(market, { now: '2026-08-24T12:01:00.000Z' });
    expect(snapshot.state).toBe('POST_ONLY');
    expect(snapshot.reasonCode).toBe('trade.market_post_only');
    expect(JSON.stringify(snapshot)).not.toContain('actor-secret');
  });
});
