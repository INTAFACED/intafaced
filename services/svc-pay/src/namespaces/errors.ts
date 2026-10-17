import { TRPCError } from '@intafaced/contracts';

/**
 * The one refusal every W0 stub throws. The procedure exists on the wire so the
 * apps can be built against it, but nothing sits behind it yet, and it must
 * never answer with data it made up. `code` reaches the client as
 * `error.data.cause.code` (see the contracts error formatter).
 */
export class PayNotBuiltError extends Error {
  readonly code = 'pay.not_built' as const;
  constructor(readonly procedure: string) {
    super(`${procedure} is not built yet`);
    this.name = 'PayNotBuiltError';
  }
}

/** Use as `() => notBuilt('merchantControl.get')` — it always throws. */
export function notBuilt(procedure: string): never {
  const cause = new PayNotBuiltError(procedure);
  throw new TRPCError({ code: 'NOT_IMPLEMENTED', message: `${cause.code}: ${cause.message}`, cause });
}
