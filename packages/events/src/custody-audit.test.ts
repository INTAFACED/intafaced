import { describe, expect, it } from 'vitest';
import { CUSTODY_AUDIT_CATEGORIES, EVENT_CATALOG, custodyAuditEntryPayloadSchema, wiringSocketReason } from './catalog.js';

/** TEST data only. */
const base = {
  entryKey: 'pay:address:changed:TEST-1',
  category: 'address_change',
  action: 'address.added',
  actor: { type: 'user', id: 'user-1' },
  subjectUserId: 'user-1',
  clientContext: { ip: '192.0.2.1', userAgent: 'TEST agent', apiKeyId: null },
  requestId: null,
  occurredAt: '2026-10-22T00:00:00.000Z',
} as const;

describe('payCustodyAuditCreated', () => {
  it('is declared on the pay service with a past-tense subject', () => {
    expect(EVENT_CATALOG.payCustodyAuditCreated.subject).toBe('intafaced.pay.custody_audit.created');
    expect(EVENT_CATALOG.payCustodyAuditCreated.version).toBe(1);
  });

  it.each(CUSTODY_AUDIT_CATEGORIES.map((c) => [c]))('accepts one entry of kind %s', (category) => {
    const entry = { ...base, category, requestId: 'req-1' };
    expect(custodyAuditEntryPayloadSchema.safeParse(entry).success).toBe(true);
  });

  it('accepts a limit change with its actor and no request id', () => {
    const entry = { ...base, category: 'limit_change', action: 'limit.changed', actor: { type: 'operator', id: 'op-1' } };
    expect(custodyAuditEntryPayloadSchema.parse(entry).actor).toEqual({ type: 'operator', id: 'op-1' });
  });

  it('refuses a withdrawal entry without its request id', () => {
    const r = custodyAuditEntryPayloadSchema.safeParse({ ...base, category: 'withdrawal', requestId: null });
    expect(r.success).toBe(false);
  });

  it('refuses an entry with no business key, no actor, an unknown kind or extra fields', () => {
    expect(custodyAuditEntryPayloadSchema.safeParse({ ...base, entryKey: '' }).success).toBe(false);
    const { actor: _a, ...noActor } = base;
    expect(custodyAuditEntryPayloadSchema.safeParse(noActor).success).toBe(false);
    expect(custodyAuditEntryPayloadSchema.safeParse({ ...base, category: 'login' }).success).toBe(false);
    expect(custodyAuditEntryPayloadSchema.safeParse({ ...base, amount: '1.00' }).success).toBe(false);
    expect(custodyAuditEntryPayloadSchema.safeParse({ ...base, action: 'Address Added' }).success).toBe(false);
  });

  it('requires client context fields to be present, null when there was no client', () => {
    const { clientContext: _c, ...noContext } = base;
    expect(custodyAuditEntryPayloadSchema.safeParse(noContext).success).toBe(false);
    const system = {
      ...base,
      actor: { type: 'system', id: 'pay-reconciler' },
      clientContext: { ip: null, userAgent: null, apiKeyId: null },
    };
    expect(custodyAuditEntryPayloadSchema.safeParse(system).success).toBe(true);
  });

  it('declares both unwired ends with a reason', () => {
    expect(wiringSocketReason('payCustodyAuditCreated', 'publisher')).toMatch(/svc-pay/);
    expect(wiringSocketReason('payCustodyAuditCreated', 'subscriber')).toMatch(/custody-ops/);
  });
});
