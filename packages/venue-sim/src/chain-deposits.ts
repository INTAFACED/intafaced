import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbiItem,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { SCALE, compare, ZERO, type Amount } from '@intafaced/ledger-client/money';
import { venueDepositRef, type UserVenueAccount, type UserVenueDepositRoute } from '@intafaced/venue-contracts';
import type { TestVenueSimulator } from './simulator.js';

/**
 * THE TEST VENUE'S CHAIN SIDE (J-wallet-09 #3 and #5): what a venue's deposit bridge does, on the stack's LOCAL TEST
 * chain (anvil). TEST ONLY: it talks to a loopback anvil node and nothing else.
 *
 *   · DEPOSITS. The customer's own wallet sends the route's token to the route's deposit address. The watcher reads the
 *     token's `Transfer` logs to that address and credits the SENDER's venue account by the transfer's own id
 *     (`venueDepositRef`: `<chainId>:<txHash>:<logIndex>`), so a log read twice, or a watcher restarted from an earlier
 *     block, credits nothing more (`creditDepositLogs`).
 *   · WITHDRAWALS. A withdrawal the customer signed is pending on the venue; after `settleAfterMs` the sender pays what
 *     arrives (the amount less the network fee taken) from the deposit address to the destination on chain, and only
 *     when that transfer's receipt succeeds settles it `done` (`payPendingWithdrawals`). One payment per withdrawal: the
 *     hash is kept before the receipt is awaited, so a slow receipt is waited on again, never sent twice.
 *
 * The deposit address has no key: it is impersonated on this anvil only (`anvil_impersonateAccount`), as the stack's
 * TEST fee relayer is, so nothing can sign for it anywhere else. If this process dies, the simulator's in-memory record
 * dies with it (every figure is TEST): no customer money exists here to strand. INTAFACED moves nothing and the ledger
 * posts nothing.
 */

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const TRANSFER_FN = parseAbiItem('function transfer(address to, uint256 value) returns (bool)');

/** One token `Transfer` log, as the watcher reads it. */
export interface DepositLog {
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
  /** A log from a block the node has since dropped (a reorg). Never credited. */
  readonly removed?: boolean;
}

/** Token base units to a scaled Amount. Exact: the token has at most the Amount's 18 decimals. */
export function tokenUnitsToAmount(units: bigint, decimals: number): Amount {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error(`token decimals must be 0 to 18, got ${decimals}`);
  return (units * (SCALE / 10n ** BigInt(decimals))) as Amount;
}

/** A scaled Amount to token base units, rounded down: a payment never sends more than the record says. */
export function amountToTokenUnits(amount: Amount, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error(`token decimals must be 0 to 18, got ${decimals}`);
  if (compare(amount, ZERO) <= 0) return 0n;
  return amount / (SCALE / 10n ** BigInt(decimals));
}

/**
 * Credit every log that is a transfer of the route's token INTO the deposit address, to its sender's main account.
 * Idempotent by `depositRef`: a log already credited adds nothing. Returns what was credited and what was a replay.
 */
export function creditDepositLogs(
  sim: TestVenueSimulator,
  route: UserVenueDepositRoute,
  logs: readonly DepositLog[],
): { credited: string[]; replayed: string[] } {
  const credited: string[] = [];
  const replayed: string[] = [];
  for (const log of logs) {
    if (log.removed) continue;
    if (log.to.toLowerCase() !== route.address.toLowerCase() || log.value <= 0n) continue;
    // The deposit address paying out a withdrawal is not a deposit; nor is a transfer to itself.
    if (log.from.toLowerCase() === route.address.toLowerCase()) continue;
    const ref = venueDepositRef(route.chainId, log.transactionHash, log.logIndex);
    const account: UserVenueAccount = { venueId: sim.venue.id, owner: log.from.toLowerCase(), subAccount: null };
    if (sim.deposit(account, route.asset, tokenUnitsToAmount(log.value, route.tokenDecimals), ref)) credited.push(ref);
    else replayed.push(ref);
  }
  return { credited, replayed };
}

/** What the payer needs from a chain: send one token transfer from the deposit address, and read its receipt. */
export interface WithdrawalPayer {
  send(to: string, units: bigint): Promise<string>;
  /** `true` succeeded, `false` reverted, `null` not mined yet. */
  receipt(hash: string): Promise<boolean | null>;
}

/**
 * Pay every pending withdrawal older than `settleAfterMs` once, and settle each `done` when its payment's receipt
 * succeeds, `failed` (the venue returns amount and fee) when it reverts. `paid` holds the hash per withdrawal across
 * calls, set BEFORE the receipt is awaited, so a withdrawal is never paid twice by this process.
 */
export async function payPendingWithdrawals(
  sim: TestVenueSimulator,
  route: UserVenueDepositRoute,
  payer: WithdrawalPayer,
  paid: Map<string, string>,
  now: Date,
  settleAfterMs: number,
): Promise<{ done: string[]; failed: string[] }> {
  const done: string[] = [];
  const failed: string[] = [];
  for (const pending of sim.pendingWithdrawals()) {
    if (pending.withdrawal.asset !== route.asset) continue;
    if (now.getTime() - pending.submittedAt.getTime() < settleAfterMs) continue;
    const key = `${pending.account.owner}/${pending.account.subAccount ?? ''}#${pending.nonce}`;
    let hash = paid.get(key);
    if (!hash) {
      const units = amountToTokenUnits(pending.arrives, route.tokenDecimals);
      const destination = pending.withdrawal.destination;
      if (!destination || units <= 0n) {
        // Nothing can arrive (no destination, or the fee takes it all): the venue returns it.
        sim.settleWithdrawal(pending.account, pending.nonce, 'failed');
        failed.push(pending.nonce);
        continue;
      }
      hash = await payer.send(destination, units);
      paid.set(key, hash);
    }
    const ok = await payer.receipt(hash);
    if (ok === null) continue;
    sim.settleWithdrawal(pending.account, pending.nonce, ok ? 'done' : 'failed');
    (ok ? done : failed).push(pending.nonce);
  }
  return { done, failed };
}

export interface ChainDepositsOptions {
  readonly sim: TestVenueSimulator;
  readonly route: UserVenueDepositRoute;
  /** The LOCAL TEST chain's anvil node. Loopback only. */
  readonly rpcUrl: string;
  readonly intervalMs?: number;
  /** How long a withdrawal stays pending before it is paid (a venue's own withdrawal delay). */
  readonly settleAfterMs?: number;
  readonly clock?: () => Date;
  readonly log?: (line: Record<string, unknown>) => void;
}

/** Start watching deposits and paying withdrawals on the TEST chain. Returns a stop function. */
export async function startChainDeposits(opts: ChainDepositsOptions): Promise<() => void> {
  const host = new URL(opts.rpcUrl).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
    throw new Error(`the TEST venue watches a loopback chain only, not ${opts.rpcUrl}`);
  }
  const transport = http(opts.rpcUrl);
  const client = createPublicClient({ transport }) as PublicClient;
  const chainId = await client.getChainId();
  if (chainId !== opts.route.chainId) throw new Error(`the TEST chain at ${opts.rpcUrl} is chain ${chainId}, not ${opts.route.chainId}`);
  const version = String(await client.request({ method: 'web3_clientVersion' } as never));
  if (!/anvil/i.test(version)) throw new Error(`the TEST venue pays from an impersonated address on anvil only, not ${version}`);
  const depositAddress = opts.route.address as Address;
  // The deposit address pays network gas in TEST ETH; it has no key, so anvil sends for it.
  await client.request({ method: 'anvil_impersonateAccount', params: [depositAddress] } as never);
  await client.request({ method: 'anvil_setBalance', params: [depositAddress, toHex(10n ** 20n)] } as never);
  const wallet = createWalletClient({ transport, account: depositAddress });
  const payer: WithdrawalPayer = {
    async send(to, units) {
      return wallet.sendTransaction({
        chain: null,
        to: opts.route.token as Address,
        data: encodeFunctionData({ abi: [TRANSFER_FN], functionName: 'transfer', args: [to as Address, units] }),
      });
    },
    async receipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash: hash as Hex });
        return r.status === 'success';
      } catch {
        return null;
      }
    },
  };
  const clock = opts.clock ?? (() => new Date());
  const log = opts.log ?? (() => undefined);
  const paid = new Map<string, string>();
  // From the start of this chain: a fresh anvil per stack, and the ref makes a re-read credit nothing.
  let fromBlock = 0n;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const head = await client.getBlockNumber();
      if (head >= fromBlock) {
        const logs = await client.getLogs({
          address: opts.route.token as Address,
          event: TRANSFER,
          args: { to: depositAddress },
          fromBlock,
          toBlock: head,
        });
        const result = creditDepositLogs(
          opts.sim,
          opts.route,
          logs.map((l) => ({
            transactionHash: l.transactionHash ?? '',
            logIndex: l.logIndex ?? -1,
            from: l.args.from ?? '',
            to: l.args.to ?? '',
            value: l.args.value ?? 0n,
            removed: l.removed,
          })),
        );
        if (result.credited.length) log({ msg: 'test-venue.deposit_credited', label: 'TEST', refs: result.credited });
        fromBlock = head + 1n;
      }
      const settled = await payPendingWithdrawals(opts.sim, opts.route, payer, paid, clock(), opts.settleAfterMs ?? 4000);
      if (settled.done.length || settled.failed.length) log({ msg: 'test-venue.withdrawals_settled', label: 'TEST', ...settled });
    } catch (err) {
      // The chain is unreachable for now: nothing is credited or paid until it answers again.
      log({ msg: 'test-venue.chain_unreachable', label: 'TEST', detail: (err as Error).message });
    } finally {
      running = false;
    }
  };
  await tick();
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}
