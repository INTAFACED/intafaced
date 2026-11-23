// A copy filled on the stack's TEST venue, where our builder fee is earned, and the lead's share of that fee owed by
// INTAFACED (J-copy-bots-otc-06 #1, J-copy-bots-otc-11 #1). One start, shared, so a fix to it lands once.
//
// A TEST lead trades a TEST spot market of the caller's own (ownSpotMarket, so no other journey's resting orders meet
// these) on their own account on the TEST venue, and a follower copies them onto their own agent account (a venue
// sub-account under their own TEST wallet). The lead buys and then sells; the copy of the sell is a venue fill that carries
// our builder fee (the venue charges none on a spot buy). svc-trade records the lead's share of that fee once its Earn is
// booked, sets it aside when the venue pays us the fee (the TEST venue's own claim control stands in for our claim) and
// owes it to the lead, all on its own (services/svc-trade/src/copy/venue-fee-share.ts). The share rate is the stack's
// labelled TEST copy fee share. The caller's file keeps svc-trade's user-venue door on (venue.mjs `venueForThisFile`);
// trade restarts once more here to let an assistant trade the caller's market, and once after to put that back.
import { createHash, randomUUID } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { expect } from './journey.mjs';
import { api, restartService, toUnits } from './stack.mjs';
import { fundedTrader } from './desk.mjs';
import { listLeader } from './copy.mjs';
import { confirmStepUp, testPasskey } from './p2p.mjs';
import { ownSpotMarket } from './own-market.mjs';
import {
  TEST_VENUE,
  doorOk,
  otherTraderRun,
  signPrepared,
  testDeposit,
  testVenue,
  otherTraderKey,
  venueAccount,
  venueInfo,
  venueRecord,
  walletDoorAct,
} from './venue.mjs';

// Every venue trade here is at one price.
const VPRICE = '100';
const STEP_UP_AGENT = { scope: 'trade.step_up.venue.agentAccount', purpose: 'venue.agentAccount' };

/** Our builder fee rides on every door order the venue charges it on: the wallet approves it once on the account. */
async function approveBuilder(session, key, subAccount, tag, symbol) {
  const status = doorOk(await session.get('/api/v1/venue/status'));
  expect(status.builder, 'the TEST builder fee is set on the door').toBeTruthy();
  const cap = (await testVenue('/markets', { account: null })).body.value.find((m) => m.symbol === symbol)?.builderFeeCapBps;
  expect(cap, `${symbol}'s builder-fee cap as the venue publishes it`).toMatchObject({ known: true });
  await walletDoorAct(session, key, {
    subAccount,
    intent: { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: cap.value },
    actionKey: `approve:${tag}:builder`,
  });
  return status.builder.address;
}

/** The TEST venue's own record for an account, read directly by the venue fixture's read. */
export const onVenue = async (path, owner, subAccount = null, extra = {}) =>
  (await venueRecord(owner, path, extra, TEST_VENUE, subAccount)).value;

/** The follower's copied venue fills and their fees, as svc-trade answers its own record `copy.myCopyFees`. */
export async function myCopyFees(who) {
  const res = await (await api(who)).get(`/api/trade/trpc/copy.myCopyFees?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** svc-trade's copied positions of a follow. */
async function copiedPositions(who, followId) {
  const res = await (await api(who)).get(`/api/trade/trpc/copy.copiedPositions?input=${encodeURIComponent(JSON.stringify({ followId }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data.positions;
}

let staff;
/** The stack's TEST founders' sessions, for svc-ledger's operator reads (founder a, admin:treasury). */
async function founders() {
  staff ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    return { ctx, sessions: await gates.approverSessions(ctx) };
  })();
  return staff;
}

/** One svc-ledger operator read, as founder a. */
async function ledgerRead(path) {
  const { ctx, sessions } = await founders();
  const res = await fetch(`${ctx.url('ledger')}${path}`, { headers: { authorization: `Bearer ${await sessions.a.treasuryToken()}` } });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return JSON.parse(text);
}

/** The transaction svc-ledger itself holds under one business key. */
export const ledgerTrace = (key) => ledgerRead(`/operator/trace?businessKey=${encodeURIComponent(key)}`);

/** What the ledger says INTAFACED owes a lead, in one asset: the lead's own owed account, from svc-ledger's account read. */
export async function ledgerOwedTo(leaderId, asset) {
  const page = await ledgerRead(`/operator/accounts?prefix=${encodeURIComponent(`module:trade:fee-share-owed:lead-trader.${leaderId}`)}`);
  const rows = page.accounts.filter((r) => r.assetId === asset);
  expect(rows.length, `the ledger has one owed account of the lead in ${asset}`).toBeLessThanOrEqual(1);
  return { accountId: rows[0]?.accountId ?? null, balance: toUnits(rows[0]?.balance ?? '0') };
}

/**
 * The venue start (above), for one journey file `J` and its run's `tag`, with `follower` (a verified TEST trader) as the
 * follower, `code` naming this file's own market (ownSpotMarket's code), and the lead's sign-up prefix and listed name.
 * `beforeClaim` runs once the share is recorded and before the venue pays us the fee, while it is not owed yet.
 * Answers what the start made: the market, the lead, the follow, the agent account, the builder and the copied sell.
 */
export async function venueCopiedSell(page, { J, tag, follower, code, traderPrefix, leaderName, beforeClaim = async () => {} }) {
  const maker = `${J} maker`;
  const walletOf = (name) => privateKeyToAccount(keccak256(toHex(`intafaced TEST venue journey trader ${J} ${name} ${tag}`)));
  /** The lead trades once on their own venue account, signed by their own wallet: an IOC that meets the TEST maker. */
  const leadOrder = async (lead, key, symbol, side, amount, n) =>
    walletDoorAct(await api(lead), key, {
      intent: {
        kind: 'place_order',
        symbol,
        side,
        type: 'limit',
        amount,
        price: VPRICE,
        timeInForce: 'IOC',
        reduceOnly: false,
        clientOrderKey: `order:${J}:lead:${tag}:${n}`,
        builderFee: null,
      },
    });
  /** The TEST maker rests one order on this file's own market. */
  const makerOrder = async (symbol, side, amount, price = VPRICE) => {
    const answer = await otherTraderRun(maker, {
      kind: 'place_order',
      symbol,
      side,
      type: 'limit',
      amount,
      price,
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: `order:${J}:maker:${tag}:${side}:${price}`,
      builderFee: null,
    });
    expect(answer, JSON.stringify(answer).slice(0, 300)).toMatchObject({ accepted: true });
  };

  const leaderKey = walletOf('leader');
  const followerKey = walletOf('follower');
  const leader = await fundedTrader(page, traderPrefix, '10');
  // A TEST spot market of this file's own, and a TEST maker funded on it in its coin and in USDC.
  const { symbol, base } = await ownSpotMarket(J, code, 'V');
  // An assistant trades only the markets the stack lists; this restart adds this file's own (put back after the start).
  await restartService('trade', { LOCAL_STACK_USER_VENUE: 'on', LOCAL_STACK_AGENT_MARKETS_ADD: symbol });
  try {
    for (const [asset, amount] of [
      [base, '10'],
      ['USDC', '1000'],
    ]) {
      const funded = await testVenue('/test/deposit', {
        account: await venueAccount(otherTraderKey(maker).address),
        asset,
        amount,
        depositRef: `seed:${maker}:${symbol}:${asset}`,
      });
      expect(funded.status, JSON.stringify(funded.body)).toBe(200);
    }
    const leaderRef = await listLeader(leader, leaderName, { assets: [symbol] });
    const { chainId } = await venueInfo();
    const ref = (who) => `${chainId}:0x${createHash('sha256').update(`${J}:${tag}:${who}`).digest('hex')}:0`;
    await testDeposit(leaderKey.address.toLowerCase(), 'USDC', '1000', ref('leader'));
    await testDeposit(followerKey.address.toLowerCase(), 'USDC', '500', ref('follower'));
    const builder = await approveBuilder(await api(leader), leaderKey, null, `${J}:${tag}:leader`, symbol);

    // The follower's agent account: cap TEST 200 USDC, funded 150, with step-up; the wallet signs the open, the agent
    // permission and the move in (J-agents-21 #3's own path, as J-copy-bots-otc-03 opens one).
    const session = await api(follower);
    const passkey = await testPasskey(session);
    const owner = followerKey.address.toLowerCase();
    const accountId = randomUUID();
    const fields = { accountId, owner, asset: 'USDC', cap: '200', fund: '150' };
    const stepUpApprovalId = await confirmStepUp(session, passkey, { ...STEP_UP_AGENT, target: accountId, amount: '150', fields });
    let view = doorOk(await session.post('/api/v1/venue/agent-accounts', { ...fields, stepUpApprovalId }));
    for (let i = 0; view.next && i < 5; i += 1) {
      view = doorOk(
        await session.post(`/api/v1/venue/agent-accounts/${accountId}/submit`, {
          actionKey: view.next.actionKey,
          signature: await signPrepared(followerKey, view.next.prepared),
        }),
      );
    }
    expect(view.status).toBe('open');
    await approveBuilder(session, followerKey, view.subAccount, `${J}:${tag}:sub`, symbol);
    const followed = doorOk(
      await session.post('/api/trade/trpc/copy.follow', {
        leaderRef,
        region: 'DE',
        permittedMarkets: [symbol],
        maxNotionalPerOrder: '50',
        maxAggregateExposure: '150',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
        clientRequestId: `${J}-venue:${tag}`,
        agentAccountId: accountId,
      }),
    );
    const followId = followed.result.data.followId;
    doorOk(await session.post('/api/trade/trpc/copy.grantSessionKey', { followId }));

    // The lead buys, and the driver copies the lead's own amount onto the sub-account (a spot buy: no builder fee).
    // The maker's ask holds exactly the two buys.
    // An assistant's order is judged against the book's mid, so the book holds both sides: a small bid under the ask.
    await makerOrder(symbol, 'sell', '0.6');
    await makerOrder(symbol, 'buy', '0.02', '99');
    await leadOrder(leader, leaderKey, symbol, 'buy', '0.3', 1);
    await expect
      .poll(async () => (await copiedPositions(follower, followId)).filter((p) => toUnits(p.open) > 0n).length, {
        timeout: 60_000,
        message: 'the copy driver never copied the lead buy onto the agent sub-account',
      })
      .toBe(1);
    // The lead sells, and the driver copies the sell: a venue fill of ours that carries our builder fee.
    const balancesBefore = await onVenue('/balances', owner, view.subAccount);
    await makerOrder(symbol, 'buy', '1');
    // The two buys took the whole ask; a small ask over the bid gives the copied sell a mid to be judged by.
    await makerOrder(symbol, 'sell', '0.02', '101');
    await leadOrder(leader, leaderKey, symbol, 'sell', '0.2', 2);
    const copiedSell = async () => (await myCopyFees(follower)).rows.find((r) => r.followId === followId && r.side === 'sell');
    let sell;
    await expect
      .poll(async () => Boolean((sell = await copiedSell())), { timeout: 60_000, message: 'the copied sell never filled' })
      .toBe(true);

    // svc-trade records the lead's share once the builder-fee poster has booked our fee earned on the fill: owed once
    // the venue pays us the fee.
    await expect
      .poll(async () => (await copiedSell()).feeShare.state, { timeout: 60_000, message: 'the leader share was never recorded' })
      .toBe('waiting_collection');
    const made = {
      symbol,
      leader,
      leaderName,
      leaderRef,
      followId,
      owner,
      sub: view.subAccount,
      builder,
      sellFill: sell.fillId,
      balancesBefore,
    };
    await beforeClaim(made);
    // The venue pays us our builder fees (the TEST venue's claim control, standing in for our claim); svc-trade's collect
    // books the claim, sets the lead's share aside from it and owes it to the lead, with no one asking.
    const claimed = await testVenue('/test/builder-claim', { builder });
    expect(claimed.status, JSON.stringify(claimed.body).slice(0, 300)).toBe(200);
    await expect
      .poll(async () => (await copiedSell()).feeShare.state, { timeout: 60_000, message: 'the leader share was never owed' })
      .toBe('owed');
    return made;
  } finally {
    await restartService('trade', { LOCAL_STACK_USER_VENUE: 'on', LOCAL_STACK_AGENT_MARKETS_ADD: null });
  }
}
