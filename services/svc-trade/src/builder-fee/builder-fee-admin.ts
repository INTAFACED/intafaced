import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { BuilderFeeReconError, type BuilderFeeRecon } from './builder-fee-recon.js';

/** What the admin door needs: the recon for one period (builder-fee-recon.ts). */
export interface BuilderFeeReconReader {
  recon(from: Date, to: Date): Promise<BuilderFeeRecon>;
}

const iso = z.string().datetime({ offset: true });

/**
 * `admin.builderFees.recon` (J-derivatives-17 #1 #2): the builder fees the venues report against the builder fees the
 * ledger records as earned, for one period. Read only, for staff who can read the console (`admin:read`). A bad period
 * or no connected venue is a typed refusal in the message's last bracket, as the console reads it.
 */
export function builderFeeAdminRouter(reader?: BuilderFeeReconReader) {
  const operator = scopedProcedure('admin:read');
  return router({
    builderFees: router({
      recon: operator.input(z.object({ from: iso, to: iso }).strict()).query(async ({ input }) => {
        if (!reader) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'builder_fee_recon_unconfigured' });
        try {
          return await reader.recon(new Date(input.from), new Date(input.to));
        } catch (error) {
          if (error instanceof BuilderFeeReconError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: `${error.message} [${error.code}]`, cause: error });
          }
          throw error;
        }
      }),
    }),
  });
}
