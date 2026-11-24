import { z } from 'zod';
import { defineProcedure, type Refusals } from './procedure.js';

/**
 * svc-trade's margin and liquidation-risk alerts on an isolated position on the person's own venue account
 * (J-derivatives-06 #6 #7; svc-trade src/venue/risk-alerts.ts). Nothing is sent to the venue and the ledger posts nothing.
 * The person turns alerts on for a position and may set two risk levels: a margin level (the position's margin with its
 * unrealised result, as the venue reports it) and a margin-ratio level (the venue's maintenance requirement over that
 * margin, in percent). Our engine sends one alert each time a figure crosses a level: a margin alert, a margin call that
 * asks for the margin bringing the ratio back to its level, and, with or without levels of theirs, the liquidation alert
 * when the ratio reaches 100%, the venue's own maintenance requirement.
 */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'trade:read', module: 'trade' } as const;
const WRITE = { caller: 'scope', scope: 'trade:write', module: 'trade' } as const;

const decimal = z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/);
/** A decimal typed by the person, or blank for no level: the service names a malformed field in its refusal. */
const typed = z.string().max(64).optional().nullable();
const owner = z.string().max(64);
const symbol = z.string().min(3).max(64);

export const RISK_ALERT_KINDS = ['margin', 'margin_call', 'liquidation'] as const;

/** One alert that went out: the level it crossed and the venue's figures at the crossing. */
export const riskAlertSchema = z.object({
  sequence: z.number().int(),
  alertKey: z.string(),
  symbol: z.string(),
  kind: z.enum(RISK_ALERT_KINDS),
  asset: z.string(),
  /** The margin level for a margin alert; a ratio in percent for a margin call or the liquidation alert. */
  level: decimal,
  marginWithResult: decimal,
  maintenance: decimal.nullable(),
  /** In percent. */
  marginRatio: decimal.nullable(),
  /** What a margin call asks: the margin to add for the ratio to come back to its level. `null` for a margin alert. */
  asked: decimal.nullable(),
  at: z.string(),
});

const venueSchema = z.object({ id: z.string(), name: z.string(), test: z.boolean() });

/** One position's alerts as the person reads them: every figure a decimal string, the position's from the venue. */
export const riskAlertsViewSchema = z.object({
  venue: venueSchema,
  owner: z.string(),
  symbol: z.string(),
  asset: z.string(),
  /** The position as the venue reports it now; `null` with no isolated position open on the symbol. */
  position: z
    .object({
      marginWithResult: decimal,
      /** `null` where the venue publishes no maintenance requirement: no ratio alert can go out then. */
      maintenance: decimal.nullable(),
      /** In percent; `null` with no maintenance requirement, or no margin left to divide by. */
      marginRatio: decimal.nullable(),
      asOf: z.string(),
    })
    .nullable(),
  /** The position's setting, or `null` when alerts were never turned on for it. */
  setting: z
    .object({
      on: z.boolean(),
      marginLevel: decimal.nullable(),
      ratioLevel: decimal.nullable(),
      armed: z.object({ margin: z.boolean(), marginCall: z.boolean(), liquidation: z.boolean() }),
    })
    .nullable(),
  /** This position's alerts, newest first. */
  alerts: z.array(riskAlertSchema),
});

/** Every alert on the venue account, newest first: the Margin calls tab reads them. */
export const riskAlertListSchema = z.object({ venue: venueSchema, owner: z.string(), alerts: z.array(riskAlertSchema) });

const refuse = (map: Record<string, 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST' | 'FORBIDDEN' | 'SERVICE_UNAVAILABLE'>): Refusals =>
  Object.freeze(map);

const COMMON = {
  'trade.risk_alerts_unavailable': 'SERVICE_UNAVAILABLE',
  'trade.risk_alerts_request_invalid': 'BAD_REQUEST',
} as const;

const OWNER = '0x1111111111111111111111111111111111111111';

/** One position's alerts, its levels and what went out, with the position as the venue reports it now. */
export const RISK_ALERTS_GET = defineProcedure({
  ...base,
  name: 'trade.riskAlerts.get',
  kind: 'query',
  path: 'riskAlerts.get',
  access: READ,
  refusals: refuse({ ...COMMON }),
  input: z.object({ owner, symbol }),
  output: riskAlertsViewSchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER, symbol: 'BTC-PERP' } },
    { verdict: 'refuse', input: { owner: OWNER, symbol: '' } },
    { verdict: 'refuse', input: {} },
  ],
});

/**
 * Turn a position's alerts on, or change its risk levels (J-derivatives-06 #6). Either level may be left blank; the
 * liquidation alert goes out whatever is set. Refused naming the field.
 */
export const RISK_ALERTS_SET = defineProcedure({
  ...base,
  name: 'trade.riskAlerts.set',
  kind: 'mutation',
  path: 'riskAlerts.set',
  access: WRITE,
  refusals: refuse({
    ...COMMON,
    'trade.risk_alerts_field_invalid': 'BAD_REQUEST',
    'trade.risk_alerts_no_position': 'CONFLICT',
  }),
  input: z.object({ owner, symbol, marginLevel: typed, ratioLevel: typed }),
  output: riskAlertsViewSchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER, symbol: 'BTC-PERP', marginLevel: '100', ratioLevel: '50' } },
    { verdict: 'accept', input: { owner: OWNER, symbol: 'BTC-PERP' } },
    { verdict: 'refuse', input: { owner: OWNER, symbol: '' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Turn a position's alerts off: nothing more goes out for it until they are turned on. */
export const RISK_ALERTS_OFF = defineProcedure({
  ...base,
  name: 'trade.riskAlerts.off',
  kind: 'mutation',
  path: 'riskAlerts.off',
  access: WRITE,
  refusals: refuse({ ...COMMON }),
  input: z.object({ owner, symbol }),
  output: riskAlertsViewSchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER, symbol: 'BTC-PERP' } },
    { verdict: 'refuse', input: { owner: OWNER } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Every alert on the venue account, newest first (J-derivatives-06 #7: the Margin calls tab). */
export const RISK_ALERTS_LIST = defineProcedure({
  ...base,
  name: 'trade.riskAlerts.list',
  kind: 'query',
  path: 'riskAlerts.list',
  access: READ,
  refusals: refuse({ ...COMMON }),
  input: z.object({ owner }),
  output: riskAlertListSchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER } },
    { verdict: 'refuse', input: { owner: 7 } },
    { verdict: 'refuse', input: {} },
  ],
});
