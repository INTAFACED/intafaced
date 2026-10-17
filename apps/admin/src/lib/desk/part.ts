import type { FounderCallResult } from './founder-call';

/**
 * One independently-read part of a desk. A failed part says why and carries no data; it can never read as "nothing
 * there". Pure, so it can be used by the server loaders and by the client components that render the result.
 */
export type Part<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | {
      readonly kind: 'failed';
      readonly message: string;
      readonly code: string | null;
      readonly notBuilt: boolean;
      /** True when the service refused this founder's session (401/403), as opposed to being down. */
      readonly forbidden: boolean;
    };

export interface PartLabels {
  /** The service, as an operator names it: "svc-pay". */
  readonly service: string;
  /** What forbidden means for this desk, in one sentence. */
  readonly forbiddenMessage: string;
  /** Optional: a sentence for a typed refusal code, or null to use the generic one. */
  readonly refusedMessage?: (code: string | null) => string | null;
}

export function partFrom<T, U>(result: FounderCallResult<T>, pick: (data: T) => U, labels: PartLabels): Part<U> {
  switch (result.kind) {
    case 'ok':
      return { kind: 'ok', data: pick(result.data) };
    case 'not_built':
      return {
        kind: 'failed',
        message: `${labels.service} has not switched this on for this deployment.`,
        code: 'not_built',
        notBuilt: true,
        forbidden: false,
      };
    case 'forbidden':
      return { kind: 'failed', message: labels.forbiddenMessage, code: result.refusal.code, notBuilt: false, forbidden: true };
    case 'refused':
      return {
        kind: 'failed',
        message: labels.refusedMessage?.(result.refusal.code) ?? `${labels.service} refused this read.`,
        code: result.refusal.code,
        notBuilt: false,
        forbidden: false,
      };
    case 'unavailable':
      return { kind: 'failed', message: `${labels.service} did not answer.`, code: null, notBuilt: false, forbidden: false };
    case 'invalid':
      return {
        kind: 'failed',
        message: `${labels.service} answered in a shape this console does not understand.`,
        code: null,
        notBuilt: false,
        forbidden: false,
      };
  }
}
