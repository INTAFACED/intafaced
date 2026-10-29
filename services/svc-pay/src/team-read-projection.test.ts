import { describe, expect, it } from 'vitest';
import { railPayload } from './payment-service/internal.js';
import { projectTeamHistoryEvent } from './team-read-projection.js';

const at = new Date('2026-10-29T06:00:00.000Z');

describe('the confirmation count a merchant reads while a crypto payment waits (J-merchant-05 #4)', () => {
  it('a pending rail result keeps how deep its transfer is and how deep it must be', () => {
    const payload = railPayload({
      ok: true,
      status: 'pending',
      railRef: 'addr',
      amount: 60n,
      assetId: 'USDT',
      at,
      raw: { received: '60', missing: '40', confirming: '40', required: 6, confirmations: 2 },
    } as Parameters<typeof railPayload>[0]);
    expect(payload).toMatchObject({ confirmations: 2, required: 6 });
    const plain = railPayload({ ok: true, status: 'pending', railRef: 'addr', amount: 0n, assetId: 'USDT', at, raw: {} } as Parameters<
      typeof railPayload
    >[0]);
    expect(plain).not.toHaveProperty('confirmations');
  });

  it('a team reader gets the count, never the rest of the payload', () => {
    const team = projectTeamHistoryEvent({
      id: 'e1',
      event: 'rail.pending',
      payload: { amount: '60', assetId: 'USDT', confirmations: 2, required: 6, railRef: 'addr_secret' },
      ts: at,
    });
    expect(team).toEqual({
      id: 'e1',
      event: 'rail.pending',
      ts: at.toISOString(),
      amount: '60',
      assetId: 'USDT',
      failure: null,
      confirmations: { seen: 2, required: 6 },
    });
    expect(projectTeamHistoryEvent({ id: 'e2', event: 'rail.pending', payload: { confirmations: 2 }, ts: at }).confirmations).toBeNull();
    expect(
      projectTeamHistoryEvent({ id: 'e3', event: 'rail.pending', payload: { confirmations: -1, required: 6 }, ts: at }).confirmations,
    ).toBeNull();
  });
});
