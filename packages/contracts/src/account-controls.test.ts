import { describe, expect, it } from 'vitest';
import {
  accountControlInputSchema,
  accountControlHistoryInputSchema,
  accountControlLookupInputSchema,
  accountControlResultSchema,
  accountOperatorEntitlementSchema,
  currentAuthorityInputSchema,
  currentAuthorityResultSchema,
  operationAdmissionInputSchema,
  operationAdmissionResultSchema,
  committedOperationAdmissionSchema,
  operationRecoveryInputSchema,
  recoveryMatchesAdmission,
} from './account-controls.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';
const MERCHANT = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-10-10T12:00:00.000Z';
const HASH = `sha256:${'a'.repeat(64)}`;
const target = { area: 'trading', userId: USER } as const;
const command = { requestId: KEY, target, action: 'restrict', reason: 'Incident review', expectedVersion: '4' };
const changed = {
  auditId: KEY,
  requestId: KEY,
  target,
  action: 'restrict',
  reason: 'Incident review',
  occurredAt: NOW,
  actorUserId: OTHER,
  outcome: 'changed',
  changed: true,
  before: { target, version: '4', restricted: false },
  after: { target, version: '5', restricted: true },
};
const subject = { userId: USER, credential: { kind: 'session', sessionId: KEY } };
const eligible = {
  status: 'eligible',
  subject,
  checkedAt: NOW,
  account: { userId: USER, status: 'active', kycTier: 'full' },
  credential: { kind: 'session', ownership: { id: KEY, userId: USER, revoked: false } },
  subAccount: null,
  version: '5',
  leaseExpiresAt: '2026-10-10T12:00:05.000Z',
};
const admissionInput = {
  operation: { service: 'svc-pay', kind: 'payout', userId: USER, merchantId: MERCHANT },
  businessId: 'payout:settlement-1:attempt-0',
  payloadHash: HASH,
};
const admission = {
  ...admissionInput,
  status: 'committed',
  admissionId: KEY,
  admittedAt: NOW,
  identityVersion: '5',
  restrictionVersion: '7',
};
const recovery = { ...admissionInput, admissionId: KEY };

describe('founder account-control wire boundary', () => {
  it('accepts separate user controls and merchant controls without requiring a second founder', () => {
    expect(accountControlInputSchema.parse(command).target).toEqual(target);
    expect(accountControlInputSchema.parse({ ...command, target: { area: 'identity', userId: USER } }).target.area).toBe('identity');
    expect(accountControlInputSchema.parse({ ...command, target: { area: 'merchant', merchantId: MERCHANT } }).target.area).toBe(
      'merchant',
    );
    expect(accountControlInputSchema.parse({ ...command, action: 'restore' }).action).toBe('restore');
  });

  it.each(['actorUserId', 'actor', 'mfa', 'founder', 'confirmOperatorId', 'approvalId', 'recoveryAllowed'])(
    'rejects caller-supplied %s authority',
    (field) => expect(accountControlInputSchema.safeParse({ ...command, [field]: OTHER }).success).toBe(false),
  );

  it('rejects wrong target fields and malformed concurrency inputs', () => {
    for (const candidate of [
      { ...command, target: { area: 'merchant', userId: USER } },
      { ...command, target: { ...target, merchantId: MERCHANT } },
      { ...command, target: { area: 'platform', userId: USER } },
      { ...command, reason: '  ' },
      { ...command, expectedVersion: 4 },
      { ...command, expectedVersion: '-1' },
      { ...command, expectedVersion: '04' },
      { ...command, requestId: 'not-an-id' },
    ])
      expect(accountControlInputSchema.safeParse(candidate).success).toBe(false);
  });

  it('requires state, target, action and versions to agree with a successful outcome', () => {
    expect(accountControlResultSchema.parse(changed).outcome).toBe('changed');
    for (const candidate of [
      { ...changed, changed: false },
      { ...changed, action: 'restore' },
      { ...changed, after: { ...changed.after, version: '4' } },
      { ...changed, after: { ...changed.after, version: '6' } },
      { ...changed, after: { ...changed.after, target: { area: 'trading', userId: OTHER } } },
      { ...changed, before: changed.after },
    ])
      expect(accountControlResultSchema.safeParse(candidate).success).toBe(false);
  });

  it('rejects malformed state versions through validation without throwing from BigInt', () => {
    for (const value of ['not-a-version', '-1', '4.5', '04', '9'.repeat(1000)]) {
      for (const field of ['before', 'after'] as const) {
        const candidate = { ...changed, [field]: { ...changed[field], version: value } };
        expect(() => accountControlResultSchema.safeParse(candidate)).not.toThrow();
        expect(accountControlResultSchema.safeParse(candidate).success).toBe(false);
      }
    }
  });

  it('isolates identity, trading and merchant state even for the same user', () => {
    const targets = [{ area: 'identity', userId: USER }, target, { area: 'merchant', merchantId: MERCHANT }];
    for (const selected of targets) {
      const result = {
        ...changed,
        target: selected,
        before: { ...changed.before, target: selected },
        after: { ...changed.after, target: selected },
      };
      expect(accountControlResultSchema.safeParse(result).success).toBe(true);
      for (const foreign of targets.filter((entry) => entry.area !== selected.area)) {
        expect(accountControlResultSchema.safeParse({ ...result, before: { ...result.before, target: foreign } }).success).toBe(false);
        expect(accountControlResultSchema.safeParse({ ...result, after: { ...result.after, target: foreign } }).success).toBe(false);
      }
    }
  });

  it('requires restoration to clear only its selected state with coherent versions', () => {
    const restored = {
      ...changed,
      action: 'restore',
      before: { ...changed.before, restricted: true },
      after: { ...changed.after, restricted: false },
    };
    expect(accountControlResultSchema.parse(restored).outcome).toBe('changed');
    const noop = { ...restored, outcome: 'noop', changed: false, before: restored.after };
    expect(accountControlResultSchema.parse(noop).outcome).toBe('noop');
    for (const candidate of [
      { ...restored, after: { ...restored.after, restricted: true } },
      { ...restored, before: { ...restored.before, restricted: false } },
      { ...restored, after: { ...restored.after, version: '4' } },
      { ...noop, after: { ...noop.after, restricted: true } },
      { ...noop, after: { ...noop.after, version: '6' } },
    ])
      expect(accountControlResultSchema.safeParse(candidate).success).toBe(false);
  });

  it.each(['operator.denied', 'mfa.required'])('does not disclose current target state after %s', (code) => {
    const refused = {
      auditId: KEY,
      requestId: KEY,
      target,
      action: 'restrict',
      reason: 'Incident review',
      occurredAt: NOW,
      outcome: 'refused',
      changed: false,
      actorUserId: null,
      code,
      current: null,
    };
    expect(accountControlResultSchema.parse(refused).outcome).toBe('refused');
    expect(accountControlResultSchema.safeParse({ ...refused, current: changed.after }).success).toBe(false);
  });

  it('distinguishes unchanged, refused and conflicting attempts without fabricated changes', () => {
    const noop = { ...changed, outcome: 'noop', changed: false, before: changed.after };
    expect(accountControlResultSchema.parse(noop).outcome).toBe('noop');
    expect(accountControlResultSchema.safeParse({ ...noop, after: { ...noop.after, version: '6' } }).success).toBe(false);
    const audit = { auditId: KEY, requestId: KEY, target, action: 'restrict', reason: 'Incident review', occurredAt: NOW };
    const refused = { ...audit, outcome: 'refused', changed: false, actorUserId: null, code: 'operator.denied', current: null };
    expect(accountControlResultSchema.parse(refused).outcome).toBe('refused');
    expect(accountControlResultSchema.safeParse({ ...refused, after: changed.after }).success).toBe(false);
    expect(
      accountControlResultSchema.parse({
        ...audit,
        outcome: 'conflict',
        changed: false,
        actorUserId: OTHER,
        code: 'restriction.version_conflict',
        current: changed.after,
      }).outcome,
    ).toBe('conflict');
    expect(accountControlResultSchema.safeParse({ ...changed, outcome: 'unknown' }).success).toBe(false);
  });
});

describe('current authority snapshot', () => {
  it('binds operator inspection to a strict target and an explicit bounded history limit', () => {
    const target = { area: 'identity', userId: USER };
    expect(accountControlLookupInputSchema.safeParse({ target }).success).toBe(true);
    expect(accountControlLookupInputSchema.safeParse({ target, actorUserId: USER }).success).toBe(false);
    expect(accountControlHistoryInputSchema.safeParse({ target, limit: 50 }).success).toBe(true);
    for (const limit of [undefined, 0, 201]) expect(accountControlHistoryInputSchema.safeParse({ target, limit }).success).toBe(false);
  });
  it('keeps revocable operator entitlement distinct from session and admission authority', () => {
    const enabled = { status: 'enabled', userId: USER, version: '1', changedAt: NOW };
    expect(accountOperatorEntitlementSchema.safeParse(enabled).success).toBe(true);
    expect(accountOperatorEntitlementSchema.safeParse({ ...enabled, status: 'revoked' }).success).toBe(true);
    expect(accountOperatorEntitlementSchema.safeParse({ status: 'unconfigured', userId: USER }).success).toBe(true);
    expect(accountOperatorEntitlementSchema.safeParse({ status: 'not_operator', userId: USER }).success).toBe(true);
    expect(accountOperatorEntitlementSchema.safeParse({ ...enabled, mfa: true }).success).toBe(false);
    expect(accountOperatorEntitlementSchema.safeParse({ ...enabled, status: 'unknown' }).success).toBe(false);
  });

  it('binds a maximum-five-second snapshot to its requested account and credential', () => {
    expect(currentAuthorityInputSchema.parse(subject)).toEqual(subject);
    expect(currentAuthorityResultSchema.parse(eligible).status).toBe('eligible');
    const apiSubject = { userId: USER, credential: { kind: 'api_key', apiKeyId: KEY } };
    expect(
      currentAuthorityResultSchema.parse({ ...eligible, subject: apiSubject, credential: { ...eligible.credential, kind: 'api_key' } })
        .status,
    ).toBe('eligible');
  });

  it('rejects frozen, foreign, revoked or wrong-kind proofs and excessive/expired leases', () => {
    for (const candidate of [
      { ...eligible, account: { ...eligible.account, status: 'frozen' } },
      { ...eligible, account: { ...eligible.account, userId: OTHER } },
      { ...eligible, credential: { ...eligible.credential, ownership: { id: OTHER, userId: USER, revoked: false } } },
      { ...eligible, credential: { ...eligible.credential, ownership: { id: KEY, userId: OTHER, revoked: false } } },
      { ...eligible, credential: { ...eligible.credential, ownership: { id: KEY, userId: USER, revoked: true } } },
      { ...eligible, credential: { ...eligible.credential, kind: 'api_key' } },
      { ...eligible, leaseExpiresAt: NOW },
      { ...eligible, leaseExpiresAt: '2026-10-10T12:00:05.001Z' },
      { ...eligible, admitted: true },
    ])
      expect(currentAuthorityResultSchema.safeParse(candidate).success).toBe(false);
  });

  it('requires a matching live sub-account proof when requested', () => {
    const scoped = {
      ...eligible,
      subject: { ...subject, subAccountId: MERCHANT },
      subAccount: { id: MERCHANT, parentUserId: USER, revoked: false },
    };
    expect(currentAuthorityResultSchema.parse(scoped).status).toBe('eligible');
    expect(currentAuthorityResultSchema.safeParse({ ...scoped, subAccount: null }).success).toBe(false);
    expect(currentAuthorityResultSchema.safeParse({ ...scoped, subAccount: { ...scoped.subAccount, parentUserId: OTHER } }).success).toBe(
      false,
    );
    expect(currentAuthorityResultSchema.safeParse({ ...scoped, subAccount: { ...scoped.subAccount, revoked: true } }).success).toBe(false);
    expect(currentAuthorityResultSchema.safeParse({ ...eligible, subAccount: scoped.subAccount }).success).toBe(false);
  });

  it('keeps denied and unavailable explicit; unknown outcomes and allowed flags refuse', () => {
    for (const status of ['unknown', 'allowed', 'active']) {
      expect(currentAuthorityResultSchema.safeParse({ ...eligible, status }).success).toBe(false);
    }
    const denied = { status: 'denied', subject, checkedAt: NOW, code: 'auth.credential_revoked' };
    expect(currentAuthorityResultSchema.parse(denied).status).toBe('denied');
    expect(currentAuthorityResultSchema.safeParse({ ...denied, allowed: true }).success).toBe(false);
    expect(
      currentAuthorityResultSchema.parse({ status: 'unavailable', subject, checkedAt: NOW, code: 'authority.unavailable' }).status,
    ).toBe('unavailable');
  });
});

describe('committed admission and immutable recovery', () => {
  it.each(['payment.create', 'payment.authorize', 'payment.capture', 'payout'])('admits and binds recovery separately for %s', (kind) => {
    const operation = { ...admissionInput.operation, kind };
    const stored = { ...admission, operation };
    const reference = { ...recovery, operation };
    expect(operationAdmissionInputSchema.parse({ ...admissionInput, operation }).operation.kind).toBe(kind);
    expect(operationAdmissionResultSchema.parse(stored).status).toBe('committed');
    expect(recoveryMatchesAdmission(reference, stored)).toBe(true);
    for (const otherKind of ['payment.create', 'payment.authorize', 'payment.capture', 'payout'].filter((entry) => entry !== kind)) {
      expect(recoveryMatchesAdmission({ ...reference, operation: { ...operation, kind: otherKind } }, stored)).toBe(false);
    }
  });

  it('accepts durable operation-specific receipts and recovery references', () => {
    expect(operationAdmissionResultSchema.parse(admission).status).toBe('committed');
    expect(operationRecoveryInputSchema.parse(recovery)).toEqual(recovery);
    expect(recoveryMatchesAdmission(recovery, admission)).toBe(true);
    expect(
      operationAdmissionInputSchema.parse({ ...admissionInput, operation: { service: 'svc-trade', kind: 'algo.child', userId: USER } })
        .operation.service,
    ).toBe('svc-trade');
  });

  it.each(['actorUserId', 'admitted', 'recoveryAllowed', 'destination', 'amount', 'identityVersion'])(
    'rejects injected recovery %s',
    (field) => {
      expect(operationRecoveryInputSchema.safeParse({ ...recovery, [field]: 'forged' }).success).toBe(false);
      expect(recoveryMatchesAdmission({ ...recovery, [field]: 'forged' }, admission)).toBe(false);
    },
  );

  it('refuses malformed evidence, unsupported operations and missing proof fields', () => {
    for (const candidate of [
      { ...admission, payloadHash: 'sha256:abc' },
      { ...admission, payloadHash: 'a'.repeat(64) },
      { ...admission, admissionId: 'fake' },
      { ...admission, admittedAt: 'yesterday' },
      { ...admission, identityVersion: 5 },
      { ...admission, restrictionVersion: '-1' },
      { ...admission, status: 'allowed' },
      { ...admission, operation: { ...admission.operation, kind: 'refund' } },
      { ...admission, operation: { ...admission.operation, kind: 'payment.accept' } },
      { ...admission, operation: { service: 'svc-trade', kind: 'payout', userId: USER } },
    ])
      expect(committedOperationAdmissionSchema.safeParse(candidate).success).toBe(false);
    const { admissionId: _, ...missingId } = recovery;
    expect(operationRecoveryInputSchema.safeParse(missingId).success).toBe(false);
    expect(operationAdmissionResultSchema.safeParse({ status: 'unknown', allowed: true }).success).toBe(false);
  });

  it('prevents one admitted operation from authorizing a different payload, subject or child', () => {
    for (const candidate of [
      { ...recovery, admissionId: OTHER },
      { ...recovery, businessId: 'payout:settlement-2:attempt-0' },
      { ...recovery, payloadHash: `sha256:${'b'.repeat(64)}` },
      { ...recovery, operation: { ...recovery.operation, userId: OTHER } },
      { ...recovery, operation: { ...recovery.operation, merchantId: OTHER } },
      { ...recovery, operation: { ...recovery.operation, kind: 'payment.create' } },
      { ...recovery, operation: { service: 'svc-trade', kind: 'algo.child', userId: USER } },
    ])
      expect(recoveryMatchesAdmission(candidate, admission)).toBe(false);
    expect(recoveryMatchesAdmission(recovery, eligible)).toBe(false);
  });
});
