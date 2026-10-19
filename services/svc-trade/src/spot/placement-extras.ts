import type { PlaceOrderInput } from './trade-service.js';

/**
 * Placement options the typed create schema does not carry (stop price, post-only, iceberg, expiry and the rest)
 * travel on the order input itself, under a symbol, from the request handler to the installer that reads them.
 * They are attached only after the caller is signed in and the body is accepted, so an option can never outlive
 * its request or be read by another caller's order (ENGINE D-1, D-2).
 */

const CARRIED = Symbol.for('intafaced.trade.placementBody');

type Carrier = { [CARRIED]?: Readonly<Record<string, unknown>> };

/** Attach a copy of the request's own body to this request's order input. */
export function carryPlacementBody<T extends PlaceOrderInput>(input: T, body: unknown): T {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return input;
  return { ...input, [CARRIED]: Object.freeze({ ...(body as Record<string, unknown>) }) };
}

/** The body the input was placed with, or null when the input did not come from a request body. */
export function carriedPlacementBody(input: PlaceOrderInput): Readonly<Record<string, unknown>> | null {
  return (input as Carrier)[CARRIED] ?? null;
}

/** The input without the request body it carried, so no installer can re-read an option from it. */
export function withoutCarriedBody<T extends PlaceOrderInput>(input: T): T {
  if ((input as Carrier)[CARRIED] === undefined) return input;
  const { [CARRIED]: _body, ...rest } = input as T & Carrier;
  return rest as unknown as T;
}

/**
 * The body the typed create schema reads. Reduce-only is carried with the request instead, because the spot mapper
 * refuses a reduce-only flag it is handed; the installer that honours it reads it from the carried body.
 */
export function schemaBodyOf(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const rec = body as Record<string, unknown>;
  if (rec.reduceOnly !== true) return body;
  const { reduceOnly: _carried, ...rest } = rec;
  return rest;
}
