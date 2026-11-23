import { z } from 'zod';
import { defineProcedure, NO_INPUT, type ProcedureRecord, type Refusals, type RefusalStatus } from './procedure.js';
import {
  campaignCalendarSchema,
  campaignGateSchema,
  campaignGetInputSchema,
  campaignJoinInputSchema,
  campaignJoinResultSchema,
  campaignReviewInputSchema,
  campaignReviewResultSchema,
  campaignVoucherSchema,
  competitionBoardInputSchema,
  competitionBoardSchema,
  distributionRunInputSchema,
  distributionRunSchema,
  drawBoardInputSchema,
  drawBoardSchema,
  earningEvaluateInputSchema,
  earningEvaluationSchema,
  myVoucherSchema,
  myVouchersSchema,
  poolBoardInputSchema,
  poolBoardSchema,
  taskClaimInputSchema,
  taskClaimResultSchema,
  taskProgressInputSchema,
  taskProgressSchema,
  voucherCodeInputSchema,
  voucherIssueInputSchema,
  voucherListInputSchema,
  voucherRedeemInputSchema,
  voucherRedeemResultSchema,
  voucherValidationSchema,
} from './campaigns-catalogue.js';
import {
  distributionPlanInputSchema,
  distributionPlanSchema,
  payoutBoardInputSchema,
  payoutBoardSchema,
} from './campaigns-payout-board.js';
import {
  riskAppealDecideInputSchema,
  riskCaseInputSchema,
  riskCaseSchema,
  riskQueueSchema,
  riskRevokeInputSchema,
  riskWithholdInputSchema,
} from './campaigns-risk.js';
import {
  alertEnableInputSchema,
  codeBatchResultSchema,
  codeBatchSchema,
  codeGenerateInputSchema,
  codeImportInputSchema,
  codePublishInputSchema,
  exportDownloadInputSchema,
  exportFileSchema,
  exportRequestInputSchema,
  exportRequestResultSchema,
  voucherDeactivateInputSchema,
  watchAlertSchema,
  watchCampaignInputSchema,
  watchCampaignSchema,
  watchOverviewSchema,
  watchVoucherSchema,
} from './campaigns-watch.js';
import type { CampaignsRefusalCode } from './campaigns-drops.js';
import type { CampaignRefusalCode } from './campaigns-catalogue.js';

/**
 * svc-campaigns' calls that are mounted from records, one record per call. The service mounts each from here
 * (`mountRecord`), so its path, guard, input, output and named refusals are this file, not its routes. The rest of
 * svc-campaigns' calls move here area by area, each with every caller, so no call has two ways at once.
 *
 * Operator calls (`ops.*`) need `campaigns:ops` and a second factor on the session: the scope is the record's guard, the
 * second factor a live fact of the session the service checks first in the handler (FORBIDDEN, no code).
 */

export type CampaignsCode = CampaignsRefusalCode | CampaignRefusalCode;

/** The status each named refusal is sent with. Every code has one: a code missing here does not compile. */
export const CAMPAIGNS_REFUSAL_STATUS: Readonly<Record<CampaignsCode, RefusalStatus>> = {
  'campaign.unknown': 'NOT_FOUND',
  'campaign.name_taken': 'CONFLICT',
  'campaign.type_unknown': 'BAD_REQUEST',
  'campaign.invalid_transition': 'CONFLICT',
  'campaign.revision_conflict': 'CONFLICT',
  'campaign.not_draft': 'CONFLICT',
  'campaign.not_active': 'CONFLICT',
  'campaign.outside_window': 'CONFLICT',
  'campaign.archive_active': 'CONFLICT',
  'campaign.type_locked': 'CONFLICT',
  'campaigns.rule_depth_unset': 'PRECONDITION_FAILED',
  'campaigns.rule_size_unset': 'PRECONDITION_FAILED',
  'campaigns.rule_too_deep': 'BAD_REQUEST',
  'campaigns.rule_too_large': 'BAD_REQUEST',
  'campaigns.rule_empty_group': 'BAD_REQUEST',
  'campaigns.rule_unknown': 'BAD_REQUEST',
  'campaigns.formula_invalid': 'BAD_REQUEST',
  'campaigns.trigger_unknown': 'BAD_REQUEST',
  'campaigns.earning_rule_name_taken': 'CONFLICT',
  'campaigns.budget_below_drawn': 'CONFLICT',
  'campaigns.budget_unset': 'PRECONDITION_FAILED',
  'campaigns.number_on_wire': 'BAD_REQUEST',
  'campaigns.rules_unset': 'PRECONDITION_FAILED',
  'campaigns.time_frame_unset': 'PRECONDITION_FAILED',
  'campaigns.reward_unset': 'PRECONDITION_FAILED',
  'campaigns.approval_required': 'PRECONDITION_FAILED',
  'campaigns.eligibility_unwired': 'PRECONDITION_FAILED',
  'campaigns.region_list_unset': 'PRECONDITION_FAILED',
  'campaigns.not_eligible': 'FORBIDDEN',
  'campaigns.region_blocked': 'FORBIDDEN',
  'campaigns.participant_unread': 'SERVICE_UNAVAILABLE',
  'campaigns.review_not_needed': 'CONFLICT',
  'campaigns.tasks_invalid': 'BAD_REQUEST',
  'campaigns.claim_window_unset': 'PRECONDITION_FAILED',
  'campaigns.hold_period_unset': 'PRECONDITION_FAILED',
  'campaigns.lock_period_unset': 'PRECONDITION_FAILED',
  'campaigns.bonus_expiry_unset': 'PRECONDITION_FAILED',
  'campaigns.bonus_scope_unset': 'PRECONDITION_FAILED',
  'campaigns.no_tasks': 'NOT_FOUND',
  'campaigns.not_joined': 'PRECONDITION_FAILED',
  'campaigns.tasks_incomplete': 'PRECONDITION_FAILED',
  'campaigns.kyc_required': 'FORBIDDEN',
  'campaigns.claim_expired': 'CONFLICT',
  'campaigns.budget_exhausted': 'CONFLICT',
  'campaigns.budget_asset_mismatch': 'PRECONDITION_FAILED',
  'campaigns.funding_unknown': 'NOT_FOUND',
  'campaigns.funding_reference_taken': 'CONFLICT',
  'campaigns.not_voucher': 'CONFLICT',
  'campaigns.voucher_invalid': 'NOT_FOUND',
  'campaigns.voucher_window_unset': 'PRECONDITION_FAILED',
  'campaigns.voucher_window_invalid': 'BAD_REQUEST',
  'campaigns.voucher_code_taken': 'CONFLICT',
  'campaigns.voucher_expired': 'CONFLICT',
  'campaigns.voucher_not_cash': 'CONFLICT',
  'campaigns.voucher_amount_invalid': 'BAD_REQUEST',
  'campaigns.voucher_exceeds_remaining': 'CONFLICT',
  'campaigns.voucher_sequence_invalid': 'CONFLICT',
  'campaigns.attempt_limit_unset': 'PRECONDITION_FAILED',
  'campaigns.attempt_limit_reached': 'TOO_MANY_REQUESTS',
  'campaigns.per_customer_limit_unset': 'PRECONDITION_FAILED',
  'campaigns.customer_limit_reached': 'CONFLICT',
  'campaigns.redemption_limit_reached': 'CONFLICT',
  'campaigns.welcome_none': 'NOT_FOUND',
  'campaigns.alert_threshold_unset': 'PRECONDITION_FAILED',
  'campaigns.code_batch_limit_unset': 'PRECONDITION_FAILED',
  'campaigns.code_batch_limit_exceeded': 'BAD_REQUEST',
  'campaigns.code_import_duplicate': 'BAD_REQUEST',
  'campaigns.code_batch_unknown': 'NOT_FOUND',
  'campaigns.code_batch_reference_taken': 'CONFLICT',
  'campaigns.voucher_unknown': 'NOT_FOUND',
  'campaigns.voucher_deactivated': 'CONFLICT',
  'campaigns.export_validity_unset': 'PRECONDITION_FAILED',
  'campaigns.export_unknown': 'NOT_FOUND',
  'campaigns.export_not_ready': 'CONFLICT',
  'campaigns.export_expired': 'CONFLICT',
  'campaigns.referral_invalid': 'BAD_REQUEST',
  'campaigns.criteria_unset': 'PRECONDITION_FAILED',
  'campaigns.competition_invalid': 'BAD_REQUEST',
  'campaigns.competition_unset': 'PRECONDITION_FAILED',
  'campaigns.prize_pool_short': 'PRECONDITION_FAILED',
  'campaigns.seats_full': 'CONFLICT',
  'campaigns.not_competition': 'BAD_REQUEST',
  'campaigns.fills_unread': 'SERVICE_UNAVAILABLE',
  'campaigns.draw_invalid': 'BAD_REQUEST',
  'campaigns.draw_unset': 'PRECONDITION_FAILED',
  'campaigns.not_draw': 'BAD_REQUEST',
  'campaigns.distribution_invalid': 'BAD_REQUEST',
  'campaigns.distribution_unset': 'PRECONDITION_FAILED',
  'campaigns.not_distribution': 'BAD_REQUEST',
  'campaigns.snapshot_not_due': 'PRECONDITION_FAILED',
  'campaigns.pool_invalid': 'BAD_REQUEST',
  'campaigns.pool_unset': 'PRECONDITION_FAILED',
  'campaigns.not_pool': 'BAD_REQUEST',
  'campaigns.pool_day_open': 'PRECONDITION_FAILED',
  'campaigns.pool_day_unknown': 'NOT_FOUND',
  'campaigns.equity_unread': 'SERVICE_UNAVAILABLE',
  'campaigns.trial_pass_invalid': 'BAD_REQUEST',
  'campaigns.trial_pass_unset': 'PRECONDITION_FAILED',
  'campaigns.not_trial_pass': 'BAD_REQUEST',
  'campaigns.trial_pass_refused': 'PRECONDITION_FAILED',
  'campaigns.trial_pass_unreachable': 'SERVICE_UNAVAILABLE',
  'owner.decision': 'PRECONDITION_FAILED',
  'campaigns.risk_threshold_unset': 'PRECONDITION_FAILED',
  'campaigns.appeal_window_unset': 'PRECONDITION_FAILED',
  'campaigns.appeal_window_closed': 'CONFLICT',
  'campaigns.appeal_not_open': 'CONFLICT',
  'campaigns.appeal_same_person': 'FORBIDDEN',
  'campaigns.risk_case_unknown': 'NOT_FOUND',
  'campaigns.risk_reward_not_held': 'CONFLICT',
  'campaigns.window_unset': 'PRECONDITION_FAILED',
  'campaigns.timezone_unset': 'BAD_REQUEST',
  'campaigns.timezone_not_platform': 'BAD_REQUEST',
  'campaigns.window_invalid': 'BAD_REQUEST',
  'campaigns.second_person_required': 'FORBIDDEN',
  'campaigns.already_published': 'CONFLICT',
  'campaigns.reward_saga_unwired': 'PRECONDITION_FAILED',
  'campaigns.store_unwired': 'PRECONDITION_FAILED',
  'season.unknown': 'NOT_FOUND',
  'season.not_published': 'PRECONDITION_FAILED',
  'drop.unknown': 'NOT_FOUND',
  'drop.count_unset': 'PRECONDITION_FAILED',
  'drop.count_invalid': 'BAD_REQUEST',
  'drop.not_open': 'CONFLICT',
  'drop.sold_out': 'CONFLICT',
  'launch.schedule_unset': 'PRECONDITION_FAILED',
  'audit.external': 'PRECONDITION_FAILED',
  'chain.go': 'PRECONDITION_FAILED',
};

/** The refusals a call may send, each with the one status `CAMPAIGNS_REFUSAL_STATUS` gives it. */
const refuse = (...codes: readonly CampaignsCode[]): Refusals =>
  Object.freeze(Object.fromEntries(codes.map((code) => [code, CAMPAIGNS_REFUSAL_STATUS[code]])));

const base = { service: 'svc-campaigns', module: 'campaigns', transport: 'trpc' } as const;
const guard = { module: 'campaigns', plane: 'fiat' } as const;
const READ = { caller: 'scope', scope: 'campaigns:read', ...guard } as const;
const WRITE = { caller: 'scope', scope: 'campaigns:write', ...guard } as const;
/** Plus a second factor on the session, which the service checks first. */
const OPS = { caller: 'scope', scope: 'campaigns:ops', ...guard } as const;

/** My vouchers takes nothing, or an empty object. */
const VOUCHERS_MINE_INPUT = z.object({}).strict().optional();

/** Joins for the caller's own account only. A second call returns the first participation. */
export const CAMPAIGNS_PARTICIPATION_JOIN = defineProcedure({
  ...base,
  name: 'campaigns.participation.join',
  kind: 'mutation',
  path: 'participation.join',
  access: WRITE,
  refusals: refuse(
    'campaign.not_active',
    'campaign.outside_window',
    'campaign.revision_conflict',
    'campaign.type_locked',
    'campaign.unknown',
    'campaigns.competition_unset',
    'campaigns.not_eligible',
    'campaigns.participant_unread',
    'campaigns.region_blocked',
    'campaigns.seats_full',
    'campaigns.timezone_unset',
  ),
  input: campaignJoinInputSchema,
  output: campaignJoinResultSchema,
  samples: [
    { verdict: 'accept', input: { campaignId: 'placeholder' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** One eligibility review request for the caller's own account, for a campaign whose rules refuse them. */
export const CAMPAIGNS_PARTICIPATION_REQUEST_REVIEW = defineProcedure({
  ...base,
  name: 'campaigns.participation.requestReview',
  kind: 'mutation',
  path: 'participation.requestReview',
  access: WRITE,
  refusals: refuse(
    'campaign.not_active',
    'campaign.unknown',
    'campaigns.not_eligible',
    'campaigns.participant_unread',
    'campaigns.region_blocked',
    'campaigns.review_not_needed',
    'campaigns.timezone_unset',
  ),
  input: campaignReviewInputSchema,
  output: campaignReviewResultSchema,
  samples: [
    { verdict: 'accept', input: { campaignId: 'placeholder' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** One competition's board: terms, seats left, the leaderboard by venue volume, the caller's own entry and milestones, and the settlement once the period closed. */
export const CAMPAIGNS_COMPETITION_BOARD = defineProcedure({
  ...base,
  name: 'campaigns.competition.board',
  kind: 'query',
  path: 'competition.board',
  access: READ,
  refusals: refuse(
    'campaign.unknown',
    'campaigns.budget_exhausted',
    'campaigns.competition_unset',
    'campaigns.fills_unread',
    'campaigns.not_competition',
    'campaigns.participant_unread',
    'campaigns.risk_threshold_unset',
    'campaigns.store_unwired',
  ),
  input: competitionBoardInputSchema,
  output: competitionBoardSchema,
  samples: [
    { verdict: 'accept', input: { campaignId: 'placeholder' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** One draw's board: odds, prize table, the caller's own chances and the cap for their user type, the seed's commitment and the entry list's hash, and why the draw does not run. */
export const CAMPAIGNS_DRAW_BOARD = defineProcedure({
  ...base,
  name: 'campaigns.draw.board',
  kind: 'query',
  path: 'draw.board',
  access: READ,
  refusals: refuse(
    'campaign.unknown',
    'campaigns.draw_unset',
    'campaigns.fills_unread',
    'campaigns.not_draw',
    'campaigns.participant_unread',
    'campaigns.store_unwired',
    'owner.decision',
  ),
  input: drawBoardInputSchema,
  output: drawBoardSchema,
  samples: [
    { verdict: 'accept', input: { campaignId: 'placeholder' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** One reward pool's board: its terms, each day with the caller's share once settled, and today with the caller's venue balance read now. */
export const CAMPAIGNS_POOL_BOARD = defineProcedure({
  ...base,
  name: 'campaigns.pool.board',
  kind: 'query',
  path: 'pool.board',
  access: READ,
  refusals: refuse('campaign.unknown', 'campaigns.equity_unread', 'campaigns.not_pool', 'campaigns.pool_unset', 'campaigns.store_unwired'),
  input: poolBoardInputSchema,
  output: poolBoardSchema,
  samples: [
    { verdict: 'accept', input: { campaignId: 'placeholder' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** The caller's own progress on one task campaign, its claim window and its reward record with the redemption log. */
export const CAMPAIGNS_TASKS_PROGRESS = defineProcedure({
  ...base,
  name: 'campaigns.tasks.progress',
  kind: 'query',
  path: 'tasks.progress',
  access: READ,
  refusals: refuse(
    'campaign.revision_conflict',
    'campaign.unknown',
    'campaigns.budget_exhausted',
    'campaigns.competition_unset',
    'campaigns.equity_unread',
    'campaigns.fills_unread',
    'campaigns.no_tasks',
    'campaigns.not_competition',
    'campaigns.not_pool',
    'campaigns.participant_unread',
    'campaigns.pool_day_open',
    'campaigns.pool_day_unknown',
    'campaigns.pool_unset',
    'campaigns.risk_threshold_unset',
    'campaigns.timezone_unset',
  ),
  input: taskProgressInputSchema,
  output: taskProgressSchema,
  samples: [
    { verdict: 'accept', input: { campaignId: 'placeholder' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Claims for the caller's own account only. A second call returns the first claim's reward. */
export const CAMPAIGNS_TASKS_CLAIM = defineProcedure({
  ...base,
  name: 'campaigns.tasks.claim',
  kind: 'mutation',
  path: 'tasks.claim',
  access: WRITE,
  refusals: refuse(
    'campaign.revision_conflict',
    'campaign.unknown',
    'campaigns.bonus_expiry_unset',
    'campaigns.bonus_scope_unset',
    'campaigns.budget_asset_mismatch',
    'campaigns.budget_exhausted',
    'campaigns.claim_expired',
    'campaigns.claim_window_unset',
    'campaigns.competition_unset',
    'campaigns.customer_limit_reached',
    'campaigns.equity_unread',
    'campaigns.fills_unread',
    'campaigns.hold_period_unset',
    'campaigns.kyc_required',
    'campaigns.lock_period_unset',
    'campaigns.no_tasks',
    'campaigns.not_competition',
    'campaigns.not_joined',
    'campaigns.not_pool',
    'campaigns.participant_unread',
    'campaigns.per_customer_limit_unset',
    'campaigns.pool_day_open',
    'campaigns.pool_day_unknown',
    'campaigns.pool_unset',
    'campaigns.redemption_limit_reached',
    'campaigns.reward_saga_unwired',
    'campaigns.reward_unset',
    'campaigns.risk_threshold_unset',
    'campaigns.tasks_incomplete',
  ),
  input: taskClaimInputSchema,
  output: taskClaimResultSchema,
  samples: [
    { verdict: 'accept', input: { campaignId: 'placeholder' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** My vouchers: the caller's own, newest claim first, with what is left and every redemption. */
export const CAMPAIGNS_VOUCHERS_MINE = defineProcedure({
  ...base,
  name: 'campaigns.vouchers.mine',
  kind: 'query',
  path: 'vouchers.mine',
  access: READ,
  refusals: refuse(),
  input: VOUCHERS_MINE_INPUT,
  output: myVouchersSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 7 },
  ],
});

/** What a code would give the caller; changes nothing. A code the caller may not claim is the generic refusal. */
export const CAMPAIGNS_VOUCHERS_VALIDATE = defineProcedure({
  ...base,
  name: 'campaigns.vouchers.validate',
  kind: 'query',
  path: 'vouchers.validate',
  access: READ,
  refusals: refuse(
    'campaigns.attempt_limit_reached',
    'campaigns.attempt_limit_unset',
    'campaigns.not_eligible',
    'campaigns.participant_unread',
    'campaigns.region_blocked',
    'campaigns.voucher_invalid',
    'campaigns.voucher_window_unset',
  ),
  input: voucherCodeInputSchema,
  output: voucherValidationSchema,
  samples: [
    { verdict: 'accept', input: { code: 'USDC' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Claims a code for the caller's own account only. */
export const CAMPAIGNS_VOUCHERS_CLAIM = defineProcedure({
  ...base,
  name: 'campaigns.vouchers.claim',
  kind: 'mutation',
  path: 'vouchers.claim',
  access: WRITE,
  refusals: refuse(
    'campaigns.attempt_limit_reached',
    'campaigns.attempt_limit_unset',
    'campaigns.not_eligible',
    'campaigns.participant_unread',
    'campaigns.region_blocked',
    'campaigns.voucher_invalid',
    'campaigns.voucher_window_unset',
  ),
  input: voucherCodeInputSchema,
  output: myVoucherSchema,
  samples: [
    { verdict: 'accept', input: { code: 'USDC' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** The n-th redemption of the caller's own voucher; the same one again returns the first. */
export const CAMPAIGNS_VOUCHERS_REDEEM = defineProcedure({
  ...base,
  name: 'campaigns.vouchers.redeem',
  kind: 'mutation',
  path: 'vouchers.redeem',
  access: WRITE,
  refusals: refuse(
    'campaign.not_active',
    'campaign.unknown',
    'campaigns.budget_asset_mismatch',
    'campaigns.budget_exhausted',
    'campaigns.budget_unset',
    'campaigns.customer_limit_reached',
    'campaigns.not_eligible',
    'campaigns.participant_unread',
    'campaigns.per_customer_limit_unset',
    'campaigns.redemption_limit_reached',
    'campaigns.region_blocked',
    'campaigns.reward_saga_unwired',
    'campaigns.risk_threshold_unset',
    'campaigns.voucher_amount_invalid',
    'campaigns.voucher_deactivated',
    'campaigns.voucher_exceeds_remaining',
    'campaigns.voucher_expired',
    'campaigns.voucher_invalid',
    'campaigns.voucher_not_cash',
    'campaigns.voucher_sequence_invalid',
  ),
  input: voucherRedeemInputSchema,
  output: voucherRedeemResultSchema,
  samples: [
    { verdict: 'accept', input: { voucherId: 'placeholder', amount: 'placeholder', sequence: 1 } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Every campaign on the calendar, in the platform time zone. */
export const CAMPAIGNS_OPS_CAMPAIGNS_CALENDAR = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.calendar',
  kind: 'query',
  path: 'ops.campaigns.calendar',
  access: OPS,
  refusals: refuse(),
  input: NO_INPUT,
  output: campaignCalendarSchema,
  samples: [{ verdict: 'accept' }],
});

/** The activation gate's answer for the campaign's stored revision. */
export const CAMPAIGNS_OPS_CAMPAIGNS_VALIDATE = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.validate',
  kind: 'query',
  path: 'ops.campaigns.validate',
  access: OPS,
  refusals: refuse(
    'campaign.type_unknown',
    'campaign.unknown',
    'campaigns.bonus_expiry_unset',
    'campaigns.bonus_scope_unset',
    'campaigns.budget_asset_mismatch',
    'campaigns.budget_unset',
    'campaigns.claim_window_unset',
    'campaigns.competition_invalid',
    'campaigns.competition_unset',
    'campaigns.criteria_unset',
    'campaigns.distribution_invalid',
    'campaigns.distribution_unset',
    'campaigns.draw_invalid',
    'campaigns.draw_unset',
    'campaigns.earning_rule_name_taken',
    'campaigns.eligibility_unwired',
    'campaigns.formula_invalid',
    'campaigns.hold_period_unset',
    'campaigns.lock_period_unset',
    'campaigns.no_tasks',
    'campaigns.number_on_wire',
    'campaigns.per_customer_limit_unset',
    'campaigns.pool_invalid',
    'campaigns.pool_unset',
    'campaigns.prize_pool_short',
    'campaigns.referral_invalid',
    'campaigns.region_list_unset',
    'campaigns.reward_unset',
    'campaigns.rules_unset',
    'campaigns.tasks_invalid',
    'campaigns.time_frame_unset',
    'campaigns.timezone_not_platform',
    'campaigns.timezone_unset',
    'campaigns.trial_pass_invalid',
    'campaigns.trial_pass_unset',
    'campaigns.trigger_unknown',
    'campaigns.voucher_window_invalid',
    'campaigns.window_invalid',
    'campaigns.window_unset',
    'owner.decision',
  ),
  input: campaignGetInputSchema,
  output: campaignGateSchema,
  samples: [
    { verdict: 'accept', input: { id: 'placeholder' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Each earning rule's answer to one TEST event; writes nothing. A points rule refuses for itself only. */
export const CAMPAIGNS_OPS_CAMPAIGNS_EARNING_EVALUATE = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.earning.evaluate',
  kind: 'query',
  path: 'ops.campaigns.earning.evaluate',
  access: OPS,
  refusals: refuse(
    'campaign.unknown',
    'campaigns.earning_rule_name_taken',
    'campaigns.formula_invalid',
    'campaigns.trigger_unknown',
    'owner.decision',
  ),
  input: earningEvaluateInputSchema,
  output: earningEvaluationSchema,
  samples: [
    { verdict: 'accept', input: { id: 'placeholder', trigger: 'placeholder', values: {} } },
    { verdict: 'refuse', input: {} },
  ],
});

/** A voucher campaign's vouchers, each with the revision and face value it was issued under. */
export const CAMPAIGNS_OPS_CAMPAIGNS_VOUCHERS_LIST = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.vouchers.list',
  kind: 'query',
  path: 'ops.campaigns.vouchers.list',
  access: OPS,
  refusals: refuse('campaign.unknown'),
  input: voucherListInputSchema,
  output: z.array(campaignVoucherSchema),
  samples: [
    { verdict: 'accept', input: { campaignId: 'placeholder' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Publishes one voucher under the live revision; the same code again returns it. */
export const CAMPAIGNS_OPS_CAMPAIGNS_VOUCHERS_ISSUE = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.vouchers.issue',
  kind: 'mutation',
  path: 'ops.campaigns.vouchers.issue',
  access: OPS,
  refusals: refuse(
    'campaign.invalid_transition',
    'campaign.unknown',
    'campaigns.not_competition',
    'campaigns.not_distribution',
    'campaigns.not_draw',
    'campaigns.not_pool',
    'campaigns.not_voucher',
    'campaigns.reward_unset',
    'campaigns.voucher_code_taken',
    'owner.decision',
  ),
  input: voucherIssueInputSchema,
  output: campaignVoucherSchema,
  samples: [
    { verdict: 'accept', input: { campaignId: 'placeholder', code: 'USDC' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Deactivates one voucher: its claim and every later use refuse. */
export const CAMPAIGNS_OPS_CAMPAIGNS_VOUCHERS_DEACTIVATE = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.vouchers.deactivate',
  kind: 'mutation',
  path: 'ops.campaigns.vouchers.deactivate',
  access: OPS,
  refusals: refuse('campaign.invalid_transition', 'campaigns.voucher_unknown'),
  input: voucherDeactivateInputSchema,
  output: watchVoucherSchema,
  samples: [
    { verdict: 'accept', input: { voucherId: 'placeholder' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** The payout board: every intent by where it stands (owed, pending funding, sending, paid, failed, other), with its keys, its ledger transactions and its one payment's chain transaction. Read only. */
export const CAMPAIGNS_OPS_PAYOUTS_BOARD = defineProcedure({
  ...base,
  name: 'campaigns.ops.payouts.board',
  kind: 'query',
  path: 'ops.payouts.board',
  access: OPS,
  refusals: refuse(
    'campaign.unknown',
    'campaigns.budget_exhausted',
    'campaigns.competition_unset',
    'campaigns.draw_unset',
    'campaigns.equity_unread',
    'campaigns.fills_unread',
    'campaigns.not_competition',
    'campaigns.not_draw',
    'campaigns.not_pool',
    'campaigns.participant_unread',
    'campaigns.pool_unset',
    'campaigns.risk_threshold_unset',
    'owner.decision',
  ),
  input: payoutBoardInputSchema,
  output: payoutBoardSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 7 },
  ],
});

/** An airdrop's plan, account by account: the run as it stands. Read only. */
export const CAMPAIGNS_OPS_CAMPAIGNS_DISTRIBUTION_PLAN = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.distribution.plan',
  kind: 'query',
  path: 'ops.campaigns.distribution.plan',
  access: OPS,
  refusals: refuse(
    'campaign.unknown',
    'campaigns.equity_unread',
    'campaigns.not_distribution',
    'campaigns.store_unwired',
    'owner.decision',
  ),
  input: distributionPlanInputSchema,
  output: distributionPlanSchema,
  samples: [
    { verdict: 'accept', input: { campaignId: 'placeholder' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** An airdrop's snapshot: taken now if it is due, or resumed where it stopped; run again it returns the run as it stands and owes nothing twice. The operator and their reason are audited. */
export const CAMPAIGNS_OPS_CAMPAIGNS_DISTRIBUTION_RUN = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.distribution.run',
  kind: 'mutation',
  path: 'ops.campaigns.distribution.run',
  access: OPS,
  refusals: refuse(
    'campaign.unknown',
    'campaigns.budget_exhausted',
    'campaigns.distribution_invalid',
    'campaigns.distribution_unset',
    'campaigns.equity_unread',
    'campaigns.not_distribution',
    'campaigns.participant_unread',
    'campaigns.risk_threshold_unset',
    'campaigns.snapshot_not_due',
    'campaigns.store_unwired',
    'owner.decision',
  ),
  input: distributionRunInputSchema,
  output: distributionRunSchema,
  samples: [
    { verdict: 'accept', input: { campaignId: 'placeholder', reason: 'placeholder' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** The risk review queue. */
export const CAMPAIGNS_OPS_RISK_QUEUE = defineProcedure({
  ...base,
  name: 'campaigns.ops.risk.queue',
  kind: 'query',
  path: 'ops.risk.queue',
  access: OPS,
  refusals: refuse('campaigns.store_unwired'),
  input: NO_INPUT,
  output: riskQueueSchema,
  samples: [{ verdict: 'accept' }],
});

/** One account's risk case. */
export const CAMPAIGNS_OPS_RISK_CASE = defineProcedure({
  ...base,
  name: 'campaigns.ops.risk.case',
  kind: 'query',
  path: 'ops.risk.case',
  access: OPS,
  refusals: refuse('campaigns.risk_case_unknown', 'campaigns.store_unwired'),
  input: riskCaseInputSchema,
  output: riskCaseSchema,
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Withholds one held reward; the operator is recorded from their own token. */
export const CAMPAIGNS_OPS_RISK_WITHHOLD = defineProcedure({
  ...base,
  name: 'campaigns.ops.risk.withhold',
  kind: 'mutation',
  path: 'ops.risk.withhold',
  access: OPS,
  refusals: refuse('campaigns.risk_case_unknown', 'campaigns.risk_reward_not_held', 'campaigns.store_unwired'),
  input: riskWithholdInputSchema,
  output: riskCaseSchema,
  samples: [
    { verdict: 'accept', input: { rewardKey: 'placeholder', reason: 'placeholder' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Revokes an account's rewards; the operator is recorded from their own token. */
export const CAMPAIGNS_OPS_RISK_REVOKE = defineProcedure({
  ...base,
  name: 'campaigns.ops.risk.revoke',
  kind: 'mutation',
  path: 'ops.risk.revoke',
  access: OPS,
  refusals: refuse(
    'campaigns.appeal_window_unset',
    'campaigns.reward_saga_unwired',
    'campaigns.risk_case_unknown',
    'campaigns.store_unwired',
  ),
  input: riskRevokeInputSchema,
  output: riskCaseSchema,
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222', reason: 'placeholder' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** The appeal's decision, by a second person. */
export const CAMPAIGNS_OPS_RISK_DECIDE_APPEAL = defineProcedure({
  ...base,
  name: 'campaigns.ops.risk.decideAppeal',
  kind: 'mutation',
  path: 'ops.risk.decideAppeal',
  access: OPS,
  refusals: refuse(
    'campaign.unknown',
    'campaigns.appeal_not_open',
    'campaigns.appeal_same_person',
    'campaigns.participant_unread',
    'campaigns.risk_case_unknown',
    'campaigns.risk_threshold_unset',
    'campaigns.store_unwired',
  ),
  input: riskAppealDecideInputSchema,
  output: riskCaseSchema,
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222', outcome: 'upheld', reason: 'placeholder' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** The watch desk, counted from the rows on each read. */
export const CAMPAIGNS_OPS_CAMPAIGNS_WATCH_OVERVIEW = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.watch.overview',
  kind: 'query',
  path: 'ops.campaigns.watch.overview',
  access: OPS,
  refusals: refuse(),
  input: NO_INPUT,
  output: watchOverviewSchema,
  samples: [{ verdict: 'accept' }],
});

/** One campaign on the watch desk, counted from its rows. */
export const CAMPAIGNS_OPS_CAMPAIGNS_WATCH_CAMPAIGN = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.watch.campaign',
  kind: 'query',
  path: 'ops.campaigns.watch.campaign',
  access: OPS,
  refusals: refuse('campaign.unknown'),
  input: watchCampaignInputSchema,
  output: watchCampaignSchema,
  samples: [
    { verdict: 'accept', input: { id: 'placeholder' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Switches an alert on or off; on refuses while its owner threshold is blank. */
export const CAMPAIGNS_OPS_CAMPAIGNS_WATCH_ALERT = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.watch.alert',
  kind: 'mutation',
  path: 'ops.campaigns.watch.alert',
  access: OPS,
  refusals: refuse('campaigns.alert_threshold_unset'),
  input: alertEnableInputSchema,
  output: watchAlertSchema,
  samples: [
    { verdict: 'accept', input: { kind: 'budget_low', enabled: true } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Makes a batch and returns its plain codes in this answer only; the same reference again returns none. Stored as hashes and last four characters only. */
export const CAMPAIGNS_OPS_CAMPAIGNS_CODES_GENERATE = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.codes.generate',
  kind: 'mutation',
  path: 'ops.campaigns.codes.generate',
  access: OPS,
  refusals: refuse(
    'campaign.invalid_transition',
    'campaign.unknown',
    'campaigns.code_batch_limit_exceeded',
    'campaigns.code_batch_limit_unset',
    'campaigns.code_batch_reference_taken',
    'campaigns.not_competition',
    'campaigns.not_distribution',
    'campaigns.not_draw',
    'campaigns.not_pool',
    'campaigns.not_voucher',
    'campaigns.reward_unset',
    'owner.decision',
  ),
  input: codeGenerateInputSchema,
  output: codeBatchResultSchema,
  samples: [
    { verdict: 'accept', input: { campaignId: 'placeholder', reference: '1.50', count: 1 } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Imports a batch of codes; stored as hashes and last four characters only. */
export const CAMPAIGNS_OPS_CAMPAIGNS_CODES_IMPORT = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.codes.import',
  kind: 'mutation',
  path: 'ops.campaigns.codes.import',
  access: OPS,
  refusals: refuse(
    'campaign.invalid_transition',
    'campaign.unknown',
    'campaigns.code_batch_limit_exceeded',
    'campaigns.code_batch_limit_unset',
    'campaigns.code_batch_reference_taken',
    'campaigns.code_import_duplicate',
    'campaigns.not_competition',
    'campaigns.not_distribution',
    'campaigns.not_draw',
    'campaigns.not_pool',
    'campaigns.not_voucher',
    'campaigns.reward_unset',
    'campaigns.voucher_code_taken',
    'owner.decision',
  ),
  input: codeImportInputSchema,
  output: codeBatchResultSchema,
  samples: [
    { verdict: 'accept', input: { campaignId: 'placeholder', reference: '1.50', codes: ['USDC'] } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Publishes a batch. */
export const CAMPAIGNS_OPS_CAMPAIGNS_CODES_PUBLISH = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.codes.publish',
  kind: 'mutation',
  path: 'ops.campaigns.codes.publish',
  access: OPS,
  refusals: refuse('campaigns.code_batch_unknown'),
  input: codePublishInputSchema,
  output: codeBatchSchema,
  samples: [
    { verdict: 'accept', input: { batchId: 'placeholder' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** One export job per export while it is open or its link valid. */
export const CAMPAIGNS_OPS_CAMPAIGNS_EXPORTS_REQUEST = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.exports.request',
  kind: 'mutation',
  path: 'ops.campaigns.exports.request',
  access: OPS,
  refusals: refuse('campaign.unknown', 'campaigns.export_validity_unset'),
  input: exportRequestInputSchema,
  output: exportRequestResultSchema,
  checks: {
    fieldsOnce: { at: 'input.fields', says: 'each field is named once' },
    fieldsCarried: { at: 'input', says: 'every field is one the dataset carries (EXPORT_FIELDS)' },
  },
  samples: [
    { verdict: 'accept', input: { campaignId: 'cmp_1', dataset: 'participants', fields: ['accountId', 'joinedAt'] } },
    { verdict: 'refuse', input: {} },
    { verdict: 'refuse', input: { campaignId: 'cmp_1', dataset: 'participants', fields: ['accountId', 'accountId'] }, by: 'fieldsOnce' },
    { verdict: 'refuse', input: { campaignId: 'cmp_1', dataset: 'participants', fields: ['asset'] }, by: 'fieldsCarried' },
  ],
});

/** An export's file, while its link is valid. */
export const CAMPAIGNS_OPS_CAMPAIGNS_EXPORTS_DOWNLOAD = defineProcedure({
  ...base,
  name: 'campaigns.ops.campaigns.exports.download',
  kind: 'query',
  path: 'ops.campaigns.exports.download',
  access: OPS,
  refusals: refuse('campaigns.export_expired', 'campaigns.export_not_ready', 'campaigns.export_unknown'),
  input: exportDownloadInputSchema,
  output: exportFileSchema,
  samples: [
    { verdict: 'accept', input: { id: 'placeholder' } },
    { verdict: 'refuse', input: {} },
  ],
});

export const CAMPAIGNS_PROCEDURES = [
  CAMPAIGNS_PARTICIPATION_JOIN,
  CAMPAIGNS_PARTICIPATION_REQUEST_REVIEW,
  CAMPAIGNS_COMPETITION_BOARD,
  CAMPAIGNS_DRAW_BOARD,
  CAMPAIGNS_POOL_BOARD,
  CAMPAIGNS_TASKS_PROGRESS,
  CAMPAIGNS_TASKS_CLAIM,
  CAMPAIGNS_VOUCHERS_MINE,
  CAMPAIGNS_VOUCHERS_VALIDATE,
  CAMPAIGNS_VOUCHERS_CLAIM,
  CAMPAIGNS_VOUCHERS_REDEEM,
  CAMPAIGNS_OPS_CAMPAIGNS_CALENDAR,
  CAMPAIGNS_OPS_CAMPAIGNS_VALIDATE,
  CAMPAIGNS_OPS_CAMPAIGNS_EARNING_EVALUATE,
  CAMPAIGNS_OPS_CAMPAIGNS_VOUCHERS_LIST,
  CAMPAIGNS_OPS_CAMPAIGNS_VOUCHERS_ISSUE,
  CAMPAIGNS_OPS_CAMPAIGNS_VOUCHERS_DEACTIVATE,
  CAMPAIGNS_OPS_PAYOUTS_BOARD,
  CAMPAIGNS_OPS_CAMPAIGNS_DISTRIBUTION_PLAN,
  CAMPAIGNS_OPS_CAMPAIGNS_DISTRIBUTION_RUN,
  CAMPAIGNS_OPS_RISK_QUEUE,
  CAMPAIGNS_OPS_RISK_CASE,
  CAMPAIGNS_OPS_RISK_WITHHOLD,
  CAMPAIGNS_OPS_RISK_REVOKE,
  CAMPAIGNS_OPS_RISK_DECIDE_APPEAL,
  CAMPAIGNS_OPS_CAMPAIGNS_WATCH_OVERVIEW,
  CAMPAIGNS_OPS_CAMPAIGNS_WATCH_CAMPAIGN,
  CAMPAIGNS_OPS_CAMPAIGNS_WATCH_ALERT,
  CAMPAIGNS_OPS_CAMPAIGNS_CODES_GENERATE,
  CAMPAIGNS_OPS_CAMPAIGNS_CODES_IMPORT,
  CAMPAIGNS_OPS_CAMPAIGNS_CODES_PUBLISH,
  CAMPAIGNS_OPS_CAMPAIGNS_EXPORTS_REQUEST,
  CAMPAIGNS_OPS_CAMPAIGNS_EXPORTS_DOWNLOAD,
] as const satisfies readonly ProcedureRecord[];
