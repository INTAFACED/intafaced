/* eslint-disable */
// Temporary: one literal call per procedure so the call-records codemod writes their records. Deleted in the same branch.
import { founderEdgeCall, type AdminSessionConfig, founderEdgeRecordCall } from '@/lib/founder-session';
import { type FounderCallContext, founderRecordCall } from '@/lib/desk/founder-call';
import {
  PAY_ACCOUNT_CONTROLS_GET_STATE,
  PAY_ACCOUNT_CONTROLS_HISTORY,
  PAY_ACCOUNT_CONTROLS_CHANGE,
} from '@intafaced/contracts/pay-account-controls-procedures';
import {
  IDENTITY_ACCOUNT_CONTROLS_GET_STATE,
  IDENTITY_ACCOUNT_CONTROLS_HISTORY,
  IDENTITY_ACCOUNT_CONTROLS_CHANGE,
} from '@intafaced/contracts/identity-account-controls-procedures';
import { TRADE_ACCOUNT_CONTROLS_GET_STATE, TRADE_ACCOUNT_CONTROLS_HISTORY } from '@intafaced/contracts/trade-account-controls-procedures';
import {
  OPS_OUTREACH_LIST_CAMPAIGNS,
  OPS_OUTREACH_LIST_SOURCE_MAPPINGS,
  OPS_OUTREACH_LIST_TASKS,
  OPS_OUTREACH_LIST_MESSAGES,
  OPS_OUTREACH_UPSERT_CAMPAIGN,
  OPS_OUTREACH_UPSERT_SOURCE_MAPPING,
  OPS_OUTREACH_CREATE_TASK,
  OPS_OUTREACH_TRANSITION_TASK,
  OPS_OUTREACH_RECORD_INTERACTION,
  OPS_OUTREACH_QUEUE_MESSAGE,
  OPS_OUTREACH_ASSIGN,
  OPS_OUTREACH_UPDATE_NEXT_ACTION,
  OPS_OUTREACH_ADD_NOTE,
  OPS_OUTREACH_DOCUMENT_PROVIDER_STATUS,
} from '@intafaced/contracts/ops-outreach-procedures';
import { OPS_ALERTS_ACKNOWLEDGE, OPS_ALERTS_SNOOZE, OPS_ALERTS_UNSNOOZE } from '@intafaced/contracts/ops-alerts-procedures';

export async function scratch(config: AdminSessionConfig, ctx: FounderCallContext, input: any, token: string) {
  await founderEdgeRecordCall(config, IDENTITY_ACCOUNT_CONTROLS_GET_STATE, input, token);
  await founderEdgeRecordCall(config, IDENTITY_ACCOUNT_CONTROLS_HISTORY, input, token);
  await founderEdgeRecordCall(config, IDENTITY_ACCOUNT_CONTROLS_CHANGE, input, token);
  await founderEdgeRecordCall(config, TRADE_ACCOUNT_CONTROLS_GET_STATE, input, token);
  await founderEdgeRecordCall(config, TRADE_ACCOUNT_CONTROLS_HISTORY, input, token);
  await founderEdgeCall(config, 'trade', 'accountControls.change', 'POST', input, token);
  await founderEdgeRecordCall(config, PAY_ACCOUNT_CONTROLS_GET_STATE, input, token);
  await founderEdgeRecordCall(config, PAY_ACCOUNT_CONTROLS_HISTORY, input, token);
  await founderEdgeRecordCall(config, PAY_ACCOUNT_CONTROLS_CHANGE, input, token);
  await founderEdgeCall(config, 'ops', 'outreach.metrics', 'GET', input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_LIST_CAMPAIGNS, input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_LIST_SOURCE_MAPPINGS, input, token);
  await founderEdgeCall(config, 'ops', 'outreach.listDuplicates', 'GET', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.getContactProvenance', 'GET', input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_LIST_TASKS, input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_LIST_MESSAGES, input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_DOCUMENT_PROVIDER_STATUS, undefined, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_UPSERT_CAMPAIGN, input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_UPSERT_SOURCE_MAPPING, input, token);
  await founderEdgeCall(config, 'ops', 'outreach.mergeContacts', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.exportSubmissions', 'POST', input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_CREATE_TASK, input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_TRANSITION_TASK, input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_RECORD_INTERACTION, input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_QUEUE_MESSAGE, input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_ASSIGN, input, token);
  await founderEdgeCall(config, 'ops', 'outreach.changeStage', 'POST', input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_UPDATE_NEXT_ACTION, input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_ADD_NOTE, input, token);
  await founderRecordCall(ctx, OPS_ALERTS_ACKNOWLEDGE, input);
  await founderRecordCall(ctx, OPS_ALERTS_SNOOZE, input);
  await founderRecordCall(ctx, OPS_ALERTS_UNSNOOZE, input);
}
