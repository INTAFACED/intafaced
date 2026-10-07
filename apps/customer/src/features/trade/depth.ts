import { z } from 'zod';
import { decimalSchema, parseAmount } from '../../shared/money';

const level = z.tuple([decimalSchema.refine((value) => parseAmount(value) > 0n), decimalSchema]);
const snapshot = z.object({
  type: z.literal('snapshot'),
  marketId: z.string(),
  sequence: z.number().int().nonnegative().safe(),
  bids: z.array(level),
  asks: z.array(level),
});
const delta = snapshot.extend({ type: z.literal('delta'), fromSequence: z.number().int().nonnegative().safe() });
const eventSchema = z.union([snapshot, delta]);
type Levels = [string, string][];
/** Public stream boundary. No socket-open event can establish freshness. */
export class LinkedDepth {
  private sequence = -1;
  private acceptedAt: number | null = null;
  private healthy = false;
  private bids = new Map<string, string>();
  private asks = new Map<string, string>();
  constructor(readonly marketId: string) {}
  receive(wire: unknown, now = Date.now()): 'accepted' | 'invalid' | 'wrong_market' | 'stale' | 'gap' {
    const parsed = eventSchema.safeParse(wire);
    if (!parsed.success) {
      this.healthy = false;
      return 'invalid';
    }
    const event = parsed.data;
    if (event.marketId !== this.marketId) return 'wrong_market';
    if (event.sequence < this.sequence || (event.type === 'delta' && event.sequence === this.sequence)) return 'stale';
    if (event.type === 'delta' && (!this.healthy || event.fromSequence !== this.sequence)) {
      this.healthy = false;
      return 'gap';
    }
    if (event.type === 'snapshot') {
      this.bids.clear();
      this.asks.clear();
    }
    for (const [side, rows] of [
      [this.bids, event.bids],
      [this.asks, event.asks],
    ] as const)
      for (const [price, quantity] of rows) {
        const key = parseAmount(price).toString();
        if (parseAmount(quantity) === 0n) side.delete(key);
        else side.set(key, JSON.stringify([price, quantity]));
      }
    this.sequence = event.sequence;
    this.acceptedAt = now;
    this.healthy = true;
    return 'accepted';
  }
  invalidate() {
    this.healthy = false;
  }
  read(now = Date.now()): { fresh: boolean; sequence: number; bids: Levels; asks: Levels; acceptedAt: number | null } {
    const rows = (side: Map<string, string>, descending: boolean): Levels =>
      Array.from(side.entries())
        .sort((a, b) => {
          const x = BigInt(a[0]),
            y = BigInt(b[0]);
          return x === y ? 0 : (x < y ? -1 : 1) * (descending ? -1 : 1);
        })
        .map(([, value]) => JSON.parse(value) as [string, string]);
    return {
      fresh: this.healthy && this.acceptedAt !== null && now - this.acceptedAt < 15000,
      sequence: this.sequence,
      bids: rows(this.bids, true),
      asks: rows(this.asks, false),
      acceptedAt: this.acceptedAt,
    };
  }
}
