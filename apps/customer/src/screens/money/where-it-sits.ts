/**
 * Assets on the launch model (J-wallet-01): what the person holds, grouped by where it sits, each figure as its own source
 * reports it with that source's as-of time. The connected wallet is read from the chain at one block (the block's own
 * time is the as-of); the venue account is the venue's own record. Nothing here is added into one INTAFACED balance, and
 * the ledger is never read: INTAFACED holds none of these funds. Amounts are exact decimal strings, never a `number`.
 */
import { exactUnits } from '../../features/protocol/tokens/format';

/** A token the wallet is read for: the network's listed tokens, and its own currency (address null). */
export interface WalletToken {
  address: string | null;
  symbol: string;
  decimals: number;
}

/** The read-only node calls the wallet answers through its own connection. */
export type NodeRead = (method: 'eth_getBlockByNumber' | 'eth_getBalance' | 'eth_call', params: unknown[]) => Promise<unknown>;

export interface WalletRow {
  symbol: string;
  token: string | null;
  amount: string;
}

/** The wallet as of one block: what it holds on that network, the block and its time. */
export type WalletRead =
  { ok: true; chainId: number; address: string; block: string; asOf: string; rows: WalletRow[]; unread: string[] } | { ok: false };

/** `balanceOf(owner)` calldata: the ERC-20 selector, then the address left-padded to one word. */
export function balanceOfData(owner: string): string {
  return `0x70a08231${owner.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

const word = (answer: unknown): bigint | null =>
  typeof answer === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(answer) ? BigInt(answer) : null;

/**
 * Reads `address`'s holdings of `tokens` at the newest block: the block first, then every balance at that same block, so
 * the figures share one as-of. A token whose read fails is named in `unread`, never shown as 0. Tokens it holds none of
 * are left out. A block that cannot be read is no read at all.
 */
export async function readWallet(read: NodeRead, chainId: number, address: string, tokens: WalletToken[]): Promise<WalletRead> {
  const block = (await read('eth_getBlockByNumber', ['latest', false]).catch(() => null)) as {
    number?: unknown;
    timestamp?: unknown;
  } | null;
  const number = word(block?.number ?? null);
  const time = word(block?.timestamp ?? null);
  if (number === null || time === null) return { ok: false };
  const at = `0x${number.toString(16)}`;
  const answers = await Promise.all(
    tokens.map((token) =>
      (token.address === null
        ? read('eth_getBalance', [address, at])
        : read('eth_call', [{ to: token.address, data: balanceOfData(address) }, at])
      ).then(word, () => null),
    ),
  );
  const rows: WalletRow[] = [];
  const unread: string[] = [];
  tokens.forEach((token, i) => {
    const units = answers[i];
    if (units === null || units === undefined) unread.push(token.symbol);
    else if (units > 0n) rows.push({ symbol: token.symbol, token: token.address, amount: exactUnits(units.toString(), token.decimals) });
  });
  return { ok: true, chainId, address, block: number.toString(), asOf: new Date(Number(time) * 1000).toISOString(), rows, unread };
}

export interface VenueBalanceRow {
  asset: string;
  free: string;
  locked: string;
  total: string;
}
export interface VenueOrderLock {
  venueOrderId: string | null;
  venueClientOrderId: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  locked: string;
  lockedAsset: string;
}

/** One venue asset: free, locked and total as the venue reports them, and each open order whose lock it names. */
export interface VenueRow extends VenueBalanceRow {
  /** What can be withdrawn: the venue's free figure, which leaves out every lock the venue holds. */
  withdrawable: string;
  orders: Array<{ id: string; symbol: string; side: 'buy' | 'sell'; locked: string }>;
}

const isZero = (decimal: string) => !/[1-9]/.test(decimal);

/** The venue's balances, each with the open orders that lock it, by the order's own id. Rows the venue holds none of drop. */
export function venueRows(balances: VenueBalanceRow[], orders: VenueOrderLock[]): VenueRow[] {
  return balances
    .filter((row) => !isZero(row.total))
    .map((row) => ({
      ...row,
      withdrawable: row.free,
      orders: orders
        .filter((order) => order.lockedAsset === row.asset && !isZero(order.locked))
        .map((order) => ({
          id: order.venueClientOrderId ?? order.venueOrderId ?? '',
          symbol: order.symbol,
          side: order.side,
          locked: order.locked,
        })),
    }));
}

/** The short form of an order id the page shows (its tail, which is what differs), with the full id kept on the element. */
export function shortOrderId(id: string): string {
  const tail = id.split(':').pop() ?? id;
  return tail.length > 10 ? tail.slice(-10) : tail;
}
