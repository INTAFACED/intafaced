import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { formatAmount } from '@intafaced/ledger-client/money';
import type { UserVenueAccount } from '@intafaced/venue-contracts';
import { TestVenueSimulator } from './simulator.js';
import { TEST_VENUE_MARKETS } from './http-server.js';

// A read writes nothing: J-derivatives-25 #1 compares the room's trading rows with the venue's own `/balances` for an
// empty account, so reading the account summary must leave that record as it was, whichever reads first.

describe('the TEST venue account summary', () => {
  it('reads an empty account without giving it a balance row', async () => {
    const sim = new TestVenueSimulator({ clock: () => new Date(Date.UTC(2026, 10, 24, 3)), markets: TEST_VENUE_MARKETS });
    const owner = privateKeyToAccount(keccak256(toHex('intafaced TEST venue read leaves balances'))).address.toLowerCase();
    const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };

    expect((await sim.balances(account)).value).toEqual([]);
    const summary = (await sim.accountSummary(account)).value;
    expect(summary.asset).toBe('USDC');
    expect(formatAmount(summary.equity)).toBe('0');
    expect(formatAmount(summary.free)).toBe('0');
    expect((await sim.balances(account)).value).toEqual([]);
  });
});
