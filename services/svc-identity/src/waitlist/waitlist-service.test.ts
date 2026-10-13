import { describe, expect, it } from 'vitest';
import { FlagDisabledError, type FlagContext } from '@intafaced/config';
import { MemoryWaitlistStore, type WaitlistStore } from './waitlist-store.js';
import { WaitlistError, WaitlistService } from './waitlist-service.js';

function flags(overrides: FlagContext['overrides'] = {}, drop: FlagContext['drop'] = '0'): FlagContext {
  return { drop, overrides };
}

function openService(): WaitlistService {
  return new WaitlistService(new MemoryWaitlistStore(), flags());
}

describe('WaitlistService — flag refuse-close', () => {
  it('enrolls when the compose pin is blank — an empty string is not off', async () => {
    const svc = new WaitlistService(new MemoryWaitlistStore(), {
      drop: '0',
      env: {
        INTAFACED_FLAG_WAITLIST_ENABLED: '',
        INTAFACED_FLAG_REFERRAL_QUEUE: '   ',
      },
    });
    const first = await svc.enroll({ email: 'ada@example.com' });
    const second = await svc.enroll({ email: 'bob@example.com', referralCode: first.entry.referralCode });
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.entry.referredBy).toBe(first.entry.referralCode);
    const place = await svc.position(first.entry.referralCode);
    expect(place.position).toBe(1);
    expect(place.referredCount).toBe(1);
    expect(place.queueLength).toBe(2);
  });

  it('refuses when the pin is the word off, and names the env source', async () => {
    const svc = new WaitlistService(new MemoryWaitlistStore(), {
      drop: '0',
      env: { INTAFACED_FLAG_WAITLIST_ENABLED: 'off' },
    });
    await expect(svc.enroll({ email: 'ada@example.com' })).rejects.toMatchObject({
      code: 'flag.waitlist.enabled.disabled',
      source: 'env',
    });
  });

  it('enrolls at drop 0 when both flags follow the clock', async () => {
    const svc = openService();
    const out = await svc.enroll({ email: 'ada@example.com' });
    expect(out.created).toBe(true);
    expect(out.entry.position).toBe(1);
    expect(out.entry.referralCode).toMatch(/^[a-f0-9]{12}$/);
    expect(out.entry.referredBy).toBeNull();
  });

  it('refuses enroll when waitlist.enabled is overridden off — no row', async () => {
    const store = new MemoryWaitlistStore();
    const svc = new WaitlistService(store, flags({ 'waitlist.enabled': false }));
    await expect(svc.enroll({ email: 'ada@example.com' })).rejects.toBeInstanceOf(FlagDisabledError);
    try {
      await svc.enroll({ email: 'ada@example.com' });
      expect.unreachable('must refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(FlagDisabledError);
      const e = err as FlagDisabledError;
      expect(e.code).toBe('flag.waitlist.enabled.disabled');
      expect(e.key).toBe('waitlist.enabled');
    }
    expect(await store.count()).toBe(0);
  });

  it('refuses enroll-with-code when referral.queue is pinned off — does not silent-drop the code', async () => {
    const store = new MemoryWaitlistStore();
    const open = new WaitlistService(store, flags());
    const referrer = await open.enroll({ email: 'ref@example.com' });

    const closed = new WaitlistService(store, flags({ 'referral.queue': false }));
    await expect(closed.enroll({ email: 'ada@example.com', referralCode: referrer.entry.referralCode })).rejects.toMatchObject({
      code: 'flag.referral.queue.disabled',
    });
    expect(await store.getByEmail('ada@example.com')).toBeNull();
    expect((await store.getByCode(referrer.entry.referralCode))?.referredCount).toBe(0);
  });

  it('still enrolls without a code when referral.queue is off', async () => {
    const svc = new WaitlistService(new MemoryWaitlistStore(), flags({ 'referral.queue': false }));
    const out = await svc.enroll({ email: 'ada@example.com' });
    expect(out.created).toBe(true);
    expect(out.entry.referredBy).toBeNull();
  });

  it('refuses position when referral.queue is off', async () => {
    const store = new MemoryWaitlistStore();
    const open = new WaitlistService(store, flags());
    const row = await open.enroll({ email: 'ada@example.com' });
    const closed = new WaitlistService(store, flags({ 'referral.queue': false }));
    await expect(closed.position(row.entry.referralCode)).rejects.toBeInstanceOf(FlagDisabledError);
  });

  it('refuses operator list when waitlist.enabled is off', async () => {
    const svc = new WaitlistService(new MemoryWaitlistStore(), flags({ 'waitlist.enabled': false }));
    await expect(svc.list({ limit: 10, offset: 0 })).rejects.toBeInstanceOf(FlagDisabledError);
  });
});

describe('WaitlistService — queue + referral attribution', () => {
  it('assigns FIFO positions and is idempotent on email', async () => {
    const svc = openService();
    const a = await svc.enroll({ email: 'Ada@example.com' });
    const b = await svc.enroll({ email: 'bob@example.com' });
    const again = await svc.enroll({ email: 'ada@example.com' });
    expect(a.entry.position).toBe(1);
    expect(b.entry.position).toBe(2);
    expect(again.created).toBe(false);
    expect(again.entry.referralCode).toBe(a.entry.referralCode);
    expect(again.entry.position).toBe(1);
  });

  it('attaches a referral on a later enroll when the row had none', async () => {
    const svc = openService();
    const ref = await svc.enroll({ email: 'ref@example.com' });
    const first = await svc.enroll({ email: 'ada@example.com' });
    const again = await svc.enroll({ email: 'ada@example.com', referralCode: ref.entry.referralCode });
    expect(again.created).toBe(false);
    expect(again.entry.position).toBe(first.entry.position);
    expect(again.entry.referredBy).toBe(ref.entry.referralCode);
    const place = await svc.position(ref.entry.referralCode);
    expect(place.referredCount).toBe(1);
  });

  it('refuses a second, different referral code instead of dropping it', async () => {
    const svc = openService();
    const ref = await svc.enroll({ email: 'ref@example.com' });
    const other = await svc.enroll({ email: 'other@example.com' });
    await svc.enroll({ email: 'ada@example.com', referralCode: ref.entry.referralCode });
    await expect(svc.enroll({ email: 'ada@example.com', referralCode: other.entry.referralCode })).rejects.toMatchObject({
      code: 'waitlist.referral_locked',
    });
    expect((await svc.position(ref.entry.referralCode)).referredCount).toBe(1);
    expect((await svc.position(other.entry.referralCode)).referredCount).toBe(0);
  });

  it('refuses an unknown code on a repeat enroll — the row stays and the code is not dropped', async () => {
    const store = new MemoryWaitlistStore();
    const svc = new WaitlistService(store, flags());
    await svc.enroll({ email: 'ada@example.com' });
    await expect(svc.enroll({ email: 'ada@example.com', referralCode: 'bbbbbbbbbbbb' })).rejects.toMatchObject({
      code: 'waitlist.unknown_referrer',
    });
    expect((await store.getByEmail('ada@example.com'))?.referredBy).toBeNull();
  });

  it('records a referral without inventing a reward or moving position', async () => {
    const svc = openService();
    const ref = await svc.enroll({ email: 'ref@example.com' });
    const kid = await svc.enroll({ email: 'kid@example.com', referralCode: ref.entry.referralCode });
    expect(kid.created).toBe(true);
    expect(kid.entry.referredBy).toBe(ref.entry.referralCode);
    expect(kid.entry.position).toBe(2);

    const pos = await svc.position(ref.entry.referralCode);
    expect(pos.position).toBe(1);
    expect(pos.referredCount).toBe(1);
    expect(pos.queueLength).toBe(2);
  });

  it('refuses an unknown referral code — no silent enroll', async () => {
    const store = new MemoryWaitlistStore();
    const svc = new WaitlistService(store, flags());
    await expect(svc.enroll({ email: 'ada@example.com', referralCode: 'aaaaaaaaaaaa' })).rejects.toMatchObject({
      code: 'waitlist.unknown_referrer',
    });
    expect(await store.count()).toBe(0);
  });

  it('refuses a malformed referral code', async () => {
    const svc = openService();
    await expect(svc.enroll({ email: 'ada@example.com', referralCode: 'not-a-code' })).rejects.toBeInstanceOf(WaitlistError);
  });

  it('sends the trimmed referral code, and a blank code as null without the referral queue', async () => {
    const seen: Array<string | null | undefined> = [];
    const store: WaitlistStore = {
      async enroll(input) {
        seen.push(input.referredBy);
        return {
          created: true,
          entry: {
            id: 'row',
            email: input.email,
            referralCode: 'observed',
            referredBy: input.referredBy ?? null,
            position: seen.length,
            referredCount: 0,
            createdAt: new Date(0),
          },
        };
      },
      async getByCode() {
        return null;
      },
      async getByEmail() {
        return null;
      },
      async list() {
        return { total: 0, entries: [] };
      },
      async count() {
        return 0;
      },
    };

    const open = new WaitlistService(store, flags());
    const padded = await open.enroll({ email: 'ada@example.com', referralCode: ' code ' });
    expect(padded.entry.referredBy).toBe('code');
    expect(seen[0]).toBe('code');

    const closed = new WaitlistService(store, flags({ 'referral.queue': false }));
    const blank = await closed.enroll({ email: 'blank@example.com', referralCode: '   ' });
    expect(blank.entry.referredBy).toBeNull();
    expect(seen[1]).toBeNull();

    const omitted = await closed.enroll({ email: 'omit@example.com' });
    expect(omitted.entry.referredBy).toBeNull();
    expect(seen[2]).toBeNull();
  });

  it('lists FIFO for the operator including email', async () => {
    const svc = openService();
    await svc.enroll({ email: 'a@example.com' });
    await svc.enroll({ email: 'b@example.com' });
    const list = await svc.list({ limit: 10, offset: 0 });
    expect(list.total).toBe(2);
    expect(list.entries.map((e) => e.email)).toEqual(['a@example.com', 'b@example.com']);
  });
});
