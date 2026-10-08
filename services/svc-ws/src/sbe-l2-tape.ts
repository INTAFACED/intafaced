/**
 * C4 — public L2 SBE tape. Real Logic SBE 1.39.0 via @intafaced/sbe-codec.
 * Never L3. Queue-probability is not inferred from this tape. Not a dual codec.
 */
import { SBE_UNAVAILABLE, type SbeCodec } from '@intafaced/sbe-codec';

export { SBE_UNAVAILABLE };

export type L2Ladder = {
  readonly marketId: string;
  readonly sequence: number | string;
  readonly bids: readonly (readonly [string, string])[];
  readonly asks: readonly (readonly [string, string])[];
};

export type EncodeL2Ok = {
  readonly ok: true;
  readonly skip?: false;
  readonly book: 'L2';
  readonly template: 'DepthLevel';
  readonly sequence: string;
  readonly payloads: readonly Uint8Array[];
};

export type EncodeL2Skip = {
  readonly ok: true;
  readonly skip: true;
  readonly payloads: readonly [];
};

export type EncodeL2Refuse = {
  readonly ok: false;
  readonly linked: boolean;
  readonly reason: string;
  readonly field?: string;
  readonly message: string;
};

export type EncodeL2Result = EncodeL2Ok | EncodeL2Skip | EncodeL2Refuse;

function moneyIsIeee(value: unknown): boolean {
  return typeof value === 'number';
}

function blankMoneyField(price: unknown, qty: unknown): 'price' | 'qty' | null {
  if (typeof price === 'string' && price.trim().length === 0) return 'price';
  if (typeof qty === 'string' && qty.trim().length === 0) return 'qty';
  return null;
}

function refuseBlankLevel(linked: boolean, field: 'price' | 'qty'): EncodeL2Refuse {
  return {
    ok: false,
    linked,
    reason: 'missing_input',
    field,
    message: 'L2 price or size is blank',
  };
}

export function encodeL2Snapshot(codec: SbeCodec, snap: L2Ladder): EncodeL2Ok | EncodeL2Refuse {
  const sequence = String(snap.sequence);
  const payloads: Uint8Array[] = [];
  const levels: Array<{ side: 'buy' | 'sell'; price: string; qty: string }> = [];
  for (const row of snap.bids) {
    if (moneyIsIeee(row[0]) || moneyIsIeee(row[1])) {
      return {
        ok: false,
        linked: codec.linked,
        reason: 'ieee_input',
        field: 'price',
        message: 'L2 money stays decimal strings',
      };
    }
    const blankBid = blankMoneyField(row[0], row[1]);
    if (blankBid) return refuseBlankLevel(codec.linked, blankBid);
    levels.push({ side: 'buy', price: row[0], qty: row[1] });
  }
  for (const row of snap.asks) {
    if (moneyIsIeee(row[0]) || moneyIsIeee(row[1])) {
      return {
        ok: false,
        linked: codec.linked,
        reason: 'ieee_input',
        field: 'price',
        message: 'L2 money stays decimal strings',
      };
    }
    const blankAsk = blankMoneyField(row[0], row[1]);
    if (blankAsk) return refuseBlankLevel(codec.linked, blankAsk);
    levels.push({ side: 'sell', price: row[0], qty: row[1] });
  }
  for (const level of levels) {
    const encoded = codec.encode({
      template: 'DepthLevel',
      instrument: snap.marketId,
      sequence,
      side: level.side,
      price: level.price,
      qty: level.qty,
      // Matching L2 snapshots do not carry exchange nanos. Do not invent them.
      eventTimeNs: '0',
    });
    if (!encoded.ok) return encoded;
    payloads.push(encoded.payload);
  }
  return { ok: true, book: 'L2', template: 'DepthLevel', sequence, payloads };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asLadder(value: Record<string, unknown>): L2Ladder | 'ieee' | 'blank-price' | 'blank-qty' | null {
  if (typeof value.marketId !== 'string' || value.marketId.length === 0) return null;
  if (value.sequence === undefined || value.sequence === null) return null;
  if (!Array.isArray(value.bids) || !Array.isArray(value.asks)) return null;
  const bids: Array<readonly [string, string]> = [];
  const asks: Array<readonly [string, string]> = [];
  for (const side of [
    [value.bids, bids],
    [value.asks, asks],
  ] as const) {
    const rows = side[0];
    const out = side[1];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 2) return null;
      if (typeof row[0] === 'number' || typeof row[1] === 'number') return 'ieee';
      if (typeof row[0] !== 'string' || typeof row[1] !== 'string') return null;
      const blank = blankMoneyField(row[0], row[1]);
      if (blank === 'price') return 'blank-price';
      if (blank === 'qty') return 'blank-qty';
      out.push([row[0], row[1]]);
    }
  }
  return { marketId: value.marketId, sequence: value.sequence as number | string, bids, asks };
}

export function encodeL2JsonFrame(codec: SbeCodec, frame: string): EncodeL2Result {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return { ok: false, linked: codec.linked, reason: 'invalid_message', message: 'L2 frame is not JSON' };
  }
  if (!isRecord(parsed)) {
    return { ok: false, linked: codec.linked, reason: 'invalid_message', message: 'L2 frame is not an object' };
  }
  if (parsed.type === 'status' || (parsed.type !== 'snapshot' && parsed.type !== 'delta')) {
    return { ok: true, skip: true, payloads: [] };
  }
  const ladder = asLadder(parsed);
  if (ladder === 'ieee') {
    return {
      ok: false,
      linked: codec.linked,
      reason: 'ieee_input',
      field: 'price',
      message: 'L2 money stays decimal strings',
    };
  }
  if (ladder === 'blank-price' || ladder === 'blank-qty') {
    return refuseBlankLevel(codec.linked, ladder === 'blank-price' ? 'price' : 'qty');
  }
  if (ladder === null) {
    return { ok: false, linked: codec.linked, reason: 'invalid_message', message: 'L2 frame is not a book' };
  }
  return encodeL2Snapshot(codec, ladder);
}

export function concatenatePayloads(payloads: readonly Uint8Array[]): Buffer {
  return Buffer.concat(payloads.map((p) => Buffer.from(p)));
}
