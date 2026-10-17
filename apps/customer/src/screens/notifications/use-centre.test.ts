import { describe, expect, it } from 'vitest';
import { buildChannels } from './use-centre';

describe('buildChannels', () => {
  it("joins platform status, the person's pauses and saved addresses per channel", () => {
    const view = buildChannels(
      [
        { channel: 'inapp', configured: true, available: true },
        { channel: 'email', configured: true, available: true },
        { channel: 'sms', configured: false, available: false },
      ],
      [
        { channel: 'email', muted: true },
        { channel: 'sms', muted: false },
      ],
      [{ channel: 'email', address: 'a@b.co', verifiedAt: '2026-10-01T00:00:00.000Z' }],
    );
    expect(view.email).toEqual({
      facts: { ready: true, muted: true, target: { verified: true } },
      address: 'a@b.co',
      verifiedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(view.sms.facts).toEqual({ ready: false, muted: false, target: null });
    expect(view.push.facts).toEqual({ ready: false, muted: null, target: null });
    expect(view.push.address).toBeNull();
  });

  it('treats a channel that is configured but not available as not ready', () => {
    const view = buildChannels([{ channel: 'email', configured: true, available: false }], [], []);
    expect(view.email.facts.ready).toBe(false);
  });

  it('marks a saved address with no confirmation time as unconfirmed', () => {
    const view = buildChannels([], [], [{ channel: 'sms', address: '+447700900000', verifiedAt: null }]);
    expect(view.sms.facts.target).toEqual({ verified: false });
  });
});
