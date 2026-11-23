/* eslint-disable */
// Temporary: one literal call per procedure so the call-records codemod writes their records. Deleted in the same branch.
import { founderEdgeCall, type AdminSessionConfig, founderEdgeRecordCall } from '@/lib/founder-session';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { z } from 'zod';
import {
  PAY_ACCOUNT_CONTROLS_GET_STATE,
  PAY_ACCOUNT_CONTROLS_HISTORY,
  PAY_ACCOUNT_CONTROLS_CHANGE,
} from '@intafaced/contracts/pay-account-controls-procedures';

export async function scratch(config: AdminSessionConfig, ctx: FounderCallContext, input: any, token: string) {
  await founderEdgeCall(config, 'identity', 'accountControls.getState', 'GET', input, token);
  await founderEdgeCall(config, 'identity', 'accountControls.history', 'GET', input, token);
  await founderEdgeCall(config, 'identity', 'accountControls.change', 'POST', input, token);
  await founderEdgeCall(config, 'trade', 'accountControls.getState', 'GET', input, token);
  await founderEdgeCall(config, 'trade', 'accountControls.history', 'GET', input, token);
  await founderEdgeCall(config, 'trade', 'accountControls.change', 'POST', input, token);
  await founderEdgeRecordCall(config, PAY_ACCOUNT_CONTROLS_GET_STATE, input, token);
  await founderEdgeRecordCall(config, PAY_ACCOUNT_CONTROLS_HISTORY, input, token);
  await founderEdgeRecordCall(config, PAY_ACCOUNT_CONTROLS_CHANGE, input, token);
  await founderEdgeCall(config, 'ops', 'outreach.metrics', 'GET', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.listCampaigns', 'GET', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.listSourceMappings', 'GET', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.listDuplicates', 'GET', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.getContactProvenance', 'GET', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.listTasks', 'GET', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.listMessages', 'GET', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.documentProviderStatus', 'GET', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.upsertCampaign', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.upsertSourceMapping', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.mergeContacts', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.exportSubmissions', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.createTask', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.transitionTask', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.recordInteraction', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.queueMessage', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.assign', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.changeStage', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.updateNextAction', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.addNote', 'POST', input, token);
  await founderCall(ctx, 'ops', 'alerts.acknowledge', 'POST', input, parseWith(z.unknown()));
  await founderCall(ctx, 'ops', 'alerts.snooze', 'POST', input, parseWith(z.unknown()));
  await founderCall(ctx, 'ops', 'alerts.unsnooze', 'POST', input, parseWith(z.unknown()));
}
