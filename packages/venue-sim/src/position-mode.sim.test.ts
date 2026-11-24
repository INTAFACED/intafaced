import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { add, formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  type PreparedVenueAction,
  type UserVenueAccount,
  type VenueIntent,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import { TestVenueSimulator, type SimMarketConfig } from './simulator.js';
import type { TestVenueTypedData } from './signing.js';

/**
 * J-derivatives-05 #3 #7 at the venue: a TEST venue that declares hedge mode switches one perpetual at a time and refuses
 * a switch while a position or an order is open on it; one that moves positions moves the whole position with the margin
 * it holds between the owner's main account and a sub-account, once. A venue that declares neither refuses both. Every
 * figure is TEST.
 */

const a = parseAmount;

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

const perp = (symbol: string, base: string): SimMarketConfig => ({
  symbol,
  kind: 'perpetual',
  baseAsset: base,
  quoteAsset: 'USDC',
  orderTypes: ['limit', 'market'],
  timeInForce: ['GTC', 'IOC'],
  marginModes: ['isolated'],
  maxLeverageBps: 200_000,
  tickSize: a('1'),
  lotSize: a('0.001'),
  makerFeeBps: { known: true, value: a('1.5') },
  takerFeeBps: { known: true, value: a('4.5') },
  maintenanceMarginRate: a('0.005'),
  markPrice: a('60000'),
});

function accepted(outcome: VenueSubmitOutcome) {
  if (!outcome.definite || !outcome.accepted) throw new Error(`expected accepted, got ${JSON.stringify(outcome)}`);
  return outcome;
}

/** The person long 0.01 BTC-PERP at 60000 (margin 60 at 10x) on the main account, with one sub-account opened. */
async function world(offers: { hedge: boolean; moves: boolean } = { hedge: true, moves: true }) {
  let now = Date.UTC(2026, 10, 23, 6, 0, 0);
  const sim = new TestVenueSimulator({
    clock: () => new Date(now),
    markets: [perp('BTC-PERP', 'BTC'), perp('ETH-PERP', 'ETH')],
    ...(offers.hedge ? { positionModes: ['one_way', 'hedge'] as const } : {}),
    ...(offers.moves ? { positionMoves: true } : {}),
  });
  const person = testWallet('jd05-mode-person');
  const maker = testWallet('jd05-mode-maker');
  const main: UserVenueAccount = { venueId: sim.venue.id, owner: person.address, subAccount: null };
  const makerAccount: UserVenueAccount = { venueId: sim.venue.id, owner: maker.address, subAccount: null };
  sim.deposit(main, 'USDC', a('1000'), 'chain:jd05-mode:person');
  sim.deposit(makerAccount, 'USDC', a('100000'), 'chain:jd05-mode:maker');
  const prepare = (account: UserVenueAccount, intent: VenueIntent) => sim.prepare(account, person.signer, intent);
  const run = async (who: ReturnType<typeof testWallet>, account: UserVenueAccount, intent: VenueIntent) => {
    const prepared = await sim.prepare(account, who.signer, intent);
    const signature = await who.sign(prepared);
    const outcome = await sim.submit(prepared, signature);
    now += 1000;
    return { outcome, prepared, signature };
  };
  const leverage: VenueIntent = { kind: 'update_leverage', symbol: 'BTC-PERP', leverageBps: 100_000, marginMode: 'isolated' };
  const order = (symbol: string, side: 'buy' | 'sell', key: string, timeInForce: 'GTC' | 'IOC', price = '60000'): VenueIntent => ({
    kind: 'place_order',
    symbol,
    side,
    type: 'limit',
    amount: a('0.01'),
    price: a(price),
    timeInForce,
    reduceOnly: false,
    clientOrderKey: key,
    builderFee: null,
  });
  accepted((await run(maker, makerAccount, leverage)).outcome);
  accepted((await run(maker, makerAccount, order('BTC-PERP', 'sell', 'order:jd05-mode-maker:1', 'GTC'))).outcome);
  accepted((await run(person, main, leverage)).outcome);
  accepted((await run(person, main, order('BTC-PERP', 'buy', 'order:jd05-mode-person:1', 'IOC'))).outcome);
  const opened = accepted(
    (await run(person, main, { kind: 'create_sub_account', name: 'TEST sub', subAccountKey: 'own:sub-account:jd05-mode:sub' })).outcome,
  );
  const subId = (await sim.subAccounts(main)).value[0]!.subAccount;
  const sub: UserVenueAccount = { ...main, subAccount: subId };
  const mode = (symbol: string): VenueIntent => ({
    kind: 'set_position_mode',
    symbol,
    mode: 'hedge',
    changeKey: `position-mode:jd05:${symbol}:h`,
  });
  const move = (direction: 'into_sub_account' | 'out_of_sub_account', key: string, symbol = 'BTC-PERP'): VenueIntent => ({
    kind: 'move_position',
    subAccount: subId,
    direction,
    symbol,
    moveKey: `position-move:jd05:${key}`,
  });
  const usdc = async (account: UserVenueAccount) => {
    const b = (await sim.balances(account)).value.find((x) => x.asset === 'USDC');
    return { free: formatAmount(b?.free ?? 0n), locked: formatAmount(b?.locked ?? 0n) };
  };
  const refusal = (intent: VenueIntent, account = main) =>
    prepare(account, intent).then(
      () => null,
      (e: unknown) => (e instanceof VenueRefusalError ? e.refusal : Promise.reject(e)),
    );
  return { sim, person, maker, makerAccount, main, sub, subId, run, order, mode, move, usdc, refusal, opened };
}

describe('TEST venue position mode (J-derivatives-05 #3)', () => {
  it('declares hedge mode only when it is set to, and reports one-way until the owner switches a perpetual', async () => {
    const w = await world();
    expect(w.sim.venue.positionModes).toEqual(['one_way', 'hedge']);
    expect((await w.sim.positionMode(w.main, 'ETH-PERP')).value).toBe('one_way');
    expect((await world({ hedge: false, moves: false })).sim.venue.positionModes).toEqual(['one_way']);
  });

  it('switches a perpetual with no position to hedge and back, each by one signed change; the same mode again is refused', async () => {
    const w = await world();
    accepted((await w.run(w.person, w.main, w.mode('ETH-PERP'))).outcome);
    expect((await w.sim.positionMode(w.main, 'ETH-PERP')).value).toBe('hedge');
    // The other perpetual and the sub-account keep their own mode.
    expect((await w.sim.positionMode(w.main, 'BTC-PERP')).value).toBe('one_way');
    expect((await w.sim.positionMode(w.sub, 'ETH-PERP')).value).toBe('one_way');
    expect(await w.refusal(w.mode('ETH-PERP'))).toMatchObject({
      code: 'venue_rejected',
      detail: 'ETH-PERP is already in hedge mode on this account',
    });
    // In hedge mode an order names its position side; the order intent carries none, so the venue refuses it.
    expect(await w.refusal(w.order('ETH-PERP', 'buy', 'order:jd05-mode-person:eth', 'IOC'))).toMatchObject({
      code: 'venue_rejected',
      detail:
        'ETH-PERP is in hedge mode on this account: an order there names its position side, and this one names none. Switch ETH-PERP to one-way mode to send it',
    });
    accepted(
      (
        await w.run(w.person, w.main, {
          kind: 'set_position_mode',
          symbol: 'ETH-PERP',
          mode: 'one_way',
          changeKey: 'position-mode:jd05:eth:o',
        })
      ).outcome,
    );
    expect((await w.sim.positionMode(w.main, 'ETH-PERP')).value).toBe('one_way');
  });

  it('refuses a switch while a position or an order is open on the perpetual, in its words, and the mode stays', async () => {
    const w = await world();
    expect(await w.refusal(w.mode('BTC-PERP'))).toMatchObject({
      code: 'venue_rejected',
      detail:
        "the position mode of BTC-PERP can't change while a position is open on it: this account holds long 0.01 BTC-PERP. Close it first",
    });
    accepted(
      (await w.run(w.person, w.main, { kind: 'update_leverage', symbol: 'ETH-PERP', leverageBps: 100_000, marginMode: 'isolated' }))
        .outcome,
    );
    accepted((await w.run(w.person, w.main, w.order('ETH-PERP', 'buy', 'order:jd05-mode-person:rest', 'GTC', '50000'))).outcome);
    expect(await w.refusal(w.mode('ETH-PERP'))).toMatchObject({
      code: 'venue_rejected',
      detail: "the position mode of ETH-PERP can't change while an order rests on it: cancel this account's open ETH-PERP orders first",
    });
    expect((await w.sim.positionMode(w.main, 'BTC-PERP')).value).toBe('one_way');
    expect((await w.sim.positionMode(w.main, 'ETH-PERP')).value).toBe('one_way');
  });

  it('an agent key may not sign a switch, and a venue with one mode refuses hedge as not offered', async () => {
    const w = await world();
    await expect(w.sim.prepare(w.main, { role: 'agent', address: w.maker.address }, w.mode('ETH-PERP'))).rejects.toThrow(
      /only the account owner's wallet/,
    );
    const plain = await world({ hedge: false, moves: false });
    expect(await plain.refusal(plain.mode('ETH-PERP'))).toMatchObject({
      code: 'not_offered',
      detail: `${plain.sim.venue.displayName} offers no hedge mode`,
    });
  });
});

describe('TEST venue position move (J-derivatives-05 #7)', () => {
  it('moves the whole position with its margin to the sub-account, once: locked margin moves, free balance does not', async () => {
    const w = await world();
    const [held] = (await w.sim.positions(w.main)).value;
    const before = { main: await w.usdc(w.main), sub: await w.usdc(w.sub) };
    expect(formatAmount(held!.margin)).toBe('60');
    const moved = await w.run(w.person, w.main, w.move('into_sub_account', 'one'));
    accepted(moved.outcome);
    // The same signed move sent again is the same answer: nothing moves twice.
    expect(await w.sim.submit(moved.prepared, moved.signature)).toEqual(moved.outcome);
    expect((await w.sim.positions(w.main)).value).toEqual([]);
    const [there] = (await w.sim.positions(w.sub)).value;
    expect(there).toMatchObject({
      symbol: 'BTC-PERP',
      side: 'long',
      size: held!.size,
      entryPrice: held!.entryPrice,
      margin: held!.margin,
      leverageBps: held!.leverageBps,
      marginMode: held!.marginMode,
    });
    const after = { main: await w.usdc(w.main), sub: await w.usdc(w.sub) };
    expect(after.main).toEqual({ free: before.main.free, locked: formatAmount(a(before.main.locked) - held!.margin) });
    expect(after.sub).toEqual({ free: before.sub.free, locked: formatAmount(add(a(before.sub.locked), held!.margin)) });
    // The sub-account trades it at the leverage it came with.
    expect((await w.sim.leverage(w.sub, 'BTC-PERP')).value).toMatchObject({ leverageBps: held!.leverageBps, marginMode: 'isolated' });
    // And back, by a new signed move.
    accepted((await w.run(w.person, w.main, w.move('out_of_sub_account', 'two'))).outcome);
    expect((await w.sim.positions(w.sub)).value).toEqual([]);
    expect((await w.sim.positions(w.main)).value.map((p) => formatAmount(p.margin))).toEqual(['60']);
    expect({ main: await w.usdc(w.main), sub: await w.usdc(w.sub) }).toEqual(before);
  });

  it('refuses a move it does not make, before anything is signed, and nothing moves', async () => {
    const w = await world();
    expect(await w.refusal(w.move('out_of_sub_account', 'none'))).toMatchObject({
      code: 'venue_rejected',
      detail: 'the sub-account holds no open BTC-PERP position to move',
    });
    expect(await w.refusal(w.move('into_sub_account', 'eth', 'ETH-PERP'))).toMatchObject({
      code: 'venue_rejected',
      detail: 'the main account holds no open ETH-PERP position to move',
    });
    expect(await w.refusal({ ...w.move('into_sub_account', 'other'), subAccount: '0xnot-mine' } as VenueIntent)).toMatchObject({
      code: 'unknown_sub_account',
    });
    // Signed on the main account only, and by the owner only.
    expect(await w.refusal(w.move('out_of_sub_account', 'on-sub'), w.sub)).toMatchObject({ code: 'not_offered' });
    await expect(w.sim.prepare(w.main, { role: 'agent', address: w.maker.address }, w.move('into_sub_account', 'agent'))).rejects.toThrow(
      /only the account owner's wallet/,
    );
    expect((await w.sim.positions(w.main)).value).toHaveLength(1);
    expect((await w.sim.positions(w.sub)).value).toEqual([]);
  });

  it('a venue that moves no position refuses the move as not offered', async () => {
    const plain = await world({ hedge: false, moves: false });
    expect(plain.sim.venue.positionMoves).toBeUndefined();
    expect(await plain.refusal(plain.move('into_sub_account', 'plain'))).toMatchObject({
      code: 'not_offered',
      detail: `${plain.sim.venue.displayName} moves no open position between accounts`,
    });
    expect((await plain.sim.positions(plain.main)).value).toHaveLength(1);
  });
});
