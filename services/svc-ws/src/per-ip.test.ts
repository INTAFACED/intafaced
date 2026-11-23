import { describe, expect, it } from 'vitest';
import { IP_BANNED, PER_IP_CAP, PER_IP_CAP_UNSET, PerIpGuard } from './per-ip.js';

/** DV-limits-03, J-developer-09 #6: the per-IP cap and the storm ban. */
function guard(policy: Partial<{ maxConnections: number; stormsBeforeBan: number; banSeconds: number }>) {
  const clock = { now: 1_000_000 };
  const g = new PerIpGuard(
    { maxConnections: policy.maxConnections, stormsBeforeBan: policy.stormsBeforeBan, banSeconds: policy.banSeconds },
    () => clock.now,
  );
  return { g, clock };
}

function fill(g: PerIpGuard, address: string, n: number): Array<() => void> {
  const held: Array<() => void> = [];
  for (let i = 0; i < n; i += 1) {
    const a = g.admit(address);
    if (!a.ok) throw new Error(`refused at ${i}: ${a.code}`);
    held.push(a.release);
  }
  return held;
}

describe('PerIpGuard', () => {
  it('a blank cap refuses every socket by its typed code, and publishes nothing invented', () => {
    const { g } = guard({});
    expect(g.admit('127.0.0.3')).toEqual({ ok: false, code: PER_IP_CAP_UNSET });
    expect(g.view()).toEqual({ maxConnections: null, stormsBeforeBan: null, banSeconds: null, cap: 'unset', ban: 'unset' });
  });

  it('holds the cap per address: the one over it is refused, the others stay, another address is untouched', () => {
    const { g } = guard({ maxConnections: 2, stormsBeforeBan: 3, banSeconds: 20 });
    const held = fill(g, '127.0.0.3', 2);
    expect(g.admit('127.0.0.3')).toEqual({ ok: false, code: PER_IP_CAP });
    expect(g.admit('127.0.0.4').ok).toBe(true);
    held[0]!();
    expect(g.admit('127.0.0.3').ok).toBe(true);
  });

  it('a release counts once', () => {
    const { g } = guard({ maxConnections: 1 });
    const [release] = fill(g, 'a', 1);
    release!();
    release!();
    fill(g, 'a', 1);
    expect(g.admit('a')).toEqual({ ok: false, code: PER_IP_CAP });
  });

  it('repeated storms ban the address for the owner-set time, then admit it again', () => {
    const { g, clock } = guard({ maxConnections: 1, stormsBeforeBan: 3, banSeconds: 20 });
    for (let storm = 0; storm < 3; storm += 1) {
      const held = fill(g, 'a', 1);
      expect(g.admit('a')).toEqual({ ok: false, code: PER_IP_CAP });
      held.forEach((r) => r());
      clock.now += 500;
    }
    expect(g.admit('a')).toEqual({ ok: false, code: IP_BANNED });
    expect(g.admit('b').ok).toBe(true);
    clock.now += 19_000;
    expect(g.admit('a')).toEqual({ ok: false, code: IP_BANNED });
    clock.now += 1_000;
    expect(g.admit('a').ok).toBe(true);
  });

  it('storms spread wider than one ban time apart never ban', () => {
    const { g, clock } = guard({ maxConnections: 1, stormsBeforeBan: 2, banSeconds: 10 });
    for (let storm = 0; storm < 5; storm += 1) {
      const held = fill(g, 'a', 1);
      expect(g.admit('a')).toEqual({ ok: false, code: PER_IP_CAP });
      held.forEach((r) => r());
      clock.now += 10_000;
    }
    expect(g.admit('a').ok).toBe(true);
  });

  it('a blank ban time refuses to enable the ban, and says so; the cap still holds', () => {
    const { g } = guard({ maxConnections: 1, stormsBeforeBan: 2 });
    expect(g.view()).toMatchObject({ maxConnections: 1, stormsBeforeBan: 2, banSeconds: null, cap: 'set', ban: 'unset' });
    for (let storm = 0; storm < 6; storm += 1) {
      const held = fill(g, 'a', 1);
      expect(g.admit('a')).toEqual({ ok: false, code: PER_IP_CAP });
      held.forEach((r) => r());
    }
    expect(g.admit('a').ok).toBe(true);
  });

  it('forgets spent storm records, so many one-off addresses do not grow without bound', () => {
    const { g, clock } = guard({ maxConnections: 1, stormsBeforeBan: 5, banSeconds: 10 });
    for (let i = 0; i < 100; i += 1) {
      const held = fill(g, `10.0.0.${i}`, 1);
      g.admit(`10.0.0.${i}`);
      held.forEach((r) => r());
    }
    expect(g.tracked).toBe(100);
    clock.now += 10_000;
    const held = fill(g, 'z', 1);
    g.admit('z');
    held.forEach((r) => r());
    expect(g.tracked).toBe(1);
  });
});
