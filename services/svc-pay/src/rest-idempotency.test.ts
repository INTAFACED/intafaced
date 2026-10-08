import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  fingerprintRequest,
  MemoryRestIdempotencyStore,
  PostgresRestIdempotencyStore,
  type RestIdempotencyClaim,
} from './rest-idempotency.js';

/** The claim token, or a failure that says which kind came back instead. */
function tokenOf(claim: RestIdempotencyClaim): string {
  if (claim.kind !== 'mine') throw new Error(`expected an owned claim, got "${claim.kind}"`);
  return claim.token;
}

describe('fingerprintRequest', () => {
  it('is stable under key reordering', () => {
    const a = fingerprintRequest('POST', '/v1/payments', { amount: '1.1', merchantId: 'm' });
    const b = fingerprintRequest('POST', '/v1/payments', { merchantId: 'm', amount: '1.1' });
    expect(a).toBe(b);
  });

  it('changes when the body changes', () => {
    const a = fingerprintRequest('POST', '/p', { amount: '1.1' });
    const b = fingerprintRequest('POST', '/p', { amount: '2.0' });
    expect(a).not.toBe(b);
  });

  /**
   * JSON.parse stores `__proto__` as an own data property. Copying that key
   * with ordinary assignment invokes the prototype setter, JSON.stringify
   * drops it, and a body that differs only by that member hashes the same.
   */
  it('keeps an own __proto__ member, so a body that differs only by it is a different fingerprint', () => {
    const plain = JSON.parse('{"note":"a"}') as Record<string, unknown>;
    const withProto = JSON.parse('{"note":"a","__proto__":{"extra":true}}') as Record<string, unknown>;
    const reordered = JSON.parse('{"__proto__":{"extra":true},"note":"a"}') as Record<string, unknown>;

    expect(Object.getOwnPropertyDescriptor(withProto, '__proto__')).toMatchObject({
      enumerable: true,
      writable: true,
      configurable: true,
      value: { extra: true },
    });

    const base = fingerprintRequest('POST', '/p', plain);
    const changed = fingerprintRequest('POST', '/p', withProto);
    const otherValue = fingerprintRequest(
      'POST',
      '/p',
      JSON.parse('{"note":"a","__proto__":{"extra":false}}') as Record<string, unknown>,
    );
    // Sorted own keys: `__proto__` then `note`. The member survives JSON.stringify.
    const kept = createHash('sha256')
      .update('POST\n/p\n{"__proto__":{"extra":true},"note":"a"}')
      .digest('hex');
    expect(changed).toBe(kept);
    expect(changed).not.toBe(base);
    expect(otherValue).not.toBe(changed);
    expect(fingerprintRequest('POST', '/p', reordered)).toBe(changed);

    const nested = JSON.parse('{"note":"a","box":{"__proto__":{"extra":true}}}') as Record<string, unknown>;
    const nestedPlain = JSON.parse('{"note":"a","box":{}}') as Record<string, unknown>;
    const nestedKept = createHash('sha256')
      .update('POST\n/p\n{"box":{"__proto__":{"extra":true}},"note":"a"}')
      .digest('hex');
    expect(fingerprintRequest('POST', '/p', nested)).toBe(nestedKept);
    expect(fingerprintRequest('POST', '/p', nested)).not.toBe(fingerprintRequest('POST', '/p', nestedPlain));
  });
});

describe('MemoryRestIdempotencyStore', () => {
  it('replays a settled claim with the same fingerprint', async () => {
    const store = new MemoryRestIdempotencyStore();
    const fp = fingerprintRequest('POST', '/p', { a: 1 });

    const c1 = await store.claim('owner', 'key-1', fp);
    expect(c1.kind).toBe('mine');
    await store.put('owner', 'key-1', { statusCode: 200, body: { ok: true } }, tokenOf(c1));

    expect(await store.claim('owner', 'key-1', fp)).toEqual({
      kind: 'replay',
      record: { statusCode: 200, body: { ok: true } },
    });
  });

  it('conflicts when the fingerprint differs', async () => {
    const store = new MemoryRestIdempotencyStore();
    const fp1 = fingerprintRequest('POST', '/p', { a: 1 });
    const fp2 = fingerprintRequest('POST', '/p', { a: 2 });

    const c2 = await store.claim('owner', 'key-2', fp1);
    expect(c2.kind).toBe('mine');
    await store.put('owner', 'key-2', { statusCode: 200, body: { ok: true } }, tokenOf(c2));

    expect(await store.claim('owner', 'key-2', fp2)).toEqual({ kind: 'conflict' });
  });

  it('CONFLICTS a repeated key when the body differs only by an own __proto__ member', async () => {
    const store = new MemoryRestIdempotencyStore();
    const plain = JSON.parse('{"note":"a"}') as Record<string, unknown>;
    const withProto = JSON.parse('{"note":"a","__proto__":{"extra":true}}') as Record<string, unknown>;
    const fp1 = fingerprintRequest('POST', '/p', plain);
    const fp2 = fingerprintRequest('POST', '/p', withProto);

    const first = await store.claim('owner', 'key-proto', fp1);
    expect(first.kind).toBe('mine');
    await store.put('owner', 'key-proto', { statusCode: 200, body: { stored: true } }, tokenOf(first));

    expect(await store.claim('owner', 'key-proto', fp2)).toEqual({ kind: 'conflict' });
    expect(await store.claim('owner', 'key-proto', fp1)).toEqual({
      kind: 'replay',
      record: { statusCode: 200, body: { stored: true } },
    });
  });

  it('abandons a pending claim so a retry may execute', async () => {
    const store = new MemoryRestIdempotencyStore();
    const fp = fingerprintRequest('POST', '/p', {});

    const c = await store.claim('owner', 'key-3', fp);
    expect(c.kind).toBe('mine');
    await store.abandon('owner', 'key-3', tokenOf(c));
    expect((await store.claim('owner', 'key-3', fp)).kind).toBe('mine');
  });

  /**
   * A duplicate that arrived while the handler was in flight is parked on the
   * pending slot. `abandon` deletes that slot and wakes the parkers. Each
   * parker must claim again: one takes the freed key, and any other waits for
   * that new owner. Throwing "stalled while pending" turns a failed mutation
   * into an error for the retry the key exists to allow.
   */
  it('lets a concurrent waiter take a key abandon freed', async () => {
    const store = new MemoryRestIdempotencyStore();
    const fp = fingerprintRequest('POST', '/p', { a: 1 });
    const other = fingerprintRequest('POST', '/p', { a: 2 });

    const failed = await store.claim('owner', 'key-retry', fp);
    const firstWaiter = store.claim('owner', 'key-retry', fp);
    const secondWaiter = store.claim('owner', 'key-retry', fp);

    expect(await store.claim('owner', 'key-retry', other)).toEqual({ kind: 'conflict' });

    await store.abandon('owner', 'key-retry', tokenOf(failed));

    const winner = await Promise.race([
      firstWaiter.then((claim) => ({ claim, other: secondWaiter })),
      secondWaiter.then((claim) => ({ claim, other: firstWaiter })),
    ]);
    expect(winner.claim.kind).toBe('mine');
    expect(tokenOf(winner.claim)).not.toBe(tokenOf(failed));

    await store.put('owner', 'key-retry', { statusCode: 201, body: { retried: true } }, tokenOf(winner.claim));

    expect(await winner.other).toEqual({
      kind: 'replay',
      record: { statusCode: 201, body: { retried: true } },
    });
    expect(await store.claim('owner', 'key-retry', fp)).toEqual({
      kind: 'replay',
      record: { statusCode: 201, body: { retried: true } },
    });
    expect(await store.claim('owner', 'key-retry', other)).toEqual({ kind: 'conflict' });
  });

  /**
   * THE HANDLER THAT CAME BACK FROM THE DEAD.
   *
   * A claim can be taken over once its owner is presumed dead (see
   * STALE_PENDING_MS). The owner may not actually be dead — it may be hung on a
   * socket and about to return. If its late `put` could still settle the row,
   * the NEW owner would be handed a response produced by an execution it knows
   * nothing about, on a money path. The token is what makes that a no-op.
   */
  it('IGNORES a settle from a claim that has been taken over', async () => {
    const store = new MemoryRestIdempotencyStore();
    const fp = fingerprintRequest('POST', '/p', { a: 1 });

    const dead = await store.claim('owner', 'key-4', fp);
    await store.abandon('owner', 'key-4', tokenOf(dead)); // presumed dead, reclaimed
    const live = await store.claim('owner', 'key-4', fp);
    expect(live.kind).toBe('mine');
    expect(tokenOf(live)).not.toBe(tokenOf(dead));

    // The corpse returns and tries to settle.
    await store.put('owner', 'key-4', { statusCode: 200, body: { from: 'dead' } }, tokenOf(dead));

    // It did not win: the live owner still holds a pending claim.
    await store.put('owner', 'key-4', { statusCode: 201, body: { from: 'live' } }, tokenOf(live));
    expect(await store.claim('owner', 'key-4', fp)).toEqual({
      kind: 'replay',
      record: { statusCode: 201, body: { from: 'live' } },
    });
  });

  it('IGNORES an abandon from a claim that has been taken over', async () => {
    const store = new MemoryRestIdempotencyStore();
    const fp = fingerprintRequest('POST', '/p', { a: 1 });

    const dead = await store.claim('owner', 'key-5', fp);
    await store.abandon('owner', 'key-5', tokenOf(dead));
    const live = await store.claim('owner', 'key-5', fp);

    // A late abandon from the corpse must not free the live owner's claim.
    await store.abandon('owner', 'key-5', tokenOf(dead));
    await store.put('owner', 'key-5', { statusCode: 200, body: { ok: true } }, tokenOf(live));

    expect((await store.claim('owner', 'key-5', fp)).kind).toBe('replay');
  });
});

describe('PostgresRestIdempotencyStore — a claim whose owner died', () => {
  /**
   * `abandon` covers a 5xx and a thrown handler. It cannot cover the process
   * ceasing to exist — an OOM kill, an eviction, a deploy landing mid-request.
   * The pending row then survives with nobody to settle it, and before this the
   * key was wedged FOREVER: every retry polled its whole budget and threw.
   * Retrying with the same key is the entire purpose of an idempotency key.
   */
  it('takes over a pending row that is older than the stale window', async () => {
    const calls: string[] = [];
    // Insert loses the race (row exists); the reclaim UPDATE wins.
    const sql = ((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      calls.push(text.trim().split(/\s+/).slice(0, 2).join(' '));
      if (text.includes('INSERT INTO pay.rest_idempotency')) return Promise.resolve([]);
      if (text.includes('UPDATE pay.rest_idempotency')) return Promise.resolve([{ token: '2026-08-08 10:00:00+00' }]);
      return Promise.resolve([]);
    }) as never;

    const store = new PostgresRestIdempotencyStore(sql);
    const claim = await store.claim('owner', 'key-dead', 'fp');

    expect(claim.kind).toBe('mine');
    expect(tokenOf(claim)).toBe('2026-08-08 10:00:00+00');
    // It reclaimed rather than polling: no SELECT was needed.
    expect(calls).toEqual(['INSERT INTO', 'UPDATE pay.rest_idempotency']);
  });

  it('does NOT take over while the row is still fresh — it waits for the owner', async () => {
    // The reclaim UPDATE matches nothing (row is young), so the caller falls
    // through to polling and sees the owner's settled response.
    const sql = ((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (text.includes('INSERT INTO pay.rest_idempotency')) return Promise.resolve([]);
      if (text.includes('UPDATE pay.rest_idempotency')) return Promise.resolve([]);
      return Promise.resolve([{ request_fingerprint: 'fp', status_code: 200, response_body: { ok: true } }]);
    }) as never;

    const store = new PostgresRestIdempotencyStore(sql);
    const claim = await store.claim('owner', 'key-live', 'fp');

    expect(claim).toEqual({ kind: 'replay', record: { statusCode: 200, body: { ok: true } } });
  });
});
