import type http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import { add, div, formatAmount, mul, parseAmount, sub, type Amount } from '@intafaced/ledger-client/money';
import type { PreparedVenueAction } from '@intafaced/venue-contracts';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { InMemoryRiskAlertStore, type RiskAlert } from './risk-alerts-store.js';
import { RiskAlertError, VenueRiskAlerts, riskAlertKey, type RiskAlertNotices } from './risk-alerts.js';
import { UserVenueDoor } from './user-venue-door.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';

// J-derivatives-06 #6 #7 in svc-trade: margin and liquidation-risk alerts on an isolated position on the person's own
// venue account, against the TEST venue simulator over HTTP. Nothing is sent to the venue and nothing is posted; every
// figure is TEST. One alert per crossing; with no levels set the liquidation alert still goes out; a margin call asks for
// the margin that brings the ratio back to its level; an alert the bus did not take is published once on a later pass.

const a = parseAmount;
const ETH = 'ETH-PERP';
const BUILDER = '0x00000000000000000000000000000000000000b3';
const HUNDRED = a('100');

/** A bus that keeps what it took, and refuses while `down`. */
class Notices implements RiskAlertNotices {
  readonly sent: RiskAlert[] = [];
  down = false;
  async publish(alert: RiskAlert) {
    if (this.down) throw new Error('TEST bus down');
    this.sent.push(alert);
  }
}

describe('venue risk alerts (J-derivatives-06 #6 #7)', { timeout: 60_000 }, () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;
  beforeAll(async () => {
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    await seedTestVenue(sim);
  });
  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  let door: UserVenueDoor;
  let store: InMemoryRiskAlertStore;
  let notices: Notices;
  let engine: VenueRiskAlerts;
  let n = 0;
  const id = (tag: string) => `${tag}-${(n += 1)}`;
  let wallet: PrivateKeyAccount;
  let owner: string;
  let person: Principal;

  beforeEach(async () => {
    sim.setMark(ETH, a('3000'));
    sim.setIndex(ETH, a('3000'));
    await seedTestVenue(sim);
    door = new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 5000 }),
      appEnv: 'test',
      store: new InMemoryPreparedActionStore(),
      stepUp: { check: async () => ({ ok: true }) } as never,
      builder: { address: BUILDER, feeBps: a('1') },
      listings: new StoreVenueRoutingGate(listedTestStore([ETH])),
      ordersPageMax: 100,
      now: () => new Date(),
    } as never);
    store = new InMemoryRiskAlertStore();
    notices = new Notices();
    engine = new VenueRiskAlerts({ door, store, notices, now: () => new Date() });
    const tag = id('person');
    wallet = privateKeyToAccount(keccak256(toHex(`intafaced TEST wallet svc-trade risk alerts ${tag}`)));
    owner = wallet.address.toLowerCase();
    const userId = `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
    person = {
      sub: userId,
      userId,
      sid: '33333333-3333-4333-8333-3333333333d4',
      scopes: ['trade:read', 'trade:write'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 600_000),
    } as Principal;
  });

  async function signed(prepared: { digest: string; typedData: unknown }) {
    const t = prepared.typedData as TestVenueTypedData;
    const signature = await wallet.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    return { digest: prepared.digest, signature, signedBy: owner };
  }
  async function send(prepared: { actionKey: string; prepared: PreparedVenueAction }) {
    return door.submit(person, prepared.actionKey, await signed(prepared.prepared));
  }
  async function ownerAct(intent: Parameters<UserVenueDoor['prepare']>[1]['intent'], actionKey?: string) {
    const answer = await send(await door.prepare(person, { owner, signer: { role: 'owner', address: owner }, intent, actionKey }));
    expect(answer.outcome).toMatchObject({ definite: true, accepted: true });
  }

  /** The Starts line: a TEST isolated long of 1 ETH-PERP at 5x on the person's own venue account. */
  async function isolatedLong() {
    const account = await door.account(owner);
    sim.deposit(account, 'USDC', a('100000'), `chain:risk-alerts:${id('d')}`);
    await ownerAct({ kind: 'update_leverage', symbol: ETH, leverageBps: 50_000, marginMode: 'isolated' }, `leverage:${owner}:${id('lev')}`);
    await ownerAct({ kind: 'approve_builder_fee', builder: BUILDER, maxFeeBps: a('5') }, `builder-fee:${owner}:${id('fee')}`);
    await ownerAct({
      kind: 'place_order',
      symbol: ETH,
      side: 'buy',
      type: 'market',
      amount: a('1'),
      price: a('3100'),
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: `order:${owner}:${id('open')}`,
      builderFee: null,
    });
  }

  async function position() {
    const p = (await sim.positions(await door.account(owner))).value.find((x) => x.symbol === ETH)!;
    if (!p.maintenanceMargin?.known) throw new Error('the TEST venue publishes a maintenance requirement on ETH-PERP');
    return { ...p, withResult: add(p.margin, p.unrealisedPnl), maintenance: p.maintenanceMargin.value };
  }

  /** Moves the TEST mark so the position's margin with its result is `target` (a 1 ETH long: one USDC per dollar). */
  async function marginTo(target: Amount) {
    const p = await position();
    sim.setMark(ETH, sub(p.markPrice, sub(p.withResult, target)));
    expect((await position()).withResult).toBe(target);
  }
  /** The margin with its result at which the ratio is exactly `level` percent. */
  const marginAtRatio = (maintenance: Amount, level: Amount) => div(mul(maintenance, HUNDRED), level, 'ceil');

  it('with no levels set, alerts on: only the liquidation alert goes out, once per crossing, asking for the margin back to 100%', async () => {
    await isolatedLong();
    const view = await engine.set(person, { owner, symbol: ETH });
    expect(view.setting).toMatchObject({ on: true, marginLevel: null, ratioLevel: null });
    const { maintenance } = await position();

    expect(await engine.tick()).toEqual({ raised: 0, published: 0 });
    // The ratio reaches 100%: the margin with its result is one below the maintenance requirement.
    const below = sub(maintenance, a('1'));
    await marginTo(below);
    expect(await engine.tick()).toEqual({ raised: 1, published: 1 });
    // Still past it: nothing more, however many passes.
    expect(await engine.tick()).toEqual({ raised: 0, published: 0 });
    await marginTo(sub(maintenance, a('2')));
    expect(await engine.tick()).toEqual({ raised: 0, published: 0 });
    expect(notices.sent).toHaveLength(1);
    expect(notices.sent[0]).toMatchObject({
      kind: 'liquidation',
      level: HUNDRED,
      marginWithResult: below,
      maintenance,
      asked: a('1'),
      alertKey: riskAlertKey({ userId: person.userId, venueId: view.venue.id, owner, symbol: ETH }, 1),
    });
    expect(notices.sent[0]!.marginRatio).toBe(div(mul(maintenance, HUNDRED), below, 'floor'));

    // Back on the safe side re-arms it; the next fall is a second alert.
    await marginTo(add(maintenance, a('50')));
    expect(await engine.tick()).toEqual({ raised: 0, published: 0 });
    await marginTo(maintenance);
    expect(await engine.tick()).toEqual({ raised: 1, published: 1 });
    expect(notices.sent.map((x) => x.kind)).toEqual(['liquidation', 'liquidation']);
    // Exactly at 100%: nothing more is asked.
    expect(notices.sent[1]).toMatchObject({ asked: a('0'), marginWithResult: maintenance });
    expect((await engine.get(person, owner, ETH)).alerts.map((x) => x.sequence)).toEqual([2, 1]);
  });

  it('a margin alert at the margin level and a margin call at the ratio level, each once per crossing', async () => {
    await isolatedLong();
    const start = await position();
    const marginLevel = sub(start.withResult, a('100'));
    const ratioLevel = a('40');
    await engine.set(person, { owner, symbol: ETH, marginLevel: formatAmount(marginLevel), ratioLevel: '40' });

    await marginTo(sub(marginLevel, a('0.5')));
    expect(await engine.tick()).toEqual({ raised: 1, published: 1 });
    expect(notices.sent[0]).toMatchObject({ kind: 'margin', level: marginLevel, asked: null });

    // The ratio rises to 40%: a margin call asking for exactly the margin that brings it back to 40%.
    const at40 = marginAtRatio(start.maintenance, ratioLevel);
    const fallen = sub(at40, a('3.25'));
    await marginTo(fallen);
    expect(await engine.tick()).toEqual({ raised: 1, published: 1 });
    expect(notices.sent[1]).toMatchObject({ kind: 'margin_call', level: ratioLevel, marginWithResult: fallen, asked: sub(at40, fallen) });
    expect(await engine.tick()).toEqual({ raised: 0, published: 0 });

    // Editing the margin level re-arms that kind only: no second margin call for the same crossing.
    await engine.set(person, { owner, symbol: ETH, marginLevel: formatAmount(add(marginLevel, a('1'))), ratioLevel: '40' });
    expect(await engine.tick()).toEqual({ raised: 1, published: 1 });
    expect(notices.sent.map((x) => x.kind)).toEqual(['margin', 'margin_call', 'margin']);

    const list = await engine.list(person, owner);
    expect(list.alerts.map((x) => x.kind)).toEqual(['margin', 'margin_call', 'margin']);
    expect(list.alerts[1]).toMatchObject({ asked: formatAmount(sub(at40, fallen)), level: '40' });
  });

  it('an alert the bus did not take stays written, and is published once on a later pass', async () => {
    await isolatedLong();
    await engine.set(person, { owner, symbol: ETH });
    const { maintenance } = await position();
    notices.down = true;
    await marginTo(sub(maintenance, a('1')));
    expect(await engine.tick()).toEqual({ raised: 1, published: 0 });
    expect(store.rows).toHaveLength(1);
    notices.down = false;
    // A new engine, as after a restart: the crossing is not raised again, and its one alert goes out.
    engine = new VenueRiskAlerts({ door, store, notices, now: () => new Date() });
    expect(await engine.tick()).toEqual({ raised: 0, published: 1 });
    expect(await engine.tick()).toEqual({ raised: 0, published: 0 });
    expect(notices.sent).toHaveLength(1);
  });

  it('off sends nothing; levels are refused in words naming the field', async () => {
    await isolatedLong();
    await expect(engine.set(person, { owner, symbol: ETH, ratioLevel: '100' })).rejects.toMatchObject({
      code: 'trade.risk_alerts_field_invalid',
      field: 'Margin ratio level',
    });
    await expect(engine.set(person, { owner, symbol: ETH, marginLevel: 'ten' })).rejects.toMatchObject({
      code: 'trade.risk_alerts_field_invalid',
      field: 'Margin level',
    });
    await expect(engine.set(person, { owner, symbol: ETH, marginLevel: '0' })).rejects.toBeInstanceOf(RiskAlertError);
    await engine.set(person, { owner, symbol: ETH });
    const off = await engine.off(person, owner, ETH);
    expect(off.setting).toMatchObject({ on: false });
    const { maintenance } = await position();
    await marginTo(sub(maintenance, a('1')));
    expect(await engine.tick()).toEqual({ raised: 0, published: 0 });
  });

  it('refuses a market with no open isolated position', async () => {
    await expect(engine.set(person, { owner, symbol: ETH })).rejects.toMatchObject({ code: 'trade.risk_alerts_no_position' });
  });
});
