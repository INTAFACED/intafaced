/**
 * What every trade-desk read or action returns: the answer, a typed refusal that names the real blocker,
 * or "unknown" when the wire dropped and we cannot say what happened. Plain data, safe in server and browser code.
 */

/** A known reason a control cannot work. `need` is the requirement id the back-end slice will cite. */
export interface Blocker {
  readonly key: string;
  /** The service or rail that owns the gap. */
  readonly owner: string;
  /** One plain sentence: what is missing. */
  readonly text: string;
  readonly need: string;
}

export type Outcome<T> =
  | { readonly kind: 'ok'; readonly data: T; readonly asOf: string }
  | {
      readonly kind: 'refused';
      /** Machine code from the service, e.g. trade.account_restricted, or an edge/console code. */
      readonly code: string;
      readonly message: string;
      readonly status: number;
      readonly blocker: Blocker | null;
      readonly asOf: string;
    }
  | {
      /** The call did not complete. For an action, the effect on the book is NOT known. */
      readonly kind: 'unknown';
      readonly message: string;
      readonly asOf: string;
    };

export const ok = <T>(data: T, asOf: string = new Date().toISOString()): Outcome<T> => ({ kind: 'ok', data, asOf });

export const refused = (
  code: string,
  message: string,
  status = 409,
  blocker: Blocker | null = null,
  asOf: string = new Date().toISOString(),
): Outcome<never> => ({ kind: 'refused', code, message, status, blocker, asOf });

export const unknown = (message: string, asOf: string = new Date().toISOString()): Outcome<never> => ({ kind: 'unknown', message, asOf });

/** A refusal that is just a named blocker (nothing was sent). */
export const blocked = (blocker: Blocker): Outcome<never> => refused(`trade_ops.${blocker.key}`, blocker.text, 501, blocker);
