import type { Sql } from 'postgres';
import { getAddress, hashTypedData, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import {
  INTENT_BAD_DECAY,
  INTENT_BAD_SIGNATURE,
  INTENT_DECAY_BOUNDS_UNSET,
  INTENT_DECAY_OUT_OF_BOUNDS,
  INTENT_NONCE_USED,
  INTENT_REACTOR_UNSET,
  protocolIntentCreateInputSchema,
  protocolIntentCreateOutputSchema,
  protocolIntentListOutputSchema,
  protocolIntentPostInputSchema,
  protocolIntentRowSchema,
  protocolIntentSettingsSchema,
  publicJurisdictionProcedure,
  router,
  TRPCError,
  type ProtocolIntentCreateInput,
  type ProtocolIntentCreateOutput,
  type ProtocolIntentList,
  type ProtocolIntentOrder,
  type ProtocolIntentPostInput,
  type ProtocolIntentRow,
  type ProtocolTypedData,
} from '@intafaced/contracts';
import { z } from 'zod';
import { isZeroAddress } from '../chain/availability.js';
import { feeRefusal } from '../amm/fee-relay.js';

/**
 * Signed intent orders with a Dutch-auction decay (D-swap-09). The swapper's own wallet signs the order (no gas); this
 * service checks and keeps it, hands it to the filler feed, and reads the chain to say what became of it. The platform
 * holds nothing: SovereignReactor moves the input straight to the filler and the output straight to the swapper. Only
 * the chain moves an order out of `open`: its nonce spent with a Filled or Cancelled event, or its deadline passed.
 */

export const REACTOR_ABI = parseAbi([
  'struct Order { address swapper; address tokenIn; uint256 amountIn; address tokenOut; uint256 startOut; uint256 endOut; uint256 decayStart; uint256 decayEnd; uint256 deadline; uint256 nonce; }',
  'function outAt(Order o, uint256 t) pure returns (uint256)',
  'function nonceSpent(address swapper, uint256 nonce) view returns (bool)',
]);
const FILLED_EVENT = parseAbiItem(
  'event Filled(bytes32 indexed orderHash, address indexed swapper, address indexed filler, uint256 nonce, uint256 amountIn, uint256 amountOut, uint256 filledAt)',
);
const CANCELLED_EVENT = parseAbiItem('event Cancelled(address indexed swapper, uint256 nonce)');
const TOKEN_ABI = parseAbi([
  'function nonces(address owner) view returns (uint256)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
]);
const DOMAIN_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];
export const ORDER_FIELDS = [
  { name: 'swapper', type: 'address' },
  { name: 'tokenIn', type: 'address' },
  { name: 'amountIn', type: 'uint256' },
  { name: 'tokenOut', type: 'address' },
  { name: 'startOut', type: 'uint256' },
  { name: 'endOut', type: 'uint256' },
  { name: 'decayStart', type: 'uint256' },
  { name: 'decayEnd', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
];
/** How far back one list reads the reactor's events: a technical read bound for one request, not a product limit. */
export const INTENT_LOG_BLOCKS = 50_000n;
/** The most nonces one create tries before refusing: a read bound. */
const NONCE_TRIES = 16;

export interface IntentRecord {
  id: string;
  chainId: number;
  reactor: Address;
  order: ProtocolIntentOrder;
  signature: Hex;
  permit: { value: string; deadline: string; signature: string } | null;
  state: 'open' | 'filled' | 'cancelled' | 'expired';
  amountOut: string | null;
  filledAt: string | null;
  fillTx: string | null;
  announcedAt: Date | null;
  createdAt: Date;
}

export interface IntentStore {
  /** Inserts the order, or returns the row already stored under the same id (a retry). Null: the nonce is taken. */
  put(
    record: Omit<IntentRecord, 'state' | 'amountOut' | 'filledAt' | 'fillTx' | 'announcedAt' | 'createdAt'>,
  ): Promise<IntentRecord | null>;
  list(chainId: number, swapper: Address): Promise<IntentRecord[]>;
  maxNonce(chainId: number, reactor: Address, swapper: Address): Promise<bigint | null>;
  settle(id: string, update: Pick<IntentRecord, 'state' | 'amountOut' | 'filledAt' | 'fillTx'>): Promise<void>;
  announced(id: string): Promise<void>;
  unannounced(chainId: number): Promise<IntentRecord[]>;
}

export class MemoryIntentStore implements IntentStore {
  private readonly rows = new Map<string, IntentRecord>();
  async put(record: Parameters<IntentStore['put']>[0]) {
    const found = this.rows.get(record.id);
    if (found) return found;
    const taken = [...this.rows.values()].some(
      (row) =>
        row.chainId === record.chainId &&
        row.reactor === record.reactor &&
        row.order.swapper === record.order.swapper &&
        row.order.nonce === record.order.nonce,
    );
    if (taken) return null;
    const row: IntentRecord = {
      ...record,
      state: 'open',
      amountOut: null,
      filledAt: null,
      fillTx: null,
      announcedAt: null,
      createdAt: new Date(),
    };
    this.rows.set(record.id, row);
    return row;
  }
  async list(chainId: number, swapper: Address) {
    return [...this.rows.values()]
      .filter((row) => row.chainId === chainId && row.order.swapper === swapper)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async maxNonce(chainId: number, reactor: Address, swapper: Address) {
    const nonces = [...this.rows.values()]
      .filter((row) => row.chainId === chainId && row.reactor === reactor && row.order.swapper === swapper)
      .map((row) => BigInt(row.order.nonce));
    return nonces.length ? nonces.reduce((a, b) => (a > b ? a : b)) : null;
  }
  async settle(id: string, update: Pick<IntentRecord, 'state' | 'amountOut' | 'filledAt' | 'fillTx'>) {
    const row = this.rows.get(id);
    if (row) Object.assign(row, update);
  }
  async announced(id: string) {
    const row = this.rows.get(id);
    if (row) row.announcedAt = new Date();
  }
  async unannounced(chainId: number) {
    return [...this.rows.values()].filter((row) => row.chainId === chainId && row.announcedAt === null && row.state === 'open');
  }
}

type Row = {
  id: string;
  chain_id: number;
  reactor: string;
  swapper: string;
  token_in: string;
  amount_in: string;
  token_out: string;
  start_out: string;
  end_out: string;
  decay_start: string;
  decay_end: string;
  deadline: string;
  nonce: string;
  signature: string;
  permit: IntentRecord['permit'] | string | null;
  state: IntentRecord['state'];
  amount_out: string | null;
  filled_at: string | null;
  fill_tx: string | null;
  announced_at: Date | string | null;
  created_at: Date | string;
};
const toRecord = (r: Row): IntentRecord => ({
  id: r.id,
  chainId: r.chain_id,
  reactor: getAddress(r.reactor),
  order: {
    swapper: getAddress(r.swapper),
    tokenIn: getAddress(r.token_in),
    amountIn: String(r.amount_in),
    tokenOut: getAddress(r.token_out),
    startOut: String(r.start_out),
    endOut: String(r.end_out),
    decayStart: String(r.decay_start),
    decayEnd: String(r.decay_end),
    deadline: String(r.deadline),
    nonce: String(r.nonce),
  },
  signature: r.signature as Hex,
  permit: typeof r.permit === 'string' ? (JSON.parse(r.permit) as IntentRecord['permit']) : r.permit,
  state: r.state,
  amountOut: r.amount_out === null ? null : String(r.amount_out),
  filledAt: r.filled_at === null ? null : String(r.filled_at),
  fillTx: r.fill_tx,
  announcedAt: r.announced_at === null ? null : new Date(r.announced_at),
  createdAt: new Date(r.created_at),
});

/** Postgres `IntentStore` over `protocol.intent_orders` (20261107090957). */
export class PostgresIntentStore implements IntentStore {
  constructor(private readonly sql: Sql) {}
  async put(record: Parameters<IntentStore['put']>[0]) {
    const o = record.order;
    const inserted = await this.sql<Row[]>`
      INSERT INTO protocol.intent_orders (id, chain_id, reactor, swapper, token_in, amount_in, token_out, start_out, end_out,
        decay_start, decay_end, deadline, nonce, signature, permit)
      VALUES (${record.id}, ${record.chainId}, ${record.reactor}, ${o.swapper}, ${o.tokenIn}, ${o.amountIn}, ${o.tokenOut},
        ${o.startOut}, ${o.endOut}, ${o.decayStart}, ${o.decayEnd}, ${o.deadline}, ${o.nonce}, ${record.signature},
        ${record.permit === null ? null : this.sql.json(record.permit)})
      ON CONFLICT DO NOTHING RETURNING *`;
    if (inserted[0]) return toRecord(inserted[0]);
    const same = await this.sql<Row[]>`SELECT * FROM protocol.intent_orders WHERE id = ${record.id}`;
    return same[0] ? toRecord(same[0]) : null;
  }
  async list(chainId: number, swapper: Address) {
    const rows = await this.sql<Row[]>`
      SELECT * FROM protocol.intent_orders WHERE chain_id = ${chainId} AND swapper = ${swapper} ORDER BY created_at DESC LIMIT 200`;
    return rows.map(toRecord);
  }
  async maxNonce(chainId: number, reactor: Address, swapper: Address) {
    const rows = await this.sql<Array<{ max: string | null }>>`
      SELECT max(nonce)::text AS max FROM protocol.intent_orders WHERE chain_id = ${chainId} AND reactor = ${reactor} AND swapper = ${swapper}`;
    return rows[0]?.max ? BigInt(rows[0].max) : null;
  }
  async settle(id: string, update: Pick<IntentRecord, 'state' | 'amountOut' | 'filledAt' | 'fillTx'>) {
    await this.sql`
      UPDATE protocol.intent_orders SET state = ${update.state}, amount_out = ${update.amountOut}, filled_at = ${update.filledAt},
        fill_tx = ${update.fillTx}, updated_at = now()
      WHERE id = ${id} AND state = 'open'`;
  }
  async announced(id: string) {
    await this.sql`UPDATE protocol.intent_orders SET announced_at = now(), updated_at = now() WHERE id = ${id} AND announced_at IS NULL`;
  }
  async unannounced(chainId: number) {
    const rows = await this.sql<Row[]>`
      SELECT * FROM protocol.intent_orders WHERE chain_id = ${chainId} AND announced_at IS NULL AND state = 'open' LIMIT 50`;
    return rows.map(toRecord);
  }
}

export interface IntentDeps {
  client: () => PublicClient;
  chainId: () => number;
  /** `PROTOCOL_INTENT_REACTOR_ADDRESS`; zero refuses `dex.intent.reactor_unset`. */
  reactor: () => Address;
  /** `PROTOCOL_INTENT_DECAY_BOUNDS` ("min,max" seconds), an owner setting; null when blank. */
  decayBounds: () => { minSeconds: number; maxSeconds: number } | null;
  /** Where an open order is handed to fillers (the filler feed); null: nobody is told, the order waits (rail.crypto). */
  fillerUrl: () => string | null;
  store: IntentStore;
  toTrpcError: (err: unknown) => TRPCError;
}

const refuse = (code: TRPCError['code'], name: string, message: string) => feeRefusal(code, name, message);

function requireReactor(deps: IntentDeps): Address {
  const reactor = deps.reactor();
  if (isZeroAddress(reactor))
    throw refuse('PRECONDITION_FAILED', INTENT_REACTOR_UNSET, 'SovereignReactor is not configured (PROTOCOL_INTENT_REACTOR_ADDRESS).');
  return getAddress(reactor);
}
function requireBounds(deps: IntentDeps) {
  const bounds = deps.decayBounds();
  if (!bounds)
    throw refuse(
      'PRECONDITION_FAILED',
      INTENT_DECAY_BOUNDS_UNSET,
      'The allowed decay window (PROTOCOL_INTENT_DECAY_BOUNDS) is an owner setting; no order is taken while it is blank.',
    );
  return bounds;
}

export function orderTypedData(reactor: Address, chainId: number, order: ProtocolIntentOrder): ProtocolTypedData {
  return {
    types: { EIP712Domain: DOMAIN_FIELDS, IntentOrder: ORDER_FIELDS },
    primaryType: 'IntentOrder',
    domain: { name: 'SovereignReactor', version: '1', chainId, verifyingContract: reactor },
    message: { ...order },
  };
}
const toChain = (order: ProtocolIntentOrder) => ({
  swapper: order.swapper as Address,
  tokenIn: order.tokenIn as Address,
  amountIn: BigInt(order.amountIn),
  tokenOut: order.tokenOut as Address,
  startOut: BigInt(order.startOut),
  endOut: BigInt(order.endOut),
  decayStart: BigInt(order.decayStart),
  decayEnd: BigInt(order.decayEnd),
  deadline: BigInt(order.deadline),
  nonce: BigInt(order.nonce),
});
export function orderId(reactor: Address, chainId: number, order: ProtocolIntentOrder): string {
  return hashTypedData({
    domain: { name: 'SovereignReactor', version: '1', chainId, verifyingContract: reactor },
    types: { IntentOrder: ORDER_FIELDS },
    primaryType: 'IntentOrder',
    message: toChain(order),
  }).toLowerCase();
}

/** ENGINE INT-2: the output decays down, over a window inside the owner's bounds, ending at or before the deadline. */
function checkDecay(order: ProtocolIntentOrder, bounds: { minSeconds: number; maxSeconds: number }) {
  const [start, end, deadline] = [BigInt(order.decayStart), BigInt(order.decayEnd), BigInt(order.deadline)];
  if (BigInt(order.endOut) > BigInt(order.startOut) || end <= start || deadline < end)
    throw refuse(
      'BAD_REQUEST',
      INTENT_BAD_DECAY,
      'The output must fall from its start to its floor, over a window that ends by the deadline.',
    );
  const window = Number(end - start);
  if (window < bounds.minSeconds || window > bounds.maxSeconds)
    throw refuse(
      'BAD_REQUEST',
      INTENT_DECAY_OUT_OF_BOUNDS,
      `A decay of ${window} s is outside the allowed ${bounds.minSeconds} to ${bounds.maxSeconds} s.`,
    );
}

/**
 * The order the swapper signs: starting now (chain time), decaying over `decaySeconds`, with the next nonce not yet used
 * by this swapper here or on chain, and, when gasless, the token's own permit for the reactor for exactly `amountIn`.
 */
export async function createIntent(deps: IntentDeps, input: ProtocolIntentCreateInput): Promise<ProtocolIntentCreateOutput> {
  const reactor = requireReactor(deps);
  const bounds = requireBounds(deps);
  const client = deps.client();
  const chainId = deps.chainId();
  const swapper = getAddress(input.swapper);
  const block = await client.getBlock({ blockTag: 'latest' });
  let nonce = ((await deps.store.maxNonce(chainId, reactor, swapper)) ?? 0n) + 1n;
  for (let tries = 0; ; tries += 1) {
    const spent = await client.readContract({ address: reactor, abi: REACTOR_ABI, functionName: 'nonceSpent', args: [swapper, nonce] });
    if (!spent) break;
    if (tries >= NONCE_TRIES) throw refuse('CONFLICT', INTENT_NONCE_USED, 'No free nonce was found for this swapper.');
    nonce += 1n;
  }
  const decayStart = block.timestamp;
  const decayEnd = decayStart + BigInt(input.decaySeconds);
  const order: ProtocolIntentOrder = {
    swapper,
    tokenIn: getAddress(input.tokenIn),
    amountIn: input.amountIn,
    tokenOut: getAddress(input.tokenOut),
    startOut: input.startOut,
    endOut: input.endOut,
    decayStart: decayStart.toString(),
    decayEnd: decayEnd.toString(),
    // The open-auction window after the decay (INT-4) is not built: the order expires when its decay ends.
    deadline: decayEnd.toString(),
    nonce: nonce.toString(),
  };
  checkDecay(order, bounds);
  let permit: ProtocolTypedData | null = null;
  if (input.gasless) {
    const tokenIn = order.tokenIn as Address;
    const [[, name, version, domainChain, verifying], tokenNonce] = await Promise.all([
      client.readContract({ address: tokenIn, abi: TOKEN_ABI, functionName: 'eip712Domain' }),
      client.readContract({ address: tokenIn, abi: TOKEN_ABI, functionName: 'nonces', args: [swapper] }),
    ]).catch(() => {
      throw refuse(
        'PRECONDITION_FAILED',
        'dex.intent.permit_unsupported',
        `${tokenIn} has no permit of its own; approve the reactor once instead.`,
      );
    });
    if (Number(domainChain) !== chainId || verifying.toLowerCase() !== tokenIn.toLowerCase())
      throw refuse('PRECONDITION_FAILED', 'dex.intent.permit_unsupported', `${tokenIn}'s permit domain names another chain or contract.`);
    permit = {
      types: {
        EIP712Domain: DOMAIN_FIELDS,
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Permit',
      domain: { name, version, chainId, verifyingContract: tokenIn },
      message: { owner: swapper, spender: reactor, value: order.amountIn, nonce: tokenNonce.toString(), deadline: order.deadline },
    };
  }
  return { order, typedData: orderTypedData(reactor, chainId, order), permit };
}

/** Hands an open order to the filler feed and records that it did; a failure leaves it for the next pass. */
async function announce(deps: IntentDeps, record: IntentRecord) {
  const url = deps.fillerUrl();
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: record.id,
        reactor: record.reactor,
        order: record.order,
        signature: record.signature,
        permit: record.permit,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) await deps.store.announced(record.id);
  } catch {
    // Not announced: `announced_at` stays null and the next pass tries again with the same id.
  }
}

/** Every stored open order not yet handed to the filler feed, handed again (a crash between storing and announcing). */
export async function reannounce(deps: IntentDeps) {
  for (const record of await deps.store.unannounced(deps.chainId())) await announce(deps, record);
}

/**
 * Checks and keeps a signed order: the decay (INT-2) and the owner's bounds, the deadline still ahead, and the signature
 * the swapper's (an EOA, or a smart account through ERC-1271). A bad order stores nothing. A retry of the same signed
 * order returns the stored one; another order on a taken nonce refuses.
 */
export async function postIntent(deps: IntentDeps, input: ProtocolIntentPostInput): Promise<ProtocolIntentRow> {
  const reactor = requireReactor(deps);
  const bounds = requireBounds(deps);
  const client = deps.client();
  const chainId = deps.chainId();
  const order = {
    ...input.order,
    swapper: getAddress(input.order.swapper),
    tokenIn: getAddress(input.order.tokenIn),
    tokenOut: getAddress(input.order.tokenOut),
  };
  checkDecay(order, bounds);
  const block = await client.getBlock({ blockTag: 'latest' });
  if (BigInt(order.deadline) <= block.timestamp) throw refuse('BAD_REQUEST', 'dex.intent.expired', 'The order’s deadline has passed.');
  const valid = await client
    .verifyTypedData({
      address: order.swapper as Address,
      domain: { name: 'SovereignReactor', version: '1', chainId, verifyingContract: reactor },
      types: { IntentOrder: ORDER_FIELDS },
      primaryType: 'IntentOrder',
      message: toChain(order),
      signature: input.signature as Hex,
    })
    .catch(() => false);
  if (!valid) throw refuse('BAD_REQUEST', INTENT_BAD_SIGNATURE, 'The signature is not the swapper’s for this order.');
  const id = orderId(reactor, chainId, order);
  const stored = await deps.store.put({ id, chainId, reactor, order, signature: input.signature as Hex, permit: input.permit });
  if (!stored) throw refuse('CONFLICT', INTENT_NONCE_USED, 'This swapper already has an order with that nonce.');
  if (!stored.announcedAt) await announce(deps, stored);
  return toRow(stored, null);
}

function toRow(record: IntentRecord, priceAtFill: string | null): ProtocolIntentRow {
  return protocolIntentRowSchema.parse({
    id: record.id,
    order: record.order,
    state: record.state,
    amountOut: record.amountOut,
    filledAt: record.filledAt,
    priceAtFill,
    fillTx: record.fillTx,
    createdAt: record.createdAt.toISOString(),
  });
}

/**
 * The swapper's orders, each open one reconciled with the chain: its nonce spent with a Filled event is filled (what
 * the swapper received, the second, and the reactor's decayed price at that second); spent with a Cancelled event is
 * cancelled; unspent past its deadline is expired. Unknown stays open: nothing is guessed.
 */
export async function listIntents(deps: IntentDeps, swapperText: string): Promise<ProtocolIntentList> {
  const reactor = requireReactor(deps);
  const client = deps.client();
  const chainId = deps.chainId();
  const swapper = getAddress(swapperText);
  await reannounce(deps);
  const block = await client.getBlock({ blockTag: 'latest' });
  const fromBlock = block.number >= INTENT_LOG_BLOCKS ? block.number - INTENT_LOG_BLOCKS + 1n : 0n;
  const rows: ProtocolIntentRow[] = [];
  for (const record of await deps.store.list(chainId, swapper)) {
    let current = record;
    if (record.state === 'open' && record.reactor === reactor) {
      const spent = await client.readContract({
        address: reactor,
        abi: REACTOR_ABI,
        functionName: 'nonceSpent',
        args: [swapper, BigInt(record.order.nonce)],
        blockNumber: block.number,
      });
      let update: Pick<IntentRecord, 'state' | 'amountOut' | 'filledAt' | 'fillTx'> | null = null;
      if (spent) {
        const [fill] = await client.getLogs({
          address: reactor,
          event: FILLED_EVENT,
          args: { orderHash: record.id as Hex },
          fromBlock,
          toBlock: block.number,
        });
        if (fill)
          update = {
            state: 'filled',
            amountOut: fill.args.amountOut!.toString(),
            filledAt: fill.args.filledAt!.toString(),
            fillTx: fill.transactionHash,
          };
        else {
          const cancels = await client.getLogs({
            address: reactor,
            event: CANCELLED_EVENT,
            args: { swapper },
            fromBlock,
            toBlock: block.number,
          });
          if (cancels.some((log) => log.args.nonce?.toString() === record.order.nonce))
            update = {
              state: 'cancelled',
              amountOut: null,
              filledAt: null,
              fillTx: cancels.find((log) => log.args.nonce?.toString() === record.order.nonce)!.transactionHash,
            };
        }
      } else if (block.timestamp > BigInt(record.order.deadline))
        update = { state: 'expired', amountOut: null, filledAt: null, fillTx: null };
      if (update) {
        await deps.store.settle(record.id, update);
        current = { ...record, ...update };
      }
    }
    const priceAtFill =
      current.state === 'filled' && current.filledAt
        ? (
            await client.readContract({
              address: reactor,
              abi: REACTOR_ABI,
              functionName: 'outAt',
              args: [toChain(current.order), BigInt(current.filledAt)],
            })
          ).toString()
        : null;
    rows.push(toRow(current, priceAtFill));
  }
  return { swapper, blockNumber: block.number.toString(), blockTime: block.timestamp.toString(), orders: rows };
}

export function createIntentRouter(deps: IntentDeps) {
  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      throw deps.toTrpcError(err);
    }
  };
  return router({
    settings: publicJurisdictionProcedure('protocol', 'protocol')
      .output(protocolIntentSettingsSchema)
      .query(() => run(async () => ({ reactor: requireReactor(deps), decayBounds: deps.decayBounds() }))),
    create: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolIntentCreateInputSchema)
      .output(protocolIntentCreateOutputSchema)
      .query(({ input }) => run(() => createIntent(deps, input))),
    post: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolIntentPostInputSchema)
      .output(protocolIntentRowSchema)
      .mutation(({ input }) => run(() => postIntent(deps, input))),
    list: publicJurisdictionProcedure('protocol', 'protocol')
      .input(z.object({ swapper: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).strict())
      .output(protocolIntentListOutputSchema)
      .query(({ input }) => run(() => listIntents(deps, input.swapper))),
  });
}
