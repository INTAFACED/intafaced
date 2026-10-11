import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentAuthorityInput, CurrentAuthorityResult } from '@intafaced/contracts';
import { PrivateAuthorityLease, type AuthorityClock } from './authority-lease.js';
import type { CurrentAuthorityPort } from './authority.js';
import { eligibleAuthority } from '../test-support/authority.js';

const BASE = Date.parse('2026-10-10T12:00:00Z');
const subject: CurrentAuthorityInput = {
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  credential: { kind: 'session', sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
};
describe('private credential lease deadlines', () => {
  let offset = 0;
  const clock: AuthorityClock = { monotonic: () => Date.now() - BASE, wall: () => Date.now() + offset };
  beforeEach(() => {
    offset = 0;
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const acquire = (port: CurrentAuthorityPort, jwtExpiresAtMs = BASE + 60000) =>
    PrivateAuthorityLease.acquire({ port, subject, jwtExpiresAtMs, clock });

  it('renews before expiry without a heartbeat or private traffic when healthy', async () => {
    const read = vi.fn(async (input: CurrentAuthorityInput) => eligibleAuthority(input));
    const lease = await acquire({ read });
    const expired = vi.fn();
    lease.start(expired);
    await vi.advanceTimersByTimeAsync(12000);
    expect(read.mock.calls.length).toBeGreaterThan(3);
    expect(lease.isCurrent()).toBe(true);
    expect(expired).not.toHaveBeenCalled();
    lease.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['auth.account_frozen', 'auth.credential_revoked'] as const)(
    'closes idle authority for %s without an invalidation event',
    async (code) => {
      let denied = false;
      const lease = await acquire({
        async read(input) {
          return denied ? { subject: input, checkedAt: new Date().toISOString(), status: 'denied', code } : eligibleAuthority(input);
        },
      });
      const expired = vi.fn();
      lease.start(expired);
      denied = true;
      await vi.advanceTimersByTimeAsync(4999);
      expect(lease.isCurrent()).toBe(false);
      expect(expired).toHaveBeenCalledOnce();
    },
  );

  it('expires independently of a hanging renewal and ignores its later eligible response', async () => {
    let reads = 0;
    let complete!: (value: CurrentAuthorityResult) => void;
    let signal: AbortSignal | undefined;
    const lease = await acquire({
      async read(input, aborted) {
        if (++reads === 1) return eligibleAuthority(input, 100);
        signal = aborted;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    const expired = vi.fn();
    lease.start(expired);
    await vi.advanceTimersByTimeAsync(100);
    expect(signal?.aborted).toBe(true);
    expect(expired).toHaveBeenCalledOnce();
    expect(lease.isCurrent()).toBe(false);
    complete(eligibleAuthority(subject));
    await vi.advanceTimersByTimeAsync(10000);
    expect(lease.isCurrent()).toBe(false);
    expect(expired).toHaveBeenCalledOnce();
    expect(reads).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a partitioned initial check even when the port ignores AbortSignal', async () => {
    const pending = acquire({ read: () => new Promise(() => undefined) });
    const refused = expect(pending).rejects.toThrow('authority');
    await vi.advanceTimersByTimeAsync(1000);
    await refused;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never renews past JWT expiry', async () => {
    const lease = await acquire(
      {
        async read(input) {
          return eligibleAuthority(input);
        },
      },
      BASE + 100,
    );
    const expired = vi.fn();
    lease.start(expired);
    await vi.advanceTimersByTimeAsync(100);
    expect(lease.isCurrent()).toBe(false);
    expect(expired).toHaveBeenCalledOnce();
  });

  it('charges initial request latency to the positive lease', async () => {
    const pending = acquire({
      async read(input) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return eligibleAuthority(input, 200);
      },
    });
    await vi.advanceTimersByTimeAsync(80);
    const lease = await pending;
    const expired = vi.fn();
    lease.start(expired);
    await vi.advanceTimersByTimeAsync(120);
    expect(lease.isCurrent()).toBe(false);
    expect(expired).toHaveBeenCalledOnce();
  });

  it.each([-10000, 10000])('a wall-clock jump of %sms cannot extend the monotonic lease', async (jump) => {
    const lease = await acquire({
      async read(input) {
        return eligibleAuthority(input);
      },
    });
    const expired = vi.fn();
    lease.start(expired);
    offset = jump;
    await vi.advanceTimersByTimeAsync(5000);
    expect(lease.isCurrent()).toBe(false);
    expect(expired).toHaveBeenCalledOnce();
  });

  it('refuses mismatched, future, stale, oversized and unknown authority proofs', async () => {
    const foreign = { ...subject, userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const valid = eligibleAuthority(subject);
    for (const proof of [
      eligibleAuthority(foreign),
      eligibleAuthority(subject, 5000, BASE + 1),
      eligibleAuthority(subject, 5000, BASE - 6000),
      { ...valid, leaseExpiresAt: new Date(BASE + 5001).toISOString() },
      { ...valid, status: 'unknown' },
      { ...valid, checkedAt: 'invalid' },
    ]) {
      await expect(
        acquire({
          async read() {
            return proof as CurrentAuthorityResult;
          },
        }),
      ).rejects.toThrow();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
