import { describe, expect, it } from 'vitest';
import {
  decideMarketAdmission,
  marketAdmissionDossierSchema,
  marketStateSnapshotSchema,
  marketTransitionRecordSchema,
  type MarketAdmissionDossier,
} from './market-lifecycle.js';

const ready = (evidence: string) => ({ status: 'READY' as const, evidenceRefs: [evidence] });

function dossier(overrides: Partial<MarketAdmissionDossier> = {}): MarketAdmissionDossier {
  return {
    dossierId: 'dossier-1',
    marketId: 'market-1',
    ruleVersion: 'rule-1',
    instrumentVersion: 'instrument-1',
    legalEntityAndJurisdiction: ready('legal-review-1'),
    counterpartyRole: ready('role-decision-1'),
    deterministicSettlement: ready('settlement-proof-1'),
    custodyAndTransferSupport: ready('custody-proof-1'),
    oracleIndexAndDisruption: ready('oracle-constitution-1'),
    liquidityAndMarketQuality: ready('liquidity-review-1'),
    surveillanceAndRetention: ready('surveillance-review-1'),
    riskAndLimits: ready('risk-review-1'),
    operationsAndIncidentOwner: ready('operations-owner-1'),
    windDownAndResiduals: ready('wind-down-plan-1'),
    approvedAt: '2026-08-24T12:00:00.000Z',
    approvalRefs: ['approval-1'],
    ...overrides,
  };
}

describe('market lifecycle contract', () => {
  it('admits only a dossier with evidence for every mandatory family', () => {
    const input = marketAdmissionDossierSchema.parse(dossier());
    expect(decideMarketAdmission(input, '2026-08-24T12:01:00.000Z')).toEqual({
      decision: 'ELIGIBLE',
      dossierId: 'dossier-1',
      checkedAt: '2026-08-24T12:01:00.000Z',
      blockingSockets: [],
    });
  });

  it('returns every named blocking socket instead of inventing readiness', () => {
    const input = dossier({
      legalEntityAndJurisdiction: { status: 'SOCKET', socketId: 'owner.jurisdiction', reasonCode: 'owner.blank', evidenceRefs: [] },
      riskAndLimits: { status: 'SOCKET', socketId: 'owner.risk-limits', reasonCode: 'owner.blank', evidenceRefs: [] },
    });
    expect(decideMarketAdmission(input, '2026-08-24T12:01:00.000Z')).toMatchObject({
      decision: 'REFUSED',
      blockingSockets: ['owner.jurisdiction', 'owner.risk-limits'],
    });
  });

  it('refuses risk-increasing actions in halted, cancel-only, and terminal states', () => {
    const base = {
      marketId: 'market-1',
      ruleVersion: 'rule-1',
      instrumentId: 'BTC-USDT',
      instrumentVersion: 'instrument-1',
      reasonCategory: 'TECHNICAL' as const,
      reasonCode: 'matching.writer_unavailable',
      effectiveAt: '2026-08-24T12:00:00.000Z',
      observedAt: '2026-08-24T12:00:01.000Z',
      lastGoodState: 'OPEN' as const,
      transitionId: 'transition-1',
      evidenceRefs: ['incident-1'],
    };
    expect(marketStateSnapshotSchema.safeParse({ ...base, state: 'HALTED', allowedActions: ['PLACE', 'CANCEL'] }).success).toBe(false);
    expect(marketStateSnapshotSchema.safeParse({ ...base, state: 'HALTED', allowedActions: ['CANCEL', 'REDUCE'] }).success).toBe(true);
    expect(marketStateSnapshotSchema.safeParse({ ...base, state: 'CANCEL_ONLY', allowedActions: ['REDUCE'] }).success).toBe(false);
    expect(marketStateSnapshotSchema.safeParse({ ...base, state: 'ARCHIVED', allowedActions: ['CANCEL'] }).success).toBe(false);
    expect(marketStateSnapshotSchema.safeParse({ ...base, state: 'PRELAUNCH', allowedActions: ['CANCEL'] }).success).toBe(true);
    expect(marketStateSnapshotSchema.safeParse({ ...base, state: 'PRELAUNCH', allowedActions: ['PLACE'] }).success).toBe(false);
    expect(marketStateSnapshotSchema.safeParse({ ...base, state: 'PRELAUNCH', allowedActions: ['CANCEL', 'PLACE'] }).success).toBe(false);
  });

  it('refuses ordinary PLACE while the market is in auction', () => {
    const base = {
      marketId: 'market-1',
      ruleVersion: 'rule-1',
      instrumentId: 'BTC-USDT',
      instrumentVersion: 'instrument-1',
      reasonCategory: 'NORMAL' as const,
      reasonCode: 'trade.lifecycle.auction',
      effectiveAt: '2026-08-24T12:00:00.000Z',
      observedAt: '2026-08-24T12:00:01.000Z',
      lastGoodState: 'PRELAUNCH' as const,
      transitionId: 'transition-auction-1',
      evidenceRefs: ['auction-window-1'],
    };
    const livePlace = marketStateSnapshotSchema.safeParse({ ...base, state: 'AUCTION', allowedActions: ['PLACE'] });
    expect(livePlace.success).toBe(false);
    if (!livePlace.success) expect(livePlace.error.issues[0]?.message).toMatch(/permits no trading action/);
    expect(marketStateSnapshotSchema.safeParse({ ...base, state: 'AUCTION', allowedActions: ['PLACE_POST_ONLY'] }).success).toBe(false);
    expect(marketStateSnapshotSchema.safeParse({ ...base, state: 'AUCTION', allowedActions: ['CANCEL'] }).success).toBe(false);
    expect(marketStateSnapshotSchema.safeParse({ ...base, state: 'AUCTION', allowedActions: [] }).success).toBe(true);
  });

  it('requires recovery evidence before reopening a halted market', () => {
    const transition = {
      transitionId: 'transition-2',
      idempotencyKey: 'market:market-1:reopen:incident-1',
      marketId: 'market-1',
      expectedState: 'HALTED' as const,
      expectedRuleVersion: 'rule-1',
      requestedState: 'AUCTION' as const,
      resolvedState: 'AUCTION' as const,
      reasonCategory: 'TECHNICAL' as const,
      reasonCode: 'incident.recovered',
      actorId: 'operator-1',
      authorityRef: 'grant-1',
      approvalRefs: ['approval-1'],
      requestedAt: '2026-08-24T12:10:00.000Z',
      effectiveAt: '2026-08-24T12:11:00.000Z',
      expiresAt: null,
      recoveryEvidenceRefs: [],
      outcome: { outcome: 'APPLIED' as const, appliedTargets: ['market-1'], unresolvedTargets: [] as [] },
    };
    expect(marketTransitionRecordSchema.safeParse(transition).success).toBe(false);
    expect(marketTransitionRecordSchema.safeParse({ ...transition, recoveryEvidenceRefs: ['restore-check-1'] }).success).toBe(true);
  });

  it('refuses AUCTION to OPEN without uncross evidence rather than inventing a price', () => {
    const transition = {
      transitionId: 'transition-uncross-1',
      idempotencyKey: 'market:market-1:uncross:window-1',
      marketId: 'market-1',
      expectedState: 'AUCTION' as const,
      expectedRuleVersion: 'rule-1',
      requestedState: 'OPEN' as const,
      resolvedState: 'OPEN' as const,
      reasonCategory: 'NORMAL' as const,
      reasonCode: 'auction.uncrossed',
      actorId: 'operator-1',
      authorityRef: 'grant-1',
      approvalRefs: ['approval-1'],
      requestedAt: '2026-08-24T12:10:00.000Z',
      effectiveAt: '2026-08-24T12:11:00.000Z',
      expiresAt: null,
      recoveryEvidenceRefs: [],
      outcome: { outcome: 'APPLIED' as const, appliedTargets: ['market-1'], unresolvedTargets: [] as [] },
    };
    const invented = marketTransitionRecordSchema.safeParse(transition);
    expect(invented.success).toBe(false);
    if (!invented.success) expect(invented.error.issues[0]?.message).toMatch(/uncross evidence/);
    expect(marketTransitionRecordSchema.safeParse({ ...transition, recoveryEvidenceRefs: ['uncross-proof-1'] }).success).toBe(true);
    expect(
      marketTransitionRecordSchema.safeParse({
        ...transition,
        resolvedState: 'AUCTION',
        effectiveAt: null,
        recoveryEvidenceRefs: [],
        outcome: { outcome: 'REFUSED' as const, appliedTargets: [] as [], unresolvedTargets: ['uncross-policy-1'] },
      }).success,
    ).toBe(true);
  });

  it('keeps partial and unknown transition results on the previous state', () => {
    const base = {
      transitionId: 'transition-3',
      idempotencyKey: 'market:market-1:halt:incident-2',
      marketId: 'market-1',
      expectedState: 'OPEN' as const,
      expectedRuleVersion: 'rule-1',
      requestedState: 'HALTED' as const,
      reasonCategory: 'SECURITY' as const,
      reasonCode: 'security.active_incident',
      actorId: 'operator-1',
      authorityRef: 'grant-1',
      approvalRefs: [],
      requestedAt: '2026-08-24T12:10:00.000Z',
      effectiveAt: null,
      expiresAt: null,
      recoveryEvidenceRefs: [],
      outcome: { outcome: 'OUTCOME_UNKNOWN' as const, appliedTargets: [], unresolvedTargets: ['matching-runtime-1'] },
    };
    expect(marketTransitionRecordSchema.safeParse({ ...base, resolvedState: 'HALTED' }).success).toBe(false);
    expect(marketTransitionRecordSchema.safeParse({ ...base, resolvedState: null }).success).toBe(true);
  });
});
