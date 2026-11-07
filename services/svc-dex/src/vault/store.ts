/**
 * The person's wallet orders, held off chain (D-limit-dca-02: "Your resting order is held by the platform keeper and is
 * not visible on chain until it fills. The vault funds are on chain."). One JSON file, `dex.wallet_orders.json`, under
 * `DEX_ORDER_STORE_DIR`, written whole and renamed into place. It holds signed orders, their states, fills and the
 * keeper's attempts: never a balance (credit lives in the vault contract) and never a key.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from 'viem';
import type { ChainOrder, WalletOrder } from './model.js';

/** The keeper keeps the last 50 attempts per order, as the trigger book did. */
export const ATTEMPTS_KEPT = 50;

const BIG_ORDER_KEYS = ['amountIn', 'triggerWad', 'trailBps', 'minOut', 'expiry', 'nonce', 'version'] as const;

function encodeOrder(o: ChainOrder): Record<string, unknown> {
  const out: Record<string, unknown> = { ...o };
  for (const k of BIG_ORDER_KEYS) out[k] = o[k].toString();
  return out;
}
function decodeOrder(raw: Record<string, unknown>): ChainOrder {
  const out: Record<string, unknown> = { ...raw };
  for (const k of BIG_ORDER_KEYS) out[k] = BigInt(String(raw[k]));
  return out as unknown as ChainOrder;
}

function encode(w: WalletOrder): Record<string, unknown> {
  return {
    ...w,
    order: encodeOrder(w.order),
    amountBase: w.amountBase.toString(),
    filledIn: w.filledIn.toString(),
    filledOut: w.filledOut.toString(),
    pending: w.pending ? { ...w.pending, take: w.pending.take.toString() } : null,
  };
}
function decode(raw: Record<string, unknown>): WalletOrder {
  const pending = raw.pending as Record<string, unknown> | null;
  return {
    ...(raw as unknown as WalletOrder),
    order: decodeOrder(raw.order as Record<string, unknown>),
    amountBase: BigInt(String(raw.amountBase)),
    filledIn: BigInt(String(raw.filledIn)),
    filledOut: BigInt(String(raw.filledOut)),
    pending: pending ? ({ ...pending, take: BigInt(String(pending.take)) } as unknown as WalletOrder['pending']) : null,
  };
}

export class WalletOrderStore {
  private readonly path: string;
  private readonly rows = new Map<Hex, WalletOrder>();

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'dex.wallet_orders.json');
    if (existsSync(this.path)) {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { orders: Record<string, unknown>[] };
      for (const raw of parsed.orders) {
        const row = decode(raw);
        this.rows.set(row.id, row);
      }
    }
  }

  get(id: Hex): WalletOrder | undefined {
    return this.rows.get(id.toLowerCase() as Hex);
  }

  /** Every order, oldest first: the order the keeper serves them in. */
  all(): WalletOrder[] {
    return [...this.rows.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  byMaker(maker: string): WalletOrder[] {
    const m = maker.toLowerCase();
    return this.all().filter((row) => row.order.maker.toLowerCase() === m);
  }

  insert(rows: readonly WalletOrder[]): void {
    for (const row of rows) {
      if (this.rows.has(row.id)) throw new Error(`order ${row.id} exists`);
    }
    for (const row of rows) this.rows.set(row.id, row);
    this.flush();
  }

  /** Writes every change made to rows read from this store. */
  save(): void {
    this.flush();
  }

  private flush(): void {
    const tmp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, JSON.stringify({ orders: [...this.rows.values()].map(encode) }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
}

export function keepAttempts(row: WalletOrder): void {
  if (row.attempts.length > ATTEMPTS_KEPT) row.attempts.splice(0, row.attempts.length - ATTEMPTS_KEPT);
}
