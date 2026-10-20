import {
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
} from '@intafaced/contracts';

export {
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
export const OPS_ALERT_LIST_LIMIT_UNSET = 'ops.alert_list_limit_unset' as const;
export const OPS_ALERT_RULE_NOT_FOUND = 'ops.alert_rule_not_found' as const;
export const OPS_ALERT_RULE_VERSION_STALE = 'ops.alert_rule_version_stale' as const;
export const OPS_ALERT_RULE_RETIRED = 'ops.alert_rule_retired' as const;
export const OPS_ALERT_RULE_NOT_RETIRED = 'ops.alert_rule_not_retired' as const;
export const OPS_ALERT_STORAGE_UNCONFIGURED = 'ops.alert_storage_unconfigured' as const;
export const OPS_ALERT_SOURCE_UNCONFIGURED = 'ops.alert_source_unconfigured' as const;
export const OPS_ALERT_PROBE_UNCONFIGURED = 'ops.alert_probe_unconfigured' as const;
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
  | typeof OPS_ALERT_SOURCE_UNCONFIGURED
  | typeof OPS_ALERT_PROBE_UNCONFIGURED
  | typeof OPS_COST_AMOUNT_INVALID
  | typeof OPS_COST_CATEGORY_INVALID
  | typeof OPS_COST_PERIOD_INVALID
  | typeof OPS_COST_STORAGE_UNCONFIGURED
  | typeof OPS_IDEMPOTENCY_KEY_INVALID
  | typeof OPS_IDEMPOTENCY_CONFLICT
  | typeof OPS_APPROVAL_UNWIRED
  | typeof OPS_APPROVAL_MISSING
  | typeof OPS_APPROVAL_WRONG
  | typeof OPS_APPROVAL_NOT_FOUNDERS;

export class OpsError extends Error {
  readonly code: OpsRefuseCode;

  constructor(code: OpsRefuseCode, message: string) {
    super(message);
    this.name = 'OpsError';
    this.code = code;
  }
}
