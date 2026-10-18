import { describe, expect, it } from 'vitest';
import { RAIL_NO_REASON, railDetail, railName } from './rails';

describe('rail names and reasons', () => {
  it('never labels a rail TEST or live: the founder read has no mode', () => {
    for (const id of ['crypto-native', 'card-sandbox', 'bank-payout']) expect(railName(id)).not.toMatch(/TEST|live/i);
  });

  it('names the known rails and leaves an unknown id as the service sent it', () => {
    expect(railName('crypto-native')).toBe('Crypto transfers');
    expect(railName('card-sandbox')).toBe('Cards');
    expect(railName('bank-payout')).toBe('Bank payouts');
    expect(railName('sepa')).toBe('sepa');
  });

  it('a down rail always says why: its own reason, else that it gave none', () => {
    expect(railDetail({ ok: false, detail: 'sandbox acquirer marked down' })).toBe('sandbox acquirer marked down');
    expect(railDetail({ ok: false, detail: null })).toBe(RAIL_NO_REASON);
    expect(railDetail({ ok: false, detail: '   ' })).toBe('The rail did not report a reason.');
  });

  it('an up rail with nothing to add stays a dash', () => {
    expect(railDetail({ ok: true, detail: null })).toBe('—');
  });

  describe('typed health reasons from svc-pay', () => {
    it('rail.health_stale says how long the rail has been silent', () => {
      expect(railDetail({ ok: false, detail: 'rail.health_stale ageMs=45000' })).toBe(
        'No health report in the last 30 seconds (the last one was 45 seconds ago)',
      );
      expect(railDetail({ ok: false, detail: 'rail.health_stale' })).toBe('No health report in the last 30 seconds');
      expect(railDetail({ ok: false, detail: 'rail.health_stale ageMs=abc' })).toBe('No health report in the last 30 seconds');
    });

    it('rail.probe_failed', () => {
      expect(railDetail({ ok: false, detail: 'rail.probe_failed' })).toBe('The last health check failed, so the rail is treated as down');
    });

    it('rail.marked_down', () => {
      expect(railDetail({ ok: false, detail: 'rail.marked_down' })).toBe('An operator marked this rail down');
    });

    it('rail.rpc_unset reads differently when the rail is up on the test chain and when it is down', () => {
      expect(railDetail({ ok: true, detail: 'rail.rpc_unset' })).toBe(
        'Running on the built-in test chain: no blockchain node is connected',
      );
      expect(railDetail({ ok: false, detail: 'rail.rpc_unset' })).toBe(
        'No blockchain node is connected, so the rail cannot send or confirm transfers',
      );
    });

    it('rail.sandbox_only', () => {
      expect(railDetail({ ok: true, detail: 'rail.sandbox_only' })).toBe('Test acquirer only: it does not move real money');
    });

    it('rail.unhealthy is the service saying it gave no cause, not a missing reason', () => {
      const out = railDetail({ ok: false, detail: 'rail.unhealthy' });
      expect(out).toBe('The rail reported itself unhealthy without saying why');
      expect(out).not.toBe(RAIL_NO_REASON);
    });

    it('a typed code this console does not know is shown as sent, never guessed at', () => {
      expect(railDetail({ ok: false, detail: 'rail.brand_new_reason x=1' })).toBe(
        'The rail reported a reason this console does not know: rail.brand_new_reason x=1',
      );
    });

    it("keeps the service's own free-text detail", () => {
      const text = 'bank-payout has nothing configured — sponsor bank / licence required (socket.psp-partners). Every call refuses.';
      expect(railDetail({ ok: false, detail: text })).toBe(text);
      expect(railDetail({ ok: false, detail: 'timeout' })).toBe('timeout');
    });

    it('only a truly missing reason says the rail did not report one', () => {
      expect(railDetail({ ok: false, detail: null })).toBe(RAIL_NO_REASON);
      expect(railDetail({ ok: false, detail: '' })).toBe(RAIL_NO_REASON);
    });
  });
});

describe('stale rail age', () => {
  it('rounds up so the age never equals the limit, and ignores a missing age', () => {
    expect(railDetail({ ok: false, detail: 'rail.health_stale ageMs=30400' })).toContain('31 seconds ago');
    expect(railDetail({ ok: false, detail: 'rail.health_stale ageMs=' })).not.toContain('seconds ago)');
  });
});
