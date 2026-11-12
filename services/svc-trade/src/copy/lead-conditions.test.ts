/**
 * The outside reads applying to lead is measured by (J-copy-bots-otc-04 #1): whom the applicant follows and has not left,
 * by its listing, and the USDC of the applicant's own venue accounts as the venue reports them. TEST figures only.
 */
import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { UserVenue } from '@intafaced/venue-contracts';
import type { CopyFollow } from './follows.js';
import { leadFollowing, leadVenueUsdc } from './lead-conditions.js';

const follow = (followId: string, leaderId: string, at: number, relationshipState?: CopyFollow['relationshipState']) =>
  ({ followId, followerId: 'u', leaderId, createdAt: new Date(at), relationshipState }) as unknown as CopyFollow;

describe('leadFollowing', () => {
  const names: Record<string, { leaderRef: string; displayName: string }> = {
    l1: { leaderRef: 'ref1', displayName: 'TEST One' },
    l2: { leaderRef: 'ref2', displayName: 'TEST Two' },
  };
  const directory = { listingName: async (id: string) => names[id] ?? null };

  it('is null for someone who follows no one or has left every leader', async () => {
    expect(await leadFollowing({ follows: { listFollowsByFollower: async () => [] }, directory }, 'u')).toBeNull();
    const left = [follow('f1', 'l1', 1, 'DETACHED')];
    expect(await leadFollowing({ follows: { listFollowsByFollower: async () => left }, directory }, 'u')).toBeNull();
  });

  it('names the oldest leader still followed, paused or stopping included', async () => {
    const rows = [follow('f3', 'l1', 3, 'DETACHED'), follow('f2', 'l2', 2, 'PAUSED'), follow('f1', 'l1', 5)];
    expect(await leadFollowing({ follows: { listFollowsByFollower: async () => rows }, directory }, 'u')).toEqual(names.l2);
  });

  it('names a leader whose listing is gone as no longer listed, and still refuses on it', async () => {
    const rows = [follow('f1', 'gone', 1)];
    expect(await leadFollowing({ follows: { listFollowsByFollower: async () => rows }, directory }, 'u')).toEqual({
      leaderRef: null,
      displayName: 'a leader no longer listed',
    });
  });
});

describe('leadVenueUsdc', () => {
  const asOf = new Date('2026-11-12T00:00:00.000Z');
  const venue = (balances: Record<string, string>) =>
    ({
      venue: { id: 'test-venue', displayName: 'TEST venue', test: true },
      balances: async (account: { owner: string; subAccount: string | null }) => {
        const usdc = balances[`${account.owner}/${account.subAccount ?? ''}`];
        return {
          value: usdc === undefined ? [] : [{ asset: 'USDC', free: parseAmount(usdc), locked: 0n, total: parseAmount(usdc) }],
          asOf,
        };
      },
    }) as unknown as UserVenue;

  it('reads off with the door off and none without an account the wallet signed for', async () => {
    expect(await leadVenueUsdc({ venue: null, store: { ownerSignedAccounts: async () => [] } }, 'u')).toEqual({ state: 'off' });
    expect(await leadVenueUsdc({ venue: async () => venue({}), store: { ownerSignedAccounts: async () => [] } }, 'u')).toEqual({
      state: 'none',
    });
  });

  it("reads the richest own account's USDC as the venue reports it; an account with no USDC holds zero", async () => {
    const store = {
      ownerSignedAccounts: async (userId: string, venueId: string) => {
        expect([userId, venueId]).toEqual(['u', 'test-venue']);
        return [
          { owner: '0xa', subAccount: null },
          { owner: '0xb', subAccount: null },
          { owner: '0xc', subAccount: null },
        ];
      },
    };
    const read = await leadVenueUsdc({ venue: async () => venue({ '0xa/': '10', '0xb/': '3000.5' }), store }, 'u');
    expect(read).toEqual({ state: 'read', owner: '0xb', test: true, usdc: parseAmount('3000.5'), asOf });
    const empty = await leadVenueUsdc({ venue: async () => venue({}), store }, 'u');
    expect(empty).toMatchObject({ state: 'read', usdc: 0n });
  });

  it('throws when the venue does not answer, so the desk refuses as unreadable', async () => {
    const down = async () => {
      throw new Error('venue_down');
    };
    await expect(leadVenueUsdc({ venue: down, store: { ownerSignedAccounts: async () => [] } }, 'u')).rejects.toThrow('venue_down');
  });
});
