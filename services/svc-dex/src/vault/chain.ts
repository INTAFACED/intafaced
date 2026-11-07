/**
 * The order vault on chain, as svc-dex sees it (D-limit-dca-01 to -04). Reads go to the node; the keeper's three calls
 * (fill, poke, sweep) are sent FROM the keeper address by the node itself (`eth_sendTransaction`): this process holds
 * no key. On the local TEST stack that address is impersonated on the throwaway anvil; anywhere else a node that does
 * not hold the keeper refuses the send, and with no node or no keeper the port is unwired and every keeper action
 * reads `rail.crypto`.
 *
 * The keeper holds no user funds: `fill` moves only the maker's own credit, through a pool, to the maker, and pays at
 * least the order's minimum output, or the contract reverts.
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { ORDER_VAULT_ABI, POOL_ABI } from './abi.js';
import type { ChainOrder } from './model.js';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const DEPOSITED_EVENT = parseAbiItem('event Deposited(address indexed maker, address indexed token, uint256 amount)');
const SWEPT_EVENT = parseAbiItem('event Swept(address indexed token, address indexed to, uint256 amount)');
const FILLED_EVENT = parseAbiItem(
  'event Filled(bytes32 indexed orderId, address indexed maker, uint256 amountIn, uint256 amountOut, uint256 priceWad)',
);

export type PriceRead =
  | { readonly status: 'ok'; readonly priceWad: bigint }
  | { readonly status: 'stale' }
  | { readonly status: 'disagree' }
  | { readonly status: 'unwired' }
  | { readonly status: 'error'; readonly detail: string };

export type Simulated = { readonly ok: true; readonly out: bigint } | { readonly ok: false; readonly reason: string };

export type Receipt =
  | { readonly status: 'pending' }
  | { readonly status: 'reverted' }
  | { readonly status: 'success'; readonly filled?: { readonly amountIn: bigint; readonly amountOut: bigint; readonly priceWad: bigint } };

export interface PoolState {
  readonly reserveIn: bigint;
  readonly reserveOut: bigint;
  readonly feeBps: bigint;
}

export interface VaultChain {
  /** False when no node, vault or keeper is configured: every keeper action then reads rail.crypto. */
  readonly wired: boolean;
  readonly vault: Address | null;
  readonly chainId: number;
  credit(maker: string, token: string): Promise<bigint>;
  uncredited(token: string): Promise<bigint>;
  /** Tokens `maker` sent the vault by a plain transfer, less what the sweep already returned to them. */
  strays(maker: string, token: string): Promise<bigint>;
  price(base: string, quote: string): Promise<PriceRead>;
  watermark(order: ChainOrder): Promise<bigint>;
  remaining(order: ChainOrder): Promise<bigint>;
  boughtOut(orderId: Hex): Promise<bigint>;
  pool(pool: string, tokenIn: string): Promise<PoolState>;
  simulateFill(order: ChainOrder, signature: Hex, take: bigint, pool: string): Promise<Simulated>;
  sendFill(order: ChainOrder, signature: Hex, take: bigint, pool: string): Promise<Hex>;
  sendPoke(order: ChainOrder): Promise<Hex>;
  sendSweep(token: string, to: string, amount: bigint): Promise<Hex>;
  receipt(hash: Hex): Promise<Receipt>;
  /** The transactions that filled this order on chain, oldest first (a fill whose send threw is found here). */
  fillTxs(order: ChainOrder): Promise<Hex[]>;
  /** The chain's own clock, in seconds: expiry is judged by it, as the contract judges it. */
  now(): Promise<bigint>;
}

export interface VaultChainSetting {
  readonly rpcUrl: string | undefined;
  readonly chainId: number | undefined;
  readonly vault: string | undefined;
  readonly keeper: string | undefined;
}

/** A vault-side revert's name, or a short reason when the node gave none. */
export function revertName(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.reason ?? 'reverted';
  }
  return 'reverted';
}

const asArgs = (o: ChainOrder) => ({
  maker: getAddress(o.maker),
  base: getAddress(o.base),
  quote: getAddress(o.quote),
  isBuy: o.isBuy,
  above: o.above,
  amountIn: o.amountIn,
  triggerWad: o.triggerWad,
  trailBps: o.trailBps,
  minOut: o.minOut,
  expiry: o.expiry,
  nonce: o.nonce,
  version: o.version,
  link: o.link,
  parent: o.parent,
  outputToVault: o.outputToVault,
});

export function unwiredVaultChain(chainId = 0): VaultChain {
  const off = async (): Promise<never> => {
    throw new Error('rail.crypto');
  };
  return {
    wired: false,
    vault: null,
    chainId,
    credit: off,
    uncredited: off,
    strays: off,
    price: async () => ({ status: 'unwired' }),
    watermark: off,
    remaining: off,
    boughtOut: off,
    pool: off,
    simulateFill: async () => ({ ok: false, reason: 'rail.crypto' }),
    sendFill: off,
    sendPoke: off,
    sendSweep: off,
    receipt: off,
    fillTxs: off,
    now: off,
  };
}

export function viemVaultChain(setting: VaultChainSetting): VaultChain {
  if (!setting.rpcUrl || !setting.chainId || !setting.vault || !setting.keeper) return unwiredVaultChain(setting.chainId ?? 0);
  const vault = getAddress(setting.vault);
  const keeper = getAddress(setting.keeper);
  const chain = defineChain({
    id: setting.chainId,
    name: 'order vault network',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [setting.rpcUrl] } },
  });
  const client: PublicClient = createPublicClient({ chain, transport: http(setting.rpcUrl, { timeout: 10_000 }) });
  const sender = createWalletClient({ chain, account: keeper, transport: http(setting.rpcUrl, { timeout: 10_000 }) });
  const read = <T>(functionName: string, args: readonly unknown[]) =>
    client.readContract({ address: vault, abi: ORDER_VAULT_ABI, functionName: functionName as never, args: args as never }) as Promise<T>;
  const send = (data: Hex, gas = 600_000n) => sender.sendTransaction({ account: keeper, chain, to: vault, data, gas });

  return {
    wired: true,
    vault,
    chainId: setting.chainId,
    credit: (maker, token) => read<bigint>('credit', [getAddress(maker), getAddress(token)]),
    uncredited: (token) => read<bigint>('uncredited', [getAddress(token)]),
    async strays(maker, token) {
      const from = getAddress(maker);
      const [transfers, deposits, swept] = await Promise.all([
        client.getLogs({ address: getAddress(token), event: TRANSFER_EVENT, args: { from, to: vault }, fromBlock: 0n }),
        client.getLogs({ address: vault, event: DEPOSITED_EVENT, args: { maker: from, token: getAddress(token) }, fromBlock: 0n }),
        client.getLogs({ address: vault, event: SWEPT_EVENT, args: { token: getAddress(token), to: from }, fromBlock: 0n }),
      ]);
      const sum = (logs: readonly { args?: unknown }[], key: string) =>
        logs.reduce((acc, log) => acc + ((log.args as Record<string, bigint> | undefined)?.[key] ?? 0n), 0n);
      // A deposit's own transfer is not a stray: the transactions that carry a Deposited event are left out.
      const depositTx = new Set(deposits.map((d) => d.transactionHash));
      const plain = transfers.filter((t) => !depositTx.has(t.transactionHash));
      const owed = sum(plain, 'value') - sum(swept, 'amount');
      if (owed <= 0n) return 0n;
      const loose = await read<bigint>('uncredited', [getAddress(token)]);
      return owed < loose ? owed : loose;
    },
    async price(base, quote) {
      try {
        return { status: 'ok', priceWad: await read<bigint>('price', [getAddress(base), getAddress(quote)]) };
      } catch (err) {
        const name = revertName(err);
        if (name === 'Stale' || name === 'MissingReport') return { status: 'stale' };
        if (name === 'Disagreement') return { status: 'disagree' };
        return { status: 'error', detail: name };
      }
    },
    // Keyed by the signed order's hash (a made-up order with the same nonce has its own mark).
    watermark: async (order) => read<bigint>('watermark', [await read<Hex>('hashOrder', [order])]),
    remaining: (order) => read<bigint>('remaining', [asArgs(order)]),
    boughtOut: (orderId) => read<bigint>('boughtOut', [orderId]),
    async pool(pool, tokenIn) {
      const address = getAddress(pool);
      const [token0, reserves, feeBps] = await Promise.all([
        client.readContract({ address, abi: POOL_ABI, functionName: 'token0' }),
        client.readContract({ address, abi: POOL_ABI, functionName: 'getReserves' }),
        client.readContract({ address, abi: POOL_ABI, functionName: 'feeBps' }),
      ]);
      const zeroIn = getAddress(token0) === getAddress(tokenIn);
      return { reserveIn: zeroIn ? reserves[0] : reserves[1], reserveOut: zeroIn ? reserves[1] : reserves[0], feeBps: BigInt(feeBps) };
    },
    async simulateFill(order, signature, take, pool) {
      try {
        const { result } = await client.simulateContract({
          account: keeper,
          address: vault,
          abi: ORDER_VAULT_ABI,
          functionName: 'fill',
          args: [asArgs(order), signature, take, getAddress(pool)],
        });
        return { ok: true, out: result as bigint };
      } catch (err) {
        return { ok: false, reason: revertName(err) };
      }
    },
    sendFill: (order, signature, take, pool) =>
      send(encodeFunctionData({ abi: ORDER_VAULT_ABI, functionName: 'fill', args: [asArgs(order), signature, take, getAddress(pool)] })),
    sendPoke: (order) => send(encodeFunctionData({ abi: ORDER_VAULT_ABI, functionName: 'poke', args: [asArgs(order)] }), 200_000n),
    sendSweep: (token, to, amount) =>
      send(
        encodeFunctionData({ abi: ORDER_VAULT_ABI, functionName: 'sweepUncredited', args: [getAddress(token), getAddress(to), amount] }),
        200_000n,
      ),
    async receipt(hash) {
      const r = await client.getTransactionReceipt({ hash }).catch(() => null);
      if (!r) return { status: 'pending' };
      if (r.status !== 'success') return { status: 'reverted' };
      for (const log of r.logs) {
        if (getAddress(log.address) !== vault) continue;
        try {
          const ev = decodeEventLog({ abi: ORDER_VAULT_ABI, data: log.data, topics: log.topics });
          if (ev.eventName === 'Filled') {
            const a = ev.args as { amountIn: bigint; amountOut: bigint; priceWad: bigint };
            return { status: 'success', filled: { amountIn: a.amountIn, amountOut: a.amountOut, priceWad: a.priceWad } };
          }
        } catch {
          // another event of the vault
        }
      }
      return { status: 'success' };
    },
    async fillTxs(order) {
      const orderId = await read<Hex>('orderId', [getAddress(order.maker), order.nonce]);
      const logs = await client.getLogs({ address: vault, event: FILLED_EVENT, args: { orderId }, fromBlock: 0n });
      return logs.map((l) => l.transactionHash).filter((h): h is Hex => h !== null);
    },
    now: async () => (await client.getBlock()).timestamp,
  };
}
