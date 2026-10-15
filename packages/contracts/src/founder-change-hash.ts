import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The canonical hash of a founder configuration change (W1 dual control). SERVER-ONLY: it uses `node:crypto`,
 * so it is its own entry point (`@intafaced/contracts/founder-change-hash`) and never part of the browser-safe root.
 *
 * svc-pay stores this hash when the first founder submits, and the second founder's confirm must carry the
 * same hash, so a confirm only ever applies the exact change its confirmer was shown. Both sides call THIS
 * function: the canonical form (object keys sorted with a FIXED 'en' collation so the machine's locale can never change a
 * hash, arrays kept in order) lives in one place.
 */

const stable = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b, 'en')))
      : v,
  );

/** `sha256:<hex>` over the canonical `{ target, expectedVersion }`. `target` is the change target svc-pay stores. */
export function founderChangeHash(target: unknown, expectedVersion: string): string {
  return `sha256:${createHash('sha256').update(stable({ target, expectedVersion })).digest('hex')}`;
}

/** Constant-time equality of two hash strings. Different lengths are simply unequal. */
export function changeHashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
