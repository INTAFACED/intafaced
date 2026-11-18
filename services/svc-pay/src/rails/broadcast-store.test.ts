import { describe, expect, it, vi } from 'vitest';
import { BROADCAST_PENDING, MemoryBroadcastStore, PostgresBroadcastStore, type BroadcastSql } from './broadcast-store.js';
import { BroadcastClosedError, runDurableBroadcast } from './durable-broadcast.js';

/** In-process fake that mimics INSERT ON CONFLICT / SELECT / UPDATE for the journal. */
function fakePgSql(): BroadcastSql & {
  rows: Map<string, { tx_hash: string; signed_raw: string | null }>;
} {
  const rows = new Map<string, { tx_hash: string; signed_raw: string | null }>();
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').toLowerCase();
    if (text.includes('insert into pay.crypto_broadcasts')) {
      const key = String(values[0]);
      const hash = String(values[1]);
      if (rows.has(key)) return [];
      rows.set(key, { tx_hash: hash, signed_raw: null });
      return [{ idempotency_key: key }];
    }
    if (text.includes('set signed_raw')) {
      const signedRaw = String(values[0]);
      const key = String(values[1]);
      const pending = String(values[2]);
      const existing = rows.get(key);
      if (!existing) return [];
      if (existing.tx_hash !== pending) return [];
      if (existing.signed_raw !== null && existing.signed_raw !== signedRaw) return [];
      existing.signed_raw = signedRaw;
      return [{ idempotency_key: key }];
    }
    if (text.includes('update pay.crypto_broadcasts') && text.includes('signed_raw is null')) {
      const closed = String(values[0]);
      const key = String(values[1]);
      const pending = String(values[2]);
      const existing = rows.get(key);
      if (!existing || existing.tx_hash !== pending || existing.signed_raw !== null) return [];
      existing.tx_hash = closed;
      return [{ idempotency_key: key }];
    }
    if (text.includes('update pay.crypto_broadcasts') && text.includes('set tx_hash')) {
      const hash = String(values[0]);
      const key = String(values[1]);
      const pending = String(values[2]);
      const existing = rows.get(key);
      if (!existing) return [];
      if (existing.tx_hash === pending || existing.tx_hash === hash) {
        existing.tx_hash = hash;
        return [{ tx_hash: hash }];
      }
      return [];
    }
    if (text.includes('select signed_raw') && !text.includes('tx_hash')) {
      const key = String(values[0]);
      const v = rows.get(key);
      return v === undefined ? [] : [{ signed_raw: v.signed_raw }];
    }
    if (text.includes('select tx_hash, signed_raw')) {
      const key = String(values[0]);
      const v = rows.get(key);
      return v === undefined ? [] : [{ tx_hash: v.tx_hash, signed_raw: v.signed_raw }];
    }
    if (text.includes('select tx_hash')) {
      const key = String(values[0]);
      const v = rows.get(key);
      return v === undefined ? [] : [{ tx_hash: v.tx_hash }];
    }
    throw new Error(`fakePgSql unhandled: ${text}`);
  }) as unknown as BroadcastSql & { rows: Map<string, { tx_hash: string; signed_raw: string | null }> };
  sql.rows = rows;
  return sql;
}

describe('MemoryBroadcastStore — Class M claim/put ordering', () => {
  it('gives exactly one concurrent claimer `mine`; others converge on the same hash', async () => {
    const store = new MemoryBroadcastStore();
    const kinds: string[] = [];

    await Promise.all(
      Array.from({ length: 8 }, () =>
        store.claim('payout:w1:1').then(async (claim) => {
          kinds.push(claim.kind);
          if (claim.kind === 'mine') {
            await store.putSigned('payout:w1:1', '0xraw');
            await store.put('payout:w1:1', '0xabc');
          } else if (claim.kind === 'resume') {
            expect(claim.signedRaw).toBe('0xraw');
            await store.put('payout:w1:1', '0xabc');
          } else {
            expect(claim).toEqual({ kind: 'done', txHash: '0xabc' });
          }
        }),
      ),
    );

    expect(kinds.filter((k) => k === 'mine')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'done' || k === 'resume').length).toBe(7);
    expect(await store.get('payout:w1:1')).toBe('0xabc');
  });

  it('put never overwrites a settled hash', async () => {
    const store = new MemoryBroadcastStore();
    await store.claim('k');
    expect(await store.put('k', '0xfirst')).toBe('0xfirst');
    expect(await store.put('k', '0xsecond')).toBe('0xfirst');
    expect(await store.get('k')).toBe('0xfirst');
  });

  it('get hides the pending sentinel', async () => {
    const store = new MemoryBroadcastStore();
    await store.claim('k');
    expect(await store.get('k')).toBeNull();
    expect(BROADCAST_PENDING).toBe('__pending__');
  });

  it('refuses to put the pending sentinel as a txHash', async () => {
    const store = new MemoryBroadcastStore();
    await store.claim('k');
    await expect(store.put('k', BROADCAST_PENDING)).rejects.toThrow(/pending sentinel/);
  });

  it('after put, a new claimer is done with the same hash (retry-safe same process)', async () => {
    const store = new MemoryBroadcastStore();
    const first = await store.claim('refund:p1:1');
    expect(first.kind).toBe('mine');
    await store.putSigned('refund:p1:1', '0xraw1');
    await store.put('refund:p1:1', '0xhash1');
    const second = await store.claim('refund:p1:1');
    expect(second).toEqual({ kind: 'done', txHash: '0xhash1' });
  });

  it('putSigned then crash-equivalent claim resumes the same signed raw (D26-P1-P9)', async () => {
    const store = new MemoryBroadcastStore();
    await store.claim('payout:resume:1');
    await store.putSigned('payout:resume:1', '0xsignedbytes');
    // Hash never journalled — process died after broadcast RPC.
    const again = await store.claim('payout:resume:1');
    expect(again).toEqual({ kind: 'resume', signedRaw: '0xsignedbytes' });
  });

  it('putSigned refuses a mismatched signed payload', async () => {
    const store = new MemoryBroadcastStore();
    await store.claim('k');
    await store.putSigned('k', '0xaaa');
    await expect(store.putSigned('k', '0xbbb')).rejects.toThrow(/mismatch/);
  });

  it('reset clears journal — documents single-process crash residual (M226-01)', async () => {
    const store = new MemoryBroadcastStore();
    await store.claim('payout:w2:1');
    await store.putSigned('payout:w2:1', '0xraw');
    await store.put('payout:w2:1', '0xsent');
    store.reset();
    // After process death equivalent, same business key is claimable again —
    // MemoryBroadcastStore is not durable across process boundaries.
    const again = await store.claim('payout:w2:1');
    expect(again.kind).toBe('mine');
  });
});

describe('PostgresBroadcastStore — Class M claim/put (fake SQL)', () => {
  it('gives exactly one concurrent claimer mine; others get done/resume with same hash', async () => {
    const sql = fakePgSql();
    const store = new PostgresBroadcastStore(sql, { pollMs: 5, maxWaits: 40 });
    const kinds: string[] = [];

    await Promise.all(
      Array.from({ length: 8 }, () =>
        store.claim('payout:w1:1').then(async (claim) => {
          kinds.push(claim.kind);
          if (claim.kind === 'mine') {
            await store.putSigned('payout:w1:1', '0xraw');
            await store.put('payout:w1:1', '0xabc');
          } else if (claim.kind === 'resume') {
            expect(claim.signedRaw).toBe('0xraw');
            await store.put('payout:w1:1', '0xabc');
          } else {
            expect(claim).toEqual({ kind: 'done', txHash: '0xabc' });
          }
        }),
      ),
    );

    expect(kinds.filter((k) => k === 'mine')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'done' || k === 'resume').length).toBe(7);
    expect(await store.get('payout:w1:1')).toBe('0xabc');
  });

  it('put never overwrites a settled hash', async () => {
    const store = new PostgresBroadcastStore(fakePgSql());
    await store.claim('k');
    expect(await store.put('k', '0xfirst')).toBe('0xfirst');
    expect(await store.put('k', '0xsecond')).toBe('0xfirst');
    expect(await store.get('k')).toBe('0xfirst');
  });

  it('survives process-equivalent restart (rows stay) — multi-replica residual closed', async () => {
    const sql = fakePgSql();
    const a = new PostgresBroadcastStore(sql);
    await a.claim('payout:w3:1');
    await a.putSigned('payout:w3:1', '0xraw');
    await a.put('payout:w3:1', '0xsent');
    const b = new PostgresBroadcastStore(sql);
    const again = await b.claim('payout:w3:1');
    expect(again).toEqual({ kind: 'done', txHash: '0xsent' });
  });

  it('crash after putSigned before put → resume same signed raw across store instances', async () => {
    const sql = fakePgSql();
    const a = new PostgresBroadcastStore(sql, { pollMs: 5, maxWaits: 40 });
    await a.claim('payout:w4:1');
    await a.putSigned('payout:w4:1', '0xsigned-resume');
    // No put — crash window that D26-P1-P9 closes.
    const b = new PostgresBroadcastStore(sql, { pollMs: 5, maxWaits: 40 });
    const again = await b.claim('payout:w4:1');
    expect(again).toEqual({ kind: 'resume', signedRaw: '0xsigned-resume' });
    expect(await b.hasSigned('payout:w4:1')).toBe(true);
  });

  it('fail-first: two identical keys on two store instances → sign once, one hash', async () => {
    const sql = fakePgSql();
    const a = new PostgresBroadcastStore(sql, { pollMs: 5, maxWaits: 40 });
    const b = new PostgresBroadcastStore(sql, { pollMs: 5, maxWaits: 40 });
    const sign = vi.fn(async () => '0xraw-once');
    const broadcast = vi.fn(async (raw: string) => {
      expect(raw).toBe('0xraw-once');
      return '0xhash-once';
    });

    const [ha, hb] = await Promise.all([
      runDurableBroadcast({ store: a, idempotencyKey: 'payout:e13:1', sign, broadcast }),
      runDurableBroadcast({ store: b, idempotencyKey: 'payout:e13:1', sign, broadcast }),
    ]);

    expect(ha).toBe('0xhash-once');
    expect(hb).toBe('0xhash-once');
    expect(sign).toHaveBeenCalledTimes(1);
    expect(new Set(broadcast.mock.calls.map((call) => call[0]))).toEqual(new Set(['0xraw-once']));
    expect(await a.get('payout:e13:1')).toBe('0xhash-once');
    expect(await b.get('payout:e13:1')).toBe('0xhash-once');
  });
});

// PayoutQuery.tla, NeverPaidTwice: a `not_sent` answer closes the key, so the send it was given for can never leave.
describe.each([
  ['MemoryBroadcastStore', () => new MemoryBroadcastStore()],
  ['PostgresBroadcastStore', () => new PostgresBroadcastStore(fakePgSql(), { pollMs: 5, maxWaits: 40 })],
] as const)('%s close', (_name, make) => {
  it('a closed key signs and broadcasts nothing, and reads as no hash', async () => {
    const store = make();
    expect(await store.close('payout:closed:1')).toEqual({ closedKey: 'payout:closed:1' });
    expect(await store.close('payout:closed:1')).toEqual({ closedKey: 'payout:closed:1' });
    expect(await store.claim('payout:closed:1')).toEqual({ kind: 'closed' });
    const sign = vi.fn(async () => '0xraw');
    const broadcast = vi.fn(async () => '0xhash');
    await expect(runDurableBroadcast({ store, idempotencyKey: 'payout:closed:1', sign, broadcast })).rejects.toBeInstanceOf(
      BroadcastClosedError,
    );
    expect(sign).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(await store.get('payout:closed:1')).toBeNull();
    expect(await store.hasSigned('payout:closed:1')).toBe(false);
    await expect(store.put('payout:closed:1', '0xlate')).rejects.toThrow(/closed/);
  });

  it('a key a send has journalled signed bytes for cannot be closed, before or after its hash lands', async () => {
    const store = make();
    expect(await store.claim('payout:held:1')).toEqual({ kind: 'mine' });
    await store.putSigned('payout:held:1', '0xraw');
    expect(await store.close('payout:held:1')).toBe('held');
    await store.put('payout:held:1', '0xhash');
    expect(await store.close('payout:held:1')).toBe('held');
    expect(await store.get('payout:held:1')).toBe('0xhash');
  });

  // A send that claimed its key and died, or whose signer threw, before journalling signed bytes must not strand the
  // payout's hold: the query takes that claim, and the sender, if it is only slow, fails at putSigned and sends nothing.
  it('closes a claim with no signed bytes, and the sender that held it then signs nothing into the journal', async () => {
    const store = make();
    expect(await store.claim('payout:stranded:1')).toEqual({ kind: 'mine' });
    expect(await store.close('payout:stranded:1')).toEqual({ closedKey: 'payout:stranded:1' });
    await expect(store.putSigned('payout:stranded:1', '0xraw-late')).rejects.toThrow(/closed/);
    expect(await store.hasSigned('payout:stranded:1')).toBe(false);
    expect(await store.claim('payout:stranded:1')).toEqual({ kind: 'closed' });
  });

  it('a send whose signer throws leaves a key the next query closes, and its retry sends nothing', async () => {
    const store = make();
    const broadcast = vi.fn(async () => '0xhash');
    await expect(
      runDurableBroadcast({
        store,
        idempotencyKey: 'payout:signer-threw:1',
        sign: async () => {
          throw new Error('remote signer timed out');
        },
        broadcast,
      }),
    ).rejects.toThrow(/timed out/);
    expect(await store.close('payout:signer-threw:1')).toEqual({ closedKey: 'payout:signer-threw:1' });
    await expect(
      runDurableBroadcast({ store, idempotencyKey: 'payout:signer-threw:1', sign: async () => '0xraw', broadcast }),
    ).rejects.toBeInstanceOf(BroadcastClosedError);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
