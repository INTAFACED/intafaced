import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { BADGE_RECORD_UNREADABLE, badgeClaimKey } from './founding-badge.js';
import { PostgresBadgeStore } from './founding-badge.pg.js';

/** RC-more-catalogue-04 auto-review minor: an unparseable stored mint-slot time is a typed refusal, not a 500. */
const ACCOUNT = 'bad9e000-ffff-4fff-8fff-ffffffffffff';
const row = (minting_at: unknown) => ({
  key: badgeClaimKey(ACCOUNT),
  account_id: ACCOUNT,
  chain_id: 31337,
  to_address: '0x00000000000000000000000000000000000000f1',
  tx_hash: null,
  minting_at,
});
const fakeSql = (rows: unknown[]) => (async () => rows) as unknown as Sql;

describe('founding badge store row guard', () => {
  it('an unparseable mint-slot time refuses badge.record_unreadable', async () => {
    const store = new PostgresBadgeStore(fakeSql([row('not-a-time')]));
    await expect(store.findClaim(badgeClaimKey(ACCOUNT))).rejects.toMatchObject({ code: BADGE_RECORD_UNREADABLE });
  });

  it('text and Date mint-slot times both read back as the same Date; null stays null', async () => {
    const iso = '2026-10-22T03:00:00.000Z';
    expect((await new PostgresBadgeStore(fakeSql([row('2026-10-22 11:00:00+08')])).findClaim('k'))!.mintingSince!.toISOString()).toBe(iso);
    expect((await new PostgresBadgeStore(fakeSql([row(new Date(iso))])).findClaim('k'))!.mintingSince!.toISOString()).toBe(iso);
    expect((await new PostgresBadgeStore(fakeSql([row(null)])).findClaim('k'))!.mintingSince).toBeNull();
  });
});
