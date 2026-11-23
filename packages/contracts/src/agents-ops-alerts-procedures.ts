import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  agentAlertDeskSchema,
  agentAlertEvaluationSchema,
  agentAlertNotificationsSchema,
  agentAlertRuleSchema,
  agentPolicySchema,
  agentRuleCheckSchema,
} from './agents-alerts.js';
import { OWN_AGENT_DATA_CLASSES, OWN_AGENT_RULE_CHOICES } from './agents-own.js';
import { ALERT_MEASURES } from './agents-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-agents `opsAlerts.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-agents', module: 'agents', transport: 'trpc' } as const;

/** The stored rules, oldest first, and the newest alerts with their delivery state. */
export const AGENTS_OPS_ALERTS_DESK = defineProcedure({
  ...base,
  name: 'agents.opsAlerts.desk',
  kind: 'query',
  path: 'opsAlerts.desk',
  access: { caller: 'scope', scope: 'admin:read', module: 'agents', person: true, ownSession: 'agents.alerts_person_only' },
  refusals: {},
  input: NO_INPUT,
  output: agentAlertDeskSchema,
  samples: [{ verdict: 'accept' }],
});

/** The owner's managed baseline per class, this environment's override, and the stricter of the two. */
export const AGENTS_OPS_ALERTS_POLICY = defineProcedure({
  ...base,
  name: 'agents.opsAlerts.policy',
  kind: 'query',
  path: 'opsAlerts.policy',
  access: { caller: 'scope', scope: 'admin:read', module: 'agents', person: true, ownSession: 'agents.alerts_person_only' },
  refusals: {},
  input: NO_INPUT,
  output: agentPolicySchema,
  samples: [{ verdict: 'accept' }],
});

/** Runs the evaluator now over every rule's current and previous window, and says what each window came to. */
export const AGENTS_OPS_ALERTS_EVALUATE = defineProcedure({
  ...base,
  name: 'agents.opsAlerts.evaluate',
  kind: 'mutation',
  path: 'opsAlerts.evaluate',
  access: { caller: 'scope', scope: 'admin:write', module: 'agents', person: true, ownSession: 'agents.alerts_person_only' },
  refusals: {},
  input: NO_INPUT,
  output: agentAlertEvaluationSchema,
  samples: [{ verdict: 'accept' }],
});

/** Stores one rule. A blank threshold is refused by name before anything is written; 0 is stored as 0. */
export const AGENTS_OPS_ALERTS_CREATE_RULE = defineProcedure({
  ...base,
  name: 'agents.opsAlerts.createRule',
  kind: 'mutation',
  path: 'opsAlerts.createRule',
  access: { caller: 'scope', scope: 'admin:write', module: 'agents', person: true, ownSession: 'agents.alerts_person_only' },
  refusals: {},
  input: z.object({
    name: z.string().trim().min(1).max(80),
    measure: z.enum(ALERT_MEASURES),
    threshold: z.string().max(60).optional(),
    windowMinutes: z.number().int().min(1).max(1440),
    agentId: z.string().trim().min(1).max(120).optional(),
  }),
  output: agentAlertRuleSchema,
  samples: [
    { verdict: 'accept', input: { name: 'USDC', measure: 'refusal_rate', windowMinutes: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Takes alert notifications down or brings them back. Back on, every alert kept meanwhile is handed over. */
export const AGENTS_OPS_ALERTS_SET_NOTIFICATIONS = defineProcedure({
  ...base,
  name: 'agents.opsAlerts.setNotifications',
  kind: 'mutation',
  path: 'opsAlerts.setNotifications',
  access: { caller: 'scope', scope: 'admin:write', module: 'agents', person: true, ownSession: 'agents.alerts_person_only' },
  refusals: {},
  input: z.object({ state: z.enum(['on', 'down']) }),
  output: agentAlertNotificationsSchema,
  samples: [
    { verdict: 'accept', input: { state: 'on' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Sets this environment's override for one class. One looser than the baseline is refused and nothing is stored. */
export const AGENTS_OPS_ALERTS_SET_OVERRIDE = defineProcedure({
  ...base,
  name: 'agents.opsAlerts.setOverride',
  kind: 'mutation',
  path: 'opsAlerts.setOverride',
  access: { caller: 'scope', scope: 'admin:write', module: 'agents', person: true, ownSession: 'agents.alerts_person_only' },
  refusals: {},
  input: z.object({ dataClass: z.enum(OWN_AGENT_DATA_CLASSES), choice: z.enum(OWN_AGENT_RULE_CHOICES) }),
  output: agentPolicySchema,
  samples: [
    { verdict: 'accept', input: { dataClass: 'own_data', choice: 'hand_off' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Checks a person's standing rule against the baseline and this environment's override. Stores nothing. */
export const AGENTS_OPS_ALERTS_CHECK_RULE = defineProcedure({
  ...base,
  name: 'agents.opsAlerts.checkRule',
  kind: 'mutation',
  path: 'opsAlerts.checkRule',
  access: { caller: 'scope', scope: 'admin:read', module: 'agents', person: true, ownSession: 'agents.alerts_person_only' },
  refusals: {},
  input: z.object({ dataClass: z.enum(OWN_AGENT_DATA_CLASSES), choice: z.enum(OWN_AGENT_RULE_CHOICES) }),
  output: agentRuleCheckSchema,
  samples: [
    { verdict: 'accept', input: { dataClass: 'own_data', choice: 'hand_off' } },
    { verdict: 'refuse', input: 42 },
  ],
});
