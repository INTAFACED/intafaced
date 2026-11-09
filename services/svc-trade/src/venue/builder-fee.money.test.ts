import type http from 'node:http';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { MemoryLedger, formatAmount, houseFees, parseAmount, recipes, venueBuilderFeeReceivable } from '@intafaced/ledger-client';
import { VenueRefusalError, type PlaceUserOrderIntent, type PreparedVenueAction, type UserVenue } from '@intafaced/venue-contracts';
import { startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor, type BuilderFeeValue } from './user-venue-door.js';
import { postBuilderFees } from './builder-fee-poster.js';
import { builderFeeRecon, BuilderFeeReconError } from './builder-fee-recon.js';
import { InMemoryBuilderFeeStore, type BuilderFeeAccount } from './builder-fee-store.js';

/**
 * D-venue-07 and J-derivatives-17 #1 #2: the poster posts our builder fee once per venue fill, and the recon reads the
 * venue's builder fees against the ledger's, fill by fill. Against the TEST venue simulator over loopback HTTP, with the
 * door placing real orders that carry our builder fee (1 bp, TEST), and the in-memory ledger.
 */
const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111b7';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333b7',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;
const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade builder fee')));
const owner = key.address.toLowerCase();
const signer = { role: 'owner' as const, address: owner };
const BUILDER: BuilderFeeValue = { address: '0x00000000000000000000000000000000000000b7', feeBps: a('1') };
const approveStepUp: StepUpCheck = {
  async require() {
    return { stepUpEventId: 'step-up-test', consumedAt: null, replayed: false };
  },
};

async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}

let server: http.Server;
let sim: TestVenueSimulator;
let url: string;
let door: UserVenueDoor;
const start = new Date(Date.now() - 60_000);

beforeAll(async () => {
  ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
  const { seedTestVenue } = await import('@intafaced/venue-sim');
  await seedTestVenue(sim);
  sim.deposit({ venueId: sim.venue.id, owner, subAccount: null }, 'USDC', a('200000'), 'deposit:test:builder-fee');
  door = new UserVenueDoor({
    connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }),
    appEnv: 'test',
    store: new InMemoryPreparedActionStore(),
    stepUp: approveStepUp,
    builder: BUILDER,
    now: () => new Date(),
  });
  const approve = await door.prepare(principal, {
    owner,
    signer,
    intent: { kind: 'approve_builder_fee', builder: BUILDER.address, maxFeeBps: a('1') },
    actionKey: `approve-builder:${USER}:1`,
  });
  await door.submit(principal, approve.actionKey, await sign(approve.prepared));
  // Two taker fills, each carrying our builder fee.
  for (const n of [1, 2]) {
    const intent: PlaceUserOrderIntent = {
      kind: 'place_order',
      symbol: 'BTC-USDC',
      side: 'buy',
      type: 'limit',
      amount: a('0.1'),
      price: a('60010'),
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: `order:${USER}:builder-fee:${n}`,
      builderFee: null,
    };
    const prepared = await door.prepare(principal, { owner, signer, intent });
    const out = await door.submit(principal, prepared.actionKey, await sign(prepared.prepared));
    expect(out.outcome).toMatchObject({ definite: true, accepted: true });
  }
});
afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
);

let ledger: MemoryLedger;
let store: InMemoryBuilderFeeStore;
const account = (): BuilderFeeAccount => ({ userId: USER, account: { venueId: sim.venue.id, owner, subAccount: null }, since: start });
beforeEach(() => {
  ledger = new MemoryLedger();
  store = new InMemoryBuilderFeeStore(() => [account()]);
});
const venue = () => door.venue();
const deps = () => ({ venue, ledger, store, now: () => new Date() });
const period = () => [start, new Date(Date.now() + 60_000)] as const;
const venueFees = async () => (await (await venue()).fills(account().account, start)).value.filter((f) => f.builderFee > 0n);

describe('the builder-fee poster', () => {
  it('posts one builderFeeEarn per fill with a builder fee, however often it runs; revenue equals the venue fees', async () => {
    const fills = await venueFees();
    expect(fills.length).toBeGreaterThanOrEqual(2);
    const first = await postBuilderFees(deps());
    const again = await postBuilderFees(deps());
    expect(first).toMatchObject({ venueId: sim.venue.id, accounts: 1, posted: fills.length, refused: 0 });
    expect(again.posted).toBe(0); // already posted: nothing is sent again
    const asset = fills[0]!.feeAsset;
    const sum = fills.filter((f) => f.feeAsset === asset).reduce((s, f) => s + f.builderFee, 0n);
    // Invariant: house builder-fee revenue equals the venue's builder fees on our users' fills, and what the venue owes
    // us is that amount; no entry is on a customer account.
    expect((await ledger.balance(houseFees('builder', asset))).amount).toBe(sum);
    expect((await ledger.balance(venueBuilderFeeReceivable(sim.venue.id, asset))).amount).toBe(-sum);
    for (const f of fills) {
      const tx = await ledger.getTxByKey(`builder-fee:${sim.venue.id}:${f.fillId}`);
      expect(tx?.entries.length).toBe(2);
    }
  });

  it('a crash after the post and before the record: the re-run posts nothing new and records the fill', async () => {
    let fail = true;
    const crashing = Object.assign(Object.create(store) as InMemoryBuilderFeeStore, {
      record: async (...args: Parameters<InMemoryBuilderFeeStore['record']>) => {
        if (fail) throw new Error('crash before the record');
        return store.record(...args);
      },
      accounts: (id: string) => store.accounts(id),
    });
    await expect(postBuilderFees({ ...deps(), store: crashing })).rejects.toThrow('crash before the record');
    const asset = (await venueFees())[0]!.feeAsset;
    const once = (await ledger.balance(houseFees('builder', asset))).amount;
    fail = false;
    await postBuilderFees(deps());
    expect((await ledger.balance(houseFees('builder', asset))).amount).toBeGreaterThanOrEqual(once);
    const fills = await venueFees();
    expect((await ledger.balance(houseFees('builder', asset))).amount).toBe(fills.reduce((s, f) => s + f.builderFee, 0n));
    expect(store.rows.size).toBe(fills.length);
  });

  it('a fee the ledger refuses is recorded refused with its code, posts nothing, and is listed by the recon', async () => {
    const refusing = {
      post: async () => {
        throw Object.assign(new Error('Unknown asset'), { code: 'ledger.asset_unknown' });
      },
    };
    const run = await postBuilderFees({ ...deps(), ledger: refusing as unknown as MemoryLedger });
    expect(run.posted).toBe(0);
    expect(run.refused).toBe((await venueFees()).length);
    const recon = await builderFeeRecon(deps(), ...period());
    const v = recon.venues[0]!;
    expect(v.state).toBe('read');
    if (v.state !== 'read') return;
    expect(v.matched).toBe(false);
    expect(v.lines.every((l) => l.status === 'ledger_refused' && l.refusalCode === 'ledger.asset_unknown')).toBe(true);
  });

  it('any failure that is not a ledger refusal stops the run, posting nothing more', async () => {
    const down = {
      post: async () => {
        throw new Error('ledger unreachable');
      },
    };
    await expect(postBuilderFees({ ...deps(), ledger: down as unknown as MemoryLedger })).rejects.toThrow('ledger unreachable');
    expect(store.rows.size).toBe(0);
  });
});

describe('the builder-fee recon (J-derivatives-17 #1 #2)', () => {
  it('#1: posted fills match the venue fill by fill; the venue is green and its totals agree', async () => {
    await postBuilderFees(deps());
    const recon = await builderFeeRecon(deps(), ...period());
    const v = recon.venues[0]!;
    expect(v).toMatchObject({ venueId: sim.venue.id, state: 'read', test: true, matched: true });
    if (v.state !== 'read') return;
    const fills = await venueFees();
    expect(v.lines.map((l) => l.fillId).sort()).toEqual(fills.map((f) => f.fillId).sort());
    for (const l of v.lines) {
      const f = fills.find((x) => x.fillId === l.fillId)!;
      expect(l).toMatchObject({
        status: 'matched',
        venueAmount: formatAmount(f.builderFee),
        ledgerAmount: formatAmount(f.builderFee),
        userId: USER,
      });
    }
    expect(v.totals.every((t) => t.matched && t.venueTotal === t.ledgerTotal)).toBe(true);
  });

  it('#2: a fee the venue reports and the ledger does not is a break with its fill id and amount; posting it turns it green', async () => {
    const before = await builderFeeRecon(deps(), ...period());
    const v = before.venues[0]!;
    if (v.state !== 'read') throw new Error('venue not read');
    expect(v.matched).toBe(false);
    const fills = await venueFees();
    for (const f of fills) {
      expect(v.lines.find((l) => l.fillId === f.fillId)).toMatchObject({
        status: 'not_in_ledger',
        venueAmount: formatAmount(f.builderFee),
        ledgerAmount: null,
      });
    }
    expect(v.totals.every((t) => !t.matched && t.ledgerTotal === '0')).toBe(true);
    await postBuilderFees(deps());
    const after = await builderFeeRecon(deps(), ...period());
    expect(after.venues[0]).toMatchObject({ matched: true });
  });

  it('#2: a fee the ledger holds and the venue does not report is a break too, never netted away', async () => {
    await postBuilderFees(deps());
    const ghost = { venueId: sim.venue.id, fillId: 'ghost-1', assetId: 'USDC', amount: a('0.3'), userId: USER };
    const tx = await ledger.post(recipes.builderFeeEarn(ghost));
    await store.record(
      { ...ghost, account: account().account, filledAt: new Date(), status: 'posted', refusalCode: null, ledgerTxId: tx.id },
      new Date(),
    );
    const v = (await builderFeeRecon(deps(), ...period())).venues[0]!;
    if (v.state !== 'read') throw new Error('venue not read');
    expect(v.matched).toBe(false);
    expect(v.lines.find((l) => l.fillId === 'ghost-1')).toMatchObject({
      status: 'not_reported_by_venue',
      venueAmount: null,
      ledgerAmount: '0.3',
    });
    const usdc = v.totals.find((t) => t.assetId === 'USDC');
    if (usdc) expect(usdc.matched).toBe(false);
  });

  it('a venue that cannot be read is unknown with its reason, never zero; a bad period and no venue are refused', async () => {
    const down = async (): Promise<UserVenue> => {
      throw new VenueRefusalError({ venueId: 'test-venue-sim', code: 'venue_down', detail: 'TEST: the venue is down' } as never);
    };
    const recon = await builderFeeRecon({ ...deps(), venue: down }, ...period());
    expect(recon.venues).toEqual([expect.objectContaining({ state: 'unknown', code: 'venue.venue_down' })]);
    const [from, to] = period();
    await expect(builderFeeRecon(deps(), to, from)).rejects.toBeInstanceOf(BuilderFeeReconError);
    await expect(builderFeeRecon(deps(), new Date(0), to)).rejects.toMatchObject({ code: 'trade.builder_fee_recon_period_invalid' });
    await expect(builderFeeRecon({ ...deps(), venue: null }, from, to)).rejects.toMatchObject({
      code: 'trade.builder_fee_recon_venue_not_connected',
    });
    expect((await builderFeeRecon(deps(), from, to)).periodOpen).toBe(true);
  });
});

describe('review fixes: what stops a run, what is skipped, and what is a break', () => {
  it('the posting freeze or an idempotency conflict stops the run; it is never recorded against a fill', async () => {
    for (const code of ['ledger.frozen', 'ledger.idempotency_conflict']) {
      const refusing = { post: async () => Promise.reject(Object.assign(new Error(code), { code })) };
      await expect(postBuilderFees({ ...deps(), ledger: refusing as unknown as MemoryLedger })).rejects.toThrow(code);
    }
    expect(store.rows.size).toBe(0);
  });

  it('an account the venue refuses to read is skipped and named; the other accounts are still posted', async () => {
    const stranger = { venueId: sim.venue.id, owner: '0x00000000000000000000000000000000000000c7', subAccount: 'gone' };
    const two = new InMemoryBuilderFeeStore(() => [{ userId: USER, account: stranger, since: start }, account()]);
    const real = await venue();
    const picky: UserVenue = Object.assign(Object.create(real) as UserVenue, {
      venue: real.venue,
      fills: async (acc: typeof stranger, since: Date) => {
        if (acc.owner === stranger.owner) {
          throw new VenueRefusalError({ venueId: real.venue.id, code: 'not_offered', detail: 'TEST: no such sub-account' } as never);
        }
        return real.fills(acc, since);
      },
    });
    const run = await postBuilderFees({ ...deps(), store: two, venue: async () => picky });
    expect(run.unread).toEqual([{ owner: stranger.owner, subAccount: 'gone', code: 'venue.not_offered' }]);
    expect(run.posted).toBe((await venueFees()).length);
  });

  it('a fill already recorded as posted is not sent to the ledger again', async () => {
    await postBuilderFees(deps());
    let posts = 0;
    const counting = { post: async (r: Parameters<MemoryLedger['post']>[0]) => ((posts += 1), ledger.post(r)) };
    const again = await postBuilderFees({ ...deps(), ledger: counting as unknown as MemoryLedger });
    expect(posts).toBe(0);
    expect(again.posted).toBe(0);
  });

  it('the same amount in another asset is a break, and each side counts in its own asset', async () => {
    const [fill] = await venueFees();
    const other = fill!.feeAsset === 'USDC' ? 'USDT' : 'USDC';
    const tx = await ledger.post(
      recipes.builderFeeEarn({ venueId: sim.venue.id, fillId: fill!.fillId, assetId: other, amount: fill!.builderFee, userId: USER }),
    );
    await store.record(
      {
        venueId: sim.venue.id,
        fillId: fill!.fillId,
        userId: USER,
        account: account().account,
        assetId: other,
        amount: fill!.builderFee,
        filledAt: fill!.filledAt,
        status: 'posted',
        refusalCode: null,
        ledgerTxId: tx.id,
      },
      new Date(),
    );
    const v = (await builderFeeRecon(deps(), ...period())).venues[0]!;
    if (v.state !== 'read') throw new Error('venue not read');
    expect(v.lines.find((l) => l.fillId === fill!.fillId)).toMatchObject({ status: 'amounts_differ', ledgerAssetId: other });
    expect(v.totals.find((t) => t.assetId === other)).toMatchObject({ venueTotal: '0', matched: false });
  });

  it('a fill recorded as posted whose transaction the ledger does not have, and the venue no longer reports, is listed', async () => {
    await store.record(
      {
        venueId: sim.venue.id,
        fillId: 'lost-1',
        userId: USER,
        account: account().account,
        assetId: 'USDC',
        amount: a('0.1'),
        filledAt: new Date(),
        status: 'posted',
        refusalCode: null,
        ledgerTxId: 'tx-gone',
      },
      new Date(),
    );
    const v = (await builderFeeRecon(deps(), ...period())).venues[0]!;
    if (v.state !== 'read') throw new Error('venue not read');
    expect(v.matched).toBe(false);
    expect(v.lines.find((l) => l.fillId === 'lost-1')).toMatchObject({ status: 'ledger_missing', venueAmount: null, ledgerAmount: null });
  });
});
