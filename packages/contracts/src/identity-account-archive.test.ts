import { describe, expect, it } from 'vitest';
import { accountArchiveOf, accountStateSchema } from './identity.js';

const USER = '00000000-0000-4000-8000-000000000001';

describe('accountArchiveOf', () => {
  it('reads archived and not archived from the field', () => {
    expect(accountArchiveOf(accountStateSchema.parse({ userId: USER, status: 'closed', kycTier: 'none', archived: true }))).toBe(
      'archived',
    );
    expect(accountArchiveOf(accountStateSchema.parse({ userId: USER, status: 'active', kycTier: 'basic', archived: false }))).toBe(
      'not_archived',
    );
  });

  it('a state without the field is unread, never not archived', () => {
    expect(accountArchiveOf(accountStateSchema.parse({ userId: USER, status: 'closed', kycTier: 'none' }))).toBe('unread');
  });
});
