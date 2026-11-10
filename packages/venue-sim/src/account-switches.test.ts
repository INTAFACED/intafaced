import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { decodeVenueWire, encodeVenueWire, type PreparedVenueAction, type UserVenueAccount } from '@intafaced/venue-contracts';
import { TestVenueSimulator } from './simulator.js';
import type { TestVenueTypedData } from './signing.js';
import { TEST_VENUE_MARKETS, answerTestVenue } from './http-server.js';

// `/test/account-switches` (J-developer-05): a TEST switch on one owner's account only, so one journey can take the venue
// away from its own person, lose its answer or hold its submit, and every other account is untouched.

const key = (name: string) => privateKeyToAccount(keccak256(toHex(`intafaced TEST wallet switches ${name}`)));

async function call(sim: TestVenueSimulator, path: string, body: unknown) {
  const [status, out] = await answerTestVenue(sim, 'POST', path, JSON.stringify(encodeVenueWire(body)));
  return { status, out: decodeVenueWire<Record<string, unknown>>(out) };
}

describe('the TEST venue per-account switches', () => {
  const sim = new TestVenueSimulator({ clock: () => new Date(Date.UTC(2026, 10, 10, 3)), markets: TEST_VENUE_MARKETS });
  const mine = key('mine');
  const other = key('other');
  const acct = (k: typeof mine): UserVenueAccount => ({ venueId: sim.venue.id, owner: k.address.toLowerCase(), subAccount: null });
  sim.deposit(acct(mine), 'USDC', parseAmount('1000'), 'seed:mine');
  sim.deposit(acct(other), 'USDC', parseAmount('1000'), 'seed:other');

  async function signedOrder(k: typeof mine, n: number) {
    const signer = { role: 'owner' as const, address: k.address.toLowerCase() };
    const intent = {
      kind: 'place_order',
      symbol: 'BTC-USDC',
      side: 'buy',
      type: 'limit',
      amount: parseAmount('0.001'),
      price: parseAmount('30000'),
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: `order:switches:${n}`,
      builderFee: null,
    };
    const { out: prepared } = await call(sim, '/prepare', { account: acct(k), signer, intent });
    const t = (prepared as unknown as PreparedVenueAction).typedData as TestVenueTypedData;
    const signature = await k.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    return { prepared, signature: { digest: (prepared as unknown as PreparedVenueAction).digest, signature, signedBy: signer.address } };
  }

  it('down refuses only that account; lost answers apply the order and answer not definite; others are untouched', async () => {
    expect((await call(sim, '/test/account-switches', { owner: mine.address, down: true })).status).toBe(200);
    expect((await call(sim, '/balances', { account: acct(mine) })).out).toMatchObject({ refusal: { code: 'venue_down' } });
    expect((await call(sim, '/balances', { account: acct(other) })).status).toBe(200);
    await call(sim, '/test/account-switches', { owner: mine.address, down: false, loseAnswers: 1 });

    const order = await signedOrder(mine, 1);
    const lost = await call(sim, '/submit', order);
    expect(lost.out).toEqual({ definite: false, reason: 'timeout' });
    // The venue applied it: the same bytes again answer the venue's first answer, and there is one order.
    const again = await call(sim, '/submit', order);
    expect(again.out).toMatchObject({ definite: true, accepted: true });
    expect(((await call(sim, '/open-orders', { account: acct(mine) })).out.value as unknown[]).length).toBe(1);

    const theirs = await call(sim, '/submit', await signedOrder(other, 2));
    expect(theirs.out).toMatchObject({ definite: true, accepted: true });
  });

  it('failAfterSend applies the order and answers a 5xx; the same bytes again are the venue answer, one order', async () => {
    await call(sim, '/test/account-switches', { owner: mine.address, failAfterSend: 1 });
    const order = await signedOrder(mine, 3);
    const failed = await call(sim, '/submit', order);
    expect(failed.status).toBe(500);
    const again = await call(sim, '/submit', order);
    expect(again.out).toMatchObject({ definite: true, accepted: true });
    const open = (await call(sim, '/open-orders', { account: acct(mine) })).out.value as { venueClientOrderId: string }[];
    expect(open.filter((o) => o.venueClientOrderId === (order.prepared as unknown as PreparedVenueAction).venueClientOrderId)).toHaveLength(
      1,
    );
  });

  it('refuses a malformed switch', async () => {
    expect((await call(sim, '/test/account-switches', { owner: 'nobody', down: true })).status).toBe(400);
    expect((await call(sim, '/test/account-switches', { owner: mine.address, submitDelayMs: 60_000 })).status).toBe(400);
    expect((await call(sim, '/test/account-switches', { owner: mine.address, failAfterSend: -1 })).status).toBe(400);
  });
});
