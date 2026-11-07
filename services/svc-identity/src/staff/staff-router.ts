import { z } from 'zod';
import {
  approvalPolicySetInputSchema,
  approvalPolicySetResultSchema,
  protectedProcedure,
  publicProcedure,
  router,
  TRPCError,
} from '@intafaced/contracts';
import {
  staffAcceptInputSchema,
  staffAcceptResultSchema,
  staffInvitationInputSchema,
  staffInvitationSchema,
  staffListSchema,
  staffEntrySchema,
} from '@intafaced/contracts/identity-staff';
import { isInteractiveFounderPrincipal } from '../auth/action-approval-audience.js';
import type { ActionApprovalService } from '../auth/action-approval-service.js';
import { AuthError } from '../auth/auth-service.js';
import { PolicyRowError, type ConsolePolicyRows } from './policy-rows.js';
import { StaffDirectoryError, type StaffDirectory } from './staff-directory.js';

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
  readonly founders: { isFounder(userId: string): Promise<boolean> };
}) {
  const founder = protectedProcedure.use(async ({ ctx, next }) => {
    const p = ctx.principal;
    if (!isInteractiveFounderPrincipal(p) || !(await deps.founders.isFounder(p.userId)))
      throw new TRPCError({ code: 'FORBIDDEN', message: 'operator.denied' });
    return next();
  });
  const map = (err: unknown): never => {
    if (err instanceof PolicyRowError || err instanceof StaffDirectoryError || err instanceof AuthError) {
      throw new TRPCError({ code: PRECONDITION.test(err.code) ? 'PRECONDITION_FAILED' : 'BAD_REQUEST', message: err.code, cause: err });
    }
    throw err;
  };

  return router({
    approvalPolicy: router({
      /** Every governed type's row as identity reads it now, with its source and the version to bind a change to. */
      rows: founder
        .output(z.object({ policies: z.array(approvalPolicySetResultSchema.shape.entry) }))
        .query(() => ({ policies: deps.rows.entries() })),
      set: founder
        .input(approvalPolicySetInputSchema)
        .output(approvalPolicySetResultSchema)
        .mutation(async ({ ctx, input }) => ({ entry: await deps.rows.set(deps.approvals, ctx.principal.userId, input).catch(map) })),
    }),
    staff: router({
      list: founder.output(staffListSchema).query(() => deps.directory.list()),
      /** The invite's fields are checked by identity itself (`readStaffInvite`), so an open link is refused by name. */
      invite: founder
        .input(z.unknown())
        .output(z.object({ staff: staffEntrySchema, mailed: z.boolean(), approverId: z.string(), auditId: z.string() }))
        .mutation(({ ctx, input }) => deps.directory.invite(ctx.principal.userId, input).catch(map)),
      invitation: publicProcedure
        .input(staffInvitationInputSchema)
        .output(staffInvitationSchema)
        .query(({ input }) => deps.directory.invitation(input.token)),
      acceptInvite: publicProcedure
        .input(staffAcceptInputSchema)
        .output(staffAcceptResultSchema)
        .mutation(async ({ input }) => ({ staff: await deps.directory.accept(input.token, input.password, input.deviceKey).catch(map) })),
    }),
  });
}
