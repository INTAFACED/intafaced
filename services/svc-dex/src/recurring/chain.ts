/**
 * The recurring buy vault on chain (D-limit-dca-05): reads of a plan, the keeper's `fillRound` and `skip`, and the logs
 * a lost record is found again by. The keeper's sends move nothing but what the plan itself says: each round's input
 * through the plan's own pool, the output straight to the maker.
 */
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { revertName } from '../vault/chain.js';

export const RECURRING_ABI = parseAbi([
  'struct Terms { address tokenIn; address tokenOut; address pool; uint256 amountPerRound; uint32 rounds; uint64 interval; uint256 lowWad; uint256 highWad; uint64 retryWindow; uint16 slippageBps; }',
  'function create(Terms t) returns (bytes32)',
  'function fillRound(bytes32 planId) returns (uint256)',
  'function skip(bytes32 planId)',
  'function cancel(bytes32 planId) returns (uint256)',
  'function remaining(bytes32 planId) view returns (uint256)',
  'function inBand(bytes32 planId) view returns (bool)',
  'function price(address tokenIn, address tokenOut) view returns (uint256)',
  'struct Plan { address maker; address tokenIn; address tokenOut; address pool; uint256 amountPerRound; uint32 rounds; uint32 filled; uint64 interval; uint64 nextDue; uint64 retryWindow; uint16 slippageBps; bool open; uint256 lowWad; uint256 highWad; }',
  'function planOf(bytes32 planId) view returns (Plan)',
  'event PlanCreated(bytes32 indexed planId, address indexed maker, uint256 amountPerRound, uint32 rounds, uint64 firstDue)',
  'event RoundFilled(bytes32 indexed planId, uint32 round, uint256 amountIn, uint256 amountOut, uint256 priceWad)',
  'event RoundSkipped(bytes32 indexed planId, uint32 round, uint64 nextDue)',
  'event PlanCancelled(bytes32 indexed planId, uint256 refund)',
]);
const PLAN_CREATED = parseAbiItem(
  'event PlanCreated(bytes32 indexed planId, address indexed maker, uint256 amountPerRound, uint32 rounds, uint64 firstDue)',
);
const ROUND_FILLED = parseAbiItem(
  'event RoundFilled(bytes32 indexed planId, uint32 round, uint256 amountIn, uint256 amountOut, uint256 priceWad)',
);

export interface ChainPlan {
  readonly maker: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly pool: Address;
  readonly amountPerRound: bigint;
  readonly rounds: number;
  readonly filled: number;
  readonly interval: bigint;
  readonly nextDue: bigint;
  readonly retryWindow: bigint;
  readonly open: boolean;
  readonly lowWad: bigint;
  readonly highWad: bigint;
}

export interface RoundFill {
  readonly round: number;
  readonly amountOut: bigint;
  readonly txHash: Hex;
}

export type SendOutcome = { status: 'success'; fill: RoundFill | null } | { status: 'reverted' } | { status: 'pending' };

export interface RecurringChain {
  readonly wired: boolean;
  readonly vault: Address | null;
  /** Plans made since `fromBlock`: their ids and the block read up to. */
  created(fromBlock: bigint): Promise<{ ids: Hex[]; toBlock: bigint }>;
  plan(id: Hex): Promise<ChainPlan>;
  /** Every round of this plan the chain filled, read by the plan's own id. */
  fills(id: Hex): Promise<RoundFill[]>;
  price(tokenIn: Address, tokenOut: Address): Promise<bigint | null>;
  inBand(id: Hex): Promise<boolean>;
  now(): Promise<bigint>;
  sendFill(id: Hex): Promise<Hex>;
  sendSkip(id: Hex): Promise<Hex>;
  outcome(hash: Hex, id: Hex): Promise<SendOutcome>;
  /** Why a fill would revert now, or null when it would go through. */
  simulateFill(id: Hex): Promise<string | null>;
}

export interface RecurringChainSetting {
  readonly rpcUrl: string | undefined;
  readonly chainId: number | undefined;
  readonly vault: string | undefined;
  readonly keeper: string | undefined;
}

const off = async (): Promise<never> => {
  throw new Error('The recurring buy vault is not wired.');
};

export function unwiredRecurringChain(): RecurringChain {
  return {
    wired: false,
    vault: null,
    created: off,
    plan: off,
    fills: off,
    price: async () => null,
    inBand: off,
    now: off,
    sendFill: off,
    sendSkip: off,
    outcome: off,
    simulateFill: async () => 'rail.crypto',
  };
}

export function viemRecurringChain(setting: RecurringChainSetting): RecurringChain {
  if (!setting.rpcUrl || !setting.chainId || !setting.vault || !setting.keeper) return unwiredRecurringChain();
  const vault = getAddress(setting.vault);
  const keeper = getAddress(setting.keeper);
  const chain = defineChain({
    id: setting.chainId,
    name: 'recurring buy network',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [setting.rpcUrl] } },
  });
  const client: PublicClient = createPublicClient({ chain, transport: http(setting.rpcUrl, { timeout: 10_000 }) });
  const sender = createWalletClient({ chain, account: keeper, transport: http(setting.rpcUrl, { timeout: 10_000 }) });
  const read = <T>(functionName: string, args: readonly unknown[]) =>
    client.readContract({ address: vault, abi: RECURRING_ABI, functionName: functionName as never, args: args as never }) as Promise<T>;
  const send = (data: Hex) => sender.sendTransaction({ account: keeper, chain, to: vault, data, gas: 400_000n });

  return {
    wired: true,
    vault,
    async created(fromBlock) {
      const toBlock = await client.getBlockNumber();
      if (toBlock < fromBlock) return { ids: [], toBlock: fromBlock };
      const logs = await client.getLogs({ address: vault, event: PLAN_CREATED, fromBlock, toBlock });
      return { ids: logs.map((l) => l.args.planId!).filter(Boolean), toBlock };
    },
    async plan(id) {
      const p = await read<{
        maker: string;
        tokenIn: string;
        tokenOut: string;
        pool: string;
        amountPerRound: bigint;
        rounds: number;
        filled: number;
        interval: bigint;
        nextDue: bigint;
        retryWindow: bigint;
        open: boolean;
        lowWad: bigint;
        highWad: bigint;
      }>('planOf', [id]);
      return {
        maker: getAddress(p.maker),
        tokenIn: getAddress(p.tokenIn),
        tokenOut: getAddress(p.tokenOut),
        pool: getAddress(p.pool),
        amountPerRound: p.amountPerRound,
        rounds: Number(p.rounds),
        filled: Number(p.filled),
        interval: p.interval,
        nextDue: p.nextDue,
        retryWindow: p.retryWindow,
        open: p.open,
        lowWad: p.lowWad,
        highWad: p.highWad,
      };
    },
    async fills(id) {
      const logs = await client.getLogs({ address: vault, event: ROUND_FILLED, args: { planId: id }, fromBlock: 0n });
      return logs.map((l) => ({ round: Number(l.args.round), amountOut: l.args.amountOut!, txHash: l.transactionHash! }));
    },
    price: (tokenIn, tokenOut) => read<bigint>('price', [tokenIn, tokenOut]).catch(() => null),
    inBand: (id) => read<boolean>('inBand', [id]),
    now: async () => (await client.getBlock()).timestamp,
    sendFill: (id) => send(encodeFunctionData({ abi: RECURRING_ABI, functionName: 'fillRound', args: [id] })),
    sendSkip: (id) => send(encodeFunctionData({ abi: RECURRING_ABI, functionName: 'skip', args: [id] })),
    async outcome(hash, id) {
      const r = await client.getTransactionReceipt({ hash }).catch(() => null);
      if (!r) return { status: 'pending' };
      if (r.status !== 'success') return { status: 'reverted' };
      for (const log of r.logs) {
        if (getAddress(log.address) !== vault) continue;
        try {
          const ev = decodeEventLog({ abi: RECURRING_ABI, data: log.data, topics: log.topics });
          if (ev.eventName === 'RoundFilled' && (ev.args as { planId: Hex }).planId.toLowerCase() === id.toLowerCase()) {
            const a = ev.args as { round: number; amountOut: bigint };
            return { status: 'success', fill: { round: Number(a.round), amountOut: a.amountOut, txHash: hash } };
          }
        } catch {
          // another event of the vault
        }
      }
      return { status: 'success', fill: null };
    },
    async simulateFill(id) {
      try {
        await client.simulateContract({ account: keeper, address: vault, abi: RECURRING_ABI, functionName: 'fillRound', args: [id] });
        return null;
      } catch (err) {
        return revertName(err);
      }
    },
  };
}
