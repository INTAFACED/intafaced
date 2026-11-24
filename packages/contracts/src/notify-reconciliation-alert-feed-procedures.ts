import { defineProcedure } from './procedure.js';
import { notifyReconAlertFeedInputSchema, notifyReconAlertFeedSchema } from './ops-reconciliation-alerts.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-notify `reconciliationAlertFeed.*`, one record per call: svc-notify mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-notify', module: 'notify', transport: 'trpc' } as const;

export const NOTIFY_RECONCILIATION_ALERT_FEED_LIST = defineProcedure({
  ...base,
  name: 'notify.reconciliationAlertFeed.list',
  kind: 'query',
  path: 'reconciliationAlertFeed.list',
  access: { caller: 'scope', scope: 'admin:read', module: 'notify' },
  refusals: {},
  input: notifyReconAlertFeedInputSchema,
  output: notifyReconAlertFeedSchema,
  samples: [
    { verdict: 'accept', input: { alertId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
