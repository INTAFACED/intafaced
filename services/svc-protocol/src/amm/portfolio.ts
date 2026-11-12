import { parseAbiItem, parseUnits, type Address, type Hex, type PublicClient } from 'viem';
import {
  PORTFOLIO_TRANSFERS_SHOWN,
  TOKENS_READ_TOO_LARGE,
  type ProtocolPortfolio,
  type ProtocolPortfolioHolding,
  type ProtocolPortfolioTransfer,
  type ProtocolSwapPairs,
} from '@intafaced/contracts';
import { classifyChainError } from '../chain/availability.js';
import { listPairs } from './pairs.js';
import { priceTokens, usdText, type PriceSetting } from './prices.js';
import { MAX_LOGS, TokensReadError, type SyncLog } from './tokens.js';
import { shapeToken, type TokenLogsChain } from './token-reader.js';

/**
 * One address's portfolio (D-portfolio-wallet-04, J-dex-protocol-06), worked out from the chain alone: its balances of
 * the listed tokens now, priced from the pools as `amm.prices` prices them, and its value at every block where its
 * balances or a pool's reserves changed, replayed from the `Transfer` and `Sync` logs. Each amount that arrived or left
 * is valued at its own block's price; a token with no price at a block is left out of that block's value, never valued
 * at zero or at another block's price. Read straight from the node and sized for the TEST chain: past `MAX_LOGS` logs it
 * refuses `protocol.tokens_read_too_large` rather than answer from part of the history.
 */

const PLACES = 18;
const SCALE = parseUnits('1', PLACES);
const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

export interface HolderTransfer {
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
  block: bigint;
  logIndex: number;
  tx: Hex;
}

/** The reads the portfolio needs: the token pages' reads and the address's own transfers. */
export interface PortfolioChain extends Pick<
  TokenLogsChain,
  'headBlock' | 'factoryPools' | 'poolSnapshot' | 'tokenBasics' | 'poolLogs' | 'blockTimes' | 'balanceOf'
> {
  /** Every `Transfer` of `tokens` to or from `holder`, from the first block to `toBlock`. */
  holderTransfers(tokens: readonly Address[], holder: Address, toBlock: bigint): Promise<HolderTransfer[]>;
}

/** `PortfolioChain` over the token pages' reads and the service's read-only client. A failed read refuses with its code. */
export function portfolioChain(logs: TokenLogsChain, client: () => PublicClient, rpcUrl: () => string): PortfolioChain {
  const read = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TokensReadError) throw err;
      throw classifyChainError(err, what, rpcUrl());
    }
  };
  return {
    headBlock: () => logs.headBlock(),
    factoryPools: (factory, limit, block) => logs.factoryPools(factory, limit, block),
    poolSnapshot: (pool, block) => logs.poolSnapshot(pool, block),
    tokenBasics: (token) => logs.tokenBasics(token),
    poolLogs: (pools, toBlock) => logs.poolLogs(pools, toBlock),
    blockTimes: (blocks) => logs.blockTimes(blocks),
    balanceOf: (token, holder, block) => logs.balanceOf(token, holder, block),
    holderTransfers: (tokens, holder, toBlock) =>
      read('holderTransfers', async () => {
        if (tokens.length === 0) return [];
        const [out, into] = await Promise.all([
          client().getLogs({ address: [...tokens], event: transfer, args: { from: holder }, fromBlock: 0n, toBlock }),
          client().getLogs({ address: [...tokens], event: transfer, args: { to: holder }, fromBlock: 0n, toBlock }),
        ]);
        tooLarge(out.length + into.length);
        // A transfer to oneself is in both reads: kept once.
        const seen = new Map<string, HolderTransfer>();
        for (const log of [...out, ...into])
          seen.set(`${log.transactionHash}:${log.logIndex}`, {
            token: log.address,
            from: log.args.from!,
            to: log.args.to!,
            value: log.args.value!,
            block: log.blockNumber!,
            logIndex: log.logIndex!,
            tx: log.transactionHash!,
          });
        return [...seen.values()];
      }),
  };
}

function tooLarge(count: number) {
  if (count > MAX_LOGS)
    throw new TokensReadError(
      TOKENS_READ_TOO_LARGE,
      `${count} logs is more than this read takes (${MAX_LOGS}); the indexer must project them.`,
    );
}

const lower = (value: string) => value.toLowerCase();
/** 18-place USD from a decimal string price. */
const priceUnits = (text: string) => parseUnits(text, PLACES);
/** The USD value (18 places) of `amount` base units at `price` (18 places per whole token). */
const valueOf = (amount: bigint, decimals: number, price: bigint) => (amount * price) / 10n ** BigInt(decimals);
/** A signed 18-place figure as a decimal string. */
const signedText = (value: bigint) => (value < 0n ? `-${usdText(-value)}` : usdText(value));
/** A ratio scaled by 1e18 as a percent with two decimals, rounded half up. */
function percentText(ratio: bigint): string {
  const hundredths = (ratio * 10_000n + SCALE / 2n) / SCALE;
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

/** Each listed token's price (18 places) at the pools' reserves in `pairs`; a token with none is absent. */
function priceMap(pairs: ProtocolSwapPairs, setting: PriceSetting): Map<string, bigint> {
  const prices = new Map<string, bigint>();
  for (const row of priceTokens(pairs, setting)) if (row.usd !== null) prices.set(lower(row.address), priceUnits(row.usd));
  return prices;
}

export interface PortfolioDeps {
  chain: PortfolioChain;
  factory: Address;
  setting: PriceSetting;
}

/** `holder`'s portfolio at the head block. */
export async function readPortfolio({ chain, factory, setting }: PortfolioDeps, holder: Address): Promise<ProtocolPortfolio> {
  const head = await chain.headBlock();
  const pairs = await listPairs(chain, factory, head);
  // A token claiming more decimals than the wire takes is left out, as on the token pages.
  const tokens = pairs.tokens.flatMap((token) => {
    const shaped = shapeToken(token);
    return shaped ? [shaped] : [];
  });
  const byAddress = new Map(tokens.map((token) => [lower(token.address), token]));
  const pools = pairs.pools.filter((pool) => byAddress.has(lower(pool.token0)) && byAddress.has(lower(pool.token1)));
  const poolSet = new Set(pools.map((pool) => lower(pool.pool)));
  const addresses = tokens.map((token) => token.address as Address);

  const [transfers, poolLogs, balances] = await Promise.all([
    chain.holderTransfers(addresses, holder, head),
    chain.poolLogs(
      pools.map((pool) => pool.pool as Address),
      head,
    ),
    Promise.all(addresses.map((token) => chain.balanceOf(token, holder, head))),
  ]);
  const shown = [...transfers].sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block < b.block ? 1 : -1));
  const listed = shown.slice(0, PORTFOLIO_TRANSFERS_SHOWN);
  const times = await chain.blockTimes([head, ...listed.map((entry) => entry.block)]);

  const history = replay({ transfers, syncs: poolLogs.syncs, pairs: { ...pairs, tokens, pools }, setting, holder, poolSet });

  // Now: the balances read at the head, priced from the head's pools.
  const nowPrices = priceTokens({ ...pairs, tokens, pools }, setting);
  const priceRow = new Map(nowPrices.map((row) => [lower(row.address), row]));
  let total = 0n;
  let unpriced = 0;
  const holdings: ProtocolPortfolioHolding[] = [];
  tokens.forEach((token, index) => {
    const balance = balances[index]!;
    if (balance === 0n) return;
    const row = priceRow.get(lower(token.address));
    const price = row?.usd ? priceUnits(row.usd) : null;
    const value = price === null ? null : valueOf(balance, token.decimals, price);
    if (value === null) unpriced += 1;
    else total += value;
    const entry = history.entries.get(lower(token.address));
    holdings.push({
      token: token.address,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      balance: balance.toString(),
      usd: price === null ? null : usdText(price),
      reason: price === null ? (row?.reason ?? 'no_route') : null,
      valueUsd: value === null ? null : usdText(value),
      entry:
        entry && entry.arrivals > 0 && entry.quantity > 0n
          ? {
              usd: usdText((entry.cost * 10n ** BigInt(token.decimals)) / entry.quantity),
              arrivals: entry.arrivals,
              unpriced: entry.unpriced,
              firstBlock: entry.firstBlock.toString(),
              lastBlock: entry.lastBlock.toString(),
            }
          : null,
    });
  });

  const outgoing: ProtocolPortfolioTransfer[] = listed.map((entry) => {
    const token = byAddress.get(lower(entry.token))!;
    const into = lower(entry.to) === lower(holder);
    const counterparty = into ? entry.from : entry.to;
    return {
      block: entry.block.toString(),
      time: times.get(entry.block) ?? 0,
      tx: entry.tx,
      token: token.address,
      symbol: token.symbol,
      decimals: token.decimals,
      direction: into ? 'in' : 'out',
      amount: entry.value.toString(),
      counterparty,
      pool: poolSet.has(lower(counterparty)),
    };
  });

  const asOf = new Date((times.get(head) ?? 0) * 1000).toISOString();
  return {
    address: holder,
    blockNumber: head.toString(),
    asOf,
    totalUsd: usdText(total),
    unpriced,
    holdings,
    pnl:
      history.since === null
        ? null
        : {
            usd: signedText(total - history.deposits + history.withdrawals),
            depositsUsd: usdText(history.deposits),
            withdrawalsUsd: usdText(history.withdrawals),
            sinceBlock: history.since.toString(),
          },
    drawdown: history.drawdown,
    transfers: outgoing,
    transferCount: transfers.length,
  };
}

interface EntryState {
  cost: bigint;
  quantity: bigint;
  arrivals: number;
  unpriced: number;
  firstBlock: bigint;
  lastBlock: bigint;
}

interface ReplayInput {
  transfers: readonly HolderTransfer[];
  syncs: readonly Omit<SyncLog, 'time'>[];
  /** The listed tokens and pools; their reserves are replaced block by block from the `Sync` logs. */
  pairs: ProtocolSwapPairs;
  setting: PriceSetting;
  holder: Address;
  poolSet: ReadonlySet<string>;
}

/**
 * Replays the address's transfers and the pools' reserves in log order, block by block. At each block where either
 * changed while the address held something, it values the holdings at that block's prices and records what came in or
 * went out (a transfer whose other side is a listed pool is a trade, not money in or out). Returns the money in and out,
 * the entry price of each token, and the largest fall of the value with money in and out taken out.
 */
export function replay({ transfers, syncs, pairs, setting, holder, poolSet }: ReplayInput) {
  const me = lower(holder);
  const decimals = new Map(pairs.tokens.map((token) => [lower(token.address), token.decimals]));
  type Event = { block: bigint; logIndex: number } & (
    { kind: 'transfer'; transfer: HolderTransfer } | { kind: 'sync'; sync: Omit<SyncLog, 'time'> }
  );
  const events: Event[] = [
    ...transfers.map((entry) => ({ kind: 'transfer' as const, block: entry.block, logIndex: entry.logIndex, transfer: entry })),
    ...syncs.map((entry) => ({ kind: 'sync' as const, block: entry.block, logIndex: entry.logIndex, sync: entry })),
  ].sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));

  const balance = new Map<string, bigint>();
  const reserves = new Map<string, { reserve0: bigint; reserve1: bigint }>();
  const entries = new Map<string, EntryState>();
  let deposits = 0n;
  let withdrawals = 0n;
  let since: bigint | null = null;
  let previousValue = 0n;
  let index = SCALE;
  let peak: { index: bigint; value: bigint; block: bigint } | null = null;
  let worst: { fall: bigint; peakValue: bigint; peakBlock: bigint; troughValue: bigint; troughBlock: bigint } | null = null;

  const pricesNow = () =>
    priceMap(
      {
        ...pairs,
        pools: pairs.pools.map((pool) => {
          const r = reserves.get(lower(pool.pool));
          return { ...pool, reserve0: (r?.reserve0 ?? 0n).toString(), reserve1: (r?.reserve1 ?? 0n).toString() };
        }),
      },
      setting,
    );
  const holdsAnything = () => [...balance.values()].some((amount) => amount > 0n);

  let i = 0;
  while (i < events.length) {
    const block = events[i]!.block;
    const moved: HolderTransfer[] = [];
    const heldBefore = holdsAnything();
    for (; i < events.length && events[i]!.block === block; i++) {
      const event = events[i]!;
      if (event.kind === 'sync') {
        reserves.set(lower(event.sync.pool), { reserve0: event.sync.reserve0, reserve1: event.sync.reserve1 });
        continue;
      }
      const entry = event.transfer;
      const token = lower(entry.token);
      const into = lower(entry.to) === me;
      const out = lower(entry.from) === me;
      if (into === out) continue;
      balance.set(token, (balance.get(token) ?? 0n) + (into ? entry.value : -entry.value));
      moved.push(entry);
    }
    if (!heldBefore && !holdsAnything()) continue;
    const prices = pricesNow();
    let flow = 0n;
    for (const entry of moved) {
      const token = lower(entry.token);
      const into = lower(entry.to) === me;
      const price = prices.get(token);
      const places = decimals.get(token) ?? 0;
      if (into) {
        const state = entries.get(token) ?? { cost: 0n, quantity: 0n, arrivals: 0, unpriced: 0, firstBlock: block, lastBlock: block };
        state.arrivals += 1;
        state.lastBlock = block;
        if (price === undefined) state.unpriced += 1;
        else {
          state.cost += valueOf(entry.value, places, price);
          state.quantity += entry.value;
        }
        entries.set(token, state);
      }
      if (price === undefined || poolSet.has(lower(into ? entry.from : entry.to))) continue;
      const value = valueOf(entry.value, places, price);
      if (into) {
        deposits += value;
        flow += value;
      } else {
        withdrawals += value;
        flow -= value;
      }
    }
    let value = 0n;
    for (const [token, amount] of balance) {
      const price = prices.get(token);
      if (amount > 0n && price !== undefined) value += valueOf(amount, decimals.get(token) ?? 0, price);
    }
    since ??= block;
    // The value's own move this block: what it is now less what came in or went out, against what it was.
    if (previousValue > 0n) {
      const moved = value - flow;
      index = moved <= 0n ? 0n : (index * moved) / previousValue;
    }
    if (value > 0n) {
      if (peak === null || index >= peak.index) peak = { index, value, block };
      else {
        const fall = ((peak.index - index) * SCALE) / peak.index;
        if (worst === null || fall > worst.fall)
          worst = { fall, peakValue: peak.value, peakBlock: peak.block, troughValue: value, troughBlock: block };
      }
    }
    previousValue = value;
  }

  return {
    since,
    deposits,
    withdrawals,
    entries,
    drawdown:
      worst === null
        ? null
        : {
            pct: percentText(worst.fall),
            peakUsd: usdText(worst.peakValue),
            peakBlock: worst.peakBlock.toString(),
            troughUsd: usdText(worst.troughValue),
            troughBlock: worst.troughBlock.toString(),
          },
  };
}
