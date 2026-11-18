/**
 * THE TEST PARTNER'S USDC PAY-IN (J-bank-31), labelled TEST, on the stack's own TEST chain only.
 *
 * Paying yourself from trading sends a venue withdrawal, signed once in the person's own wallet, straight to their own
 * account at the partner bank. Whether the real partner gives each person an address the venue can withdraw to is the
 * partner's open answer, so this is the TEST stand-in for that rail: the TEST partner gives each person one TEST pay-in
 * address on the TEST chain (made from their id; no key exists for it), watches the TEST chain for transfers of its TEST
 * USD token to an address it gave, reports each one pending from the block it landed in, and once it has
 * `TEST_PAY_IN_CONFIRMATIONS` confirmations credits it to the person's main USDC balance at the TEST partner ONCE, keyed
 * by the transfer itself (`bank.pay-in:usdc:<chainId>:<txHash>:<logIndex>`). With the person's `payIn` switch `held`, the
 * partner holds its answer: the transfer stays pending ("on its way") and is not credited until the switch goes back.
 *
 * INTAFACED holds none of it and the ledger posts nothing: the credit is the partner's own figure. The book is the TEST
 * partner's, in memory, as the TEST partner bank's is: a restart forgets both together, and the watch starts again at the
 * chain's head. Loopback RPC only; the TEST partner itself is refused outside dev and test.
 */
import { createHash } from 'node:crypto';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { TestPartnerDoors } from '../partner/test-partner.js';

/**
 * TEST: confirmations the TEST partner waits for before it credits a pay-in. Not a partner's terms. The stack's TEST chain
 * mines about a block a second, so a pay-in is seen pending for about this many seconds before it is credited.
 */
export const TEST_PAY_IN_CONFIRMATIONS = 12;
/** The partner asset a pay-in is credited as. */
export const PAY_IN_ASSET = 'USDC';
/** keccak256("Transfer(address,address,uint256)"): an ERC-20 transfer's log topic. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** The most pay-ins the TEST book keeps; past it a new transfer is not taken (never one forgotten after it was taken). */
const MAX_CREDITS = 100_000;
const ADDRESS = /^0x[0-9a-f]{40}$/;

export interface PayInRoute {
  readonly label: 'TEST';
  readonly chainId: number;
  /** The TEST token the partner credits, lowercase. */
  readonly token: string;
  readonly tokenDecimals: number;
  /** The person's own TEST pay-in address at the partner, lowercase. */
  readonly address: string;
  readonly asset: string;
  readonly confirmations: number;
}

export interface PayInCredit {
  readonly key: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly amount: Amount;
  /** pending: seen on chain, not yet credited by the partner; available: credited to the main balance. */
  readonly status: 'pending' | 'available';
  /** The partner holds its answer on this pay-in (the `payIn` switch). */
  readonly held: boolean;
  readonly confirmations: number;
  readonly required: number;
  /** When the partner first saw the transfer on chain. */
  readonly seenAt: Date;
  /** When the partner credited it; null while pending. */
  readonly availableAt: Date | null;
  /** The partner's move for the credit; null while pending. */
  readonly moveId: string | null;
}

export interface PayInRail {
  readonly label: 'TEST';
  /** The person's pay-in route; the address is given (and watched) from the first ask. */
  route(userId: string): PayInRoute;
  /** The person's pay-ins as the partner reports them now, newest first. */
  credits(userId: string): readonly PayInCredit[];
  /** One watch pass: new transfers are seen, confirmed ones credited. Errors are thrown to the caller's log. */
  poll(): Promise<void>;
}

interface Kept {
  key: string;
  userId: string;
  txHash: string;
  logIndex: number;
  amount: Amount;
  block: bigint;
  seenAt: Date;
  availableAt: Date | null;
  moveId: string | null;
}

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

function rpcOver(url: string, fetchFn: typeof globalThis.fetch): Rpc {
  let id = 0;
  return async (method, params) => {
    id += 1;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (!res.ok || body.error) throw new Error(`TEST chain ${method} failed: ${body.error?.message ?? res.status}`);
    return body.result;
  };
}

/** A TEST pay-in address for a person: the last 20 bytes of a hash of their id. No key exists for it. */
export function testPayInAddress(userId: string): string {
  return `0x${createHash('sha256').update(`INTAFACED TEST partner pay-in:${userId}`).digest('hex').slice(-40)}`;
}

/** Token base units as a decimal string's Amount (6 decimals: 1500000 is 1.5). */
export function unitsToAmount(units: bigint, decimals: number): Amount {
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const frac = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return parseAmount(frac ? `${whole}.${frac}` : whole.toString());
}

export function testPayInRail(options: {
  partner: TestPartnerDoors;
  rpcUrl: string;
  chainId: number;
  token: string;
  tokenDecimals?: number;
  fetchFn?: typeof globalThis.fetch;
  clock?: () => Date;
}): PayInRail {
  const host = new URL(options.rpcUrl).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
    throw new Error(`the TEST partner's pay-in watches a loopback TEST chain only, not ${options.rpcUrl}`);
  }
  const token = options.token.toLowerCase();
  if (!ADDRESS.test(token)) throw new Error('the TEST pay-in token must be an address');
  const decimals = options.tokenDecimals ?? 6;
  const rpc = rpcOver(options.rpcUrl, options.fetchFn ?? globalThis.fetch);
  const clock = options.clock ?? (() => new Date());
  const owners = new Map<string, string>(); // address -> userId
  const kept = new Map<string, Kept>();
  const byPerson = new Map<string, Kept[]>();
  let from: bigint | null = null;
  let head = 0n;

  const credit = (k: Kept): void => {
    if (k.availableAt || options.partner.switches(k.userId).payIn === 'held') return;
    if (head - k.block + 1n < BigInt(TEST_PAY_IN_CONFIRMATIONS)) return;
    const move = options.partner.receive({ userId: k.userId, assetId: PAY_IN_ASSET, spaceId: null }, k.key, k.amount);
    k.moveId = move.id;
    k.availableAt = move.movedAt;
  };

  return {
    label: 'TEST',
    route(userId) {
      const address = testPayInAddress(userId);
      owners.set(address, userId);
      return {
        label: 'TEST',
        chainId: options.chainId,
        token,
        tokenDecimals: decimals,
        address,
        asset: PAY_IN_ASSET,
        confirmations: TEST_PAY_IN_CONFIRMATIONS,
      };
    },
    credits(userId) {
      return [...(byPerson.get(userId) ?? [])].reverse().map((k) => {
        const held = !k.availableAt && options.partner.switches(userId).payIn === 'held';
        const confirmations = Number(head >= k.block ? head - k.block + 1n : 0n);
        return Object.freeze({
          key: k.key,
          txHash: k.txHash,
          logIndex: k.logIndex,
          amount: k.amount,
          status: k.availableAt ? ('available' as const) : ('pending' as const),
          held,
          confirmations: Math.min(confirmations, TEST_PAY_IN_CONFIRMATIONS),
          required: TEST_PAY_IN_CONFIRMATIONS,
          seenAt: k.seenAt,
          availableAt: k.availableAt,
          moveId: k.moveId,
        });
      });
    },
    async poll() {
      head = BigInt(String(await rpc('eth_blockNumber', [])));
      if (from === null) from = head + 1n;
      if (owners.size > 0 && head >= from) {
        const padded = [...owners.keys()].map((a) => `0x${'0'.repeat(24)}${a.slice(2)}`);
        const logs = (await rpc('eth_getLogs', [
          {
            address: token,
            topics: [TRANSFER_TOPIC, null, padded],
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${head.toString(16)}`,
          },
        ])) as { transactionHash: string; logIndex: string; blockNumber: string; data: string; topics: string[]; removed?: boolean }[];
        for (const log of logs) {
          if (log.removed) continue;
          const to = `0x${log.topics[2]!.slice(-40)}`.toLowerCase();
          const userId = owners.get(to);
          if (!userId) continue;
          const units = BigInt(log.data);
          if (units <= 0n) continue;
          const logIndex = Number(BigInt(log.logIndex));
          const txHash = log.transactionHash.toLowerCase();
          const key = `bank.pay-in:usdc:${options.chainId}:${txHash}:${logIndex}`;
          if (kept.has(key) || kept.size >= MAX_CREDITS) continue;
          const k: Kept = {
            key,
            userId,
            txHash,
            logIndex,
            amount: unitsToAmount(units, decimals),
            block: BigInt(log.blockNumber),
            seenAt: clock(),
            availableAt: null,
            moveId: null,
          };
          kept.set(key, k);
          const list = byPerson.get(userId) ?? [];
          list.push(k);
          byPerson.set(userId, list);
        }
        from = head + 1n;
      }
      // A refusal of one credit (the partner down, an account closing) leaves it pending for the next pass.
      for (const k of kept.values()) {
        if (k.availableAt) continue;
        try {
          credit(k);
        } catch {
          /* tried again next pass */
        }
      }
    },
  };
}

/** A pay-in credit on the wire: decimal strings and ISO times. */
export function payInCreditView(c: PayInCredit) {
  return {
    key: c.key,
    txHash: c.txHash,
    amount: formatAmount(c.amount),
    status: c.status,
    held: c.held,
    confirmations: c.confirmations,
    required: c.required,
    seenAt: c.seenAt.toISOString(),
    availableAt: c.availableAt?.toISOString() ?? null,
  };
}

/** What the TEST partner has credited the person in pay-ins of `assetId`, as a card partner counts it in spendable. */
export function payInCredited(rail: PayInRail | null | undefined, userId: string, assetId: string): Amount {
  if (!rail || assetId !== PAY_IN_ASSET) return 0n;
  let sum = 0n;
  for (const c of rail.credits(userId)) if (c.status === 'available') sum += c.amount;
  return sum;
}

/**
 * The TEST partner's pay-in for this stack, or null: only with the TEST partner and all three settings given. The TEST
 * partner itself refuses to boot outside dev and test, and the rail refuses an RPC off loopback.
 */
export function testPayInRailFor(
  partner: TestPartnerDoors | null,
  settings: { rpcUrl?: string | undefined; chainId?: string | undefined; token?: string | undefined },
): PayInRail | null {
  const rpcUrl = settings.rpcUrl?.trim() ?? '';
  const chainId = settings.chainId?.trim() ?? '';
  const token = settings.token?.trim() ?? '';
  if (!partner || !rpcUrl || !chainId || !token) return null;
  if (!/^[1-9]\d{0,9}$/.test(chainId)) throw new Error('BANK_TEST_PAY_IN_CHAIN_ID must be a chain id');
  return testPayInRail({ partner, rpcUrl, chainId: Number(chainId), token });
}
