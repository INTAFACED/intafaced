import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../shared/api';
import { hasSupportEventGap, supportEventsSchema } from './SupportEvents';

const ownerId = '11111111-1111-4111-8111-111111111111';
const ticketId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const event = {
  id: '44444444-4444-4444-8444-444444444444',
  ticketId,
  sequence: 1,
  kind: 'opened',
  actorId: ownerId,
  actorRole: 'user',
  fromStatus: null,
  toStatus: null,
  note: null,
  occurredAt: '2026-10-09T02:00:00.000Z',
};
async function read(rows: unknown) {
  const api = createApiClient({ fetch: async () => new Response(JSON.stringify({ result: { data: rows } })) });
  return api.query('support', 'events', { ticketId, limit: 50 }, supportEventsSchema(ticketId, 50, ownerId));
}

describe('Support event network ownership and recorded chronology', () => {
  it('refuses foreign ticket or customer identities before returning private content', async () => {
    for (const changed of [{ ticketId: otherId }, { actorId: otherId }]) {
      expect(await read([{ ...event, ...changed, note: 'foreign content' }])).toMatchObject({ ok: false, reason: 'invalid_response' });
    }
  });
  it('refuses duplicated identity, reversed sequence and invented status transitions', async () => {
    const next = { ...event, id: otherId, sequence: 2 };
    for (const rows of [[event, event], [next, event], [{ ...event, kind: 'status_changed' }], [{ ...event, toStatus: 'closed' }]]) {
      expect(await read(rows)).toMatchObject({ ok: false, reason: 'invalid_response' });
    }
  });
  it('keeps returned original records and detects sequence gaps without filling them', async () => {
    const next = {
      ...event,
      id: otherId,
      sequence: 3,
      kind: 'status_changed',
      actorRole: 'operator',
      actorId: otherId,
      fromStatus: 'open',
      toStatus: 'pending',
    };
    const result = await read([event, next]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((row) => row.sequence)).toEqual([1, 3]);
    expect(hasSupportEventGap(result.data)).toBe(true);
    expect(result.data[1]).toMatchObject({ id: otherId, fromStatus: 'open', toStatus: 'pending' });
  });
  it('accepts a move onto hold and back', async () => {
    const hold = {
      ...event,
      id: otherId,
      sequence: 2,
      kind: 'status_changed',
      actorRole: 'operator',
      actorId: otherId,
      fromStatus: 'open',
      toStatus: 'on_hold',
    };
    const result = await read([event, hold]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[1]).toMatchObject({ fromStatus: 'open', toStatus: 'on_hold' });
  });
  it('treats empty returned events as a read result, with no invented opening or current status', async () => {
    expect(await read([])).toEqual({ ok: true, data: [] });
    expect(hasSupportEventGap([])).toBe(false);
  });
});
