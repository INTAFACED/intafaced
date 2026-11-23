// TEMPORARY, never merged: one literal call per svc-ops call the console's routes pick from the request, so the
// call-records codemod writes each one's record and mount. Deleted in the same branch once the records exist.
import { founderEdgeCall, type AdminSessionConfig } from '@/lib/founder-session';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { opsAlertDetailSchema } from '@intafaced/contracts/ops-reconciliation-alerts';
import { incidentDetailSchema } from '@intafaced/contracts/ops-incidents';

export async function tempSites(config: AdminSessionConfig, ctx: FounderCallContext, input: never, token: string) {
  await founderEdgeCall(config, 'ops', 'outreach.assign', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.changeStage', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.updateNextAction', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.addNote', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.metrics', 'GET', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.listCampaigns', 'GET', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.listSourceMappings', 'GET', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.listDuplicates', 'GET', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.listTasks', 'GET', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.listMessages', 'GET', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.documentProviderStatus', 'GET', undefined, token);
  await founderEdgeCall(config, 'ops', 'outreach.upsertCampaign', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.upsertSourceMapping', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.mergeContacts', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.exportSubmissions', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.createTask', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.transitionTask', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.recordInteraction', 'POST', input, token);
  await founderEdgeCall(config, 'ops', 'outreach.queueMessage', 'POST', input, token);
  await founderCall(ctx, 'ops', 'alerts.acknowledge', 'POST', input, parseWith(opsAlertDetailSchema));
  await founderCall(ctx, 'ops', 'alerts.snooze', 'POST', input, parseWith(opsAlertDetailSchema));
  await founderCall(ctx, 'ops', 'alerts.unsnooze', 'POST', input, parseWith(opsAlertDetailSchema));
  await founderCall(ctx, 'ops', 'incidents.declare', 'POST', input, parseWith(incidentDetailSchema));
  await founderCall(ctx, 'ops', 'incidents.note', 'POST', input, parseWith(incidentDetailSchema));
  await founderCall(ctx, 'ops', 'incidents.invite', 'POST', input, parseWith(incidentDetailSchema));
  await founderCall(ctx, 'ops', 'incidents.task', 'POST', input, parseWith(incidentDetailSchema));
  await founderCall(ctx, 'ops', 'incidents.resolve', 'POST', input, parseWith(incidentDetailSchema));
}
