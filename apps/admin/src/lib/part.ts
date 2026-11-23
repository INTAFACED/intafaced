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
