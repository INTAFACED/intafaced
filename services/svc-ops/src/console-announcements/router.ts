import { TRPCError } from '@trpc/server';
import {
  ANNOUNCEMENT_NOT_FOUND,
  BANNER_CONFLICT,
  announcementSaveInputSchema,
  announcementWriteOutputSchema,
} from '@intafaced/contracts/ops-console-announcements';
import { router, scopedProcedure } from '@intafaced/contracts/trpc';
import { OPS_IDEMPOTENCY_CONFLICT, OpsError } from '../codes.js';
import type { AnnouncementDesk } from './desk.js';
import {
  OPS_ANNOUNCEMENTS_ACTIVE,
  OPS_ANNOUNCEMENTS_LIST,
  OPS_ANNOUNCEMENTS_CHANGE,
} from '@intafaced/contracts/ops-announcements-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { opsRefusal } from '../refusal.js';

const guards = { module: 'core-ops' as const, plane: 'fiat' as const };

function deskError(err: unknown): never {
  if (err instanceof OpsError) {
    const code =
      err.code === ANNOUNCEMENT_NOT_FOUND
        ? 'NOT_FOUND'
        : err.code === BANNER_CONFLICT || err.code === OPS_IDEMPOTENCY_CONFLICT
          ? 'CONFLICT'
          : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: `${err.code} — ${err.message}`, cause: err });
  }
  throw err;
}

/**
 * `announcements.list` and `announcements.active` (`admin:read`): the console's announcements, and the one showing now.
 * `announcements.save` and `announcements.change` (`admin:write`): save one as a draft or published, and publish or
 * withdraw it. No storage refuses `ops.announcement_storage_unconfigured`.
 */
export function createAnnouncementsRouter(desk: AnnouncementDesk) {
  return router({
    list: mountRecord(
      OPS_ANNOUNCEMENTS_LIST,
      async () => {
        try {
          return await desk.list();
        } catch (err) {
          return deskError(err);
        }
      },
      opsRefusal,
    ),
    active: mountRecord(
      OPS_ANNOUNCEMENTS_ACTIVE,
      async () => {
        try {
          return await desk.active();
        } catch (err) {
          return deskError(err);
        }
      },
      opsRefusal,
    ),
    save: scopedProcedure('admin:write', guards)
      .input(announcementSaveInputSchema)
      .output(announcementWriteOutputSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await desk.save(ctx.principal.userId, input);
        } catch (err) {
          return deskError(err);
        }
      }),
    change: mountRecord(
      OPS_ANNOUNCEMENTS_CHANGE,
      async ({ ctx, input }) => {
        try {
          return await desk.change(ctx.principal.userId, input);
        } catch (err) {
          return deskError(err);
        }
      },
      opsRefusal,
    ),
  });
}
