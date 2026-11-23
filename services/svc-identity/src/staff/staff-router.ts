import { z } from 'zod';
import { router, TRPCError } from '@intafaced/contracts/trpc';
import { staffInviteResultSchema } from '@intafaced/contracts/identity-staff';
import { founderProcedure, type Founders } from '../founder-procedure.js';
import type { ActionApprovalService } from '../auth/action-approval-service.js';
import { AuthError } from '../auth/auth-service.js';
import { PolicyRowError, type ConsolePolicyRows } from './policy-rows.js';
import { StaffDirectoryError, type StaffDirectory } from './staff-directory.js';
import {
  IDENTITY_STAFF_ACCEPT_INVITE,
  IDENTITY_STAFF_INVITATION,
  IDENTITY_STAFF_LIST,
} from '@intafaced/contracts/identity-staff-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from '../record-refusal.js';
import { IDENTITY_APPROVAL_POLICY_ROWS, IDENTITY_APPROVAL_POLICY_SET } from '@intafaced/contracts/identity-approval-policy-procedures';

/** Refusals that mean "this request cannot go ahead as it stands", not a bad shape. */
const PRECONDITION = /^(action_approval\.|identity\.staff_invite_ttl_unset$|identity\.staff_already_invited$|auth\.email_taken$)/;

/**
 * The staff directory and the console's approval policy rows (J-ops-console-09 #1, #2). Reads and changes are a live
 * founder's on an interactive second-factor session; every change also spends a second person's approval. The
 * first-connection pair (`staff.invitation`, `staff.acceptInvite`) is public: the one-time token is the authority.
 * Each refusal carries its typed code as the whole message.
 */
export function createStaffRouter(deps: {
  readonly rows: ConsolePolicyRows;
  readonly directory: StaffDirectory;
  readonly approvals: Pick<ActionApprovalService, 'consume'>;
  readonly founders: Founders;
}) {
  const founder = founderProcedure(deps.founders);
  const map = (err: unknown): never => {
    if (err instanceof PolicyRowError || err instanceof StaffDirectoryError || err instanceof AuthError) {
      throw new TRPCError({ code: PRECONDITION.test(err.code) ? 'PRECONDITION_FAILED' : 'BAD_REQUEST', message: err.code, cause: err });
    }
    throw err;
  };

  return router({
    approvalPolicy: router({
      /** Every governed type's row as identity reads it now, with its source and the version to bind a change to. */
      rows: mountRecord(IDENTITY_APPROVAL_POLICY_ROWS, () => ({ policies: deps.rows.entries() }), {
        refusalOf: codedRefusal,
        founder: founder,
      }),
      set: mountRecord(
        IDENTITY_APPROVAL_POLICY_SET,
        async ({ ctx, input }) => ({ entry: await deps.rows.set(deps.approvals, ctx.principal.userId, input).catch(map) }),
        { refusalOf: codedRefusal, founder },
      ),
    }),
    staff: router({
      list: mountRecord(IDENTITY_STAFF_LIST, () => deps.directory.list(), { refusalOf: codedRefusal, founder }),
      /** The invite's fields are checked by identity itself (`readStaffInvite`), so an open link is refused by name. */
      invite: founder
        .input(z.unknown())
        .output(staffInviteResultSchema)
        .mutation(({ ctx, input }) => deps.directory.invite(ctx.principal.userId, input).catch(map)),
      invitation: mountRecord(IDENTITY_STAFF_INVITATION, ({ input }) => deps.directory.invitation(input.token), codedRefusal),
      acceptInvite: mountRecord(
        IDENTITY_STAFF_ACCEPT_INVITE,
        async ({ input }) => ({ staff: await deps.directory.accept(input.token, input.password, input.deviceKey).catch(map) }),
        codedRefusal,
      ),
    }),
  });
}
