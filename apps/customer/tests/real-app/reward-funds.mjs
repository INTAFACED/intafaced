// INTAFACED's own TEST money for paying USDC rewards to a customer's wallet on the stack (launch money model, OWNER 226 and
// 288), as J-campaigns-03 first did it: builder fees the TEST venue credits us on a journey file's own routed sells fund
// the USDC reward pot (the founders sweep them: A asks, B approves), and a TEST claim of those fees at the TEST venue
// makes svc-trade move what our builder account holds above the TEST float to INTAFACED's TEST rewards wallet on the TEST
// chain, which svc-campaigns pays each due reward from. Nothing here moves our money itself: every move is a service's.
// A file that uses it must turn the TEST venue on for itself (`venueForThisFile`). LOCAL TEST only.
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { expect } from './journey.mjs';
import { api } from './stack.mjs';
import { CHAIN_ID, TOKEN_USD, fundOnTestChain, testChain } from './dex.mjs';
import { GATE_URL } from '../../../../tooling/scripts/local-test-facts.mjs';
import { TEST_VENUE_DEPOSIT_ADDRESS } from '../../../../tooling/scripts/local-test-venue.mjs';
import { otherTraderKey, otherTraderRun, testDeposit, testVenue, venueRecord } from './venue.mjs';

const ASSET = 'USDC';
const SELL_SIZE = 0.5;
const TRANSFER_FN = 'function transfer(address to, uint256 value) returns (bool)';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Adds decimal strings exactly (no float). */
export function sumDecimal(values) {
  const scale = 18;
  const units = (x) => {
    const [w, f = ''] = String(x).split('.');
    return BigInt(w + f.padEnd(scale, '0'));
  };
  const sum = values
    .reduce((n, v) => n + units(v), 0n)
    .toString()
    .padStart(scale + 1, '0');
  const frac = sum.slice(-scale).replace(/0+$/, '');
  return frac ? `${sum.slice(0, -scale)}.${frac}` : sum.slice(0, -scale);
}

async function rpc(method, params) {
  const res = await fetch(GATE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** TEST USD (6 decimals) `address` holds on the TEST chain, read from the node itself. */
export async function chainUsd(address) {
  return BigInt(
    await rpc('eth_call', [{ to: TOKEN_USD.address, data: `0x70a08231${address.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest']),
  );
}

/** TEST ETH (the chain's own coin, in wei) `address` holds, read from the node itself. */
export async function chainEth(address) {
  return BigInt(await rpc('eth_getBalance', [address, 'latest']));
}

/** Mines `n` empty blocks on the stack's TEST chain (`evm_mine`, the TEST chain's own control). */
export async function mineBlocks(n) {
  for (let i = 0; i < n; i += 1) await rpc('evm_mine', []);
}

/**
 * The TEST chain's own receipt of `txHash`: who sent it, what it cost the sender (gas used times its price, in wei), and
 * the token transfers it made as { token, from, to, value } (read from the chain, not from us).
 */
export async function chainReceipt(txHash) {
  const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  expect(receipt, `the TEST chain has a receipt for ${txHash}`).toBeTruthy();
  expect(receipt.status).toBe('0x1');
  return {
    from: receipt.from.toLowerCase(),
    fee: BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice),
    transfers: receipt.logs
      .filter((l) => l.topics[0] === TRANSFER_TOPIC)
      .map((l) => ({
        token: l.address.toLowerCase(),
        from: `0x${l.topics[1].slice(26)}`,
        to: `0x${l.topics[2].slice(26)}`,
        value: BigInt(l.data),
      })),
  };
}

/**
 * One journey file's TEST reward funding. `operators()` gives the stack's two TEST founders (local-test-gates.mjs).
 */
export function rewardFunds({ J, RUN, operators }) {
  const traderKey = privateKeyToAccount(keccak256(toHex(`intafaced TEST venue journey trader ${J} ${RUN}`)));
  const traderOwner = traderKey.address.toLowerCase();
  let orders = 0;
  let builder = null;

  const data = (res, what) => {
    const row = res.json?.result?.data;
    if (!row) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
    return row;
  };

  /** One action through svc-trade's user-venue door as `who`: prepare, sign with the TEST key, submit. */
  async function door(who, intent, actionKey) {
    const session = await api(who);
    const signer = { role: 'owner', address: traderOwner };
    const prepared = await session.post('/api/v1/venue/prepare', {
      owner: traderOwner,
      signer,
      intent,
      ...(actionKey ? { actionKey } : {}),
    });
    expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(200);
    const p = prepared.body.prepared;
    const t = p.typedData;
    const signature = await traderKey.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    const sent = await session.post('/api/v1/venue/submit', {
      actionKey: prepared.body.actionKey,
      signature: { digest: p.digest, signature, signedBy: traderOwner },
    });
    expect(sent.status, JSON.stringify(sent.body).slice(0, 400)).toBe(200);
    expect(sent.body.outcome, JSON.stringify(sent.body.outcome).slice(0, 400)).toMatchObject({ definite: true, accepted: true });
    return sent.body;
  }

  /**
   * Builder fees the TEST venue credits us on this file's own sells: the file's TEST trader approves our builder fee and
   * sells SELL_SIZE BTC into a TEST bid `sells` times through `who`'s session; the venue's own fills say what each earned
   * us. Returns their sum, the most the pot may be funded with once svc-trade has posted them.
   */
  async function earnBuilderFees(who, sells) {
    const since = new Date(Date.now() - 1000);
    const account = { venueId: (await testVenue('/venue')).body.venue.id, owner: traderOwner, subAccount: null };
    for (const [asset, amount] of [
      ['USDC', '10000'],
      ['BTC', String(SELL_SIZE * sells + 0.5)],
    ]) {
      const ref = `84532:${keccak256(toHex(`${J} ${RUN} ${traderOwner} ${asset} ${Date.now()}`))}:0`;
      const funded = await testVenue('/test/deposit', { account, asset, amount, depositRef: ref });
      expect(funded.status, JSON.stringify(funded.body)).toBe(200);
    }
    const status = (await (await api(who)).get('/api/v1/venue/status')).body;
    expect(status, JSON.stringify(status).slice(0, 300)).toMatchObject({ enabled: true, test: true });
    builder = status.builder.address;
    const markets = await testVenue('/markets', { account: null });
    const cap = markets.body.value.find((m) => m.symbol === 'BTC-USDC').builderFeeCapBps.value;
    await door(who, { kind: 'approve_builder_fee', builder, maxFeeBps: cap }, `approve-builder:${traderOwner}:${J}`);
    const buyer = `${J}-buyer-${RUN}`;
    await testDeposit(otherTraderKey(buyer).address, 'USDC', '200000', `seed:${buyer}:USDC:${Date.now()}`);
    const bid = await otherTraderRun(buyer, {
      kind: 'place_order',
      symbol: 'BTC-USDC',
      side: 'buy',
      type: 'limit',
      amount: String(SELL_SIZE * sells),
      price: '59990',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: `order:${buyer}:bid:${Date.now()}`,
      builderFee: null,
    });
    expect(bid, JSON.stringify(bid).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
    for (let i = 0; i < sells; i += 1) {
      await door(who, {
        kind: 'place_order',
        symbol: 'BTC-USDC',
        side: 'sell',
        type: 'limit',
        amount: String(SELL_SIZE),
        price: '59990',
        timeInForce: 'GTC',
        reduceOnly: false,
        clientOrderKey: `order:${J}:${RUN}:${Date.now()}:${(orders += 1)}`,
        builderFee: null,
      });
    }
    let fees = [];
    await expect
      .poll(
        async () => {
          const body = await venueRecord(traderOwner, '/fills', { since: since.toISOString() });
          fees = body.value.filter((f) => f.feeAsset === ASSET && !/^0(\.0+)?$/.test(f.builderFee)).map((f) => f.builderFee);
          return fees.length;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(sells);
    return sumDecimal(fees);
  }

  /** Founder A asks to sweep earned builder fees into the USDC reward pot; founder B approves, which posts it. */
  async function fundPot(reference, amount) {
    const { ctx, pair } = await operators();
    const a = await pair.a.campaignsOpsToken();
    const b = await pair.b.campaignsOpsToken();
    data(
      await ctx.edge.mutate('campaigns', 'ops.pot.request', { reference, sourceModule: 'builder', asset: ASSET, amount }, a),
      'ops.pot.request',
    );
    const funded = data(await ctx.edge.mutate('campaigns', 'ops.pot.approve', { reference }, b), 'ops.pot.approve');
    expect(funded.state, JSON.stringify(funded)).toBe('posted');
  }

  /** Funds the pot with builder fees once svc-trade has posted them to the ledger (it posts on its own cadence). */
  async function fundPotFromFees(reference, amount) {
    await expect
      .poll(
        async () => {
          try {
            await fundPot(`${reference}-${Date.now().toString(36)}`, amount);
            return 'posted';
          } catch (err) {
            return String(err).slice(0, 200);
          }
        },
        { timeout: 90_000, intervals: [5_000] },
      )
      .toBe('posted');
  }

  /**
   * Pays INTAFACED's TEST rewards wallet from our own TEST builder fees: the file's TEST trader sends 10 TEST USD to the
   * TEST venue's deposit address on the chain (so the venue holds tokens to pay a withdrawal from), then the TEST venue
   * records a claim of our unclaimed builder fees (its TEST claim control). svc-trade books the claim collected and
   * sweeps what our builder account holds above the TEST float to the rewards wallet.
   */
  async function claimOurBuilderFees() {
    expect(testChain().chain, 'this journey needs the stack TEST chain').toBe('running');
    expect(builder, 'earnBuilderFees ran first').toBeTruthy();
    fundOnTestChain(traderOwner, 'venue');
    const { createWalletClient, encodeFunctionData, http, parseAbiItem } = await import('viem');
    const chain = {
      id: CHAIN_ID,
      name: 'TEST chain',
      nativeCurrency: { name: 'TEST ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [GATE_URL] } },
    };
    const before = await chainUsd(TEST_VENUE_DEPOSIT_ADDRESS);
    const wallet = createWalletClient({ account: traderKey, chain, transport: http(GATE_URL) });
    await wallet.sendTransaction({
      to: TOKEN_USD.address,
      data: encodeFunctionData({
        abi: [parseAbiItem(TRANSFER_FN)],
        functionName: 'transfer',
        args: [TEST_VENUE_DEPOSIT_ADDRESS, 10_000_000n],
      }),
    });
    await mineBlocks(4);
    expect(await chainUsd(TEST_VENUE_DEPOSIT_ADDRESS)).toBe(before + 10_000_000n);
    const claimed = await testVenue('/test/builder-claim', { builder });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
  }

  return { earnBuilderFees, fundPotFromFees, claimOurBuilderFees };
}
