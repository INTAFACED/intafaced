import { describe, expect, it } from 'vitest';
import {
  SUPPORT_OWNED_RECORD_KINDS,
  SUPPORT_RECORD_OWNERSHIP_CALLERS,
  SUPPORT_RECORD_OWNERSHIP_PROCEDURES,
  supportRecordOwnershipInputSchema,
  supportRecordOwnershipResultSchema,
} from './support-record-ownership.js';
import { SERVICE_NAMES } from './service-keys.js';
import * as root from './index.js';

const input = { kind: 'withdrawal', recordId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' };

describe('support record ownership door', () => {
  it('names svc-support as its only caller, a real service, and one path', () => {
    expect(SUPPORT_RECORD_OWNERSHIP_CALLERS).toEqual(['svc-support']);
    for (const caller of SUPPORT_RECORD_OWNERSHIP_CALLERS) expect(SERVICE_NAMES).toContain(caller);
    expect(Object.values(SUPPORT_RECORD_OWNERSHIP_PROCEDURES)).toEqual(['supportRecordOwnership.owns']);
  });

  it('asks about a withdrawal or a deposit by its id, for one customer', () => {
    expect(SUPPORT_OWNED_RECORD_KINDS).toEqual(['withdrawal', 'deposit']);
    expect(supportRecordOwnershipInputSchema.parse(input)).toEqual(input);
    expect(supportRecordOwnershipInputSchema.safeParse({ ...input, kind: 'deposit' }).success).toBe(true);
    expect(supportRecordOwnershipInputSchema.safeParse({ ...input, kind: 'order' }).success).toBe(false);
    expect(supportRecordOwnershipInputSchema.safeParse({ ...input, recordId: 'w-1' }).success).toBe(false);
    expect(supportRecordOwnershipInputSchema.safeParse({ ...input, userId: '' }).success).toBe(false);
    const { userId: _userId, ...noUser } = input;
    expect(supportRecordOwnershipInputSchema.safeParse(noUser).success).toBe(false);
    expect(supportRecordOwnershipInputSchema.safeParse({ ...input, amount: '1' }).success).toBe(false);
  });

  it('answers one boolean and nothing else: no amount, status or owner can ride along', () => {
    expect(supportRecordOwnershipResultSchema.parse({ owned: false })).toEqual({ owned: false });
    expect(supportRecordOwnershipResultSchema.safeParse({ owned: true, amount: '10' }).success).toBe(false);
    expect(supportRecordOwnershipResultSchema.safeParse({ owned: true, userId: input.userId }).success).toBe(false);
    expect(supportRecordOwnershipResultSchema.safeParse({ owned: 'yes' }).success).toBe(false);
  });

  it('is exported from the package root', () => {
    expect(root.SUPPORT_RECORD_OWNERSHIP_PROCEDURES).toBe(SUPPORT_RECORD_OWNERSHIP_PROCEDURES);
  });
});
