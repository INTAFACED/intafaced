import { TRPCError } from '@trpc/server';
import {
  staffHoldConfirmInputSchema,
  staffHoldPlaceInputSchema,
  staffHoldReleaseInputSchema,
  staffHoldResultSchema,
} from '@intafaced/contracts/ops-staff-holds';
import { router, scopedProcedure } from '@intafaced/contracts/trpc';
import { OPS_IDEMPOTENCY_CONFLICT, OpsError, STAFF_HOLD_NOT_FOUND } from '../codes.js';
import type { StaffHoldDesk } from './desk.js';
import { OPS_STAFF_HOLDS_LIST } from '@intafaced/contracts/ops-staff-holds-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { opsRefusal } from '../refusal.js';

const guards = { module: 'core-ops' as const, plane: 'fiat' as const };

function deskError(err: unknown): never {
  if (err instanceof OpsError) {
    const code =
      err.code === STAFF_HOLD_NOT_FOUND ? 'NOT_FOUND' : err.code === OPS_IDEMPOTENCY_CONFLICT ? 'CONFLICT' : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: `${err.code} — ${err.message}`, cause: err });
  }
  throw err;
}

/**
 * Staff holds on funds (OPS-accounts-desk-01). `staffHolds.list` (`admin:read`) shows one customer's holds with every
 * ledger post made for them. `place`, `release` and `confirm` move value in the ledger, so they need `admin:treasury`
 * (the spec's scope for holds); `release` and `confirm` also spend a second founder's approval.
 */
export function createStaffHoldsRouter(desk: StaffHoldDesk) {
  return router({
    list: mountRecord(
      OPS_STAFF_HOLDS_LIST,
      async ({ input }) => {
        try {
          return await desk.list(input.userId);
        } catch (err) {
          return deskError(err);
        }
      },
      opsRefusal,
    ),
    place: scopedProcedure('admin:treasury', guards)
      .input(staffHoldPlaceInputSchema)
      .output(staffHoldResultSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await desk.place(ctx.principal.userId, input);
        } catch (err) {
          return deskError(err);
        }
      }),
    release: scopedProcedure('admin:treasury', guards)
      .input(staffHoldReleaseInputSchema)
      .output(staffHoldResultSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await desk.release(ctx.principal.userId, input);
        } catch (err) {
          return deskError(err);
        }
      }),
    confirm: scopedProcedure('admin:treasury', guards)
      .input(staffHoldConfirmInputSchema)
      .output(staffHoldResultSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await desk.confirm(ctx.principal.userId, input);
        } catch (err) {
          return deskError(err);
        }
      }),
  });
}
