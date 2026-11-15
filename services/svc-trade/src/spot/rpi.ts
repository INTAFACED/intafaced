/**
 * The retail price improvement layer (SP-markets-data-04) is not built: the engine has not specified its priority class,
 * speed bump or retail-only crossing rule, and the owner has not decided the retail programme. An order that asks for it
 * is refused with a typed code before anything is held, never placed as an ordinary order with the flag dropped (the
 * create schema strips keys it does not know, so without this door the flag would vanish silently).
 */
import { TradeError } from './types.js';

/** The body keys a client may use to ask for the layer. */
export const RPI_FLAGS = ['rpi', 'retailPriceImprovement', 'priceImprovement'] as const;

export function refuseRetailPriceImprovement(body: unknown): void {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return;
  const asked = RPI_FLAGS.find((key) => Object.hasOwn(body, key));
  if (asked === undefined) return;
  throw new TradeError(
    `retail price improvement is not available: priority class not specified (${asked} is not accepted on any order)`,
    'trade.rpi_unavailable',
  );
}
