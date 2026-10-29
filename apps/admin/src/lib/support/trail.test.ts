import { describe, expect, it } from 'vitest';
import type { SupportTicketEvent } from '@intafaced/contracts';
import { lastSequence, newerByOthers, trailWords } from './trail';

const ME = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const row = (sequence: number, actorId: string, over: Partial<SupportTicketEvent> = {}): SupportTicketEvent => ({
  id: `00000000-0000-4000-8000-00000000000${sequence}`,
  ticketId: '22222222-2222-4222-8222-222222222222',
  sequence,
  kind: 'assigned',
  actorId,
  actorRole: 'operator',
  fromStatus: null,
  toStatus: null,
  note: null,
  occurredAt: '2026-10-29T12:00:00.000Z',
  ...over,
});

describe('the trail a reply is checked against', () => {
  it('the last row read is the highest sequence, 0 for none', () => {
    expect(lastSequence([])).toBe(0);
    expect(lastSequence([row(2, ME), row(5, OTHER), row(3, ME)])).toBe(5);
  });
  it("lists only someone else's rows after the one read, oldest first, and never an account read", () => {
    const rows = [
      row(4, OTHER, { kind: 'status_changed', fromStatus: 'pending', toStatus: 'on_hold', note: 'TEST' }),
      row(1, OTHER),
      row(3, ME),
      row(5, OTHER, { kind: 'grounding_read' }),
      row(6, OTHER.toUpperCase()),
    ];
    expect(newerByOthers(rows, 1, ME).map((e) => e.sequence)).toEqual([4, 6]);
    expect(newerByOthers(rows, 6, ME)).toEqual([]);
    expect(trailWords(rows[0]!)).toBe('#4 status_changed from pending to on_hold (TEST)');
  });
});
