import { beforeEach, describe, expect, it } from 'vitest';
import {
  LedgerError,
  MemoryLedger,
  formatAmount,
  houseFees,
  parseAmount,
  recipes,
  venueBuilderAccount,
  venueBuilderFeeReceivable,
  type PostRequest,
} from '@intafaced/ledger-client';
import { collectBuilderFees, type BuilderFeeClaim, type BuilderFeeClaimReader } from './builder-fee-collect.js';

/**
 * Collect (J-derivatives-17; launch money model, rule 5): one `builderFeeReceive` per claim the venue records for our
 * builder address, keyed on the venue's claim id. Against the in-memory ledger and a TEST claim reader, since the venue
 * adapter does not read the claim record yet. TEST amounts only.
 */
const a = parseAmount;
const VENUE = 'test-venue-sim';
const OURS = '0x00000000000000000000000000000000000000B7';
const THEIRS = '0x00000000000000000000000000000000000000c8';
const USER = '11111111-1111-4111-8111-1111111111c0';

let ledger: MemoryLedger;
beforeEach(() => {
  ledger = new MemoryLedger();
});
const bal = async (ref: Parameters<MemoryLedger['balance']>[0]) => formatAmount((await ledger.balance(ref)).amount);
const claim = (claimId: string, amount: string, over: Partial<BuilderFeeClaim> = {}): BuilderFeeClaim => ({
  claimId,
  builder: OURS.toLowerCase(),
  assetId: 'USDC',
  amount: a(amount),
  claimedAt: new Date('2026-11-10T10:00:00.000Z'),
  ...over,
});
const reader = (claims: readonly BuilderFeeClaim[]): BuilderFeeClaimReader => ({ venueId: VENUE, claims: async () => claims });
async function earn(fillId: string, amount: string) {
  await ledger.post(recipes.builderFeeEarn({ venueId: VENUE, fillId, assetId: 'USDC', amount: a(amount), userId: USER }));
}

describe('collectBuilderFees', () => {
  it('posts one Collect per claim the venue records for our address, keyed on the venue claim id, once', async () => {
    await earn('f1', '3');
    await earn('f2', '2');
    const r = reader([claim('c1', '1.5'), claim('c2', '2')]);
    const first = await collectBuilderFees({ reader: r, builder: OURS, ledger });
    const again = await collectBuilderFees({ reader: r, builder: OURS, ledger });
    expect(first).toEqual({ status: 'ran', venueId: VENUE, read: 2, posted: 2, notOurs: 0, refused: [] });
    expect(again.status).toBe('ran');
    expect(await ledger.getTxByKey(`builder-fee-payout:${VENUE}:c1`)).not.toBeNull();
    expect(ledger.journal().filter((t) => t.reason === 'trade.builder_fee.received')).toHaveLength(2);
    expect(await bal(venueBuilderAccount(VENUE, 'USDC'))).toBe('-3.5');
    expect(await bal(venueBuilderFeeReceivable(VENUE, 'USDC'))).toBe('-1.5');
  });

  it('invariant: owed plus collected equals earned, and revenue is what was earned, whatever is collected', async () => {
    await earn('f1', '4');
    await earn('f2', '6');
    await collectBuilderFees({ reader: reader([claim('c1', '4'), claim('c2', '5')]), builder: OURS, ledger });
    const owed = -(await ledger.balance(venueBuilderFeeReceivable(VENUE, 'USDC'))).amount;
    const collected = -(await ledger.balance(venueBuilderAccount(VENUE, 'USDC'))).amount;
    expect(formatAmount(owed + collected)).toBe('10');
    expect(await bal(houseFees('builder', 'USDC'))).toBe('10');
  });

  it('never posts a claim paid to another builder address', async () => {
    const run = await collectBuilderFees({
      reader: reader([claim('c1', '1'), claim('x1', '9', { builder: THEIRS })]),
      builder: OURS,
      ledger,
    });
    expect(run).toMatchObject({ status: 'ran', read: 2, posted: 1, notOurs: 1 });
    expect(await ledger.getTxByKey(`builder-fee-payout:${VENUE}:x1`)).toBeNull();
    expect(await bal(venueBuilderAccount(VENUE, 'USDC'))).toBe('-1');
  });

  it('waits, posting nothing, while the adapter cannot read the claim record or our address is blank', async () => {
    expect(await collectBuilderFees({ reader: null, builder: OURS, ledger })).toEqual({
      status: 'waiting',
      reason: 'trade.builder_fee_claim_read_missing',
    });
    expect(await collectBuilderFees({ reader: reader([claim('c1', '1')]), builder: '  ', ledger })).toEqual({
      status: 'waiting',
      reason: 'trade.builder_address_unset',
    });
    expect(ledger.journal()).toHaveLength(0);
  });

  it('lists a claim the ledger refuses for itself and goes on; any other refusal stops the run', async () => {
    const posts: PostRequest[] = [];
    const picky = {
      async post(req: PostRequest) {
        posts.push(req);
        if (req.meta?.claimId === 'bad') throw new LedgerError('unknown asset', 'ledger.asset_unknown');
        return ledger.post(req);
      },
    };
    const run = await collectBuilderFees({ reader: reader([claim('bad', '1'), claim('c2', '1')]), builder: OURS, ledger: picky });
    expect(run).toMatchObject({ status: 'ran', posted: 1, refused: [{ claimId: 'bad', code: 'ledger.asset_unknown' }] });

    const frozen = {
      async post() {
        throw new LedgerError('posting is frozen', 'ledger.frozen');
      },
    };
    await expect(collectBuilderFees({ reader: reader([claim('c3', '1')]), builder: OURS, ledger: frozen })).rejects.toThrow('frozen');
  });

  it('a claim of zero, or with a claim id the key cannot carry, never posts', async () => {
    const run = await collectBuilderFees({ reader: reader([claim('c:1', '1'), claim('c2', '0')]), builder: OURS, ledger });
    expect(run).toMatchObject({ status: 'ran', posted: 0, refused: [{ code: 'ledger.invalid_entry' }, { code: 'ledger.invalid_entry' }] });
    expect(ledger.journal()).toHaveLength(0);
  });
});
