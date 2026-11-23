import { z } from 'zod';
import { defineProcedure, NO_INPUT, type Refusals } from './procedure.js';

/**
 * Our builder address's account mode at each venue (J-ops-console-28), for the founder console. A venue pays builder fees
 * only to a builder address in the mode it requires (Hyperliquid: "Builder code addresses must be in standard mode to
 * accrue builder fees"), so svc-trade reads the mode at every venue an order can be routed to, beside the mode the venue
 * requires, and alerts the owner's named contact once when it leaves that mode. Read only: nothing moves.
 */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;

/** The most recent alerts one read lists, newest first. */
export const BUILDER_MODE_ALERTS_LISTED = 50;

/** The mode as the venue reports it with the venue's time, or a read that failed: never read as in the required mode. */
export const builderModeReadSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('read'), mode: z.string().min(1), asOf: z.string() }),
  z.object({ status: z.literal('unknown'), code: z.string().min(1), message: z.string() }),
]);

/** The mode the venue requires to accrue builder fees: published, not published by the venue, or not read at all. */
export const builderModeRequiredSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('published'), mode: z.string().min(1) }),
  z.object({ status: z.literal('not_published') }),
  z.object({ status: z.literal('unknown') }),
]);

/**
 * - `required_mode`: the address is in the mode the venue requires, so the venue accrues our builder fees.
 * - `not_collected`: it is in another mode, so the venue collects no builder fees for us ("Builder fees not collected in this mode").
 * - `not_published`: the venue publishes no required mode, so nothing can be said.
 * - `unknown`: the mode could not be read.
 */
export const BUILDER_MODE_VERDICTS = ['required_mode', 'not_collected', 'not_published', 'unknown'] as const;

export const builderModeVenueSchema = z.object({
  venueId: z.string().min(1),
  displayName: z.string().nullable(),
  test: z.boolean(),
  builder: z.string().min(1),
  mode: builderModeReadSchema,
  required: builderModeRequiredSchema,
  verdict: z.enum(BUILDER_MODE_VERDICTS),
});

/** One episode of our builder address out of the required mode at one venue: opened once, cleared once it is back. */
export const builderModeAlertSchema = z.object({
  id: z.string().min(1),
  venueId: z.string().min(1),
  builder: z.string().min(1),
  modeSeen: z.string().min(1),
  requiredMode: z.string().min(1),
  /** The owner's named contact the alert went to. */
  contact: z.string().min(1),
  openedAt: z.string(),
  clearedAt: z.string().nullable(),
  clearedMode: z.string().nullable(),
});

/** Alerting is on with the owner's named contact, or refused while that contact is blank (no alert is invented). */
export const builderModeAlertingSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('on'), contact: z.string().min(1) }),
  z.object({ status: z.literal('refused'), code: z.literal('trade.builder_mode_alert_contact_unset'), message: z.string() }),
]);

export const builderAccountModeSchema = z.object({
  asOf: z.string(),
  builder: z.string().min(1),
  venues: z.array(builderModeVenueSchema),
  alerting: builderModeAlertingSchema,
  alerts: z.array(builderModeAlertSchema).max(BUILDER_MODE_ALERTS_LISTED),
});

const refuse = (map: Record<string, 'PRECONDITION_FAILED' | 'SERVICE_UNAVAILABLE'>): Refusals => Object.freeze(map);

/** `admin.builderFees.accountMode`: our builder address's mode at each venue, and its alerts. Staff who can read the console. */
export const TRADE_BUILDER_ACCOUNT_MODE = defineProcedure({
  ...base,
  name: 'trade.admin.builderFees.accountMode',
  kind: 'query',
  path: 'admin.builderFees.accountMode',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: refuse({
    'trade.user_venue_off': 'SERVICE_UNAVAILABLE',
    'trade.builder_address_unset': 'PRECONDITION_FAILED',
  }),
  input: NO_INPUT,
  output: builderAccountModeSchema,
  samples: [{ verdict: 'accept' }],
});
