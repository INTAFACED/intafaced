import { describe, expect, it } from 'vitest';
import { QUOTE, SYMBOL, balance, draft, orderOf, reviewAndPlace } from './desk';
import { bankCall } from './bank';
import { claimsOf, identityCall, type Issued } from './identity';
import { fund, ledgerAvailable, newCustomer } from './stack';

/**
 * The wallet view of the pro trader's account. The bank splits what the ledger holds by lock kind; an open order is a hold,
 * and the split must agree with the desk and the ledger: available plus locks equals the ledger total, and cancelling the
 * order moves the hold back to available.
 */
type Breakdown = {
  assets: Array<{
    assetId: string;
    available: string;
    total: string;
    locked: Array<{ kind: string; amount: string; claims: Array<{ purpose: string; amount: string }> }>;
  }>;
};

type Allocation = {
  totalValueUsd: string;
  classes: Array<{ class: string; valueUsd: string; share: string }>;
  types: Array<{ type: string; valueUsd: string; share: string }>;
};

const lineOf = (data: unknown, asset: string) => (data as Breakdown).assets.find((a) => a.assetId === asset);

describe('pro trader: wallet view', () => {
  it('shows an open order as a hold, not as available, and the parts add to what the ledger holds', async () => {
    const person = await newCustomer({ kycTier: 'full' });
    await fund(person.userId, QUOTE, '500');
    const claims = claimsOf(
      (await identityCall<Issued>('auth.login', { identifier: person.account.email, password: person.account.password }, null)).accessToken,
    );

    const before = await bankCall('portfolio.balanceBreakdown', { scope: 'main' }, claims);
    expect(before.status, before.body).toBe(200);
    expect(lineOf(before.data, QUOTE)).toMatchObject({ available: '500', total: '500' });

    const { placed } = await reviewAndPlace(person.trade, draft({ price: '80', amount: '0.1' }));
    orderOf(placed);
    const held = (await balance(person.trade, QUOTE)).used;
    expect(Number(held)).toBeGreaterThan(0);

    const open = await bankCall('portfolio.balanceBreakdown', { scope: 'main' }, claims);
    expect(open.status).toBe(200);
    const line = lineOf(open.data, QUOTE)!;
    const hold = line.locked.find((l) => l.kind === 'hold');
    expect(hold?.amount).toBe(held);
    expect(hold?.claims).toHaveLength(1);
    expect(hold?.claims[0]?.purpose).toMatch(/^order:/);
    expect(line.total).toBe('500');
    expect(line.available).toBe(await ledgerAvailable(person.userId, QUOTE));
    expect(Number(line.available) + Number(hold!.amount)).toBe(500);

    expect((await person.trade.cancelAll(SYMBOL)).ok).toBe(true);
    const after = await bankCall('portfolio.balanceBreakdown', { scope: 'main' }, claims);
    expect(lineOf(after.data, QUOTE)).toMatchObject({ available: '500', total: '500' });
    expect(lineOf(after.data, QUOTE)!.locked).toEqual([]);
  });

  it('groups the money by kind and by place, and an open order moves its stake from spendable to locked', async () => {
    const person = await newCustomer({ kycTier: 'full' });
    await fund(person.userId, QUOTE, '500');
    const claims = claimsOf(
      (await identityCall<Issued>('auth.login', { identifier: person.account.email, password: person.account.password }, null)).accessToken,
    );
    const groups = (data: unknown) => data as Allocation;

    const before = await bankCall('portfolio.allocation', undefined, claims);
    expect(before.status, before.body).toBe(200);
    expect(groups(before.data).totalValueUsd).toBe('500');
    expect(groups(before.data).classes.map((c) => [c.class, c.valueUsd])).toEqual([['stablecoin', '500']]);
    expect(groups(before.data).types).toEqual([
      { type: 'available', valueUsd: '500', share: '1' },
      { type: 'locked', valueUsd: '0', share: '0' },
    ]);

    const { placed } = await reviewAndPlace(person.trade, draft({ price: '80', amount: '0.1' }));
    orderOf(placed);
    const held = (await balance(person.trade, QUOTE)).used;
    expect(Number(held)).toBeGreaterThan(0);

    const open = groups((await bankCall('portfolio.allocation', undefined, claims)).data);
    const locked = open.types.find((t) => t.type === 'locked')!;
    const available = open.types.find((t) => t.type === 'available')!;
    expect(locked.valueUsd).toBe(held);
    expect(available.valueUsd).not.toBe('500');
    expect(open.totalValueUsd).toBe('500');
    expect(Number(available.valueUsd) + Number(locked.valueUsd)).toBe(500);
    expect(open.classes.map((c) => [c.class, c.valueUsd])).toEqual([['stablecoin', '500']]);

    expect((await person.trade.cancelAll(SYMBOL)).ok).toBe(true);
    const after = groups((await bankCall('portfolio.allocation', undefined, claims)).data);
    expect(after.types.find((t) => t.type === 'locked')!.valueUsd).toBe('0');
    expect(after.types.find((t) => t.type === 'available')!.valueUsd).toBe('500');
  });
});
