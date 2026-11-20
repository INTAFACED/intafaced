import { z } from 'zod';
import type { ProcedureInput } from '@intafaced/contracts/procedure';
import {
  PAY_ALLOWLIST_LIST_ENTRIES,
  PAY_ALLOWLIST_LIST_FOR_TEAM,
  PAY_ALLOWLIST_PROPOSE_ADD,
  PAY_ALLOWLIST_PROPOSE_DELETE,
  PAY_ALLOWLIST_PROPOSE_POLICY,
  PAY_ALLOWLIST_SET_MODE,
} from '@intafaced/contracts/pay-allowlist-procedures';
import {
  payAllowlistChangeSchema,
  payAllowlistEntrySchema,
  payAllowlistModeSchema,
  payAllowlistPolicySchema,
  payAllowlistSetModeResultSchema,
} from '@intafaced/contracts/pay-money-room';

/**
 * The withdrawal allowlist's founder-side wire shapes (W-withdraw-10). The customer's and approver's calls, and the views
 * every side answers with, are svc-pay's records (`@intafaced/contracts/pay-allowlist-procedures`, `pay-money-room`). Every
 * input object is `.strict()`; no field has a default, so a blank one is a parse error.
 */
const id = z.string().guid();
const limit = z.number().int().min(1).max(200);

export type ChangeOp = z.output<typeof payAllowlistChangeSchema>['op'];
export type ChangeStatus = z.output<typeof payAllowlistChangeSchema>['status'];

export type ProposeAddInput = ProcedureInput<typeof PAY_ALLOWLIST_PROPOSE_ADD>;
export type ProposeDeleteInput = ProcedureInput<typeof PAY_ALLOWLIST_PROPOSE_DELETE>;
/** Turning the mode ON tightens and applies at once. Turning it OFF is a governed change and needs a `clientRef`. */
export type SetModeInput = ProcedureInput<typeof PAY_ALLOWLIST_SET_MODE>;
export type ProposePolicyInput = ProcedureInput<typeof PAY_ALLOWLIST_PROPOSE_POLICY>;
export type ListInput = ProcedureInput<typeof PAY_ALLOWLIST_LIST_ENTRIES>;
export type ListForTeamInput = ProcedureInput<typeof PAY_ALLOWLIST_LIST_FOR_TEAM>;

export const setQuorumInputSchema = z
  .object({ userId: id, teamAccountId: id, requiredApprovals: z.number().int().min(1).max(100) })
  .strict();
export type SetQuorumInput = z.infer<typeof setQuorumInputSchema>;
export const userQueryInputSchema = z.object({ userId: id, limit: limit.optional(), after: id.optional() }).strict();
export const suspendInputSchema = z.object({ entryId: id, reason: z.string().min(1).max(200) }).strict();
export const resumeInputSchema = z.object({ entryId: id }).strict();

export const quorumViewSchema = z.object({
  userId: id,
  teamAccountId: id,
  requiredApprovals: z.number().int(),
  setBy: z.string(),
  setAt: z.string().datetime({ offset: true }),
});
export type QuorumView = z.infer<typeof quorumViewSchema>;

/** What svc-pay builds for each view: the record's input side, so an asset id is a plain string until it is sent. */
export type EntryView = z.input<typeof payAllowlistEntrySchema>;
export type ChangeView = z.input<typeof payAllowlistChangeSchema>;
export type ModeView = z.input<typeof payAllowlistModeSchema>;
export type PolicyView = z.input<typeof payAllowlistPolicySchema>;
export type SetModeResult = z.input<typeof payAllowlistSetModeResultSchema>;
