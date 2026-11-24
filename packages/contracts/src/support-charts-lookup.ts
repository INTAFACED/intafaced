/**
 * A support agent's read of a customer's price alerts, their trigger history and saved desk layouts (C-ops-03 (a),
 * J-charts-desk-19 #1), through svc-support and bound to a ticket the agent can see.
 *
 * The customer comes off the ticket row, never off the caller: `support.ticketChartsLookup` takes a ticket id and nothing
 * else (`.strict()`), so there is no way to ask about an arbitrary account. Every lookup writes ONE `charts_lookup` row on
 * the ticket's trail (the agent, the customer, the time) before anything is read; a lookup whose row did not land is
 * refused. Read-only: nothing here edits an alert or a layout, and nothing moves money.
 *
 * svc-support reads the alerts from svc-notify (`supportCharts.alerts`) and the layouts from svc-identity
 * (`GET /internal/desk-layouts/:userId`). Both doors admit svc-support alone. A plane that cannot be reached reads as
 * `unread` with its reason, never as an empty list: "no alerts" and "we could not look" are different facts.
 */
import { z } from 'zod';
import type { ServiceName } from './service-keys.js';
import { deskLayoutSchema } from './desk-layouts-preferences.js';

/** The tRPC path on svc-notify's root router. */
export const SUPPORT_CHARTS_ALERTS_PROCEDURE = 'supportCharts.alerts' as const;
/** svc-identity's internal read of one account's saved desk layouts. */
export const SUPPORT_DESK_LAYOUTS_PATH = '/internal/desk-layouts/:userId' as const;
export const supportDeskLayoutsPath = (userId: string): string => `/internal/desk-layouts/${encodeURIComponent(userId)}`;
/** The only service allowed to read either door. */
export const SUPPORT_CHARTS_READERS: readonly ServiceName[] = ['svc-support'];

/** Fixed bounds on one lookup, so a read of a large account stays one page. Not owner limits; `more` says when there are more. */
export const SUPPORT_CHARTS_ALERTS_MAX = 100;
export const SUPPORT_CHARTS_HISTORY_MAX = 100;

const at = z.string().datetime({ offset: true });
/** Decimal strings as svc-notify stores them; never a number. */
const decimal = z.string().min(1).max(64);
const condition = z.enum(['crossing', 'crossing_up', 'crossing_down', 'greater_than', 'less_than']);

/** One of the customer's alerts as the agent sees it. Their webhook address and channel choice are not shown. */
export const supportChartsAlertSchema = z
  .object({
    id: z.string().guid(),
    marketId: z.string().min(1),
    kind: z.enum(['price', 'funding', 'liquidation_proximity', 'whale']),
    condition,
    targetPrice: decimal,
    status: z.enum(['active', 'fired', 'cancelled', 'expired', 'stopped']),
    name: z.string().nullable(),
    source: z.enum(['mark', 'bid', 'ask', 'last']),
    frequency: z.enum(['once', 'every_crossing']),
    fireCount: z.number().int().min(0),
    createdAt: at,
    firedAt: at.nullable(),
    lastFiredAt: at.nullable(),
    expiresAt: at.nullable(),
  })
  .strict();
export type SupportChartsAlert = z.infer<typeof supportChartsAlertSchema>;

/** One time an alert fired, with the mark that fired it and what the alert asked for then. */
export const supportChartsTriggerSchema = z
  .object({
    alertId: z.string().guid(),
    seq: z.number().int().min(1),
    marketId: z.string().min(1),
    condition,
    targetPrice: decimal,
    markPrice: decimal,
    firedAt: at,
  })
  .strict();
export type SupportChartsTrigger = z.infer<typeof supportChartsTriggerSchema>;

/** The trigger history, or why it was not read: the owner has not set how long it is kept. */
export const supportChartsHistorySchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('read'),
      retentionDays: z.number().int().positive(),
      items: z.array(supportChartsTriggerSchema),
      more: z.boolean(),
    })
    .strict(),
  z.object({ status: z.literal('unread'), reason: z.literal('retention_unset') }).strict(),
]);
export type SupportChartsHistory = z.infer<typeof supportChartsHistorySchema>;

/** svc-notify's answer to svc-support: one account's alerts and their history. */
export const supportChartsAlertsReadSchema = z
  .object({
    userId: z.string().guid(),
    alerts: z.array(supportChartsAlertSchema),
    more: z.boolean(),
    history: supportChartsHistorySchema,
  })
  .strict();
export type SupportChartsAlertsRead = z.infer<typeof supportChartsAlertsReadSchema>;
export const supportChartsAlertsInputSchema = z.object({ userId: z.string().guid() }).strict();

/** svc-identity's answer to svc-support: the saved layouts and the one in use. No row is `layouts: []`, never an error. */
export const supportDeskLayoutsReadSchema = z
  .object({
    userId: z.string().guid(),
    layouts: z.array(deskLayoutSchema),
    active: z.string().nullable(),
  })
  .strict();
export type SupportDeskLayoutsRead = z.infer<typeof supportDeskLayoutsReadSchema>;

/** `plane_dark`: the owning service did not answer, or answered with a shape not its contract. `unwired`: no address or credential is set. */
const unread = z.object({ status: z.literal('unread'), reason: z.enum(['plane_dark', 'unwired']) }).strict();

export const supportChartsLookupInputSchema = z.object({ ticketId: z.string().guid() }).strict();
export type SupportChartsLookupInput = z.infer<typeof supportChartsLookupInputSchema>;

export const supportChartsLookupSchema = z
  .object({
    ticketId: z.string().guid(),
    /** The trail row this lookup wrote before anything was read. */
    audit: z.object({ sequence: z.number().int().positive(), agentId: z.string().guid(), customerId: z.string().guid(), at }).strict(),
    alerts: z.discriminatedUnion('status', [
      z
        .object({
          status: z.literal('read'),
          items: z.array(supportChartsAlertSchema),
          more: z.boolean(),
          history: supportChartsHistorySchema,
        })
        .strict(),
      unread,
    ]),
    layouts: z.discriminatedUnion('status', [
      z.object({ status: z.literal('read'), items: z.array(deskLayoutSchema), active: z.string().nullable() }).strict(),
      unread,
    ]),
  })
  .strict();
export type SupportChartsLookup = z.infer<typeof supportChartsLookupSchema>;

/** The trail note of a `charts_lookup` row: whose charts were read. */
export const chartsLookupNote = (customerId: string): string => `customer:${customerId}`;
