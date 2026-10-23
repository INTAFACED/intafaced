import { describe, expect, it } from 'vitest';
import { attemptFromRailAuthorize } from './attempts.js';

const at = new Date('2026-04-01T00:00:00.000Z');

describe('payment attempts', () => {
  it('maps a rail authorize event and skips one it cannot read', () => {
    expect(
      attemptFromRailAuthorize({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ts: at,
        payload: { ok: true, status: 'authorized', railRef: 'rail-1', amount: '10' },
      }),
    ).toEqual({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      at: '2026-04-01T00:00:00.000Z',
      status: 'authorized',
      railRef: 'rail-1',
      mapsTo: 'authorized',
    });
    expect(
      attemptFromRailAuthorize({
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        ts: at,
        payload: { ok: true, status: 'pending', railRef: '' },
      }),
    ).toMatchObject({ status: 'pending', railRef: null, mapsTo: 'created' });
    expect(
      attemptFromRailAuthorize({
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        ts: at,
        payload: { ok: false, status: 'failed', railRef: 'rail-2', failureCode: 'card.declined' },
      }),
    ).toMatchObject({ status: 'failed', railRef: 'rail-2', mapsTo: 'failed' });
    expect(attemptFromRailAuthorize({ id: 'x', ts: at, payload: { status: 'authorized' } })).toBeNull();
    expect(attemptFromRailAuthorize({ id: 'x', ts: new Date('not-a-date'), payload: { ok: true } })).toBeNull();
  });
});
