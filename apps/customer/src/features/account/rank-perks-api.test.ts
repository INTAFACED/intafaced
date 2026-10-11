import { describe, expect, it } from 'vitest';
import { accountPerks, formatXp, rankForOwner } from './rank-perks-api';

const owner = '11111111-1111-4111-8111-111111111111';
const rank = { userId: owner, rank: 2, xp: '2500', seasonXp: '400', nextRankAt: '1500', updatedAt: '2026-10-10T08:00:00.000Z' };
const perks = {
  feeDiscountBps: 50,
  p2pLimitMultiplier: 1.5,
  copyFollowerCap: 10,
  lobbyHostRights: false,
  cardTier: 'none',
  otcAccess: false,
  launchpadTier: 0,
};

describe('actual self-rank wire boundary', () => {
  it('preserves exact large XP and configured zero without borrowed thresholds', () => {
    const input = { ...rank, rank: 0, xp: '0', seasonXp: '0', nextRankAt: '9223372036854775807' };
    expect(rankForOwner(owner).parse(input)).toEqual(input);
    expect(rankForOwner(owner).parse({ ...rank, xp: '9223372036854775807', nextRankAt: null }).nextRankAt).toBeNull();
  });
  it.each(['-1', '1.5', '01', '1e3', '', ' 5', 'NaN'])('refuses noncanonical XP %s', (value) => {
    for (const field of ['xp', 'seasonXp', 'nextRankAt'])
      expect(rankForOwner(owner).safeParse({ ...rank, [field]: value }).success).toBe(false);
  });
  it.each(['2026-02-31T08:00:00.000Z', '2026-13-10T08:00:00.000Z', 'not a date', '9999-99-99T08:00:00.000Z'])(
    'refuses a fabricated or nonrenderable timestamp %s',
    (updatedAt) => {
      expect(rankForOwner(owner).safeParse({ ...rank, updatedAt }).success).toBe(false);
    },
  );
  it('refuses another owner, missing fields and unsafe rank', () => {
    expect(rankForOwner(owner).safeParse({ ...rank, userId: '22222222-2222-4222-8222-222222222222' }).success).toBe(false);
    expect(rankForOwner(owner).safeParse({ ...rank, xp: 2500 }).success).toBe(false);
    expect(rankForOwner(owner).safeParse({ ...rank, rank: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(rankForOwner(owner).safeParse({}).success).toBe(false);
  });
  it.each(['en', 'es', 'fr'])('formats bigint XP exactly in %s', (locale) => {
    const value = '9223372036854775807';
    expect(formatXp(value, locale).replace(/\D/g, '')).toBe(value);
    expect(formatXp('0', locale)).toBe('0');
  });
});
describe('seven independent perk projections', () => {
  it('reads actual values without synthesizing zero or an owner/timestamp', () => {
    expect(accountPerks.parse(perks)).toEqual(perks);
    expect(accountPerks.safeParse(null).success).toBe(false);
    expect(accountPerks.safeParse({}).success).toBe(false);
  });
  it.each([
    { feeDiscountBps: 10001 },
    { p2pLimitMultiplier: Infinity },
    { copyFollowerCap: Number.MAX_SAFE_INTEGER + 1 },
    { launchpadTier: -1 },
    { lobbyHostRights: 'yes' },
    { cardTier: 'issued' },
    { otcAccess: 1 },
  ])('refuses malformed projection %j', (invalid) => {
    expect(accountPerks.safeParse({ ...perks, ...invalid }).success).toBe(false);
  });
});
