import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { VenueRefusalError, type PreparedVenueAction, type UserVenueAccount, type VenueIntent } from '@intafaced/venue-contracts';
import { TestVenueSimulator } from './simulator.js';
import { TEST_VENUE_MARKETS } from './http-server.js';
import type { TestVenueTypedData } from './signing.js';

/**
 * J-derivatives-29 at the venue: the account's mode is the venue's setting on the person's own account. Standard mode
 * keeps spot and perps apart, so a spot buy pays from spot and USDC moves between them by one signed transfer; unified
 * holds one balance for each asset and caps the day's actions. Every figure is TEST.
 */

const a = parseAmount;
const BTC_USDC = { ...TEST_VENUE_MARKETS.find((m) => m.symbol === 'BTC-USDC')! };

function testWallet(name: string) {
  const key = privateKeyToAccount(keccak256(toHex(`intafaced TEST wallet ${name}`)));
  const address = key.address.toLowerCase();
  return {
    address,
    signer: { role: 'owner', address } as const,
    async sign(prepared: PreparedVenueAction) {
      const typed = prepared.typedData as TestVenueTypedData;
      const signature = await key.signTypedData({
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
      });
      return { digest: prepared.digest, signature, signedBy: address };
    },
  };
}

async function world() {
  let now = Date.UTC(2026, 10, 20, 6, 0, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date(now), markets: [BTC_USDC] });
  const maker = testWallet('jd29-maker');
  const makerAccount: UserVenueAccount = { venueId: sim.venue.id, owner: maker.address, subAccount: null };
  sim.deposit(makerAccount, 'BTC', a('10'), 'chain:jd29:maker');
  const person = testWallet('jd29-person');
  const account: UserVenueAccount = { venueId: sim.venue.id, owner: person.address, subAccount: null };
  sim.testAccountMode(account, { mode: 'standard' });
  sim.deposit(account, 'USDC', a('500'), 'chain:jd29:person');
  const run = async (who: ReturnType<typeof testWallet>, acct: UserVenueAccount, intent: VenueIntent) => {
    const prepared = await sim.prepare(acct, who.signer, intent);
    const signature = await who.sign(prepared);
    const outcome = await sim.submit(prepared, signature);
    now += 1000;
    return { outcome, prepared, signature };
  };
  const order = (side: 'buy' | 'sell', amount: string, price: string, key: string, tif: 'GTC' | 'IOC'): VenueIntent => ({
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side,
    type: 'limit',
    amount: a(amount),
    price: a(price),
    timeInForce: tif,
    reduceOnly: false,
    clientOrderKey: key,
    builderFee: null,
  });
  const move = (direction: 'perps_to_spot' | 'spot_to_perps', amount: string, key: string): VenueIntent => ({
    kind: 'spot_perps_transfer',
    direction,
    asset: 'USDC',
    amount: a(amount),
    moveKey: key,
  });
  const mode = async () => (await sim.accountMode(account)).value;
  const fig = (rows: readonly { asset: string; total: bigint }[] | null, asset: string) =>
    formatAmount(rows?.find((r) => r.asset === asset)?.total ?? 0n);
  return { sim, run, order, move, mode, fig, maker, makerAccount, person, account };
}

describe('TEST venue account mode (J-derivatives-29)', () => {
  it('standard mode keeps spot and perps apart: a spot buy pays from spot, after one signed move from perps that moves once', async () => {
    const w = await world();
    const start = await w.mode();
    expect(start.mode).toBe('standard');
    expect(w.fig(start.perps, 'USDC')).toBe('500');
    expect(start.spot).toEqual([]);
    expect(start.actions).toEqual({ usedToday: 0, dailyLimit: null });

    await w.run(w.maker, w.makerAccount, w.order('sell', '0.01', '20000', 'maker:jd29:ask', 'GTC'));
    // Nothing in spot: the buy is refused by the venue, and spot and perps are as they were.
    const refused = await w.run(w.person, w.account, w.order('buy', '0.01', '20000', 'order:jd29:early', 'IOC'));
    expect(refused.outcome).toMatchObject({ definite: true, accepted: false, refusal: { code: 'insufficient_balance' } });
    expect((refused.outcome as { refusal: { detail: string } }).refusal.detail).toContain('in spot');

    const moved = await w.run(w.person, w.account, w.move('perps_to_spot', '201', 'class-move:jd29:one'));
    expect(moved.outcome).toMatchObject({ accepted: true });
    // The same signed move again: the venue answers the first result, and nothing moves twice.
    expect(await w.sim.submit(moved.prepared, moved.signature)).toEqual(moved.outcome);
    const after = await w.mode();
    expect(w.fig(after.perps, 'USDC')).toBe('299');
    expect(w.fig(after.spot, 'USDC')).toBe('201');

    const bought = await w.run(w.person, w.account, w.order('buy', '0.01', '20000', 'order:jd29:buy', 'IOC'));
    expect(bought.outcome).toMatchObject({ accepted: true });
    const filled = await w.mode();
    // 200 USDC paid from spot; the taker fee (3.5 bps) taken in the BTC bought; perps untouched.
    expect(w.fig(filled.spot, 'USDC')).toBe('1');
    expect(w.fig(filled.spot, 'BTC')).toBe('0.0099965');
    expect(w.fig(filled.perps, 'USDC')).toBe('299');
    // The refused buy, the move (its re-send is the same action, not a new one) and the buy.
    expect(filled.actions?.usedToday).toBe(3);
  });

  it('refuses a move above the source balance before anything is signed, naming its figure', async () => {
    const w = await world();
    await w.run(w.person, w.account, w.move('perps_to_spot', '50', 'class-move:jd29:fifty'));
    await expect(w.sim.prepare(w.account, w.person.signer, w.move('spot_to_perps', '50.01', 'class-move:jd29:more'))).rejects.toThrow(
      /spot holds 50 USDC free; 50\.01 is more than that/,
    );
    const err = await w.sim.prepare(w.account, w.person.signer, w.move('spot_to_perps', '51', 'class-move:jd29:more2')).catch((e) => e);
    expect(err).toBeInstanceOf(VenueRefusalError);
    expect((err as VenueRefusalError).refusal.code).toBe('insufficient_balance');
  });

  it("changes the mode only by the owner's signed action; a refused switch leaves it; unified holds one balance and caps the day", async () => {
    const w = await world();
    await w.run(w.person, w.account, w.move('perps_to_spot', '100', 'class-move:jd29:hundred'));
    // An agent key may not sign it.
    await expect(
      w.sim.prepare(
        w.account,
        { role: 'agent', address: w.maker.address },
        { kind: 'set_account_mode', mode: 'unified', changeKey: 'account-mode:jd29:x' },
      ),
    ).rejects.toThrow(/only the account owner's wallet/);

    w.sim.testAccountMode(w.account, { refuseSwitch: 'TEST: the venue takes no mode change now' });
    const no = await w.run(w.person, w.account, { kind: 'set_account_mode', mode: 'unified', changeKey: 'account-mode:jd29:one' });
    expect(no.outcome).toMatchObject({
      accepted: false,
      refusal: { code: 'venue_rejected', detail: 'TEST: the venue takes no mode change now' },
    });
    expect((await w.mode()).mode).toBe('standard');

    w.sim.testAccountMode(w.account, { refuseSwitch: null });
    const yes = await w.run(w.person, w.account, { kind: 'set_account_mode', mode: 'unified', changeKey: 'account-mode:jd29:two' });
    expect(yes.outcome).toMatchObject({ accepted: true });
    const unified = await w.mode();
    expect(unified).toMatchObject({ mode: 'unified', spot: null, perps: null, actions: { dailyLimit: 50_000 } });
    expect(formatAmount((await w.sim.balances(w.account)).value.find((b) => b.asset === 'USDC')!.total)).toBe('500');
    // One balance: no move between spot and perps.
    await expect(w.sim.prepare(w.account, w.person.signer, w.move('perps_to_spot', '1', 'class-move:jd29:none'))).rejects.toThrow(
      /unified mode, which holds one balance for each asset/,
    );

    // At the day's limit, the next order is refused in the venue's words, and counted once.
    w.sim.testAccountMode(w.account, { actionsToday: 50_000 });
    const capped = await w.run(w.person, w.account, w.order('buy', '0.001', '19000', 'order:jd29:capped', 'GTC'));
    expect(capped.outcome).toMatchObject({ accepted: false, refusal: { code: 'venue_rejected' } });
    expect((capped.outcome as { refusal: { detail: string } }).refusal.detail).toMatch(/used its 50,000 actions for today in unified mode/);
    expect((await w.mode()).actions?.usedToday).toBe(50_001);
    expect((await w.sim.openOrders(w.account)).value).toEqual([]);

    w.sim.testAccountMode(w.account, { unreported: true });
    expect((await w.mode()).mode).toBeNull();
  });
});
