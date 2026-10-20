import { describe, expect, it } from 'vitest';
import { OPS_ALERT_REFUSAL_CODES, opsAlertBusinessKey, opsAlertRuleDraftSchema, opsAlertRuleSchema } from './ops-alert-rules.js';

const draft = {
  name: 'Ledger postings stalled',
  folder: 'ledger',
  group: 'every-minute',
  signal: 'ledger.postings.count',
  condition: { operator: 'lt' as const },
  labels: { owner: 'founder' },
  reason: 'first rule',
};

describe('alert rule draft', () => {
  it('lets a blank threshold, interval and pending period through so svc-ops can refuse them by name', () => {
    const parsed = opsAlertRuleDraftSchema.parse(draft);
    expect(parsed.condition.threshold).toBeUndefined();
    expect(parsed.intervalSeconds).toBeUndefined();
    expect(parsed.pendingSeconds).toBeUndefined();
  });

  it('fails closed on missing data and on a failed check unless the rule says otherwise', () => {
    const parsed = opsAlertRuleDraftSchema.parse(draft);
    expect(parsed.noData).toBe('alerting');
    expect(parsed.execError).toBe('alerting');
  });

  it('keeps a threshold a decimal string, never a number', () => {
    expect(opsAlertRuleDraftSchema.safeParse({ ...draft, condition: { operator: 'gt', threshold: 5 } }).success).toBe(false);
    expect(opsAlertRuleDraftSchema.safeParse({ ...draft, condition: { operator: 'gt', threshold: '5.25' } }).success).toBe(true);
  });

  it('bounds labels', () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`l${i}`, 'v']));
    expect(opsAlertRuleDraftSchema.safeParse({ ...draft, labels: many }).success).toBe(false);
    expect(opsAlertRuleDraftSchema.safeParse({ ...draft, labels: { 'Bad Name': 'v' } }).success).toBe(false);
  });

  it('requires a reason for every save', () => {
    expect(opsAlertRuleDraftSchema.safeParse({ ...draft, reason: ' ' }).success).toBe(false);
  });
});

describe('alert rule', () => {
  it('has no unset field: a stored rule carries every number', () => {
    const rule = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'x',
      folder: 'f',
      group: 'g',
      signal: 'ledger.postings.count',
      condition: { operator: 'lt', threshold: '1' },
      intervalSeconds: 60,
      pendingSeconds: 0,
      labels: {},
      annotations: {},
      noData: 'alerting',
      execError: 'alerting',
      paused: false,
      version: 1,
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
      retiredAt: null,
    };
    expect(opsAlertRuleSchema.safeParse(rule).success).toBe(true);
    expect(opsAlertRuleSchema.safeParse({ ...rule, condition: { operator: 'lt' } }).success).toBe(false);
  });

  it('builds the business key from the stored epoch', () => {
    expect(opsAlertBusinessKey('r', 'abc', 3)).toBe('ops:alert:r:abc:3');
  });

  it('names six refusals, all in the ops namespace', () => {
    expect(OPS_ALERT_REFUSAL_CODES).toHaveLength(6);
    expect(OPS_ALERT_REFUSAL_CODES.every((c) => c.startsWith('ops.alert_'))).toBe(true);
  });
});
