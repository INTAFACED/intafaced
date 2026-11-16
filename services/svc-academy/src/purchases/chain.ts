/**
 * J-academy-07 — what the chain says about one course payment or refund, read over plain JSON-RPC from the owner's node
 * (`ACADEMY_PAYMENT_RPC_URL`). Reads only: this module builds the calldata a wallet signs, but it never signs or sends.
 *
 * A payment is one ERC-20 `transfer(receiver, amount)` of the payment token from the buyer's wallet. It counts only when
 * the chain shows a successful transaction whose token `Transfer` log moves exactly that amount from that wallet to
 * INTAFACED's receiving address, with the confirmations the owner set. Anything else is not that payment.
 */

import { parseAmount } from '@intafaced/ledger-client';

/** The ledger's scale: amounts are bigints of 18 decimals (`packages/ledger-client` money). */
const LEDGER_DECIMALS = 18;

/** keccak256("Transfer(address,address,uint256)"). */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** `transfer(address,uint256)`. */
export const TRANSFER_SELECTOR = '0xa9059cbb';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;

export const isAddress = (value: string): boolean => ADDRESS.test(value.toLowerCase());
export const isTxHash = (value: string): boolean => HASH.test(value);

const word = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0');
const topicOf = (address: string) => `0x${word(address.toLowerCase())}`;
const addressOfTopic = (topic: string) => `0x${topic.slice(-40)}`.toLowerCase();

/** The calldata of `transfer(to, amount)`: what the buyer's wallet is asked to sign, and nothing else. */
export function transferCalldata(to: string, amount: bigint): string {
  if (!isAddress(to)) throw new Error('transfer needs a 0x address');
  if (amount <= 0n) throw new Error('transfer needs an amount above zero');
  return `${TRANSFER_SELECTOR}${word(to.toLowerCase())}${word(amount.toString(16))}`;
}

/**
 * A decimal string amount (`"20"`, `"20.5"`) in the token's smallest unit, parsed by the ledger's own money parser
 * (18 decimals) and scaled down; more decimals than the token has refuse.
 */
export function toBaseUnits(amount: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > LEDGER_DECIMALS)
    throw new Error(`token decimals must be 0 to ${LEDGER_DECIMALS}`);
  const scaled = parseAmount(amount.trim());
  if (scaled < 0n) throw new Error(`not a decimal amount: ${amount}`);
  const step = 10n ** BigInt(LEDGER_DECIMALS - decimals);
  if (scaled % step !== 0n) throw new Error(`${amount} has more decimals than the token's ${decimals}`);
  return scaled / step;
}

/** The token's smallest unit as a decimal string with no trailing zeros (`20000000`, 6 → `"20"`). */
export function fromBaseUnits(units: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export interface TransferFact {
  readonly txHash: string;
  readonly blockNumber: bigint;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
}

/** The chain's answer about one transaction: not seen yet, reverted, or mined with the token transfers it logged. */
export type TxFact =
  | { readonly state: 'unseen' }
  | { readonly state: 'reverted'; readonly blockNumber: bigint }
  | { readonly state: 'mined'; readonly blockNumber: bigint; readonly confirmations: bigint; readonly transfers: readonly TransferFact[] };

export interface PaymentChain {
  /** The latest block number. */
  blockNumber(): Promise<bigint>;
  /** One transaction as the chain shows it now, with the `token` transfers it logged. */
  transaction(txHash: string, token: string): Promise<TxFact>;
  /** Every `token` transfer from `from` to `to` in blocks `fromBlock` to the latest, oldest first. */
  transfers(input: { token: string; from: string; to: string; fromBlock: bigint }): Promise<TransferFact[]>;
}

type RpcLog = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string };

function transferOf(log: RpcLog, token: string): TransferFact | null {
  if (log.address.toLowerCase() !== token.toLowerCase()) return null;
  if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null;
  return {
    txHash: log.transactionHash.toLowerCase(),
    blockNumber: BigInt(log.blockNumber),
    from: addressOfTopic(log.topics[1]!),
    to: addressOfTopic(log.topics[2]!),
    amount: BigInt(log.data === '0x' ? 0 : log.data),
  };
}

/** Thrown when the node cannot be read: the answer is unknown, never "no payment". */
export class ChainUnreadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainUnreadError';
  }
}

/** The JSON-RPC reader over one node URL. `fetchImpl` is for tests. */
export function rpcPaymentChain(rpcUrl: string, fetchImpl: typeof fetch = globalThis.fetch, timeoutMs = 5_000): PaymentChain {
  let id = 0;
  const call = async <T>(method: string, params: unknown[]): Promise<T> => {
    let res: Response;
    try {
      res = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ChainUnreadError(`${method}: the payment node did not answer (${(err as Error).message})`);
    }
    if (!res.ok) throw new ChainUnreadError(`${method}: the payment node answered HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null;
    if (!body || body.error || !('result' in body)) throw new ChainUnreadError(`${method}: ${body?.error?.message ?? 'no result'}`);
    return body.result as T;
  };
  const blockNumber = async () => BigInt(await call<string>('eth_blockNumber', []));
  return {
    blockNumber,
    async transaction(txHash, token) {
      const receipt = await call<{ status: string; blockNumber: string; logs: RpcLog[] } | null>('eth_getTransactionReceipt', [txHash]);
      if (!receipt) return { state: 'unseen' };
      const mined = BigInt(receipt.blockNumber);
      if (BigInt(receipt.status) !== 1n) return { state: 'reverted', blockNumber: mined };
      const head = await blockNumber();
      const transfers = receipt.logs.map((log) => transferOf(log, token)).filter((t): t is TransferFact => t !== null);
      return { state: 'mined', blockNumber: mined, confirmations: head - mined + 1n, transfers };
    },
    async transfers({ token, from, to, fromBlock }) {
      const logs = await call<RpcLog[]>('eth_getLogs', [
        {
          address: token,
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: 'latest',
          topics: [TRANSFER_TOPIC, topicOf(from), topicOf(to)],
        },
      ]);
      return logs
        .map((log) => transferOf(log, token))
        .filter((t): t is TransferFact => t !== null)
        .sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));
    },
  };
}
