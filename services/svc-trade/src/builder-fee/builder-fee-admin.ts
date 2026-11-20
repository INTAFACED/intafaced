import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { mountRecord, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import { TRADE_BUILDER_ACCOUNT_MODE } from '@intafaced/contracts/trade-builder-mode-procedures';
import { BuilderFeeReconError, type BuilderFeeRecon } from './builder-fee-recon.js';
import { BuilderModeError, type BuilderModeAlert, type BuilderModeCheck } from './builder-mode.js';

/** Our builder address's mode at each venue, checked on this read, with the latest alerts (J-ops-console-28). */
export interface BuilderAccountModeView extends BuilderModeCheck {
  readonly asOf: Date;
  readonly alerts: readonly BuilderModeAlert[];
}

/** What the admin door needs: the recon for one period (builder-fee-recon.ts) and the builder account's mode. */
export interface BuilderFeeReconReader {
  recon(from: Date, to: Date): Promise<BuilderFeeRecon>;
  accountMode?(): Promise<BuilderAccountModeView>;
}

const iso = z.string().datetime({ offset: true });

/** A `BuilderModeError` leaves with its code at the end of the message, where the console reads it. */
const builderModeRefusalOf: RefusalOf = (err) => {
  if (!(err instanceof BuilderModeError)) return undefined;
  const code = err.code === 'trade.user_venue_off' ? 'SERVICE_UNAVAILABLE' : 'PRECONDITION_FAILED';
  return { code: err.code, error: new TRPCError({ code, message: `${err.message} [${err.code}]`, cause: err }) };
};

export function builderAccountModeWire(view: BuilderAccountModeView) {
  return {
    asOf: view.asOf.toISOString(),
    builder: view.builder,
    alerting: view.alerting,
    venues: view.venues.map((v) => ({ ...v, mode: v.mode.status === 'read' ? { ...v.mode, asOf: v.mode.asOf.toISOString() } : v.mode })),
    alerts: view.alerts.map((a) => ({ ...a, openedAt: a.openedAt.toISOString(), clearedAt: a.clearedAt?.toISOString() ?? null })),
  };
}

/**
 * `admin.builderFees.recon` (J-derivatives-17 #1 #2): the builder fees the venues report against the builder fees the
 * ledger records as earned, for one period. Read only, for staff who can read the console (`admin:read`). A bad period
 * or no connected venue is a typed refusal in the message's last bracket, as the console reads it.
 * `admin.builderFees.accountMode` (J-ops-console-28): our builder address's mode at each venue, from its record.
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
      accountMode: mountRecord(
        TRADE_BUILDER_ACCOUNT_MODE,
        async () => {
          if (!reader?.accountMode) throw new BuilderModeError('trade.user_venue_off', 'the user-venue door is off on this deployment');
          return builderAccountModeWire(await reader.accountMode());
        },
        builderModeRefusalOf,
      ),
    }),
  });
}
