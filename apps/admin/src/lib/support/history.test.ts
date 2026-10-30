import { describe, expect, it } from 'vitest';
import type { SupportTicketEvent, SupportTicketPropertyChange } from '@intafaced/contracts';
import { historyRows } from './history';

const T = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';

const event = (sequence: number, at: string, over: Partial<SupportTicketEvent> = {}): SupportTicketEvent => ({
  id: `00000000-0000-4000-8000-00000000000${sequence}`,
  ticketId: T,
  sequence,
  kind: 'opened',
  actorId: A,
  actorRole: 'user',
  fromStatus: null,
  toStatus: null,
  note: null,
  occurredAt: at,
  ...over,
});

const base = { logId: '3', ticketId: T, setBy: A, reason: null, setAt: '2026-10-29T10:00:00.000Z' };

describe('historyRows', () => {
  it('makes one row per changed field, naming the field, its old and new value, and the operator', () => {
    const changes: SupportTicketPropertyChange[] = [
      { ...base, field: 'priority', from: null, to: 'high' },
      { ...base, field: 'type', from: 'question', to: null },
      { ...base, field: 'labels', from: ['a'], to: ['a', 'vip'] },
    ];
    const rows = historyRows([], changes);
    expect(rows.map((r) => r.what)).toEqual(['priority none → high', 'type question → none', 'labels a → a, vip']);
    expect(rows.every((r) => r.sequence === null && r.actorRole === 'operator' && r.actorId === A)).toBe(true);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });

  it('puts trail events and property changes in time order, the trail first at the same instant', () => {
    const rows = historyRows(
      [
        event(1, '2026-10-29T09:00:00.000Z'),
        event(2, '2026-10-29T10:00:00.000Z', { kind: 'status_changed', fromStatus: 'open', toStatus: 'pending', actorRole: 'operator' }),
        event(3, '2026-10-29T11:00:00.000Z', { kind: 'assigned', actorRole: 'operator' }),
      ],
      [{ ...base, field: 'labels', from: [], to: ['vip'], reason: 'big account' }],
    );
    expect(rows.map((r) => r.what)).toEqual(['opened', 'status open → pending', 'labels none → vip', 'assigned']);
    expect(rows[2]).toMatchObject({ note: 'big account' });
  });
});
