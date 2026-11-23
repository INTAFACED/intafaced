import { defineProcedure } from './procedure.js';
import {
  opsAlertDetailSchema,
  opsAlertGetInputSchema,
  opsAlertListInputSchema,
  opsAlertListSchema,
  opsPlatformIncidentsInputSchema,
  opsPlatformIncidentsSchema,
  opsReconciliationPeriodsInputSchema,
  opsReconciliationPeriodsSchema,
  opsAlertAcknowledgeInputSchema,
  opsAlertSnoozeInputSchema,
  opsAlertUnsnoozeInputSchema,
} from './ops-reconciliation-alerts.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-ops `alerts.*`, one record per call: svc-ops mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-ops', module: 'ops', transport: 'trpc' } as const;

export const OPS_ALERTS_LIST = defineProcedure({
  ...base,
  name: 'ops.alerts.list',
  kind: 'query',
  path: 'alerts.list',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: { 'ops.alert_storage_unconfigured': 'PRECONDITION_FAILED' },
  input: opsAlertListInputSchema,
  output: opsAlertListSchema,
  samples: [
    { verdict: 'accept', input: { after: { lastSeen: '2026-01-01T00:00:00.000Z', id: '11111111-1111-4111-8111-111111111111' }, limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_ALERTS_PERIODS = defineProcedure({
  ...base,
  name: 'ops.alerts.periods',
  kind: 'query',
  path: 'alerts.periods',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: { 'ops.alert_storage_unconfigured': 'PRECONDITION_FAILED' },
  input: opsReconciliationPeriodsInputSchema,
  output: opsReconciliationPeriodsSchema,
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_ALERTS_PLATFORM_INCIDENTS = defineProcedure({
  ...base,
  name: 'ops.alerts.platformIncidents',
  kind: 'query',
  path: 'alerts.platformIncidents',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: opsPlatformIncidentsInputSchema,
  output: opsPlatformIncidentsSchema,
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_ALERTS_GET = defineProcedure({
  ...base,
  name: 'ops.alerts.get',
  kind: 'query',
  path: 'alerts.get',
  access: { caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' },
  refusals: { 'ops.alert_not_found': 'NOT_FOUND' },
  input: opsAlertGetInputSchema,
  output: opsAlertDetailSchema,
  samples: [
    { verdict: 'accept', input: { alertId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_ALERTS_ACKNOWLEDGE = defineProcedure({
  ...base,
  name: 'ops.alerts.acknowledge',
  kind: 'mutation',
  path: 'alerts.acknowledge',
  access: { caller: 'scope', scope: 'admin:write', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: opsAlertAcknowledgeInputSchema,
  output: opsAlertDetailSchema,
  samples: [
    { verdict: 'accept', input: { alertId: '11111111-1111-4111-8111-111111111111', note: 'USDC', idempotencyKey: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_ALERTS_SNOOZE = defineProcedure({
  ...base,
  name: 'ops.alerts.snooze',
  kind: 'mutation',
  path: 'alerts.snooze',
  access: { caller: 'scope', scope: 'admin:write', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: opsAlertSnoozeInputSchema,
  output: opsAlertDetailSchema,
  samples: [
    {
      verdict: 'accept',
      input: { alertId: '11111111-1111-4111-8111-111111111111', endsAt: '2026-01-01T00:00:00.000Z', idempotencyKey: 'ethereum' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const OPS_ALERTS_UNSNOOZE = defineProcedure({
  ...base,
  name: 'ops.alerts.unsnooze',
  kind: 'mutation',
  path: 'alerts.unsnooze',
  access: { caller: 'scope', scope: 'admin:write', module: 'core-ops', plane: 'fiat' },
  refusals: {},
  input: opsAlertUnsnoozeInputSchema,
  output: opsAlertDetailSchema,
  samples: [
    { verdict: 'accept', input: { alertId: '11111111-1111-4111-8111-111111111111', idempotencyKey: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});
