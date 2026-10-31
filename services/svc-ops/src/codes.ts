import {
  OPS_ALERT_NOT_FOUND,
  OPS_ALERT_NOTE_REQUIRED,
  OPS_ALERT_REPEAT_UNSET,
  OPS_ALERT_SNOOZE_END_INVALID,
  OPS_ALERT_SOURCE_UNAVAILABLE,
  OPS_ALERT_STATE_ILLEGAL,
  OPS_RESOLVE_LEDGER_UNAVAILABLE,
  OPS_RESOLVE_NOTE_REQUIRED,
  OPS_RESOLVE_TRANSACTION_NOT_FOUND,
} from '@intafaced/contracts/ops-reconciliation-alerts';
import {
  COMPLIANCE_CASE_NOT_FOUND,
  COMPLIANCE_CASES_LIST_LIMIT_UNSET,
  COMPLIANCE_INBOX_FORBIDDEN,
  COMPLIANCE_QUEUE_ENTITY_UNKNOWN,
  COMPLIANCE_QUEUE_NAME_TAKEN,
  OPS_ALERT_FORBIDDEN,
  OPS_ALERT_HISTORY_RETENTION_UNSET,
  OPS_ALERT_INTERVAL_UNSET,
  OPS_ALERT_LABELS_DUPLICATE,
  OPS_ALERT_SIGNAL_UNKNOWN,
  OPS_ALERT_THRESHOLD_UNSET,
  OPS_COST_AMOUNT_INVALID,
  OPS_COST_CATEGORY_INVALID,
  OPS_COST_PERIOD_INVALID,
  OPS_COST_STORAGE_UNCONFIGURED,
  OPS_RESTORE_STEP_OUT_OF_ORDER,
  OPS_RESTORE_TARGET_UNSET,
  OPS_RESTORE_WATERMARKS_DISAGREE,
  CONSOLE_MODE_STORAGE_UNCONFIGURED,
  ANNOUNCEMENT_NOT_FOUND,
  ANNOUNCEMENT_STORAGE_UNCONFIGURED,
  ANNOUNCEMENT_WITHDRAWN,
  BANNER_CONFLICT,
  BANNER_WINDOW_INVALID,
  PREFERENCE_INVALID,
  PREFERENCES_STORAGE_UNCONFIGURED,
  PREFERENCES_TEAM_UNASSIGNED,
  PREFERENCES_STALE,
  SERVICE_NOT_FOUND,
  SERVICE_RECORD_INVALID,
  SERVICE_RECORD_STALE,
  SERVICE_STORAGE_UNCONFIGURED,
  STAFF_HOLD_STORAGE_UNCONFIGURED,
  STAFF_HOLD_LEDGER_UNCONFIGURED,
  STAFF_HOLD_STATE_ILLEGAL,
  STAFF_HOLD_AMOUNT_EXCEEDS_REMAINING,
  STAFF_HOLD_EXPIRY_UNSET,
  STAFF_HOLD_EXPIRY_TOO_LONG,
  STAFF_HOLD_CONFIRM_ACCOUNT_UNSET,
  STAFF_HOLD_NOT_FOUND,
} from '@intafaced/contracts';

export {
  STAFF_HOLD_STORAGE_UNCONFIGURED,
  STAFF_HOLD_LEDGER_UNCONFIGURED,
  STAFF_HOLD_STATE_ILLEGAL,
  STAFF_HOLD_AMOUNT_EXCEEDS_REMAINING,
  STAFF_HOLD_EXPIRY_UNSET,
  STAFF_HOLD_EXPIRY_TOO_LONG,
  STAFF_HOLD_CONFIRM_ACCOUNT_UNSET,
  STAFF_HOLD_NOT_FOUND,
  CONSOLE_MODE_STORAGE_UNCONFIGURED,
  SERVICE_NOT_FOUND,
  SERVICE_RECORD_INVALID,
  SERVICE_RECORD_STALE,
  SERVICE_STORAGE_UNCONFIGURED,
  PREFERENCES_STALE,
  ANNOUNCEMENT_NOT_FOUND,
  ANNOUNCEMENT_STORAGE_UNCONFIGURED,
  ANNOUNCEMENT_WITHDRAWN,
  BANNER_CONFLICT,
  BANNER_WINDOW_INVALID,
  PREFERENCE_INVALID,
  PREFERENCES_STORAGE_UNCONFIGURED,
  PREFERENCES_TEAM_UNASSIGNED,
  OPS_RESTORE_STEP_OUT_OF_ORDER,
  OPS_RESTORE_TARGET_UNSET,
  OPS_RESTORE_WATERMARKS_DISAGREE,
  COMPLIANCE_CASE_NOT_FOUND,
  COMPLIANCE_CASES_LIST_LIMIT_UNSET,
  COMPLIANCE_INBOX_FORBIDDEN,
  COMPLIANCE_QUEUE_ENTITY_UNKNOWN,
  COMPLIANCE_QUEUE_NAME_TAKEN,
  OPS_ALERT_FORBIDDEN,
  OPS_ALERT_HISTORY_RETENTION_UNSET,
  OPS_ALERT_INTERVAL_UNSET,
  OPS_ALERT_LABELS_DUPLICATE,
  OPS_ALERT_SIGNAL_UNKNOWN,
  OPS_ALERT_THRESHOLD_UNSET,
  OPS_COST_AMOUNT_INVALID,
  OPS_COST_CATEGORY_INVALID,
  OPS_COST_PERIOD_INVALID,
  OPS_COST_STORAGE_UNCONFIGURED,
};

import {
  OPS_ALERT_CHANNEL_KEY_UNSET,
  OPS_ALERT_DEFAULT_CONTACT_UNSET,
  OPS_ALERT_ROUTE_INVALID,
  OPS_ALERT_ROUTE_UNSET,
  OPS_ALERT_ROUTE_VERSION_STALE,
  OPS_CHANNEL_AUTH_CONFLICT,
  OPS_CHANNEL_DELIVERY_FAILED,
  OPS_CHANNEL_SECRET_UNSET,
  OPS_CHANNEL_TARGET_UNSET,
  OPS_CONTACT_POINT_IN_USE,
  OPS_CONTACT_POINT_NOT_FOUND,
  OPS_CONTACT_VERSION_STALE,
  OPS_GROUP_TIMING_UNSET,
  OPS_FLAP_SUPPRESSION_UNSET,
  OPS_MUTE_TIMING_UNSET,
  OPS_ACTIVE_TIME_UNSET,
  OPS_MATCHER_INVALID,
  OPS_SILENCE_END_UNSET,
  OPS_SILENCE_ID_TAKEN,
  OPS_SILENCE_NOT_FOUND,
} from '@intafaced/contracts';

export {
  OPS_ALERT_CHANNEL_KEY_UNSET,
  OPS_ALERT_DEFAULT_CONTACT_UNSET,
  OPS_ALERT_ROUTE_INVALID,
  OPS_ALERT_ROUTE_UNSET,
  OPS_ALERT_ROUTE_VERSION_STALE,
  OPS_CHANNEL_AUTH_CONFLICT,
  OPS_CHANNEL_DELIVERY_FAILED,
  OPS_CHANNEL_SECRET_UNSET,
  OPS_CHANNEL_TARGET_UNSET,
  OPS_CONTACT_POINT_IN_USE,
  OPS_CONTACT_POINT_NOT_FOUND,
  OPS_CONTACT_VERSION_STALE,
  OPS_GROUP_TIMING_UNSET,
  OPS_FLAP_SUPPRESSION_UNSET,
  OPS_MUTE_TIMING_UNSET,
  OPS_ACTIVE_TIME_UNSET,
  OPS_MATCHER_INVALID,
  OPS_SILENCE_END_UNSET,
  OPS_SILENCE_ID_TAKEN,
  OPS_SILENCE_NOT_FOUND,
};

/** Not in the spec's list: the case store has no database, or the inbox a case names does not exist. */
export const OPS_COMPLIANCE_STORAGE_UNCONFIGURED = 'ops.compliance_storage_unconfigured' as const;
/** An open of an id that already belongs to a case in another inbox. */
export const COMPLIANCE_CASE_ALREADY_OPEN = 'compliance.case_already_open' as const;
export const COMPLIANCE_INBOX_NOT_FOUND = 'compliance.inbox_not_found' as const;

/** The ledger's fee revenue read for the venue report could not be asked or did not answer cleanly. */
export const OPS_FEE_REVENUE_UNCONFIGURED = 'ops.fee_revenue_unconfigured' as const;
export const OPS_FEE_REVENUE_UNAVAILABLE = 'ops.fee_revenue_unavailable' as const;

/** Machine-readable refuses. The code leads the tRPC message so IxState can quote it. */
export const OPS_WAREHOUSE_UNWIRED = 'ops.warehouse_unwired' as const;
export const OPS_WAREHOUSE_LAG_UNKNOWN = 'ops.warehouse_lag_unknown' as const;
export const OPS_WAREHOUSE_LAG_STALE = 'ops.warehouse_lag_stale' as const;
export const OPS_PAYROLL_INVENT_FORBIDDEN = 'ops.payroll_invent_forbidden' as const;
export const OPS_IDENTITY_UNWIRED = 'ops.identity_unwired' as const;
export const OPS_SUPPORT_UNWIRED = 'ops.support_unwired' as const;
export const OPS_CONTACT_REQUIRED = 'ops.contact_required' as const;
export const OPS_PROJECT_REQUIRED = 'ops.project_required' as const;
export const OPS_TEAM_HANDLE_REQUIRED = 'ops.team_handle_required' as const;
export const OPS_RAISE_NAME_REQUIRED = 'ops.raise_name_required' as const;
export const OPS_FUNDRAISING_AMOUNT_INVALID = 'ops.fundraising_amount_invalid' as const;
export const OPS_FUNDRAISING_CHAIN_UNWIRED = 'ops.fundraising_chain_unwired' as const;
export const OPS_STRUCTURED_OWNER_PRICE_REQUIRED = 'ops.structured_owner_price_required' as const;
export const OPS_STRUCTURED_PRICE_FORBIDDEN = 'ops.structured_price_forbidden' as const;
export const OPS_CUSTODY_WRAP_UNSET = 'ops.custody_wrap_unset' as const;
export const OPS_CUSTODY_CHAIN_UNWIRED = 'ops.custody_chain_unwired' as const;
export const OPS_CUSTODY_KEYS_FORBIDDEN = 'ops.custody_keys_forbidden' as const;
export const OPS_CUSTODY_TIER_REQUIRED = 'ops.custody_tier_required' as const;
export const OPS_CUSTODY_AMOUNT_INVALID = 'ops.custody_amount_invalid' as const;
export const OPS_CUSTODY_FREEZE_UNSET = 'ops.custody_freeze_unset' as const;
export const OPS_CUSTODY_FROZEN = 'ops.custody_frozen' as const;
export const OPS_CONTACTS_LIST_LIMIT_UNSET = 'ops.contacts_list_limit_unset' as const;
export const OPS_TEAM_LIST_LIMIT_UNSET = 'ops.team_list_limit_unset' as const;
export const OPS_PROJECTS_LIST_LIMIT_UNSET = 'ops.projects_list_limit_unset' as const;
export const OPS_FUNDRAISING_LIST_LIMIT_UNSET = 'ops.fundraising_list_limit_unset' as const;
export const OPS_FUNDRAISING_MILESTONES_LIST_LIMIT_UNSET = 'ops.fundraising_milestones_list_limit_unset' as const;
export const OPS_STRUCTURED_LIST_LIMIT_UNSET = 'ops.structured_list_limit_unset' as const;
export const OPS_CUSTODY_LIST_LIMIT_UNSET = 'ops.custody_list_limit_unset' as const;
export const OPS_CUSTODY_LEDGER_UNWIRED = 'ops.custody_ledger_unwired' as const;
export const OPS_CUSTODY_KEYS_UNPUBLISHED = 'ops.custody_keys_unpublished' as const;
export const OPS_RESTORE_ARCHIVE_UNCONFIGURED = 'ops.restore_archive_unconfigured' as const;
export const OPS_RESTORE_ARCHIVE_UNPROBED = 'ops.restore_archive_unprobed' as const;
export const OPS_RESTORE_STORAGE_UNCONFIGURED = 'ops.restore_storage_unconfigured' as const;
export const OPS_RESTORE_WATERMARK_REQUIRED = 'ops.restore_watermark_required' as const;
/** Not in the spec's list: a service's watermark could not be read (no URL, a refusal, a timeout or a body that is not the contract). */
export const OPS_RESTORE_WATERMARK_UNAVAILABLE = 'ops.restore_watermark_unavailable' as const;
/** A hold's owner is archived: the record is read-only, so a confirm (a new movement onward) is refused; release stays open. */
export const OPS_HOLD_ACCOUNT_ARCHIVED = 'identity.account_archived' as const;
/** Whether a hold's owner is archived could not be read from identity, so a confirm is refused rather than assumed allowed. */
export const OPS_HOLD_ACCOUNT_UNREADABLE = 'ops.hold_account_unreadable' as const;
export const OPS_RESTORE_RUN_NOT_FOUND = 'ops.restore_run_not_found' as const;
export const OPS_ALERT_LIST_LIMIT_UNSET = 'ops.alert_list_limit_unset' as const;
export const OPS_ALERT_RULE_NOT_FOUND = 'ops.alert_rule_not_found' as const;
export const OPS_ALERT_RULE_VERSION_STALE = 'ops.alert_rule_version_stale' as const;
export const OPS_ALERT_RULE_RETIRED = 'ops.alert_rule_retired' as const;
export const OPS_ALERT_RULE_NOT_RETIRED = 'ops.alert_rule_not_retired' as const;
export const OPS_ALERT_STORAGE_UNCONFIGURED = 'ops.alert_storage_unconfigured' as const;
/** OPS-reconciliation-03 alert codes; the contract owns the strings. */
export {
  OPS_ALERT_NOT_FOUND,
  OPS_ALERT_STATE_ILLEGAL,
  OPS_ALERT_REPEAT_UNSET,
  OPS_ALERT_SOURCE_UNAVAILABLE,
  OPS_ALERT_NOTE_REQUIRED,
  OPS_ALERT_SNOOZE_END_INVALID,
  OPS_RESOLVE_LEDGER_UNAVAILABLE,
  OPS_RESOLVE_NOTE_REQUIRED,
  OPS_RESOLVE_TRANSACTION_NOT_FOUND,
};
/** Blank actor on an operator write. Nothing is stored. */
export const OPS_ALERT_ACTOR_UNSET = 'ops.alert_actor_unset' as const;
/** No owner window for how long a pipeline heartbeat may stay quiet. Overdue is not invented. Spec: alerts-013. */
export const OPS_HEARTBEAT_WINDOW_UNSET = 'ops.heartbeat_window_unset' as const;
/** A window is set and no pipeline beat has ever been recorded. That is not "late by zero". */
export const OPS_ALERT_HEARTBEAT_ABSENT = 'ops.alert_heartbeat_absent' as const;
export const OPS_ALERT_TEMPLATE_TITLE_UNSET = 'ops.alert_template_title_unset' as const;
export const OPS_ALERT_TEMPLATE_BODY_UNSET = 'ops.alert_template_body_unset' as const;
export const OPS_ALERT_TEMPLATE_NOT_FOUND = 'ops.alert_template_not_found' as const;
export const OPS_ALERT_TEMPLATE_VERSION_STALE = 'ops.alert_template_version_stale' as const;
/** A create used a name that already has a template. An update still uses the stale-version code. */
export const OPS_TEMPLATE_NAME_TAKEN = 'ops.template_name_taken' as const;
export const OPS_ALERT_TEMPLATE_VARIABLE_INVALID = 'ops.alert_template_variable_invalid' as const;
export const OPS_ALERT_QUALITY_POLICY_UNSET = 'ops.alert_quality_policy_unset' as const;
export const OPS_ALERT_QUALITY_NOTHING_REQUIRED = 'ops.alert_quality_nothing_required' as const;
export const OPS_ALERT_QUALITY_REQUIREMENT_INVALID = 'ops.alert_quality_requirement_invalid' as const;
export const OPS_ALERT_QUALITY_VERSION_STALE = 'ops.alert_quality_version_stale' as const;
/**
 * An enforced quality requirement is missing, or a template references a variable it does not declare while enforcement is on.
 * The row was not saved. Spec name: alerts-013.
 */
export const OPS_ALERT_LABEL_REQUIRED = 'ops.alert_label_required' as const;
/** A panel link needs both the dashboard and the panel. Spec name: alerts-013. */
export const OPS_PANEL_LINK_INCOMPLETE = 'ops.panel_link_incomplete' as const;
export const OPS_PROTOCOL_REASON_CODES_UNSET = 'owner.decision' as const;
export const OPS_PROTOCOL_REASON_CODE_UNKNOWN = 'protocol.ops_reason_code_unknown' as const;
export const OPS_PROTOCOL_LISTING_STORAGE_UNCONFIGURED = 'ops.protocol_listing_storage_unconfigured' as const;
export const OPS_IDEMPOTENCY_KEY_INVALID = 'ops.idempotency_key_invalid' as const;
export const OPS_IDEMPOTENCY_CONFLICT = 'ops.idempotency_conflict' as const;
export const OPS_APPROVAL_UNWIRED = 'action_approval.identity_unwired' as const;
export const OPS_APPROVAL_MISSING = 'action_approval.missing' as const;
export const OPS_APPROVAL_WRONG = 'action_approval.wrong_action' as const;
export const OPS_APPROVAL_NOT_FOUNDERS = 'action_approval.not_founders' as const;

export type OpsRefuseCode =
  | typeof OPS_WAREHOUSE_UNWIRED
  | typeof OPS_WAREHOUSE_LAG_UNKNOWN
  | typeof OPS_WAREHOUSE_LAG_STALE
  | typeof OPS_PAYROLL_INVENT_FORBIDDEN
  | typeof OPS_IDENTITY_UNWIRED
  | typeof OPS_SUPPORT_UNWIRED
  | typeof OPS_CONTACT_REQUIRED
  | typeof OPS_PROJECT_REQUIRED
  | typeof OPS_TEAM_HANDLE_REQUIRED
  | typeof OPS_RAISE_NAME_REQUIRED
  | typeof OPS_FUNDRAISING_AMOUNT_INVALID
  | typeof OPS_FUNDRAISING_CHAIN_UNWIRED
  | typeof OPS_STRUCTURED_OWNER_PRICE_REQUIRED
  | typeof OPS_STRUCTURED_PRICE_FORBIDDEN
  | typeof OPS_CUSTODY_WRAP_UNSET
  | typeof OPS_CUSTODY_CHAIN_UNWIRED
  | typeof OPS_CUSTODY_KEYS_FORBIDDEN
  | typeof OPS_CUSTODY_TIER_REQUIRED
  | typeof OPS_CUSTODY_AMOUNT_INVALID
  | typeof OPS_CUSTODY_FREEZE_UNSET
  | typeof OPS_CUSTODY_FROZEN
  | typeof OPS_CONTACTS_LIST_LIMIT_UNSET
  | typeof OPS_TEAM_LIST_LIMIT_UNSET
  | typeof OPS_PROJECTS_LIST_LIMIT_UNSET
  | typeof OPS_FUNDRAISING_LIST_LIMIT_UNSET
  | typeof OPS_FUNDRAISING_MILESTONES_LIST_LIMIT_UNSET
  | typeof OPS_STRUCTURED_LIST_LIMIT_UNSET
  | typeof OPS_CUSTODY_LIST_LIMIT_UNSET
  | typeof OPS_CUSTODY_LEDGER_UNWIRED
  | typeof OPS_CUSTODY_KEYS_UNPUBLISHED
  | typeof OPS_RESTORE_ARCHIVE_UNCONFIGURED
  | typeof OPS_RESTORE_ARCHIVE_UNPROBED
  | typeof OPS_RESTORE_STORAGE_UNCONFIGURED
  | typeof OPS_RESTORE_WATERMARK_REQUIRED
  | typeof OPS_RESTORE_WATERMARK_UNAVAILABLE
  | typeof OPS_HOLD_ACCOUNT_ARCHIVED
  | typeof OPS_HOLD_ACCOUNT_UNREADABLE
  | typeof OPS_RESTORE_RUN_NOT_FOUND
  | typeof OPS_RESTORE_STEP_OUT_OF_ORDER
  | typeof OPS_RESTORE_TARGET_UNSET
  | typeof OPS_RESTORE_WATERMARKS_DISAGREE
  | typeof OPS_ALERT_THRESHOLD_UNSET
  | typeof OPS_ALERT_INTERVAL_UNSET
  | typeof OPS_ALERT_LABELS_DUPLICATE
  | typeof OPS_ALERT_FORBIDDEN
  | typeof OPS_ALERT_SIGNAL_UNKNOWN
  | typeof OPS_ALERT_HISTORY_RETENTION_UNSET
  | typeof OPS_ALERT_LIST_LIMIT_UNSET
  | typeof OPS_ALERT_RULE_NOT_FOUND
  | typeof OPS_ALERT_RULE_VERSION_STALE
  | typeof OPS_ALERT_RULE_RETIRED
  | typeof OPS_ALERT_RULE_NOT_RETIRED
  | typeof OPS_ALERT_STORAGE_UNCONFIGURED
  | typeof OPS_ALERT_NOT_FOUND
  | typeof OPS_ALERT_STATE_ILLEGAL
  | typeof OPS_ALERT_REPEAT_UNSET
  | typeof OPS_ALERT_SOURCE_UNAVAILABLE
  | typeof OPS_ALERT_NOTE_REQUIRED
  | typeof OPS_ALERT_SNOOZE_END_INVALID
  | typeof OPS_RESOLVE_LEDGER_UNAVAILABLE
  | typeof OPS_RESOLVE_NOTE_REQUIRED
  | typeof OPS_RESOLVE_TRANSACTION_NOT_FOUND
  | typeof OPS_ALERT_ACTOR_UNSET
  | typeof OPS_HEARTBEAT_WINDOW_UNSET
  | typeof OPS_ALERT_HEARTBEAT_ABSENT
  | typeof OPS_ALERT_TEMPLATE_TITLE_UNSET
  | typeof OPS_ALERT_TEMPLATE_BODY_UNSET
  | typeof OPS_ALERT_TEMPLATE_NOT_FOUND
  | typeof OPS_ALERT_TEMPLATE_VERSION_STALE
  | typeof OPS_TEMPLATE_NAME_TAKEN
  | typeof OPS_ALERT_TEMPLATE_VARIABLE_INVALID
  | typeof OPS_ALERT_QUALITY_POLICY_UNSET
  | typeof OPS_ALERT_QUALITY_NOTHING_REQUIRED
  | typeof OPS_ALERT_QUALITY_REQUIREMENT_INVALID
  | typeof OPS_ALERT_QUALITY_VERSION_STALE
  | typeof OPS_ALERT_LABEL_REQUIRED
  | typeof OPS_ALERT_DEFAULT_CONTACT_UNSET
  | typeof OPS_CONTACT_POINT_IN_USE
  | typeof OPS_CHANNEL_AUTH_CONFLICT
  | typeof OPS_GROUP_TIMING_UNSET
  | typeof OPS_FLAP_SUPPRESSION_UNSET
  | typeof OPS_MUTE_TIMING_UNSET
  | typeof OPS_ACTIVE_TIME_UNSET
  | typeof OPS_MATCHER_INVALID
  | typeof OPS_SILENCE_END_UNSET
  | typeof OPS_ALERT_CHANNEL_KEY_UNSET
  | typeof OPS_CONTACT_POINT_NOT_FOUND
  | typeof OPS_ALERT_ROUTE_VERSION_STALE
  | typeof OPS_CONTACT_VERSION_STALE
  | typeof OPS_SILENCE_NOT_FOUND
  | typeof OPS_CHANNEL_TARGET_UNSET
  | typeof OPS_CHANNEL_SECRET_UNSET
  | typeof OPS_CHANNEL_DELIVERY_FAILED
  | typeof OPS_ALERT_ROUTE_UNSET
  | typeof OPS_ALERT_ROUTE_INVALID
  | typeof OPS_SILENCE_ID_TAKEN
  | typeof OPS_PANEL_LINK_INCOMPLETE
  | typeof OPS_COST_AMOUNT_INVALID
  | typeof OPS_COST_CATEGORY_INVALID
  | typeof OPS_COST_PERIOD_INVALID
  | typeof OPS_COST_STORAGE_UNCONFIGURED
  | typeof COMPLIANCE_CASE_ALREADY_OPEN
  | typeof COMPLIANCE_CASE_NOT_FOUND
  | typeof COMPLIANCE_CASES_LIST_LIMIT_UNSET
  | typeof COMPLIANCE_INBOX_FORBIDDEN
  | typeof COMPLIANCE_INBOX_NOT_FOUND
  | typeof COMPLIANCE_QUEUE_ENTITY_UNKNOWN
  | typeof COMPLIANCE_QUEUE_NAME_TAKEN
  | typeof OPS_COMPLIANCE_STORAGE_UNCONFIGURED
  | typeof OPS_PROTOCOL_REASON_CODES_UNSET
  | typeof OPS_PROTOCOL_REASON_CODE_UNKNOWN
  | typeof OPS_PROTOCOL_LISTING_STORAGE_UNCONFIGURED
  | typeof CONSOLE_MODE_STORAGE_UNCONFIGURED
  | typeof ANNOUNCEMENT_NOT_FOUND
  | typeof ANNOUNCEMENT_STORAGE_UNCONFIGURED
  | typeof ANNOUNCEMENT_WITHDRAWN
  | typeof BANNER_CONFLICT
  | typeof BANNER_WINDOW_INVALID
  | typeof PREFERENCE_INVALID
  | typeof PREFERENCES_STORAGE_UNCONFIGURED
  | typeof PREFERENCES_TEAM_UNASSIGNED
  | typeof PREFERENCES_STALE
  | typeof SERVICE_NOT_FOUND
  | typeof SERVICE_RECORD_INVALID
  | typeof SERVICE_RECORD_STALE
  | typeof SERVICE_STORAGE_UNCONFIGURED
  | typeof OPS_IDEMPOTENCY_KEY_INVALID
  | typeof OPS_IDEMPOTENCY_CONFLICT
  | typeof OPS_APPROVAL_UNWIRED
  | typeof OPS_APPROVAL_MISSING
  | typeof OPS_APPROVAL_WRONG
  | typeof OPS_APPROVAL_NOT_FOUNDERS
  | typeof STAFF_HOLD_STORAGE_UNCONFIGURED
  | typeof STAFF_HOLD_LEDGER_UNCONFIGURED
  | typeof STAFF_HOLD_STATE_ILLEGAL
  | typeof STAFF_HOLD_AMOUNT_EXCEEDS_REMAINING
  | typeof STAFF_HOLD_EXPIRY_UNSET
  | typeof STAFF_HOLD_EXPIRY_TOO_LONG
  | typeof STAFF_HOLD_CONFIRM_ACCOUNT_UNSET
  | typeof STAFF_HOLD_NOT_FOUND
  /** A ledger refusal passed through as the ledger typed it (a staff hold post refused for funds or the posting freeze). */
  | `ledger.${string}`;

export class OpsError extends Error {
  readonly code: OpsRefuseCode;

  constructor(code: OpsRefuseCode, message: string) {
    super(message);
    this.name = 'OpsError';
    this.code = code;
  }
}
