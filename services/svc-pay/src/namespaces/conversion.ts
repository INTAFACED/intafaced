import { z } from 'zod';
import {
  conversionQuoteInputSchema,
  conversionQuoteSchema,
  conversionExecuteInputSchema,
  conversionOrderSchema,
  conversionGetInputSchema,
  conversionListInputSchema,
} from '@intafaced/contracts/conversion';
import { router, scopedProcedure } from '@intafaced/contracts/trpc';
import type { Principal } from '@intafaced/auth';
import { ControlError } from '../control/errors.js';
import { mapConversionError } from '../conversion/errors.js';
import type { ConversionService } from '../conversion/service.js';
import { toTrpcError } from './control-errors.js';
import { notBuilt } from './errors.js';
import { ownMerchantRead } from '../own-merchant-read.js';
import {
  PAY_CONVERSION_LIST,
  PAY_CONVERSION_GET,
  PAY_CONVERSION_QUOTE,
  PAY_CONVERSION_EXECUTE,
} from '@intafaced/contracts/pay-conversion-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { payRefusal } from '../record-refusal.js';

/**
 * `conversion.*` — USD to USDT, sandbox only.
 * `quote` is a write. `execute` moves value, so it carries the payout scope.
 * The service also requires the `payout.approve` team role on execute.
 * With no service wired, every procedure stays `pay.not_built`.
 */
export function createConversionRouter(conversion?: ConversionService) {
  const read = ownMerchantRead();
  const write = scopedProcedure('pay:write', { module: 'pay' });
  const execute = scopedProcedure('pay:payout', { module: 'pay' });
  if (!conversion) {
    return router({
      conversion: router({
        quote: write
          .input(conversionQuoteInputSchema)
          .output(conversionQuoteSchema)
          .mutation(() => notBuilt('conversion.quote')),
        execute: execute
          .input(conversionExecuteInputSchema)
          .output(conversionOrderSchema)
          .mutation(() => notBuilt('conversion.execute')),
        get: read
          .input(conversionGetInputSchema)
          .output(conversionOrderSchema)
          .query(() => notBuilt('conversion.get')),
        list: read
          .input(conversionListInputSchema)
          .output(z.array(conversionOrderSchema))
          .query(() => notBuilt('conversion.list')),
      }),
    });
  }

  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ControlError) throw toTrpcError(error);
      throw mapConversionError(error);
    }
  };
  const principalOf = (ctx: { principal: Principal | null }): Principal | null => ctx.principal;

  return router({
    conversion: router({
      quote: mountRecord(PAY_CONVERSION_QUOTE, ({ ctx, input }) => run(() => conversion.quote(principalOf(ctx), input)), payRefusal),
      execute: mountRecord(PAY_CONVERSION_EXECUTE, ({ ctx, input }) => run(() => conversion.execute(principalOf(ctx), input)), payRefusal),
      get: mountRecord(PAY_CONVERSION_GET, ({ ctx, input }) => run(() => conversion.get(principalOf(ctx), input.conversionId)), payRefusal),
      list: mountRecord(PAY_CONVERSION_LIST, ({ ctx, input }) => run(() => conversion.list(principalOf(ctx), input)), payRefusal),
    }),
  });
}
