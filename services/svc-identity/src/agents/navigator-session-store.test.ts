import { describe, expect, it } from 'vitest';
import { mapAuthSessionRow } from './navigator-session-store.js';

describe('mapAuthSessionRow', () => {
  const now = new Date('2026-08-21T12:00:00.000Z');
  it('closes a frozen or closed identity even when its session row is otherwise live', () => {
    for (const user_status of ['frozen', 'closed'] as const) {
      expect(
        mapAuthSessionRow(
          { id: 'sess-1', user_id: 'user-1', user_status, revoked: false, expires_at: new Date('2026-08-22T12:00:00.000Z') },
          now,
        ).status,
      ).toBe('closed');
    }
  });

  it('maps a live auth session as open', () => {
    expect(
      mapAuthSessionRow(
        {
          id: 'sess-1',
          user_id: 'user-1',
          revoked: false,
          user_status: 'active',
          expires_at: new Date('2026-08-22T12:00:00.000Z'),
        },
        now,
      ),
    ).toEqual({ sessionId: 'sess-1', userId: 'user-1', status: 'open' });
  });

  it('maps revoked or expired sessions as closed', () => {
    expect(
      mapAuthSessionRow(
        {
          id: 'sess-2',
          user_id: 'user-2',
          revoked: true,
          user_status: 'active',
          expires_at: new Date('2026-08-22T12:00:00.000Z'),
        },
        now,
      ),
    ).toEqual({ sessionId: 'sess-2', userId: 'user-2', status: 'closed' });

    expect(
      mapAuthSessionRow(
        {
          id: 'sess-3',
          user_id: 'user-3',
          revoked: false,
          user_status: 'active',
          expires_at: new Date('2026-08-20T12:00:00.000Z'),
        },
        now,
      ),
    ).toEqual({ sessionId: 'sess-3', userId: 'user-3', status: 'closed' });
  });
});
