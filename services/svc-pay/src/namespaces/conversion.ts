import { z } from 'zod';
import {
  router,
  scopedProcedure,
  conversionQuoteInputSchema,
  conversionQuoteSchema,
  conversionExecuteInputSchema,
  conversionOrderSchema,
  conversionGetInputSchema,
  conversionListInputSchema,
} from '@intafaced/contracts';
import { notBuilt } from './errors.js';

/**
 * `conversion.*` — USD to USDT, sandbox only (W6 replaces these stubs).
 * `execute` moves value, so it carries the payout scope, not the take-a-payment one.
 */
export function createConversionRouter() {
  const read = scopedProcedure('pay:read', { module: 'pay' });
  const execute = scopedProcedure('pay:payout', { module: 'pay' });
  return router({
    conversion: router({
      quote: read
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
