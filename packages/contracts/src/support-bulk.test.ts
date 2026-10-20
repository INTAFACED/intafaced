import { describe, expect, it } from 'vitest';
import {
  SUPPORT_BULK_TRANSPORT_MAX,
  supportBulkInputSchema,
  supportBulkKey,
  supportBulkPolicySchema,
  supportBulkResultSchema,
} from './support-bulk.js';
import * as root from './index.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const base = { batchKey: 'batch-0001', ticketIds: [A, B], change: { kind: 'status', status: 'closed' } };

describe('bulk update input', () => {
  it('takes one change of each kind', () => {
    expect(supportBulkInputSchema.safeParse(base).success).toBe(true);
    expect(supportBulkInputSchema.safeParse({ ...base, change: { kind: 'assign', assigneeId: A } }).success).toBe(true);
    expect(supportBulkInputSchema.safeParse({ ...base, change: { kind: 'priority', priority: 'high' } }).success).toBe(true);
    expect(supportBulkInputSchema.safeParse({ ...base, change: { kind: 'priority', priority: null } }).success).toBe(true);
  });
  it('refuses a priority the single change would refuse', () => {
    expect(supportBulkInputSchema.safeParse({ ...base, change: { kind: 'priority', priority: 'bogus' } }).success).toBe(false);
    expect(supportBulkInputSchema.safeParse({ ...base, change: { kind: 'priority', priority: '' } }).success).toBe(false);
  });
  it('refuses a mixed change, an unknown kind, a bad status and an extra key', () => {
    expect(supportBulkInputSchema.safeParse({ ...base, change: { kind: 'status', status: 'closed', priority: 'x' } }).success).toBe(false);
    expect(supportBulkInputSchema.safeParse({ ...base, change: { kind: 'delete' } }).success).toBe(false);
    expect(supportBulkInputSchema.safeParse({ ...base, change: { kind: 'status', status: 'gone' } }).success).toBe(false);
    expect(supportBulkInputSchema.safeParse({ ...base, cap: 5 }).success).toBe(false);
  });
  it('refuses an empty batch, a repeated request, a short key and a blank reason', () => {
    expect(supportBulkInputSchema.safeParse({ ...base, ticketIds: [] }).success).toBe(false);
    expect(supportBulkInputSchema.safeParse({ ...base, ticketIds: [A, A] }).success).toBe(false);
    expect(supportBulkInputSchema.safeParse({ ...base, batchKey: 'short' }).success).toBe(false);
    expect(supportBulkInputSchema.safeParse({ ...base, reason: '   ' }).success).toBe(false);
    expect(supportBulkInputSchema.parse({ ...base, reason: ' why ' }).reason).toBe('why');
  });
  it('has a transport bound that is not the owner cap', () => {
    const ids = Array.from({ length: SUPPORT_BULK_TRANSPORT_MAX + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(supportBulkInputSchema.safeParse({ ...base, ticketIds: ids }).success).toBe(false);
  });
});

describe('bulk result, policy and key', () => {
  it('lists each request with its own outcome and a code only for a refusal', () => {
    const result = {
      batchKey: 'batch-0001',
      results: [
        { ticketId: A, outcome: 'changed', code: null },
        { ticketId: B, outcome: 'refused', code: 'support.not_found' },
      ],
    };
    expect(supportBulkResultSchema.parse(result)).toEqual(result);
    expect(supportBulkResultSchema.safeParse({ ...result, results: [{ ticketId: A, outcome: 'maybe', code: null }] }).success).toBe(false);
  });
  it('reads a blank cap as null and names what is missing, never a built-in number', () => {
    expect(supportBulkPolicySchema.parse({ cap: null, missing: 'support.bulk_cap' })).toEqual({ cap: null, missing: 'support.bulk_cap' });
    expect(supportBulkPolicySchema.safeParse({ cap: 0, missing: null }).success).toBe(false);
    expect(supportBulkPolicySchema.safeParse({ cap: null, missing: 'support.other' }).success).toBe(false);
  });
  it('keys a request by the batch and the request, never a random value', () => {
    expect(supportBulkKey('batch-0001', A)).toBe(`bulk:batch-0001:${A}`);
    expect(supportBulkKey('batch-0001', A)).toBe(supportBulkKey('batch-0001', A));
    expect(supportBulkKey('batch-0001', A)).not.toBe(supportBulkKey('batch-0001', B));
  });
  it('is exported from the package root', () => {
    expect(root.supportBulkInputSchema).toBe(supportBulkInputSchema);
  });
});
