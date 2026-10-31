import { TRPCError } from '@trpc/server';
import {
  scopedProcedure,
  setKbSegmentInputSchema,
  SUPPORT_KB_SEGMENT_CAP_UNSET,
  SUPPORT_KB_SEGMENT_MEMBERSHIP_UNWIRED,
} from '@intafaced/contracts';
import { requireSupportOps } from './support-service.js';

/**
 * Per-segment visibility of a help article (SP-help-centre-02). Nothing is ever stored here.
 *
 * The number of segments one article may name is the owner's `SUPPORT_KB_SEGMENT_CAP`; blank refuses
 * `support.kb_segment_cap_unset` and is never defaulted. With a cap set the door still refuses
 * `support.kb_segment_membership_unwired`: who belongs to a segment is svc-identity's answer, read through a contract
 * that does not exist yet, and the desk never keeps a second customer table. Whether per-segment visibility is wanted at
 * all is a thread decision; the audience column ships without it, so no restriction is claimed that cannot be enforced.
 */
export function kbSegmentRefusal(cap: number | null): string {
  return cap === null ? SUPPORT_KB_SEGMENT_CAP_UNSET : SUPPORT_KB_SEGMENT_MEMBERSHIP_UNWIRED;
}

export function kbSegmentProcedures(segmentCap: number | null) {
  return {
    setKbSegment: scopedProcedure('support:ops')
      .input(setKbSegmentInputSchema)
      .mutation(({ ctx }): never => {
        requireSupportOps(ctx.principal!);
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: kbSegmentRefusal(segmentCap) });
      }),
  };
}
