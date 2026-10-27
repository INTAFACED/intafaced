/**
 * D26-P2-05 / ADR D-S-13 — broken-promise vs socket inventory.
 *
 * `WIRING_SOCKETS` already classifies every unwired end. This module is the
 * **closed catalog matrix** a test can execute: every catalog key is listed as
 * live (both ends mounted), socket (Class A|C), or broken_promise (Class B).
 *
 * Absence from `WIRING_SOCKETS` is not enough. A new event that nobody lists
 * would otherwise go silent-live. `EVENT_BUS_MATRIX` is the pin — adding a
 * catalog key without a row here is a type error and a red test.
 *
 * Do not invent consumers here. Classify from `WIRING_SOCKETS` + the gate's
 * mounted-vs-defined walk. Closing Class B is owner scope (crewMemberCreated).
 *
 * Mounted-vs-defined wiring is still the job of `tooling/ci/event-wiring.mjs`.
 */

import { EVENT_CATALOG, WIRING_SOCKETS, type EventName, type SocketClass, type WiringSocket } from './catalog.js';

export type WiringEnd = 'publisher' | 'subscriber';

/** How an event end is accounted for in the completeness inventory. */
export type EndDisposition =
  | { readonly kind: 'live' }
  | { readonly kind: 'socket'; readonly socketClass: 'A' | 'C'; readonly socket: WiringSocket }
  | { readonly kind: 'broken_promise'; readonly socketClass: 'B'; readonly socket: WiringSocket };

/** How a catalog key (not an end) is accounted for. */
export type CatalogDisposition =
  | { readonly kind: 'live' }
  | { readonly kind: 'socket'; readonly socketClass: 'A' | 'C' }
  | { readonly kind: 'broken_promise'; readonly socketClass: 'B' };

export interface EventEndRow {
  readonly event: EventName;
  readonly end: WiringEnd;
  readonly disposition: EndDisposition;
}

export interface CatalogKindRow {
  readonly event: EventName;
  readonly disposition: CatalogDisposition;
}

export interface BusCompletenessInventory {
  /** Every catalog event name, stable Object.keys order. */
  readonly events: readonly EventName[];
  /** 2 × events.length rows — publisher and subscriber for each. */
  readonly ends: readonly EventEndRow[];
  /** One row per catalog key — live | socket | broken_promise. */
  readonly catalog: readonly CatalogKindRow[];
  /** Catalog keys classified live (neither end on WIRING_SOCKETS). */
  readonly live: readonly EventName[];
  /** Class A or C — true sockets (record ahead / disclosed gap). */
  readonly sockets: readonly WiringSocket[];
  /** Catalog keys whose missing end is a true socket. */
  readonly socketEvents: readonly EventName[];
  /** Class B — promise with no delivery. Not a socket. */
  readonly brokenPromises: readonly WiringSocket[];
  /** Catalog keys whose missing end is Class B. */
  readonly brokenPromiseEvents: readonly EventName[];
  /** @deprecated Use `live`. Kept so older pins still compile. */
  readonly presumedFullyWired: readonly EventName[];
}

const ENDS: readonly WiringEnd[] = ['publisher', 'subscriber'];

/**
 * Closed matrix: every `EventName` appears exactly once.
 *
 * Live means the event-wiring gate must prove both ends mount — not "a consumer
 * we wish existed". Socket / broken_promise rows must match `WIRING_SOCKETS`.
 */
export const EVENT_BUS_MATRIX = {
  xpEarned: { kind: 'live' },
  rankUpdated: { kind: 'live' },
  userCreated: { kind: 'socket', socketClass: 'A' },
  kycApproved: { kind: 'live' },
  kycSubmitted: { kind: 'socket', socketClass: 'A' },
  kycRejected: { kind: 'socket', socketClass: 'A' },
  kycInfoRequested: { kind: 'socket', socketClass: 'A' },
  securityFactorChanged: { kind: 'live' },
  deathNoticeCreated: { kind: 'socket', socketClass: 'A' },
  deathNoticeConfirmed: { kind: 'socket', socketClass: 'A' },
  ledgerTxPosted: { kind: 'socket', socketClass: 'A' },
  ledgerReconciliationFailed: { kind: 'socket', socketClass: 'A' },
  ledgerReconciliationRunFailed: { kind: 'socket', socketClass: 'A' },
  ledgerFreezeUpdated: { kind: 'live' },
  coreOpsAlertRuleUpdated: { kind: 'socket', socketClass: 'A' },
  coreOpsAlertOpened: { kind: 'socket', socketClass: 'A' },
  coreOpsAlertResolved: { kind: 'socket', socketClass: 'A' },
  coreOpsAlertPolicyUpdated: { kind: 'socket', socketClass: 'A' },
  coreOpsAlertGroupOpened: { kind: 'socket', socketClass: 'A' },
  coreOpsAlertGroupUpdated: { kind: 'socket', socketClass: 'A' },
  coreOpsAlertGroupResolved: { kind: 'socket', socketClass: 'A' },
  coreOpsComplianceCaseCreated: { kind: 'socket', socketClass: 'A' },
  coreOpsComplianceInboxUpdated: { kind: 'socket', socketClass: 'A' },
  coreOpsRestoreStarted: { kind: 'socket', socketClass: 'A' },
  coreOpsRestoreCompleted: { kind: 'socket', socketClass: 'A' },
  coreOpsRestoreFailed: { kind: 'socket', socketClass: 'A' },
  payCustodyAuditCreated: { kind: 'socket', socketClass: 'A' },
  payDepositCreditPosted: { kind: 'live' },
  stakeCreated: { kind: 'live' },
  buybackExecuted: { kind: 'socket', socketClass: 'A' },
  bankMarginCalled: { kind: 'live' },
  personalRequestCreated: { kind: 'live' },
  personalRequestSettled: { kind: 'live' },
  personalTransferPosted: { kind: 'live' },
  personalRefundPosted: { kind: 'socket', socketClass: 'A' },
  personalDisputeUpdated: { kind: 'socket', socketClass: 'A' },
  bankScheduledReminder: { kind: 'live' },
  bankScheduledFailed: { kind: 'live' },
  blueprintCreated: { kind: 'live' },
  blueprintDeleted: { kind: 'live' },
  crewMemberCreated: { kind: 'broken_promise', socketClass: 'B' },
  orderAccepted: { kind: 'socket', socketClass: 'A' },
  orderFilled: { kind: 'live' },
  orderCancelled: { kind: 'live' },
  orderTriggered: { kind: 'live' },
  spreadFilled: { kind: 'socket', socketClass: 'A' },
  orderUpdated: { kind: 'live' },
  fillSettled: { kind: 'live' },
  positionUpdated: { kind: 'live' },
  protocolAccountCreated: { kind: 'socket', socketClass: 'A' },
  protocolSessionKeyCreated: { kind: 'socket', socketClass: 'A' },
  protocolSessionKeyCancelled: { kind: 'socket', socketClass: 'A' },
  agentActionCompleted: { kind: 'live' },
  agentActionRejected: { kind: 'live' },
  agentUsageSettled: { kind: 'socket', socketClass: 'A' },
  p2pOfferCreated: { kind: 'socket', socketClass: 'A' },
  p2pEscrowLocked: { kind: 'live' },
  p2pEscrowReleased: { kind: 'live' },
  p2pEscrowRefunded: { kind: 'live' },
  p2pTradeDisputed: { kind: 'live' },
  p2pDisputeResolved: { kind: 'socket', socketClass: 'A' },
  p2pTradeExpired: { kind: 'socket', socketClass: 'A' },
  p2pTradeFiatSent: { kind: 'live' },
  p2pTradeReminderSent: { kind: 'socket', socketClass: 'A' },
  p2pOfferPaused: { kind: 'socket', socketClass: 'A' },
  p2pRemarkCaseOpened: { kind: 'socket', socketClass: 'A' },
  p2pChatMessageSent: { kind: 'socket', socketClass: 'A' },
  p2pDisputeEscalated: { kind: 'socket', socketClass: 'A' },
  p2pQuoteExpired: { kind: 'socket', socketClass: 'A' },
  projectionUpdated: { kind: 'socket', socketClass: 'A' },
  supportTicketResolved: { kind: 'live' },
} as const satisfies Record<EventName, CatalogDisposition>;

/**
 * ADR D-S-13: Class B is a broken promise; A and C are sockets.
 * An unclassified entry is a type error upstream (`WiringSocket.class`).
 */
export function dispositionOf(socket: WiringSocket): EndDisposition {
  if (socket.class === 'B') {
    return { kind: 'broken_promise', socketClass: 'B', socket };
  }
  return { kind: 'socket', socketClass: socket.class, socket };
}

export function socketFor(event: EventName, end: WiringEnd): WiringSocket | undefined {
  return WIRING_SOCKETS.find((s) => s.event === event && s.missing === end);
}

export function catalogDispositionOf(event: EventName): CatalogDisposition {
  return EVENT_BUS_MATRIX[event] as CatalogDisposition;
}

/**
 * Build the full broken-promise vs socket inventory from the catalog.
 * Pure data — no filesystem, no NATS. Safe to call from unit tests.
 */
export function buildBusCompletenessInventory(): BusCompletenessInventory {
  const events = Object.keys(EVENT_CATALOG) as EventName[];
  const ends: EventEndRow[] = [];

  for (const event of events) {
    for (const end of ENDS) {
      const socket = socketFor(event, end);
      ends.push({
        event,
        end,
        disposition: socket ? dispositionOf(socket) : { kind: 'live' },
      });
    }
  }

  const catalog: CatalogKindRow[] = events.map((event) => ({
    event,
    disposition: catalogDispositionOf(event),
  }));

  // Prefer `!== 'B'` over `=== 'A' || === 'C'`: when the live catalog has no Class C
  // rows, TypeScript narrows the const array's class union to 'A' | 'B' and rejects
  // a `'C'` comparison as intentional-unreachability — which would break the
  // day a Class C socket is added.
  const sockets = WIRING_SOCKETS.filter((s) => s.class !== 'B');
  const brokenPromises = WIRING_SOCKETS.filter((s) => s.class === 'B');
  const live = events.filter((event) => catalogDispositionOf(event).kind === 'live');
  const socketEvents = events.filter((event) => catalogDispositionOf(event).kind === 'socket');
  const brokenPromiseEvents = events.filter((event) => catalogDispositionOf(event).kind === 'broken_promise');

  return {
    events,
    ends,
    catalog,
    live,
    sockets,
    socketEvents,
    brokenPromises,
    brokenPromiseEvents,
    presumedFullyWired: live,
  };
}

/** Compact keys for pin assertions — same shape as event-wiring's Class B list. */
export function brokenPromiseKeys(inventory = buildBusCompletenessInventory()): readonly string[] {
  return inventory.brokenPromises.map((s) => `${s.event}::${s.missing}`);
}

export function socketKeys(inventory = buildBusCompletenessInventory()): readonly string[] {
  return inventory.sockets.map((s) => `${s.event}::${s.missing}`);
}

export function liveEventKeys(inventory = buildBusCompletenessInventory()): readonly EventName[] {
  return inventory.live.slice();
}

export function countByClass(inventory = buildBusCompletenessInventory()): Record<SocketClass, number> {
  const counts: Record<SocketClass, number> = { A: 0, B: 0, C: 0 };
  for (const s of [...inventory.sockets, ...inventory.brokenPromises]) {
    counts[s.class] += 1;
  }
  return counts;
}

export function countByCatalogKind(inventory = buildBusCompletenessInventory()): {
  live: number;
  socket: number;
  broken_promise: number;
} {
  return {
    live: inventory.live.length,
    socket: inventory.socketEvents.length,
    broken_promise: inventory.brokenPromiseEvents.length,
  };
}
