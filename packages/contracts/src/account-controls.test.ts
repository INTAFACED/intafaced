import { describe, expect, it } from 'vitest';
import {
  accountLimitAmountSchema,
  accountLimitOverrideSetInputSchema,
  accountLimitResultSchema,
  accountArchiveInputSchema,
  accountArchiveProposalsSchema,
  accountArchiveResultSchema,
  accountArchiveStateSchema,
  accountControlInputSchema,
  accountTierResultSchema,
  accountTierTermsSchema,
  identityAccountControlInputSchema,
  accountControlHistoryInputSchema,
  accountControlLookupInputSchema,
  accountControlResultSchema,
  accountOperatorEntitlementSchema,
  currentAuthorityInputSchema,
  currentAuthorityResultSchema,
  operationAdmissionInputSchema,
  serviceOperatorEntitlementInputSchema,
  operationAdmissionResultSchema,
  committedOperationAdmissionSchema,
  operationRecoveryInputSchema,
  recoveryMatchesAdmission,
  customerDetailChangesSchema,
  customerDetailReviewSchema,
  customerDetailValueSchemas,
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

  it.each(['actorUserId', 'actor', 'mfa', 'founder', 'confirmOperatorId', 'recoveryAllowed', 'approvalId'])(
    'rejects caller-supplied %s authority',
    (field) => expect(accountControlInputSchema.safeParse({ ...command, [field]: OTHER }).success).toBe(false),
  );

  it('accepts an approval id as a reference and rejects a blank one', () => {
    expect(identityAccountControlInputSchema.parse({ ...command, approvalId: KEY }).approvalId).toBe(KEY);
    expect(identityAccountControlInputSchema.safeParse({ ...command, approvalId: '  ' }).success).toBe(false);
    expect(identityAccountControlInputSchema.safeParse({ ...command, approvalId: KEY, unknownExtra: true }).success).toBe(false);
  });

  it('accepts an owner reason code shaped as a list code, and only on the identity schema', () => {
    expect(identityAccountControlInputSchema.parse({ ...command, reasonCode: 'market_conduct_review' }).reasonCode).toBe(
      'market_conduct_review',
    );
    for (const reasonCode of ['', 'a', 'Market_review', '1review', 'review code', 'x'.repeat(65)])
      expect(identityAccountControlInputSchema.safeParse({ ...command, reasonCode }).success).toBe(false);
    expect(accountControlInputSchema.safeParse({ ...command, reasonCode: 'market_conduct_review' }).success).toBe(false);
  });

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

describe('service-only operator entitlement read', () => {
  it('names the user and the live session the caller authenticated, and nothing else', () => {
    expect(serviceOperatorEntitlementInputSchema.parse({ userId: USER, sessionId: KEY })).toEqual({ userId: USER, sessionId: KEY });
    for (const candidate of [
      { userId: USER },
      { sessionId: KEY },
      { userId: 'someone', sessionId: KEY },
      { userId: USER, sessionId: 'session' },
      { userId: USER, sessionId: KEY, mfa: true },
      { userId: USER, sessionId: KEY, expiresAt: NOW },
    ])
      expect(serviceOperatorEntitlementInputSchema.safeParse(candidate).success).toBe(false);
  });
});

describe('customer archive (J-ops-console-04 #10)', () => {
  const open = { userId: USER, version: '3', status: 'closed', archivedAt: null, archiveReasonCode: null } as const;
  const archived = { ...open, version: '4', archivedAt: NOW, archiveReasonCode: 'dormant' } as const;
  const base = {
    auditId: KEY,
    requestId: KEY,
    userId: USER,
    reasonCode: 'dormant',
    reason: 'No contact since closing',
    occurredAt: NOW,
  } as const;

  it('takes a reason code from the list and a reason, and nothing else', () => {
    const input = { requestId: KEY, userId: USER, reasonCode: 'dormant', reason: 'No contact since closing', expectedVersion: '3' };
    expect(accountArchiveInputSchema.safeParse(input).success).toBe(true);
    expect(accountArchiveInputSchema.safeParse({ ...input, approvalId: 'approval-1' }).success).toBe(true);
    expect(accountArchiveInputSchema.safeParse({ ...input, reasonCode: 'fraud' }).success).toBe(false);
    expect(accountArchiveInputSchema.safeParse({ ...input, reason: 'no' }).success).toBe(false);
    expect(accountArchiveInputSchema.safeParse({ ...input, archivedAt: NOW }).success).toBe(false);
  });

  it('shows an archive only on a closed account, always with its reason code', () => {
    expect(accountArchiveStateSchema.safeParse(archived).success).toBe(true);
    expect(accountArchiveStateSchema.safeParse({ ...archived, status: 'active' }).success).toBe(false);
    expect(accountArchiveStateSchema.safeParse({ ...archived, archiveReasonCode: null }).success).toBe(false);
    expect(accountArchiveStateSchema.safeParse({ ...open, archiveReasonCode: 'dormant' }).success).toBe(false);
  });

  it('claims an archive only when the version moved by one, a different person approved and the reason code is the one asked', () => {
    const changed = {
      ...base,
      outcome: 'changed',
      changed: true,
      actorUserId: USER.replace('1111-4', '1112-4'),
      approverUserId: OTHER,
      before: open,
      after: archived,
    };
    expect(accountArchiveResultSchema.safeParse(changed).success).toBe(true);
    expect(accountArchiveResultSchema.safeParse({ ...changed, approverUserId: changed.actorUserId }).success).toBe(false);
    expect(accountArchiveResultSchema.safeParse({ ...changed, after: { ...archived, version: '5' } }).success).toBe(false);
    expect(accountArchiveResultSchema.safeParse({ ...changed, reasonCode: 'duplicate' }).success).toBe(false);
    expect(accountArchiveResultSchema.safeParse({ ...changed, before: archived }).success).toBe(false);
  });

  it('names an open account and an archived one as refusals, and never shows state to an unauthorised caller', () => {
    const refused = {
      ...base,
      outcome: 'refused',
      changed: false,
      actorUserId: OTHER,
      code: 'identity.archive_blocked_open_account',
      current: { ...open, status: 'active' },
    };
    expect(accountArchiveResultSchema.safeParse(refused).success).toBe(true);
    expect(accountArchiveResultSchema.safeParse({ ...refused, code: 'identity.account_archived', current: archived }).success).toBe(true);
    expect(accountArchiveResultSchema.safeParse({ ...refused, code: 'operator.denied' }).success).toBe(false);
    expect(accountArchiveResultSchema.safeParse({ ...refused, code: 'operator.denied', current: null, actorUserId: null }).success).toBe(
      true,
    );
  });

  it('makes no proposal without the owner dormancy period', () => {
    expect(accountArchiveProposalsSchema.safeParse({ dormancyDays: null, proposals: [], asOf: NOW }).success).toBe(true);
    expect(
      accountArchiveProposalsSchema.safeParse({ dormancyDays: null, proposals: [{ userId: USER, lastActivityAt: NOW }], asOf: NOW })
        .success,
    ).toBe(false);
    expect(
      accountArchiveProposalsSchema.safeParse({ dormancyDays: 365, proposals: [{ userId: USER, lastActivityAt: NOW }], asOf: NOW }).success,
    ).toBe(true);
    expect(accountArchiveProposalsSchema.safeParse({ dormancyDays: 0, proposals: [], asOf: NOW }).success).toBe(false);
  });
});

describe('account tier results (J-ops-console-04 #11)', () => {
  const user = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
  const base = {
    auditId: '33333333-3333-4333-8333-333333333333',
    requestId: '44444444-4444-4444-8444-444444444444',
    userId: user,
    tierId: 'plus',
    reason: 'Customer qualifies for plus',
    occurredAt: '2026-10-23T03:00:00.000Z',
  };
  const changed = {
    ...base,
    outcome: 'changed',
    changed: true,
    actorUserId: '11111111-1111-4111-8111-111111111111',
    approverUserId: '22222222-2222-4222-8222-222222222222',
    before: { userId: user, version: '0', tierId: null },
    after: { userId: user, version: '1', tierId: 'plus' },
  };
  it('accepts a coherent move and refuses one whose tier, version or approver disagree', () => {
    expect(accountTierResultSchema.safeParse(changed).success).toBe(true);
    expect(accountTierResultSchema.safeParse({ ...changed, after: { ...changed.after, tierId: 'standard' } }).success).toBe(false);
    expect(accountTierResultSchema.safeParse({ ...changed, after: { ...changed.after, version: '2' } }).success).toBe(false);
    expect(accountTierResultSchema.safeParse({ ...changed, approverUserId: changed.actorUserId }).success).toBe(false);
  });
  it('carries blank terms with tier_terms_unset only', () => {
    const refused = { ...base, outcome: 'refused', changed: false, actorUserId: changed.actorUserId, current: changed.before };
    expect(accountTierResultSchema.safeParse({ ...refused, code: 'identity.tier_terms_unset', blankTerms: ['monthlyFee'] }).success).toBe(
      true,
    );
    expect(accountTierResultSchema.safeParse({ ...refused, code: 'identity.tier_terms_unset' }).success).toBe(false);
    expect(accountTierResultSchema.safeParse({ ...refused, code: 'identity.tier_unknown', blankTerms: ['monthlyFee'] }).success).toBe(
      false,
    );
    expect(accountTierResultSchema.safeParse({ ...refused, code: 'operator.denied', current: changed.before }).success).toBe(false);
  });
  it('keeps tier terms as decimal strings or null, never numbers', () => {
    const terms = { ratePercent: '1.5', monthlyFee: null, feeAssetId: 'USD', dailyLimit: '1000', clearingDays: '2' };
    expect(accountTierTermsSchema.safeParse(terms).success).toBe(true);
    expect(accountTierTermsSchema.safeParse({ ...terms, monthlyFee: 4.99 }).success).toBe(false);
    expect(accountTierTermsSchema.safeParse({ ...terms, dailyLimit: '-1' }).success).toBe(false);
  });
});

describe('customer details (J-ops-console-04 #9)', () => {
  const USER = '11111111-1111-4111-8111-111111111111';
  it('takes one or more details, null to take one off the record, and refuses an empty or unknown change', () => {
    expect(customerDetailChangesSchema.safeParse({ city: 'Leeds', phone: null }).success).toBe(true);
    expect(customerDetailChangesSchema.safeParse({}).success).toBe(false);
    expect(customerDetailChangesSchema.safeParse({ nickname: 'x' }).success).toBe(false);
  });
  it('reads a date of birth as a real calendar date and a country as two capitals', () => {
    expect(customerDetailValueSchemas.dateOfBirth.safeParse('1990-12-10').success).toBe(true);
    expect(customerDetailValueSchemas.dateOfBirth.safeParse('1990-02-30').success).toBe(false);
    expect(customerDetailValueSchemas.dateOfBirth.safeParse('1899-12-31').success).toBe(false);
    expect(customerDetailValueSchemas.dateOfBirth.safeParse('2999-01-01').success).toBe(false);
    expect(customerDetailValueSchemas.countryCode.safeParse('GB').success).toBe(true);
    expect(customerDetailValueSchemas.countryCode.safeParse('gb').success).toBe(false);
  });
  it('keeps a review open only without a decision, and names only protected fields', () => {
    const review = {
      reviewId: USER,
      userId: USER,
      status: 'open',
      fields: ['legalName'],
      proposed: { legalName: 'Ada King' },
      documentIds: [],
      reason: 'Marriage certificate seen',
      requestedBy: USER,
      requestedAt: '2026-10-24T19:00:00.000Z',
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
    };
    expect(customerDetailReviewSchema.safeParse(review).success).toBe(true);
    expect(customerDetailReviewSchema.safeParse({ ...review, status: 'passed' }).success).toBe(false);
    expect(customerDetailReviewSchema.safeParse({ ...review, fields: ['city'] }).success).toBe(false);
  });
});

describe('account limit overrides', () => {
  const userId = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
  const actor = '1c7a8b4f-2d3e-4f60-9b0c-1d2e3f4a5b6c';
  const row = {
    userId,
    rail: 'withdrawal',
    assetId: 'USDT',
    version: '1',
    perTx: null,
    rolling24h: '3000',
    expiresAt: '2026-10-25T12:00:00.000Z',
    status: 'active',
    setBy: actor,
    approvedBy: null,
    setAt: '2026-10-24T12:00:00.000Z',
    reason: 'Customer is moving house this week',
    clearedBy: null,
    clearedAt: null,
  } as const;
  const common = {
    auditId: actor,
    requestId: actor,
    userId,
    action: 'set',
    rail: 'withdrawal',
    assetId: 'USDT',
    reason: row.reason,
    occurredAt: '2026-10-24T12:00:00.000Z',
  } as const;

  it('a figure is a positive decimal string within the ledger column, never zero or a number', () => {
    for (const good of ['1', '0.000000000000000001', '99999999999999999999.5'])
      expect(accountLimitAmountSchema.safeParse(good).success).toBe(true);
    for (const bad of ['0', '0.00', '-1', '1e3', '01', '1.0000000000000000001', '100000000000000000000', 5])
      expect(accountLimitAmountSchema.safeParse(bad).success).toBe(false);
  });

  it('a set names at least one figure', () => {
    const input = {
      requestId: actor,
      userId,
      rail: 'withdrawal',
      assetId: 'USDT',
      perTx: null,
      rolling24h: null,
      expiresAt: row.expiresAt,
      reason: row.reason,
      expectedVersion: '0',
    };
    expect(accountLimitOverrideSetInputSchema.safeParse(input).success).toBe(false);
    expect(accountLimitOverrideSetInputSchema.safeParse({ ...input, perTx: '10' }).success).toBe(true);
  });

  it('a changed result is coherent: one version up, the right status, and the approver is another person', () => {
    const changed = { ...common, outcome: 'changed', changed: true, actorUserId: actor, approverUserId: null, before: null, after: row };
    expect(accountLimitResultSchema.safeParse(changed).success).toBe(true);
    expect(accountLimitResultSchema.safeParse({ ...changed, after: { ...row, version: '2' } }).success).toBe(false);
    expect(accountLimitResultSchema.safeParse({ ...changed, approverUserId: actor }).success).toBe(false);
    expect(accountLimitResultSchema.safeParse({ ...changed, after: { ...row, assetId: 'BTC' } }).success).toBe(false);
    expect(accountLimitResultSchema.safeParse({ ...changed, action: 'clear' }).success).toBe(false);
  });

  it('a refusal carries the ceiling only with limit_requires_approver, and an unauthorised one shows no state', () => {
    const refused = {
      ...common,
      outcome: 'refused',
      changed: false,
      actorUserId: actor,
      code: 'identity.limit_requires_approver',
      current: null,
    };
    expect(accountLimitResultSchema.safeParse({ ...refused, ceiling: '5000' }).success).toBe(true);
    expect(accountLimitResultSchema.safeParse(refused).success).toBe(false);
    expect(accountLimitResultSchema.safeParse({ ...refused, code: 'identity.limit_unchanged', ceiling: '5000' }).success).toBe(false);
    expect(accountLimitResultSchema.safeParse({ ...refused, code: 'operator.denied', current: row }).success).toBe(false);
  });
});
