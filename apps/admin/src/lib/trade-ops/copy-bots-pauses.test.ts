import { describe, expect, it } from 'vitest';
import { checkScope, parsePauseDesk, scopeText } from './copy-bots-pauses';
import { pausePayloadHash } from './copy-bots-pauses-calls';

const REQUEST = {
  id: '3f2c1b7a-0d4e-4a5b-9c6d-7e8f9a0b1c2d',
  op: 'pause',
  scope: { kind: 'symbol', value: 'ETH/USDT' },
  status: 'awaiting_second',
  approvalId: 'appr-1',
  proposedBy: 'founder-a',
  approverId: null,
  confirmedBy: null,
  requestedAt: '2026-11-07T08:00:00.000Z',
  decidedAt: null,
};

describe('the copy and bots kill switch desk (CB-ops-03)', () => {
  it('files the approval with the hash svc-trade recomputes (services/svc-trade/src/copy/platform-pauses.test.ts pins the same)', () => {
    expect(pausePayloadHash({ requestId: REQUEST.id, op: 'pause', scope: { kind: 'symbol', value: 'ETH/USDT' } })).toBe(
      'sha256:e767120e16c80b018b6fabde7b45f1f441fcc0c9ca13c549b63117b8c6349a7c',
    );
  });

  it('checks a scope the way svc-trade does', () => {
    expect(checkScope('symbol', ' eth/usdt ')).toEqual({ ok: true, scope: { kind: 'symbol', value: 'ETH/USDT' } });
    expect(checkScope('bot_type', 'Grid')).toEqual({ ok: true, scope: { kind: 'bot_type', value: 'grid' } });
    expect(checkScope('lead', 'abc_123')).toEqual({ ok: true, scope: { kind: 'lead', value: 'abc_123' } });
    expect(checkScope('symbol', 'ETHUSDT').ok).toBe(false);
    expect(checkScope('bot_type', 'dca').ok).toBe(false);
    expect(checkScope('market', 'x').ok).toBe(false);
  });

  it('reads the desk only in the shape svc-trade sends', () => {
    const desk = {
      paused: [
        { id: 'p1', scope: { kind: 'bot_type', value: 'grid' }, pausedBy: 'a', pauseApprover: 'b', pausedAt: '2026-11-07T08:00:00.000Z' },
      ],
      waiting: [REQUEST],
    };
    expect(parsePauseDesk(desk)).toEqual(desk);
    expect(parsePauseDesk({ ...desk, waiting: [{ ...REQUEST, op: 'halt' }] })).toBeNull();
    expect(parsePauseDesk({ paused: [] })).toBeNull();
    expect(scopeText({ kind: 'bot_type', value: 'grid' })).toBe('Bot type Grid');
  });
});
