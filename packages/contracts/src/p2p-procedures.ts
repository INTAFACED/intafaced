import { z } from 'zod';
import { defineProcedure, NO_INPUT, type ProcedureRecord, type Refusals, type RefusalStatus } from './procedure.js';

/**
 * svc-p2p's calls that are mounted from records, one record per call. The service mounts each from here
 * (`mountRecords`), so its path, guard, input, output and named refusals are this file, not its router. The rest of
 * svc-p2p's calls move here area by area, each with every caller, so no call has two ways at once.
 *
 * Calls guarded `merchantApi` also refuse an API key whose account is not an approved merchant (FORBIDDEN, no code):
 * standing is a live fact the service reads on each call, so the record names only the scope.
 */

const base = { service: 'svc-p2p', module: 'p2p', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'p2p:read', module: 'p2p' } as const;
const WRITE = { caller: 'scope', scope: 'p2p:write', module: 'p2p' } as const;

const refuse = (codes: Readonly<Record<string, RefusalStatus>> = {}): Refusals => Object.freeze({ ...codes });

const PEER = '22222222-2222-4222-8222-222222222222';

/** Amounts on the wire: unsigned decimal strings with at most 18 decimals. */
const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18dp');

/**
 * Health, a dispute and the backlog never probe a human moderator: named moderators are `configured` and unprobed,
 * none is `absent`.
 */
export const P2P_MODERATION = z.discriminatedUnion('status', [
  z.object({ status: z.literal('absent'), code: z.literal('p2p.moderation_unreachable') }),
  z.object({ status: z.literal('configured'), code: z.literal('p2p.moderation_unprobed') }),
]);

export const P2P_HEALTH = defineProcedure({
  ...base,
  name: 'p2p.health',
  kind: 'query',
  path: 'health',
  access: { caller: 'public' },
  refusals: refuse(),
  input: NO_INPUT,
  output: z.object({
    ok: z.boolean(),
    service: z.literal('svc-p2p'),
    /** True when `P2P_MODERATOR_USER_IDS` names at least one person. Config, not a live probe. */
    moderationConfigured: z.boolean(),
    moderation: P2P_MODERATION,
    /** False until an offer ceiling is set: the merchant badge buys no higher limit while none is. */
    offerLimitsConfigured: z.boolean(),
    offerLimitsPosture: z.enum(['unset', 'unlimited', 'configured']),
    /** Always false until the owner's key service seals instruments. */
    instrumentKmsConfigured: z.literal(false),
    /** `local-test` is a test seal, not a configured key service. */
    instrumentKeyProvider: z.enum(['none', 'local-test']),
  }),
  samples: [{ verdict: 'accept' }],
});

/** The enabled fiat currencies, from configuration: svc-p2p holds no currency table. */
export const P2P_FIAT_LIST = defineProcedure({
  ...base,
  name: 'p2p.fiat.list',
  kind: 'query',
  path: 'fiat.list',
  access: { caller: 'public' },
  refusals: refuse(),
  input: NO_INPUT,
  output: z.array(z.object({ code: z.string(), name: z.string(), symbol: z.string(), minorUnits: z.number().int() })),
  samples: [{ verdict: 'accept' }],
});

/** The published house fee, charged once on release off the released amount. Signed-out callers read it too. */
export const P2P_FEES_SCHEDULE = defineProcedure({
  ...base,
  name: 'p2p.fees.schedule',
  kind: 'query',
  path: 'fees.schedule',
  access: { caller: 'public' },
  refusals: refuse({ 'p2p.fee_bps_unset': 'PRECONDITION_FAILED', 'p2p.invalid_fee_bps': 'BAD_REQUEST' }),
  input: NO_INPUT,
  output: z.object({ feeBps: z.number().int().nonnegative(), chargedOn: z.literal('release'), basis: z.literal('released_amount') }),
  samples: [{ verdict: 'accept' }],
});

export const P2P_ELIGIBILITY_CHECK_IDS = ['verification', 'contact', 'jurisdiction', 'deposit'] as const;
export const P2P_ELIGIBILITY_STATES = ['met', 'not_met', 'unknown'] as const;

/** Each check before a take, in the service's order. `fix` is an app path, or null. */
export const P2P_ACCESS_ELIGIBILITY = defineProcedure({
  ...base,
  name: 'p2p.access.eligibility',
  kind: 'query',
  path: 'access.eligibility',
  access: { caller: 'scope', scope: 'p2p:read' },
  refusals: refuse({
    'p2p.contact_required': 'FORBIDDEN',
    'p2p.contact_unverifiable': 'PRECONDITION_FAILED',
    'p2p.take_gate_unwired': 'PRECONDITION_FAILED',
  }),
  input: NO_INPUT,
  output: z.object({
    checks: z.array(
      z.object({
        id: z.enum(P2P_ELIGIBILITY_CHECK_IDS),
        state: z.enum(P2P_ELIGIBILITY_STATES),
        reason: z.string(),
        fix: z.string().nullable(),
      }),
    ),
    canTake: z.boolean(),
  }),
  samples: [{ verdict: 'accept' }],
});

/**
 * How many of the caller's cancels count now, out of how many pause buying, when the earliest stops counting, and
 * until when buying is paused. A blank limit refuses `p2p.config_unset`. guard: merchantApi.
 */
export const P2P_ACCESS_LIMITS = defineProcedure({
  ...base,
  name: 'p2p.access.limits',
  kind: 'query',
  path: 'access.limits',
  access: READ,
  refusals: refuse({ 'p2p.config_unset': 'PRECONDITION_FAILED' }),
  input: NO_INPUT,
  output: z.object({
    cancels: z.object({
      used: z.number().int().nonnegative(),
      cap: z.number().int().positive(),
      windowHours: z.number().int().positive(),
      nextDropAt: z.string().datetime().nullable(),
      restrictedUntil: z.string().datetime().nullable(),
    }),
  }),
  samples: [{ verdict: 'accept' }],
});

/** The caller's own verification cap, in the table's one fiat. Neither invents a number. guard: merchantApi. */
export const P2P_LIMITS_VERIFICATION = defineProcedure({
  ...base,
  name: 'p2p.limits.verification',
  kind: 'query',
  path: 'limits.verification',
  access: READ,
  refusals: refuse({
    'p2p.verification_limits_unset': 'PRECONDITION_FAILED',
    'p2p.verification_limits_invalid': 'PRECONDITION_FAILED',
    'p2p.verification_level_unwired': 'PRECONDITION_FAILED',
  }),
  input: NO_INPUT,
  output: z.object({
    tier: z.enum(['none', 'basic', 'full', 'institutional']),
    currency: z.string().length(3),
    orderMin: amountString,
    orderMax: amountString,
    dailyMax: amountString,
    lifetimeMax: amountString,
    dailyUsed: amountString,
    lifetimeUsed: amountString,
    dailyRemaining: amountString,
    lifetimeRemaining: amountString,
  }),
  samples: [{ verdict: 'accept' }],
});

/**
 * Unpublished refuses `p2p.security_change_lock_unset`; published refuses `p2p.security_change_lock_unwired`, because
 * the change time is not on this principal. There is no `locked: false`. guard: merchantApi.
 */
export const P2P_LIMITS_SECURITY_CHANGE = defineProcedure({
  ...base,
  name: 'p2p.limits.securityChange',
  kind: 'query',
  path: 'limits.securityChange',
  access: READ,
  refusals: refuse({
    'p2p.security_change_lock_unset': 'PRECONDITION_FAILED',
    'p2p.invalid_security_change_lock': 'PRECONDITION_FAILED',
    'p2p.security_change_lock_unwired': 'PRECONDITION_FAILED',
  }),
  input: NO_INPUT,
  output: z.object({ seconds: z.number().int().positive() }),
  samples: [{ verdict: 'accept' }],
});

/** The account ids the caller follows and blocks: every contacts call answers with both whole lists. */
const contactsOutput = z.object({ following: z.array(z.string()), blocking: z.array(z.string()) });
/** `idempotencyKey` makes a repeat of the same change harmless. */
const contactChange = z.object({ peerId: z.string().guid(), idempotencyKey: z.string().min(8).max(128) });
const contactRefusals = refuse({
  'p2p.contact_self': 'FORBIDDEN',
  'p2p.block_open_order': 'CONFLICT',
  'p2p.idempotency_conflict': 'CONFLICT',
  'p2p.idempotency_in_progress': 'CONFLICT',
});
const contactSamples = [
  { verdict: 'accept', input: { peerId: PEER, idempotencyKey: 'contact-change-1' } },
  { verdict: 'refuse', input: { peerId: 'not-an-id', idempotencyKey: 'contact-change-1' } },
  { verdict: 'refuse', input: { peerId: PEER, idempotencyKey: 'short' } },
  { verdict: 'refuse', input: {} },
] as const;

/** guard: merchantApi. */
export const P2P_CONTACTS_LIST = defineProcedure({
  ...base,
  name: 'p2p.contacts.list',
  kind: 'query',
  path: 'contacts.list',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: contactsOutput,
  samples: [{ verdict: 'accept' }],
});

/** guard: merchantApi. */
export const P2P_CONTACTS_FOLLOW = defineProcedure({
  ...base,
  name: 'p2p.contacts.follow',
  kind: 'mutation',
  path: 'contacts.follow',
  access: WRITE,
  refusals: contactRefusals,
  input: contactChange,
  output: contactsOutput,
  samples: contactSamples,
});

/** guard: merchantApi. */
export const P2P_CONTACTS_UNFOLLOW = defineProcedure({
  ...base,
  name: 'p2p.contacts.unfollow',
  kind: 'mutation',
  path: 'contacts.unfollow',
  access: WRITE,
  refusals: contactRefusals,
  input: contactChange,
  output: contactsOutput,
  samples: contactSamples,
});

/** Blocking someone with an open order between you refuses `p2p.block_open_order`. guard: merchantApi. */
export const P2P_CONTACTS_BLOCK = defineProcedure({
  ...base,
  name: 'p2p.contacts.block',
  kind: 'mutation',
  path: 'contacts.block',
  access: WRITE,
  refusals: contactRefusals,
  input: contactChange,
  output: contactsOutput,
  samples: contactSamples,
});

/** guard: merchantApi. */
export const P2P_CONTACTS_UNBLOCK = defineProcedure({
  ...base,
  name: 'p2p.contacts.unblock',
  kind: 'mutation',
  path: 'contacts.unblock',
  access: WRITE,
  refusals: contactRefusals,
  input: contactChange,
  output: contactsOutput,
  samples: contactSamples,
});

/** Every svc-p2p call mounted from a record. */
export const P2P_PROCEDURES = [
  P2P_HEALTH,
  P2P_FIAT_LIST,
  P2P_FEES_SCHEDULE,
  P2P_ACCESS_ELIGIBILITY,
  P2P_ACCESS_LIMITS,
  P2P_LIMITS_VERIFICATION,
  P2P_LIMITS_SECURITY_CHANGE,
  P2P_CONTACTS_LIST,
  P2P_CONTACTS_FOLLOW,
  P2P_CONTACTS_UNFOLLOW,
  P2P_CONTACTS_BLOCK,
  P2P_CONTACTS_UNBLOCK,
] as const satisfies readonly ProcedureRecord[];
