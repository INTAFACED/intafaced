import { describe, expect, it } from 'vitest';
import {
  identityOperationDecisionInputSchema,
  identityOperationDecisionSchema,
  identityOperationGrantSchema,
  identityOperationIntentSchema,
} from './operation-identity-decisions.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL = '33333333-3333-4333-8333-333333333333';
const MERCHANT = '44444444-4444-4444-8444-444444444444';
const GRANT = '55555555-5555-4555-8555-555555555555';
const NOW = '2026-10-10T12:00:00.000Z';
const HASH = `sha256:${'a'.repeat(64)}`;

const tradeIntent = {
  operation: { service: 'svc-trade', kind: 'order.place', userId: USER },
  businessId: 'order:client-42',
  payloadHash: HASH,
  authority: { kind: 'credential', subject: { userId: USER, credential: { kind: 'session', sessionId: CREDENTIAL } } },
} as const;

const payIntent = {
  operation: { service: 'svc-pay', kind: 'payment.capture', userId: USER, merchantId: MERCHANT },
  businessId: 'payment:capture:payment-42',
  payloadHash: HASH,
  authority: { kind: 'merchant_policy', merchantId: MERCHANT },
} as const;

describe('identity operation decision wire shapes', () => {
  it('binds credential authority to the operation subject and limits delegation to fresh trading children', () => {
    expect(identityOperationIntentSchema.safeParse(tradeIntent).success).toBe(true);
    expect(
      identityOperationIntentSchema.safeParse({
        ...tradeIntent,
        authority: { ...tradeIntent.authority, subject: { ...tradeIntent.authority.subject, userId: OTHER } },
      }).success,
    ).toBe(false);

    for (const kind of ['algo.child', 'copy.mirror'] as const) {
      expect(
        identityOperationIntentSchema.safeParse({
          ...tradeIntent,
          operation: { service: 'svc-trade', kind, userId: USER },
          authority: { kind: 'delegation', parentGrantId: GRANT },
        }).success,
      ).toBe(true);
    }
    for (const operation of [
      { service: 'svc-trade', kind: 'order.place', userId: USER },
      { service: 'svc-trade', kind: 'strategy.start', userId: USER },
      { service: 'svc-pay', kind: 'payment.capture', userId: USER, merchantId: MERCHANT },
    ]) {
      expect(
        identityOperationIntentSchema.safeParse({ ...tradeIntent, operation, authority: { kind: 'delegation', parentGrantId: GRANT } })
          .success,
      ).toBe(false);
    }
  });

  it('binds merchant policy to svc-pay and the operation merchant', () => {
    expect(identityOperationIntentSchema.safeParse(payIntent).success).toBe(true);
    expect(
      identityOperationIntentSchema.safeParse({
        ...payIntent,
        authority: { kind: 'merchant_policy', merchantId: OTHER },
      }).success,
    ).toBe(false);
    expect(
      identityOperationIntentSchema.safeParse({
        ...payIntent,
        operation: { service: 'svc-trade', kind: 'order.place', userId: USER },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields and caller-supplied completion, recovery, or permission claims', () => {
    expect(identityOperationIntentSchema.safeParse({ ...tradeIntent, actorUserId: USER }).success).toBe(false);
    expect(identityOperationIntentSchema.safeParse({ ...tradeIntent, completed: true }).success).toBe(false);
    expect(identityOperationIntentSchema.safeParse({ ...tradeIntent, recoveryAllowed: true }).success).toBe(false);
    expect(identityOperationIntentSchema.safeParse({ ...tradeIntent, permission: 'trade:write' }).success).toBe(false);
    expect(
      identityOperationIntentSchema.safeParse({
        ...tradeIntent,
        authority: { ...tradeIntent.authority, continuation: 'caller-permission' },
      }).success,
    ).toBe(false);

    for (const field of ['admissionId', 'completedAt', 'recovery', 'grantId', 'identityVersion']) {
      expect(identityOperationDecisionInputSchema.safeParse({ mode: 'grant', intent: tradeIntent, [field]: USER }).success).toBe(false);
    }
    expect(identityOperationDecisionInputSchema.safeParse({ mode: 'grant', intent: tradeIntent, status: 'granted' }).success).toBe(false);
  });

  it('preserves PayFac actor credentials with explicit journal or implicit root provenance, limited to matching pay operations', () => {
    const delegated = {
      ...payIntent,
      authority: {
        kind: 'payfac_credential',
        area: 'payment',
        subject: { userId: OTHER, credential: { kind: 'session', sessionId: CREDENTIAL } },
        proof: {
          kind: 'explicit_grant',
          actorMerchantId: OTHER,
          subjectMerchantId: MERCHANT,
          grantEventId: GRANT,
          grantSequence: '9007199254740993',
        },
      },
    };
    expect(identityOperationIntentSchema.safeParse(delegated).success).toBe(true);
    expect(
      identityOperationIntentSchema.safeParse({
        ...delegated,
        authority: { ...delegated.authority, proof: { kind: 'root_relation', actorMerchantId: OTHER, subjectMerchantId: MERCHANT } },
      }).success,
    ).toBe(true);
    for (const authority of [
      { ...delegated.authority, area: 'settlement.payout' },
      { ...delegated.authority, proof: { ...delegated.authority.proof, actorMerchantId: MERCHANT } },
      { ...delegated.authority, proof: { ...delegated.authority.proof, subjectMerchantId: OTHER } },
      { ...delegated.authority, proof: { ...delegated.authority.proof, grantSequence: 9007199254740993 } },
      { ...delegated.authority, proof: { ...delegated.authority.proof, grantSequence: '0' } },
    ])
      expect(identityOperationIntentSchema.safeParse({ ...delegated, authority }).success).toBe(false);
    expect(identityOperationIntentSchema.safeParse({ ...tradeIntent, authority: delegated.authority }).success).toBe(false);
  });

  it('keeps grant versions as decimal strings beyond JavaScript safe integers', () => {
    const grant = {
      status: 'granted',
      intent: tradeIntent,
      grantId: GRANT,
      identityVersion: '9007199254740993',
      decidedAt: NOW,
    };
    expect(identityOperationGrantSchema.parse(grant).identityVersion).toBe('9007199254740993');
    for (const invalid of ['-1', '01', '1.5', 9007199254740993]) {
      expect(identityOperationGrantSchema.safeParse({ ...grant, identityVersion: invalid }).success).toBe(false);
    }
  });

  it('preserves grant, cancellation, conflict, and unavailable as distinct decision shapes', () => {
    const request = { mode: 'resolve_or_cancel', intent: tradeIntent };
    expect(identityOperationDecisionInputSchema.parse(request).mode).toBe('resolve_or_cancel');

    expect(
      identityOperationDecisionSchema.safeParse({
        status: 'granted',
        intent: tradeIntent,
        grantId: GRANT,
        identityVersion: '7',
        decidedAt: NOW,
      }).success,
    ).toBe(true);
    expect(
      identityOperationDecisionSchema.safeParse({
        status: 'cancelled',
        intent: tradeIntent,
        code: 'auth.account_frozen',
        decidedAt: NOW,
      }).success,
    ).toBe(true);
    expect(identityOperationDecisionSchema.safeParse({ status: 'conflict', code: 'operation.conflict' }).success).toBe(true);
    expect(identityOperationDecisionSchema.safeParse({ status: 'unavailable', code: 'authority.unavailable' }).success).toBe(true);
    expect(identityOperationDecisionSchema.safeParse({ status: 'cancelled', code: 'authority.unavailable' }).success).toBe(false);
    expect(identityOperationDecisionSchema.safeParse({ status: 'conflict', code: 'operation.conflict', intent: tradeIntent }).success).toBe(
      false,
    );
  });
});
