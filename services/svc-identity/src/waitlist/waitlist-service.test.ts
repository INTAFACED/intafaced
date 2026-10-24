import { describe, expect, it } from 'vitest';
import { FlagDisabledError, type FlagContext } from '@intafaced/config';
import { MemoryWaitlistStore, type WaitlistStore } from './waitlist-store.js';
import { parseWaveSize, WaitlistError, WaitlistService } from './waitlist-service.js';

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
      async standing() {
        return { rank: null, waiting: 0, release: null };
      },
      async waitingCount() {
        return 0;
      },
      async waves() {
        return [];
      },
      async releaseWave() {
        throw new Error('not used');
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

describe('WaitlistService — referral rank and waves (RC-campaigns-03)', () => {
  const OPERATOR = '11111111-1111-4111-8111-111111111111';
  const APPROVER = '22222222-2222-4222-8222-222222222222';

  async function threeWithReferrals(svc: WaitlistService) {
    const a = await svc.enroll({ email: 'a@example.com' });
    const b = await svc.enroll({ email: 'b@example.com' });
    const c = await svc.enroll({ email: 'c@example.com' });
    await svc.enroll({ email: 'c1@example.com', referralCode: c.entry.referralCode });
    await svc.enroll({ email: 'c2@example.com', referralCode: c.entry.referralCode });
    return { a, b, c };
  }

  it('ranks by referrals, then join order: the third entry with two referrals ranks first', async () => {
    const svc = new WaitlistService(new MemoryWaitlistStore(), flags(), 2);
    const { a, b, c } = await threeWithReferrals(svc);
    expect((await svc.position(c.entry.referralCode)).rank).toBe(1);
    expect((await svc.position(a.entry.referralCode)).rank).toBe(2);
    expect((await svc.position(b.entry.referralCode)).rank).toBe(3);
    const place = await svc.position(a.entry.referralCode);
    expect(place.position).toBe(1);
    expect(place.waiting).toBe(5);
    expect(place.release).toBeNull();
    // One referral moves b above a; a tie at one each goes back to join order, so a is ahead again.
    await svc.enroll({ email: 'b1@example.com', referralCode: b.entry.referralCode });
    expect((await svc.position(b.entry.referralCode)).rank).toBe(2);
    await svc.enroll({ email: 'a1@example.com', referralCode: a.entry.referralCode });
    expect((await svc.position(a.entry.referralCode)).rank).toBe(2);
    expect((await svc.position(b.entry.referralCode)).rank).toBe(3);
  });

  it('a wave of 2 releases the top two once; the same wave again spends no approval and releases nobody new', async () => {
    const svc = new WaitlistService(new MemoryWaitlistStore(), flags(), 2);
    const { a, b, c } = await threeWithReferrals(svc);
    const sizes: number[] = [];
    const authorize = async (size: number) => {
      sizes.push(size);
      return { approverId: APPROVER };
    };
    const first = await svc.release({ waveNumber: 1, releasedBy: OPERATOR }, authorize);
    expect(first.created).toBe(true);
    expect(first.wave).toMatchObject({ waveNumber: 1, size: 2, releasedCount: 2, flagKey: 'waitlist.enabled', approvedBy: APPROVER });
    const again = await svc.release({ waveNumber: 1, releasedBy: OPERATOR }, authorize);
    expect(again).toEqual({ wave: first.wave, created: false });
    expect(sizes).toEqual([2]);

    const pc = await svc.position(c.entry.referralCode);
    const pa = await svc.position(a.entry.referralCode);
    const pb = await svc.position(b.entry.referralCode);
    expect(pc).toMatchObject({ rank: null, release: { waveNumber: 1 } });
    expect(pa).toMatchObject({ rank: null, release: { waveNumber: 1 } });
    expect(pb).toMatchObject({ rank: 1, release: null, waiting: 3 });
    expect((await svc.waves()).waves).toHaveLength(1);
    expect((await svc.waves()).nextWave).toBe(2);
  });

  it('a blank wave size refuses drop.wave_unset before the approval and releases nobody', async () => {
    const svc = new WaitlistService(new MemoryWaitlistStore(), flags());
    const { a } = await threeWithReferrals(svc);
    let asked = 0;
    await expect(
      svc.release({ waveNumber: 1, releasedBy: OPERATOR }, async () => {
        asked++;
        return { approverId: APPROVER };
      }),
    ).rejects.toMatchObject({ code: 'drop.wave_unset' });
    expect(asked).toBe(0);
    expect((await svc.waves()).waveSize).toBeNull();
    expect((await svc.waves()).waves).toEqual([]);
    expect((await svc.position(a.entry.referralCode)).release).toBeNull();
  });

  it('the flag off refuses with the named flag code and releases nobody', async () => {
    const store = new MemoryWaitlistStore();
    const open = new WaitlistService(store, flags(), 2);
    const { a } = await threeWithReferrals(open);
    const closed = new WaitlistService(store, flags({ 'waitlist.enabled': false }), 2);
    let asked = 0;
    await expect(
      closed.release({ waveNumber: 1, releasedBy: OPERATOR }, async () => {
        asked++;
        return { approverId: APPROVER };
      }),
    ).rejects.toMatchObject({ code: 'flag.waitlist.enabled.disabled' });
    expect(asked).toBe(0);
    expect((await open.position(a.entry.referralCode)).release).toBeNull();
  });

  it('refuses a wave number that is not the next one, and an empty queue, without spending the approval', async () => {
    const svc = new WaitlistService(new MemoryWaitlistStore(), flags(), 2);
    let asked = 0;
    const authorize = async () => {
      asked++;
      return { approverId: APPROVER };
    };
    await expect(svc.release({ waveNumber: 1, releasedBy: OPERATOR }, authorize)).rejects.toMatchObject({ code: 'waitlist.wave_empty' });
    await svc.enroll({ email: 'a@example.com' });
    await expect(svc.release({ waveNumber: 2, releasedBy: OPERATOR }, authorize)).rejects.toMatchObject({ code: 'waitlist.wave_unknown' });
    expect(asked).toBe(0);
    await expect(svc.release({ waveNumber: 1, releasedBy: OPERATOR }, authorize)).resolves.toMatchObject({ wave: { releasedCount: 1 } });
    await expect(svc.release({ waveNumber: 2, releasedBy: OPERATOR }, authorize)).rejects.toMatchObject({ code: 'waitlist.wave_empty' });
    expect(asked).toBe(1);
  });

  it('a refused approval releases nobody', async () => {
    const svc = new WaitlistService(new MemoryWaitlistStore(), flags(), 2);
    const { a } = await threeWithReferrals(svc);
    await expect(
      svc.release({ waveNumber: 1, releasedBy: OPERATOR }, async () => {
        throw new Error('action_approval.same_person');
      }),
    ).rejects.toThrow('action_approval.same_person');
    expect((await svc.waves()).waves).toEqual([]);
    expect((await svc.position(a.entry.referralCode)).rank).toBe(2);
  });

  it('parses the owner wave size: blank is unset, junk stops the service', () => {
    expect(parseWaveSize(undefined)).toBeUndefined();
    expect(parseWaveSize('  ')).toBeUndefined();
    expect(parseWaveSize('2')).toBe(2);
    expect(() => parseWaveSize('0')).toThrow();
    expect(() => parseWaveSize('2.5')).toThrow();
  });
});
