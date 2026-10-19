import type { FastifyInstance } from 'fastify';

/**
 * Request-scoped release for the preValidation stashes in the *-place.ts files.
 * A stash entry is written before auth and schema, so a request that fails
 * (401, 400, 429) never reaches the bind that consumes it. Without a release,
 * its flags would sit in the process-wide map and be picked up by a later order
 * that reuses the clientOrderId. Every response, success or refusal, passes
 * onSend, so each request drops the entries it wrote and only those: an entry a
 * newer request has since replaced is left alone.
 */
const written = new WeakMap<object, Array<{ stash: Map<string, unknown>; key: string; value: unknown }>>();
const HOOKED = Symbol.for('intafaced.trade.stashRelease');

export function stashSet<V>(req: object, stash: Map<string, V>, key: string, value: V): void {
  stash.set(key, value);
  const list = written.get(req) ?? [];
  list.push({ stash: stash as Map<string, unknown>, key, value });
  written.set(req, list);
}

/** Claim an entry already written to `stash` so this request's response releases it. */
export function stashClaim<V>(req: object, stash: Map<string, V>, key: string): void {
  if (!stash.has(key)) return;
  const list = written.get(req) ?? [];
  list.push({ stash: stash as Map<string, unknown>, key, value: stash.get(key) });
  written.set(req, list);
}

export function releaseStash(req: object): void {
  const list = written.get(req);
  if (!list) return;
  written.delete(req);
  for (const { stash, key, value } of list) {
    if (stash.get(key) === value) stash.delete(key);
  }
}

export function attachStashRelease(app: FastifyInstance): void {
  const marked = app as unknown as { [HOOKED]?: true };
  if (marked[HOOKED]) return;
  marked[HOOKED] = true;
  app.addHook('onSend', (req, _reply, payload, done) => {
    releaseStash(req);
    done(null, payload);
  });
}
