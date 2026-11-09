/**
 * LIVE TESTNET CONFORMANCE — run by hand, never in CI.
 *
 *   APP_ENV=test HL_TESTNET_KEY_FILE=/path/to/keys.json \
 *   HL_SPOT_SYMBOL=PURR-USDC HL_SPOT_PRICE=<a price near the book> HL_SPOT_SIZE=<size> \
 *   HL_PROBE_SYMBOL=ETH-PERP HL_PROBE_PRICE=<a price far from the book> HL_PROBE_SIZE=<size> \
 *     pnpm --filter @intafaced/venue-hyperliquid conformance:live
 *
 * Runs the shared `UserVenue` conformance suite (`@intafaced/venue-sim`, conformance.ts)
 * against the Hyperliquid TESTNET, then a duplicate-cloid probe: the same order
 * intent prepared and signed twice (same cloid, new nonce) must leave one order
 * on the venue, and the second answer must be `already_submitted` or a
 * definite refusal. The probe prints the venue's own words for the second
 * answer, so the adapter's duplicate-cloid matching can be checked against them.
 *
 * Keys: `HL_TESTNET_KEY_FILE` is the PATH of a JSON file
 * `{ "trader": "0x…", "agent": "0x…", "other": "0x…", "third": "0x…" }` holding
 * throwaway TESTNET keys the owner arranged. Only `trader` is needed for the
 * probe; the suite needs all four. A key is read into memory and used to sign;
 * it is never printed, logged or written anywhere. Only addresses are printed.
 *
 * What the live venue cannot do on demand is reported skipped, never passed:
 * losing an answer, settling a withdrawal, a perp market with no leverage set
 * (the venue always has a default). `fund` cannot credit a testnet account: it
 * checks the account already holds enough and says how much is missing.
 */
import { readFileSync } from 'node:fs';
import { deepStrictEqual } from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { compare, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type { PlaceUserOrderIntent, PreparedVenueAction, UserVenueAccount } from '@intafaced/venue-contracts';
import { defineUserVenueConformance, type ConformanceWallet } from '@intafaced/venue-sim';
import { HL_TESTNET_VENUE_ID, HyperliquidTestnetUserVenue, typedDataDigest, type HlTypedData, type L1TypedData } from '../src/index.js';

type KeyName = 'trader' | 'agent' | 'other' | 'third';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function readKeys(): Partial<Record<KeyName, `0x${string}`>> {
  const path = process.env.HL_TESTNET_KEY_FILE;
  if (!path) fail('HL_TESTNET_KEY_FILE is not set: give the path of the TESTNET key file the owner arranged.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Never echo the file's contents.
    fail('HL_TESTNET_KEY_FILE could not be read as JSON.');
  }
  const out: Partial<Record<KeyName, `0x${string}`>> = {};
  for (const name of ['trader', 'agent', 'other', 'third'] as const) {
    const value = (parsed as Record<string, unknown>)[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value))
      fail(`key "${name}" is not a 32-byte hex key (its value is not shown).`);
    out[name] = value as `0x${string}`;
  }
  if (!out.trader) fail('the key file has no "trader" key.');
  return out;
}

function wallet(key: `0x${string}`, role: 'owner' | 'agent'): ConformanceWallet {
  const signerKey = privateKeyToAccount(key);
  const address = signerKey.address.toLowerCase();
  return {
    signer: { role, address },
    async sign(prepared: PreparedVenueAction) {
      const typed = prepared.typedData as HlTypedData;
      const signature =
        typed.primaryType === 'Agent'
          ? await signerKey.signTypedData(typed as L1TypedData)
          : await signerKey.sign({ hash: typedDataDigest(typed) });
      return { digest: prepared.digest, signature, signedBy: address };
    },
  };
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) fail(`${name} is not set.`);
  return v;
}

// ── a tiny describe / it / expect, so the shared suite runs without a test runner ──
const tests: { name: string; fn: () => Promise<void>; skip: boolean }[] = [];
const describe = (_name: string, fn: () => void) => fn();
const it = Object.assign((name: string, fn: () => Promise<void>) => void tests.push({ name, fn, skip: false }), {
  skip: (name: string, fn: () => Promise<void>) => void tests.push({ name, fn, skip: true }),
});
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? formatAmount(x) : x));
function expect(actual: unknown) {
  const toBe = (expected: unknown) => {
    if (!Object.is(actual, expected)) throw new Error(`expected ${show(expected)}, got ${show(actual)}`);
  };
  return {
    toBe,
    toEqual: (expected: unknown) => deepStrictEqual(actual, expected),
    toBeNull: () => toBe(null),
    not: {
      toBeNull: () => {
        if (actual === null) throw new Error('expected a value, got null');
      },
      toBe: (expected: unknown) => {
        if (Object.is(actual, expected)) throw new Error(`expected anything but ${show(expected)}`);
      },
    },
    rejects: {
      toBeInstanceOf: async (type: unknown) => {
        try {
          await (actual as Promise<unknown>);
        } catch (error) {
          if (!(error instanceof (type as new () => unknown)))
            throw new Error(`rejected with the wrong error: ${(error as Error).message}`);
          return;
        }
        throw new Error('expected a rejection');
      },
    },
  };
}

async function main(): Promise<void> {
  const keys = readKeys();
  const venue = new HyperliquidTestnetUserVenue({ appEnv: process.env.APP_ENV });
  const acct = (key: `0x${string}`): UserVenueAccount => ({
    venueId: HL_TESTNET_VENUE_ID,
    owner: privateKeyToAccount(key).address.toLowerCase(),
    subAccount: null,
  });
  const trader = wallet(keys.trader!, 'owner');
  const traderAccount = acct(keys.trader!);
  process.stdout.write(`venue: ${venue.venue.displayName} (${venue.venue.id}); trader ${traderAccount.owner}\n`);

  // ── the duplicate-cloid probe ──
  const probeSymbol = env('HL_PROBE_SYMBOL');
  const probe: PlaceUserOrderIntent = {
    kind: 'place_order',
    symbol: probeSymbol,
    side: 'buy',
    type: 'limit',
    amount: parseAmount(env('HL_PROBE_SIZE')),
    price: parseAmount(env('HL_PROBE_PRICE')),
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:live-probe:${traderAccount.owner}:${new Date().toISOString().slice(0, 10)}:dup`,
    builderFee: null,
  };
  const first = await venue.prepare(traderAccount, trader.signer, probe);
  const firstOutcome = await venue.submit(first, await trader.sign(first));
  process.stdout.write(`probe first answer: ${show(firstOutcome)}\n`);
  const second = await venue.prepare(traderAccount, trader.signer, probe);
  const secondOutcome = await venue.submit(second, await trader.sign(second));
  process.stdout.write(`probe second answer (same cloid ${second.venueClientOrderId}, new nonce): ${show(secondOutcome)}\n`);
  const sameCloid = (await venue.openOrders(traderAccount)).value.filter((o) => o.venueClientOrderId === first.venueClientOrderId);
  const probePassed = sameCloid.length <= 1 && (!secondOutcome.definite || !secondOutcome.accepted);
  process.stdout.write(`probe: ${sameCloid.length} open order(s) with that cloid; ${probePassed ? 'PASS' : 'FAIL'}\n`);
  const cancel = await venue.prepare(traderAccount, trader.signer, {
    kind: 'cancel_order',
    symbol: probeSymbol,
    clientOrderKey: probe.clientOrderKey,
  });
  process.stdout.write(`probe cleanup cancel: ${show(await venue.submit(cancel, await trader.sign(cancel)))}\n`);

  // ── the shared suite ──
  if (!keys.agent || !keys.other || !keys.third) {
    process.stdout.write('conformance suite: SKIPPED (the key file needs "agent", "other" and "third" too)\n');
    process.exit(probePassed ? 0 : 1);
  }
  const spot = { symbol: env('HL_SPOT_SYMBOL'), price: parseAmount(env('HL_SPOT_PRICE')), size: parseAmount(env('HL_SPOT_SIZE')) };
  const spotMarket = (await venue.markets(null)).value.find((m) => m.symbol === spot.symbol);
  if (!spotMarket) fail(`${spot.symbol} is not listed on the testnet`);
  defineUserVenueConformance(
    {
      canLoseAnswers: false,
      dedupesClientIds: true,
      canSettleWithdrawals: false,
      perp: null,
      async setup() {
        return {
          venue,
          trader: { account: traderAccount, wallet: trader, agent: wallet(keys.agent!, 'agent') },
          other: { account: acct(keys.other!), wallet: wallet(keys.other!, 'owner') },
          third: { account: acct(keys.third!), wallet: wallet(keys.third!, 'owner') },
          spot: { ...spot, base: spotMarket.baseAsset, quote: spotMarket.quoteAsset },
          async fund(account: UserVenueAccount, asset: string, amount: Amount) {
            const have = (await venue.balances(account)).value.find((b) => b.asset === asset)?.free ?? 0n;
            if (compare(have, amount) < 0) {
              throw new Error(
                `${account.owner} holds ${formatAmount(have)} ${asset} free; fund it on the testnet to at least ${formatAmount(amount)}`,
              );
            }
          },
          loseNextAnswer: null,
          settleWithdrawals: null,
          setVenueDown: null,
        };
      },
    },
    { describe, it, expect: expect as never },
  );
  let failed = 0;
  for (const t of tests) {
    if (t.skip) {
      process.stdout.write(`SKIP  ${t.name}\n`);
      continue;
    }
    try {
      await t.fn();
      process.stdout.write(`PASS  ${t.name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`FAIL  ${t.name}\n      ${(error as Error).message.split('\n')[0]}\n`);
    }
  }
  process.stdout.write(
    `${tests.length} checks: ${failed} failed, ${tests.filter((t) => t.skip).length} skipped; probe ${probePassed ? 'PASS' : 'FAIL'}\n`,
  );
  process.exit(failed === 0 && probePassed ? 0 : 1);
}

main().catch((error: unknown) => {
  // A key never reaches an error message: only venue answers and our own words do.
  process.stderr.write(`live conformance stopped: ${(error as Error).message}\n`);
  process.exit(1);
});
