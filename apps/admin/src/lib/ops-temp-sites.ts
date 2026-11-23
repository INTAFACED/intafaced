// TEMPORARY, never merged: one literal call per svc-ops call the console's routes pick from the request, so the
// call-records codemod writes each one's record and mount. Deleted in the same branch once the records exist.
import { founderEdgeCall, type AdminSessionConfig, founderEdgeRecordCall } from '@/lib/founder-session';
import { type FounderCallContext, founderRecordCall } from '@/lib/desk/founder-call';
import {
  OPS_OUTREACH_ASSIGN,
  OPS_OUTREACH_UPDATE_NEXT_ACTION,
  OPS_OUTREACH_ADD_NOTE,
  OPS_OUTREACH_LIST_CAMPAIGNS,
  OPS_OUTREACH_LIST_SOURCE_MAPPINGS,
  OPS_OUTREACH_LIST_DUPLICATES,
  OPS_OUTREACH_LIST_TASKS,
  OPS_OUTREACH_DOCUMENT_PROVIDER_STATUS,
  OPS_OUTREACH_UPSERT_CAMPAIGN,
  OPS_OUTREACH_UPSERT_SOURCE_MAPPING,
  OPS_OUTREACH_CREATE_TASK,
  OPS_OUTREACH_TRANSITION_TASK,
  OPS_OUTREACH_RECORD_INTERACTION,
} from '@intafaced/contracts/ops-outreach-procedures';
import { OPS_ALERTS_ACKNOWLEDGE, OPS_ALERTS_SNOOZE, OPS_ALERTS_UNSNOOZE } from '@intafaced/contracts/ops-alerts-procedures';
import {
  OPS_INCIDENTS_DECLARE,
  OPS_INCIDENTS_NOTE,
  OPS_INCIDENTS_INVITE,
  OPS_INCIDENTS_TASK,
  OPS_INCIDENTS_RESOLVE,
} from '@intafaced/contracts/ops-incidents-procedures';

export async function tempSites(config: AdminSessionConfig, ctx: FounderCallContext, input: never, token: string) {
  await founderEdgeRecordCall(config, OPS_OUTREACH_ASSIGN, input, token);
  await founderEdgeCall(config, 'ops', 'outreach.changeStage', 'POST', input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_UPDATE_NEXT_ACTION, input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_ADD_NOTE, input, token);
  await founderEdgeCall(config, 'ops', 'outreach.metrics', 'GET', input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_LIST_CAMPAIGNS, input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_LIST_SOURCE_MAPPINGS, input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_LIST_DUPLICATES, input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_LIST_TASKS, input, token);
  await founderEdgeCall(config, 'ops', 'outreach.listMessages', 'GET', input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_DOCUMENT_PROVIDER_STATUS, undefined, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_UPSERT_CAMPAIGN, input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_UPSERT_SOURCE_MAPPING, input, token);
  await founderEdgeCall(config, 'ops', 'outreach.mergeContacts', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.exportSubmissions', 'POST', input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_CREATE_TASK, input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_TRANSITION_TASK, input, token);
  await founderEdgeRecordCall(config, OPS_OUTREACH_RECORD_INTERACTION, input, token);
  await founderEdgeCall(config, 'ops', 'outreach.queueMessage', 'POST', input, token);
  await founderRecordCall(ctx, OPS_ALERTS_ACKNOWLEDGE, input);
  await founderRecordCall(ctx, OPS_ALERTS_SNOOZE, input);
  await founderRecordCall(ctx, OPS_ALERTS_UNSNOOZE, input);
  await founderRecordCall(ctx, OPS_INCIDENTS_DECLARE, input);
  await founderRecordCall(ctx, OPS_INCIDENTS_NOTE, input);
  await founderRecordCall(ctx, OPS_INCIDENTS_INVITE, input);
  await founderRecordCall(ctx, OPS_INCIDENTS_TASK, input);
  await founderRecordCall(ctx, OPS_INCIDENTS_RESOLVE, input);
}
