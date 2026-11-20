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

const TRADE = '44444444-4444-4444-8444-444444444444';
const tradeId = z.object({ tradeId: z.string().guid() });
/** A trade the caller is not a party to reads as missing, so a probe cannot tell the two apart. */
const TRADE_NOT_FOUND = { 'p2p.trade_not_found': 'NOT_FOUND' } as const;

/** One message in a trade chat, oldest first. `clientId` is the sender's idempotency key. */
const chatMessage = z.object({
  id: z.string().guid(),
  tradeId: z.string().guid(),
  senderId: z.string(),
  clientId: z.string(),
  text: z.string(),
  createdAt: z.string(),
});

/**
 * A page of one trade's chat after `cursor`. A page that ends the thread marks it read for the caller. A blank page
 * size refuses `p2p.chat_list_limit_unset`. The parties read it, and a moderator while a dispute is open. guard:
 * merchantApi.
 */
export const P2P_CHAT_MESSAGES_LIST = defineProcedure({
  ...base,
  name: 'p2p.chat.messages.list',
  kind: 'query',
  path: 'chat.messages.list',
  access: READ,
  refusals: refuse({ ...TRADE_NOT_FOUND, 'p2p.chat_list_limit_unset': 'PRECONDITION_FAILED' }),
  input: z.object({
    tradeId: z.string().guid(),
    cursor: z.string().guid().nullable().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.object({ messages: z.array(chatMessage), nextCursor: z.string().nullable(), unread: z.number().int().nonnegative() }),
  samples: [
    { verdict: 'accept', input: { tradeId: TRADE, limit: 100 } },
    { verdict: 'refuse', input: { tradeId: TRADE, limit: 0 } },
    { verdict: 'refuse', input: { tradeId: 'not-an-id' } },
  ],
});

/**
 * Any attachment a caller may send: an object, a list of plain values or objects, or a plain value. All of them refuse
 * `p2p.chat_attachment_unwired`, because no object store is wired; the shape is named only so the record exports.
 */
const plain = [z.string(), z.number(), z.boolean(), z.null()] as const;
const attachmentShape = z.union([z.object({}), z.array(z.union([z.object({}), ...plain])), ...plain]);

/**
 * Sends one message. The same `clientId` from the same sender stores it once (`created: false` the second time). It
 * needs `p2p:write`, except a moderator's on a trade whose dispute is open (FORBIDDEN, no code). No object store is
 * wired, so any attachment refuses before a row is written. `notify` says whether the other side was told. guard:
 * merchantApi.
 */
export const P2P_CHAT_MESSAGES_SEND = defineProcedure({
  ...base,
  name: 'p2p.chat.messages.send',
  kind: 'mutation',
  path: 'chat.messages.send',
  access: READ,
  refusals: refuse({
    ...TRADE_NOT_FOUND,
    'p2p.chat_attachment_unwired': 'PRECONDITION_FAILED',
    'p2p.blocked': 'FORBIDDEN',
    'p2p.chat_text_required': 'BAD_REQUEST',
    'p2p.idempotency_conflict': 'CONFLICT',
    'p2p.idempotency_in_progress': 'CONFLICT',
  }),
  input: z.object({
    tradeId: z.string().guid(),
    text: z.string().min(1).max(2000),
    clientId: z.string().min(1).max(128),
    attachment: attachmentShape.optional(),
  }),
  output: chatMessage.extend({
    created: z.boolean(),
    notify: z.object({
      delivered: z.boolean(),
      code: z.enum(['p2p.chat_notify_delivered', 'p2p.chat_notify_unwired', 'p2p.chat_notify_failed']),
    }),
  }),
  samples: [
    { verdict: 'accept', input: { tradeId: TRADE, text: 'hello', clientId: 'client-1' } },
    { verdict: 'refuse', input: { tradeId: TRADE, text: '', clientId: 'client-1' } },
    { verdict: 'refuse', input: { tradeId: TRADE, text: 'hello' } },
  ],
});

/** Messages from the other side the caller has not read, for one trade. guard: merchantApi. */
export const P2P_CHAT_UNREAD = defineProcedure({
  ...base,
  name: 'p2p.chat.unread',
  kind: 'query',
  path: 'chat.unread',
  access: READ,
  refusals: refuse(TRADE_NOT_FOUND),
  input: tradeId,
  output: z.object({ tradeId: z.string().guid(), unread: z.number().int().nonnegative() }),
  samples: [
    { verdict: 'accept', input: { tradeId: TRADE } },
    { verdict: 'refuse', input: { tradeId: 'not-an-id' } },
  ],
});

/**
 * One good or bad review per party of a released trade. Someone who is neither its author nor its subject reads no
 * trade id, author or hide reason (`reviews.list`).
 */
export const P2P_REVIEW = z.object({
  id: z.string().guid(),
  tradeId: z.string().guid().nullable(),
  authorId: z.string().nullable(),
  subjectId: z.string(),
  rating: z.enum(['good', 'bad']),
  comment: z.string(),
  explanation: z.string().nullable(),
  reply: z.string().nullable(),
  repliedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  hidden: z.boolean(),
  hiddenReason: z.string().nullable(),
});
const reviewText = z.string().max(2000);

/** A second leave returns the first, unchanged. A bad review needs an explanation. guard: merchantApi. */
export const P2P_REVIEWS_LEAVE = defineProcedure({
  ...base,
  name: 'p2p.reviews.leave',
  kind: 'mutation',
  path: 'reviews.leave',
  access: WRITE,
  refusals: refuse({
    ...TRADE_NOT_FOUND,
    'p2p.review_not_eligible': 'BAD_REQUEST',
    'p2p.explanation_required': 'BAD_REQUEST',
    'p2p.idempotency_in_progress': 'CONFLICT',
  }),
  input: z.object({
    tradeId: z.string().guid(),
    rating: z.enum(['good', 'bad']),
    comment: reviewText.optional(),
    explanation: reviewText.optional(),
  }),
  output: P2P_REVIEW,
  samples: [
    { verdict: 'accept', input: { tradeId: TRADE, rating: 'good', comment: 'Paid on time' } },
    { verdict: 'refuse', input: { tradeId: TRADE, rating: 'fine' } },
    { verdict: 'refuse', input: { tradeId: TRADE } },
  ],
});

/**
 * Rewrites one's own review inside the owner's edit window: a blank window refuses `p2p.config_unset`; one with a reply
 * or a hide, or past the window, refuses `p2p.review_not_eligible`. guard: merchantApi.
 */
export const P2P_REVIEWS_EDIT = defineProcedure({
  ...base,
  name: 'p2p.reviews.edit',
  kind: 'mutation',
  path: 'reviews.edit',
  access: WRITE,
  refusals: refuse({
    'p2p.config_unset': 'PRECONDITION_FAILED',
    'p2p.review_not_eligible': 'BAD_REQUEST',
    'p2p.explanation_required': 'BAD_REQUEST',
  }),
  input: z.object({
    tradeId: z.string().guid(),
    rating: z.enum(['good', 'bad']).optional(),
    comment: reviewText.optional(),
    explanation: reviewText.optional(),
  }),
  output: P2P_REVIEW,
  samples: [
    { verdict: 'accept', input: { tradeId: TRADE, comment: 'Paid on time' } },
    { verdict: 'refuse', input: { tradeId: TRADE, rating: 'fine' } },
  ],
});

/** One reply from the person a review is about. guard: merchantApi. */
export const P2P_REVIEWS_REPLY = defineProcedure({
  ...base,
  name: 'p2p.reviews.reply',
  kind: 'mutation',
  path: 'reviews.reply',
  access: WRITE,
  refusals: refuse({ 'p2p.reason_required': 'BAD_REQUEST', 'p2p.review_not_eligible': 'BAD_REQUEST', 'p2p.review_exists': 'CONFLICT' }),
  input: z.object({ tradeId: z.string().guid(), text: reviewText }),
  output: P2P_REVIEW,
  samples: [
    { verdict: 'accept', input: { tradeId: TRADE, text: 'Thank you' } },
    { verdict: 'refuse', input: { tradeId: TRADE } },
  ],
});

/**
 * Reviews about one person, newest first. A blocked pair reads neither the reviews nor the card (`p2p.blocked`). The
 * page size is never invented: a missing one refuses `p2p.review_list_limit_unset`. guard: merchantApi.
 */
export const P2P_REVIEWS_LIST = defineProcedure({
  ...base,
  name: 'p2p.reviews.list',
  kind: 'query',
  path: 'reviews.list',
  access: READ,
  refusals: refuse({
    'p2p.blocked': 'FORBIDDEN',
    'p2p.review_list_limit_unset': 'PRECONDITION_FAILED',
    'p2p.cursor_invalid': 'BAD_REQUEST',
  }),
  input: z.object({
    userId: z.string().guid(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().max(200).nullable().optional(),
  }),
  output: z.object({ reviews: z.array(P2P_REVIEW), nextCursor: z.string().nullable() }),
  samples: [
    { verdict: 'accept', input: { userId: PEER, limit: 20 } },
    { verdict: 'refuse', input: { userId: PEER, limit: 500 } },
    { verdict: 'refuse', input: { userId: 'not-an-id', limit: 20 } },
  ],
});

/** The order page's review panel: the caller's own review of this trade and the visible one about them. guard: merchantApi. */
export const P2P_REVIEWS_FOR_TRADE = defineProcedure({
  ...base,
  name: 'p2p.reviews.forTrade',
  kind: 'query',
  path: 'reviews.forTrade',
  access: READ,
  refusals: refuse(TRADE_NOT_FOUND),
  input: tradeId,
  output: z.object({ mine: P2P_REVIEW.nullable(), theirs: P2P_REVIEW.nullable() }),
  samples: [
    { verdict: 'accept', input: { tradeId: TRADE } },
    { verdict: 'refuse', input: { tradeId: 'not-an-id' } },
  ],
});

/** A moderator hides a review, and the audit row commits with the hide. A person rules, never a key. guard: merchantApi. */
export const P2P_REVIEWS_MODERATE = defineProcedure({
  ...base,
  name: 'p2p.reviews.moderate',
  kind: 'mutation',
  path: 'reviews.moderate',
  access: READ,
  refusals: refuse({
    'p2p.not_a_moderator': 'FORBIDDEN',
    'p2p.moderation_unreachable': 'PRECONDITION_FAILED',
    'p2p.ruling_not_attributed': 'BAD_REQUEST',
    'p2p.reason_required': 'BAD_REQUEST',
    'p2p.review_not_eligible': 'BAD_REQUEST',
  }),
  input: z.object({ reviewId: z.string().guid(), reason: z.string().min(1).max(2000) }),
  output: P2P_REVIEW,
  samples: [
    { verdict: 'accept', input: { reviewId: TRADE, reason: 'Abusive words' } },
    { verdict: 'refuse', input: { reviewId: TRADE, reason: '' } },
  ],
});

/** A person's one completion appeal: one escrowed order that ended cancelled or disputed, decided once by support. */
export const P2P_COMPLETION_APPEAL = z.object({
  id: z.string().guid(),
  userId: z.string(),
  tradeId: z.string().guid(),
  reason: z.string(),
  status: z.enum(['submitted', 'accepted', 'rejected']),
  submittedAt: z.string(),
  reviewDueAt: z.string(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
});

/** The caller's one completion appeal, or null while it is still available. guard: merchantApi. */
export const P2P_REPUTATION_MY_APPEAL = defineProcedure({
  ...base,
  name: 'p2p.reputation.myAppeal',
  kind: 'query',
  path: 'reputation.myAppeal',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: P2P_COMPLETION_APPEAL.nullable(),
  samples: [{ verdict: 'accept' }],
});

/**
 * Appeals one cancelled or disputed escrowed order, once ever. The same appeal sent again returns it; any other second
 * one refuses `p2p.appeal_used`. A blank review window refuses `p2p.config_unset`. guard: merchantApi.
 */
export const P2P_REPUTATION_APPEAL = defineProcedure({
  ...base,
  name: 'p2p.reputation.appeal',
  kind: 'mutation',
  path: 'reputation.appeal',
  access: WRITE,
  refusals: refuse({
    ...TRADE_NOT_FOUND,
    'p2p.config_unset': 'PRECONDITION_FAILED',
    'p2p.reason_required': 'BAD_REQUEST',
    'p2p.appeal_used': 'CONFLICT',
    'p2p.appeal_not_eligible': 'BAD_REQUEST',
  }),
  input: z.object({ tradeId: z.string().guid(), reason: z.string().max(2000) }),
  output: P2P_COMPLETION_APPEAL,
  samples: [
    { verdict: 'accept', input: { tradeId: TRADE, reason: 'The buyer never answered' } },
    { verdict: 'refuse', input: { tradeId: TRADE } },
  ],
});

/**
 * Support decides one submitted appeal, once, with MFA (UNAUTHORIZED `mfa.required` without it). The actor is the
 * principal, never the body, so the audit row names who decided. Nobody decides their own.
 */
export const P2P_REPUTATION_DECIDE_APPEAL = defineProcedure({
  ...base,
  name: 'p2p.reputation.decideAppeal',
  kind: 'mutation',
  path: 'reputation.decideAppeal',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'p2p' },
  refusals: refuse({
    'p2p.reason_required': 'BAD_REQUEST',
    'p2p.appeal_not_found': 'NOT_FOUND',
    'p2p.appeal_self_decision': 'FORBIDDEN',
    'p2p.appeal_decided': 'CONFLICT',
  }),
  input: z.object({ appealId: z.string().guid(), decision: z.enum(['accepted', 'rejected']), reason: z.string().max(2000) }),
  output: P2P_COMPLETION_APPEAL,
  samples: [
    { verdict: 'accept', input: { appealId: TRADE, decision: 'accepted', reason: 'The order was the buyer’s fault' } },
    { verdict: 'refuse', input: { appealId: TRADE, decision: 'maybe', reason: 'x' } },
  ],
});

const int4 = z.number().int().nonnegative().max(2147483647);
/** The reputation card's counts as a caller holds them: Postgres integers, never negative, and a rate from 0 to 1. */
const reputationCounts = z.object({
  tradesTotal: int4,
  completed: int4,
  cancelled: int4,
  disputed: int4,
  disputesLost: int4,
  avgReleaseSecs: int4,
  completionRate: z.number().min(0).max(1),
});
const percent = z
  .string()
  .regex(/^\d{1,3}\.\d{2}$/)
  .nullable();

/**
 * The numbers a counterparty sees before they trade with someone, the same ones that raise limits elsewhere. A blocked
 * pair reads no card (`p2p.blocked`); someone identity does not know and this service never traded with refuses
 * `p2p.user_not_found`. guard: merchantApi.
 */
export const P2P_REPUTATION_GET = defineProcedure({
  ...base,
  name: 'p2p.reputation.get',
  kind: 'query',
  path: 'reputation.get',
  access: READ,
  refusals: refuse({
    'p2p.blocked': 'FORBIDDEN',
    'p2p.user_not_found': 'NOT_FOUND',
    'p2p.public_profile_unavailable': 'PRECONDITION_FAILED',
  }),
  input: z.object({ userId: z.string().guid() }),
  output: z.object({
    tradesTotal: z.number().int(),
    completed: z.number().int(),
    cancelled: z.number().int(),
    disputed: z.number().int(),
    disputesLost: z.number().int(),
    completionRate: z.number(),
    avgReleaseSecs: z.number().int(),
    badges: z.array(z.string()),
    /** Null when identity has not published a public profile to this service. */
    handle: z.string().nullable(),
    /** ISO timestamp from identity. Null when that read is unwired or absent. */
    memberSince: z.string().nullable(),
    profile: z.object({
      status: z.enum(['unwired', 'found', 'absent']),
      code: z.enum(['p2p.public_profile_unwired', 'p2p.public_profile_found', 'p2p.public_profile_absent']),
    }),
    /** Released trades this person was a party to in the last 30 days. */
    trades30d: z.number().int().nonnegative(),
    /** Decimal-string percents ("95.24"); null when nothing is counted. What they count is `completionDefinition`. */
    completionRate30d: percent,
    completionRateTotal: percent,
    completionDefinition: z.object({ numerator: z.string(), denominator: z.string(), window30d: z.string(), noHistory: z.string() }),
    /** Buyer side: average seconds from escrow lock to "marked paid". Null with no sample, never 0-as-fast. */
    avgPaySecs: z.number().int().nonnegative().nullable(),
    /** Visible good and bad reviews about this person. Null when none is visible: a hidden review is not a zero. */
    rating: z.object({ good: z.number().int().nonnegative(), bad: z.number().int().nonnegative() }).nullable(),
    /** Identity verification level only (no documents). Null when identity has not published it. */
    verification: z.object({ level: z.string().min(1) }).nullable(),
    /**
     * True only for an approved merchant: an application, a suspension and a withdrawal read false, because the badge
     * is a claim to a stranger about to send money. Null when the programme is not enabled here.
     */
    merchant: z.boolean().nullable(),
  }),
  accept: {
    counts: {
      says: 'every count is a non-negative 32-bit integer and the completion rate is a fraction from 0 to 1',
      holds: (reply) => reputationCounts.safeParse(reply).success,
    },
    consistent: {
      says: 'completed plus cancelled is at most the trades total, and disputes lost are at most the disputes',
      holds: (reply) => {
        const r = reputationCounts.safeParse(reply);
        return r.success && r.data.completed + r.data.cancelled <= r.data.tradesTotal && r.data.disputesLost <= r.data.disputed;
      },
    },
  },
  samples: [
    { verdict: 'accept', input: { userId: PEER } },
    { verdict: 'refuse', input: { userId: 'not-an-id' } },
  ],
});

/** P-ads-merchant-08: how a merchant is on the board: always, never, or in their weekly windows. */
export const PRESENCE_MODES = ['online', 'offline', 'scheduled'] as const;
/** The most weekly windows one schedule holds. */
export const MAX_PRESENCE_WINDOWS = 28;
/** What an open order waits on: the buyer's payment, the seller's release, the other side, or a dispute. */
export const TODO_KINDS = ['payment_required', 'release_required', 'counterparty_action', 'dispute_open'] as const;
/** P-ads-merchant-12: the checks posting an ad in one fiat makes, and their states. */
export const POSTING_CHECK_IDS = ['kyc_tier', 'completed_orders', 'completion_rate'] as const;
export const POSTING_CHECK_STATES = ['met', 'not_met', 'unknown'] as const;
/** What compliance published for a fiat: thresholds, none at all, nothing yet, or a list that does not parse. */
export const POSTING_POLICIES = ['thresholds', 'none', 'unset', 'invalid'] as const;
const MERCHANT_STATUSES = ['applied', 'approved', 'rejected', 'suspended', 'withdrawn'] as const;

/**
 * The merchant programme's calls. When the deployment has no programme wired, each call that reads standing refuses
 * PRECONDITION_FAILED with no code: not wired is not an empty programme.
 */
const ADMIN = { caller: 'scope', scope: 'admin:compliance', module: 'p2p' } as const;
const APPROVAL_REFUSALS = {
  'action_approval.identity_unwired': 'PRECONDITION_FAILED',
  'action_approval.missing': 'PRECONDITION_FAILED',
  'action_approval.consume_failed': 'PRECONDITION_FAILED',
} as const;
const TRANSITION_REFUSALS = {
  'p2p.merchant_reason_required': 'BAD_REQUEST',
  'p2p.merchant_not_found': 'NOT_FOUND',
  'p2p.merchant_transition_invalid': 'CONFLICT',
  'p2p.merchant_ineligible': 'BAD_REQUEST',
} as const;

/** A person's presence, as the console shows it. `nextChangeAt` is when a schedule next puts them on or off the board. */
/** What every caller checks of a presence: its times are real ISO date-times. */
const presenceTimes = z.object({
  nextChangeAt: z.iso.datetime({ offset: true }).nullable(),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
});
/** What every caller checks of a to-do: a real deadline, and a link to one order's page. */
const todoLinks = z.object({
  items: z.array(
    z.object({
      deadlineAt: z.iso.datetime({ offset: true }).nullable(),
      link: z.string().regex(/^\/uc\/order\?tradeId=[0-9a-f-]{36}$/),
    }),
  ),
});
const presence = z.object({
  mode: z.enum(PRESENCE_MODES),
  timezone: z.string(),
  windows: z.array(z.object({ day: z.number().int(), start: z.string(), end: z.string() })),
  onBoard: z.boolean(),
  nextChangeAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

/** One person's standing in the merchant programme, with the reputation it was applied on. */
export const P2P_MERCHANT = z.object({
  userId: z.string(),
  status: z.enum(MERCHANT_STATUSES),
  appliedCompletionRate: z.number(),
  appliedTradesTotal: z.number().int(),
  appliedAt: z.string(),
  decidedAt: z.string().nullable(),
});

/** Offline, or scheduled outside every window, takes the caller's ads off the board; open orders carry on. guard: merchantApi. */
export const P2P_MERCHANTS_PRESENCE = defineProcedure({
  ...base,
  name: 'p2p.merchants.presence',
  kind: 'query',
  path: 'merchants.presence',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: presence,
  accept: {
    times: {
      says: 'nextChangeAt and updatedAt are ISO 8601 date-times, or null',
      holds: (reply) => presenceTimes.safeParse(reply).success,
    },
  },
  samples: [{ verdict: 'accept' }],
});

/** A schedule that is not a valid week refuses `p2p.schedule_invalid`. guard: merchantApi. */
export const P2P_MERCHANTS_SET_PRESENCE = defineProcedure({
  ...base,
  name: 'p2p.merchants.setPresence',
  kind: 'mutation',
  path: 'merchants.setPresence',
  access: WRITE,
  refusals: refuse({ 'p2p.schedule_invalid': 'BAD_REQUEST' }),
  input: z.object({
    mode: z.enum(PRESENCE_MODES),
    timezone: z.string().min(1).max(64).optional(),
    windows: z
      .array(z.object({ day: z.number().int().min(1).max(7), start: z.string().max(5), end: z.string().max(5) }))
      .max(MAX_PRESENCE_WINDOWS)
      .optional(),
  }),
  output: presence,
  accept: {
    times: {
      says: 'nextChangeAt and updatedAt are ISO 8601 date-times, or null',
      holds: (reply) => presenceTimes.safeParse(reply).success,
    },
  },
  samples: [
    { verdict: 'accept', input: { mode: 'scheduled', timezone: 'Europe/Berlin', windows: [{ day: 1, start: '09:00', end: '17:00' }] } },
    { verdict: 'refuse', input: { mode: 'away' } },
    { verdict: 'refuse', input: { mode: 'scheduled', windows: [{ day: 8, start: '09:00', end: '17:00' }] } },
  ],
});

/** The caller's open orders that wait on someone, soonest deadline first, each linking to its order. guard: merchantApi. */
export const P2P_MERCHANTS_TODOS = defineProcedure({
  ...base,
  name: 'p2p.merchants.todos',
  kind: 'query',
  path: 'merchants.todos',
  access: READ,
  refusals: refuse(),
  input: z.object({ limit: z.number().int().min(1).max(200) }),
  output: z.object({
    items: z.array(
      z.object({
        kind: z.enum(TODO_KINDS),
        tradeId: z.string(),
        role: z.enum(['buyer', 'seller']),
        status: z.string(),
        asset: z.string(),
        amount: amountString,
        fiatCurrency: z.string(),
        fiatAmount: amountString,
        deadlineAt: z.string().nullable(),
        link: z.string(),
      }),
    ),
  }),
  accept: {
    orders: {
      says: 'each deadline is an ISO 8601 date-time or null, and each link is the order page of one trade',
      holds: (reply) => todoLinks.safeParse(reply).success,
    },
  },
  samples: [
    { verdict: 'accept', input: { limit: 20 } },
    { verdict: 'refuse', input: { limit: 0 } },
  ],
});

/**
 * The caller's own P2P performance, merchant or not, recomputed from trades. Volume is decimal strings per asset and
 * fiat. guard: merchantApi.
 */
export const P2P_MERCHANTS_STATS = defineProcedure({
  ...base,
  name: 'p2p.merchants.stats',
  kind: 'query',
  path: 'merchants.stats',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.object({
    ordersTotal: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    disputed: z.number().int().nonnegative(),
    completionRate: z.number().min(0).max(1).nullable(),
    cancelRate: z.number().min(0).max(1).nullable(),
    avgReleaseSecs: z.number().int().nonnegative().nullable(),
    avgPaySecs: z.number().int().nonnegative().nullable(),
    volume: z.array(z.object({ asset: z.string(), fiatCurrency: z.string(), amount: amountString, fiatAmount: amountString })),
  }),
  samples: [{ verdict: 'accept' }],
});

/**
 * Whether current standing unlocks the merchant API. It has no merchantApi guard, so a suspended key can learn why it
 * was refused. Keys come from identity and throttling from the edge; disputes are only ever ruled by a person.
 */
export const P2P_MERCHANTS_API_ACCESS = defineProcedure({
  ...base,
  name: 'p2p.merchants.apiAccess',
  kind: 'query',
  path: 'merchants.apiAccess',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.object({
    eligible: z.boolean(),
    credential: z.enum(['session', 'api_key']),
    merchantStatus: z.enum(MERCHANT_STATUSES).nullable(),
    keyPlane: z.literal('identity'),
    rateLimitPlane: z.literal('edge'),
    disputeResolution: z.literal('interactive_human_only'),
  }),
  samples: [{ verdict: 'accept' }],
});

/** The owner-published advertiser terms version and when the caller accepted it. A blank version refuses `p2p.config_unset`. guard: merchantApi. */
export const P2P_MERCHANTS_ADVERTISER_TERMS = defineProcedure({
  ...base,
  name: 'p2p.merchants.advertiserTerms',
  kind: 'query',
  path: 'merchants.advertiserTerms',
  access: READ,
  refusals: refuse({ 'p2p.config_unset': 'PRECONDITION_FAILED' }),
  input: NO_INPUT,
  output: z.object({ version: z.string(), acceptedAt: z.string().nullable() }),
  samples: [{ verdict: 'accept' }],
});

/**
 * Accepts exactly the version shown; another refuses `p2p.terms_version_stale`, and accepting again returns the first
 * acceptance. A person's own act: an API key refuses (FORBIDDEN, no code), and so does a forwarded principal.
 */
export const P2P_MERCHANTS_ACCEPT_ADVERTISER_TERMS = defineProcedure({
  ...base,
  name: 'p2p.merchants.acceptAdvertiserTerms',
  kind: 'mutation',
  path: 'merchants.acceptAdvertiserTerms',
  access: { ...WRITE, person: true },
  refusals: refuse({ 'p2p.config_unset': 'PRECONDITION_FAILED', 'p2p.terms_version_stale': 'CONFLICT' }),
  input: z.object({ version: z.string().min(1).max(64) }),
  output: z.object({ version: z.string(), acceptedAt: z.string() }),
  samples: [
    { verdict: 'accept', input: { version: 'TEST-2026-11' } },
    { verdict: 'refuse', input: { version: '' } },
  ],
});

/**
 * The posting checklist for one fiat: the policy compliance published for it and every check, with the caller's value
 * and the target as strings. Posting in that fiat refuses on the same checks. guard: merchantApi.
 */
export const P2P_MERCHANTS_POSTING_ELIGIBILITY = defineProcedure({
  ...base,
  name: 'p2p.merchants.postingEligibility',
  kind: 'query',
  path: 'merchants.postingEligibility',
  access: READ,
  refusals: refuse(),
  input: z.object({ fiatCurrency: z.string().length(3) }),
  output: z.object({
    fiatCurrency: z.string(),
    policy: z.enum(POSTING_POLICIES),
    checks: z.array(
      z.object({
        id: z.enum(POSTING_CHECK_IDS),
        state: z.enum(POSTING_CHECK_STATES),
        current: z.string().nullable(),
        required: z.string().nullable(),
        reason: z.string(),
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: { fiatCurrency: 'EUR' } },
    { verdict: 'refuse', input: { fiatCurrency: 'EURO' } },
  ],
});

/** The caller's own standing. Null means never applied, not rejected. guard: merchantApi. */
export const P2P_MERCHANTS_ME = defineProcedure({
  ...base,
  name: 'p2p.merchants.me',
  kind: 'query',
  path: 'merchants.me',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: P2P_MERCHANT.nullable(),
  samples: [{ verdict: 'accept' }],
});

const limitMode = z.enum(['unset', 'unlimited', 'capped']);

/**
 * The deployment's offer ceilings: policy, not standing. A null max is no numeric cap; magnitudes are never invented.
 * guard: merchantApi.
 */
export const P2P_MERCHANTS_OFFER_LIMITS = defineProcedure({
  ...base,
  name: 'p2p.merchants.offerLimits',
  kind: 'query',
  path: 'merchants.offerLimits',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.object({
    standardMax: z.string().nullable(),
    merchantMax: z.string().nullable(),
    configured: z.boolean(),
    posture: z.enum(['unset', 'unlimited', 'configured']),
    standardMode: limitMode,
    merchantMode: limitMode,
    /** The same sentence the boot log prints. */
    summary: z.string(),
  }),
  samples: [{ verdict: 'accept' }],
});

/** The ceiling that binds the caller now: the standard band, or the merchant band once approved. guard: merchantApi. */
export const P2P_MERCHANTS_MY_OFFER_CEILING = defineProcedure({
  ...base,
  name: 'p2p.merchants.myOfferCeiling',
  kind: 'query',
  path: 'merchants.myOfferCeiling',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.object({
    maxAmount: z.string().nullable(),
    band: z.enum(['standard', 'merchant']),
    limitMode,
    merchantStatus: z.enum(MERCHANT_STATUSES).nullable(),
  }),
  samples: [{ verdict: 'accept' }],
});

/** Applies on the caller's own behalf: the account is the principal's, never the input's. guard: merchantApi. */
export const P2P_MERCHANTS_SUBMIT_APPLICATION = defineProcedure({
  ...base,
  name: 'p2p.merchants.submitApplication',
  kind: 'mutation',
  path: 'merchants.submitApplication',
  access: WRITE,
  refusals: refuse({ 'p2p.merchant_ineligible': 'BAD_REQUEST', 'p2p.merchant_exists': 'CONFLICT' }),
  input: NO_INPUT,
  output: P2P_MERCHANT,
  samples: [{ verdict: 'accept' }],
});

/** Leaves the programme, for good: coming back is a new application. guard: merchantApi. */
export const P2P_MERCHANTS_WITHDRAW = defineProcedure({
  ...base,
  name: 'p2p.merchants.withdraw',
  kind: 'mutation',
  path: 'merchants.withdraw',
  access: WRITE,
  refusals: refuse(TRANSITION_REFUSALS),
  input: z.object({ reason: z.string().min(1) }),
  output: P2P_MERCHANT,
  samples: [
    { verdict: 'accept', input: { reason: 'Trading less' } },
    { verdict: 'refuse', input: { reason: '' } },
  ],
});

/**
 * An operator approves, rejects or suspends a merchant, with MFA (UNAUTHORIZED `mfa.required` without it) and an
 * approval identity consumed from a second person: a typed-in operator id is not a second person.
 */
export const P2P_MERCHANTS_DECIDE = defineProcedure({
  ...base,
  name: 'p2p.merchants.decide',
  kind: 'mutation',
  path: 'merchants.decide',
  access: ADMIN,
  refusals: refuse({ ...TRANSITION_REFUSALS, ...APPROVAL_REFUSALS }),
  input: z.object({
    userId: z.string().guid(),
    to: z.enum(['approved', 'rejected', 'suspended']),
    reason: z.string().min(1),
    confirmOperatorId: z.string().max(128).nullish(),
    approvalId: z.string().max(128).nullish(),
    operationId: z.string().max(128).nullish(),
  }),
  output: P2P_MERCHANT.extend({ confirmOperatorId: z.string() }),
  samples: [
    { verdict: 'accept', input: { userId: PEER, to: 'suspended', reason: 'Lost a dispute', approvalId: 'appr-1', operationId: 'op-1' } },
    { verdict: 'refuse', input: { userId: PEER, to: 'withdrawn', reason: 'x' } },
  ],
});

/** Why a merchant stands where they do, newest first. A missing page size refuses `p2p.merchant_history_limit_unset`. */
export const P2P_MERCHANTS_HISTORY = defineProcedure({
  ...base,
  name: 'p2p.merchants.history',
  kind: 'query',
  path: 'merchants.history',
  access: ADMIN,
  refusals: refuse({ 'p2p.merchant_history_limit_unset': 'PRECONDITION_FAILED' }),
  input: z.object({ userId: z.string().guid(), limit: z.number().int().min(1).max(200).optional() }),
  output: z.array(
    z.object({
      seq: z.string(),
      fromStatus: z.string(),
      toStatus: z.string(),
      reason: z.string(),
      actorId: z.string(),
      actorScope: z.string(),
      createdAt: z.string(),
    }),
  ),
  samples: [
    { verdict: 'accept', input: { userId: PEER, limit: 50 } },
    { verdict: 'refuse', input: { userId: 'not-an-id', limit: 50 } },
  ],
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
  P2P_CHAT_MESSAGES_LIST,
  P2P_CHAT_MESSAGES_SEND,
  P2P_CHAT_UNREAD,
  P2P_REVIEWS_LEAVE,
  P2P_REVIEWS_EDIT,
  P2P_REVIEWS_REPLY,
  P2P_REVIEWS_LIST,
  P2P_REVIEWS_FOR_TRADE,
  P2P_REVIEWS_MODERATE,
  P2P_REPUTATION_MY_APPEAL,
  P2P_REPUTATION_APPEAL,
  P2P_REPUTATION_DECIDE_APPEAL,
  P2P_REPUTATION_GET,
  P2P_MERCHANTS_PRESENCE,
  P2P_MERCHANTS_SET_PRESENCE,
  P2P_MERCHANTS_TODOS,
  P2P_MERCHANTS_STATS,
  P2P_MERCHANTS_API_ACCESS,
  P2P_MERCHANTS_ADVERTISER_TERMS,
  P2P_MERCHANTS_ACCEPT_ADVERTISER_TERMS,
  P2P_MERCHANTS_POSTING_ELIGIBILITY,
  P2P_MERCHANTS_ME,
  P2P_MERCHANTS_OFFER_LIMITS,
  P2P_MERCHANTS_MY_OFFER_CEILING,
  P2P_MERCHANTS_SUBMIT_APPLICATION,
  P2P_MERCHANTS_WITHDRAW,
  P2P_MERCHANTS_DECIDE,
  P2P_MERCHANTS_HISTORY,
] as const satisfies readonly ProcedureRecord[];
