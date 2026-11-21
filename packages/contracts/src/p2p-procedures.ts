import { z } from 'zod';
import { P2P_CANCEL_REASONS, P2P_CANCELLED_BY } from './p2p-cancel.js';
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

/**
 * The trade calls' named refusals, read from each handler and the service methods it calls (statuses from svc-p2p's
 * `toTrpcError`). Internal failures (a ledger or database error) are not listed: they are not refusals.
 */
const STEP_UP = {
  'auth.step_up_required': 'FORBIDDEN',
  'auth.step_up_expired': 'FORBIDDEN',
  'auth.step_up_failed': 'FORBIDDEN',
  'p2p.step_up_unverifiable': 'PRECONDITION_FAILED',
} as const;
const TRADE_MOVE = { ...TRADE_NOT_FOUND, 'p2p.invalid_transition': 'CONFLICT', 'p2p.trade_terminal': 'CONFLICT' } as const;
const ESCROW_HELD = {
  'p2p.escrow_contract_held': 'CONFLICT',
  'p2p.trade_moved': 'CONFLICT',
  'p2p.escrow_missing': 'CONFLICT',
  'p2p.escrow_terms_unproven': 'PRECONDITION_FAILED',
} as const;
/** Everything a quote checks of the ad, the taker and the figures, before anything is reserved; a take checks it again. */
const QUOTE_CHECKS = {
  'p2p.trading_disabled': 'FORBIDDEN',
  'p2p.offer_not_found': 'NOT_FOUND',
  'p2p.offer_private': 'NOT_FOUND',
  'p2p.share_link_expired': 'CONFLICT',
  'p2p.share_link_revoked': 'CONFLICT',
  'p2p.maker_offline': 'CONFLICT',
  'p2p.offer_not_active': 'BAD_REQUEST',
  'p2p.self_trade': 'FORBIDDEN',
  'p2p.blocked': 'FORBIDDEN',
  'p2p.invalid_security_change_lock': 'PRECONDITION_FAILED',
  'p2p.security_change_lock_unwired': 'PRECONDITION_FAILED',
  'p2p.take_refused': 'BAD_REQUEST',
  'p2p.method_delisted': 'BAD_REQUEST',
  'p2p.invalid_amount': 'BAD_REQUEST',
  'p2p.amount_below_min': 'BAD_REQUEST',
  'p2p.amount_above_max': 'BAD_REQUEST',
  'p2p.insufficient_offer_liquidity': 'BAD_REQUEST',
  'p2p.unsupported_fiat': 'BAD_REQUEST',
  'p2p.reference_price_unavailable': 'BAD_REQUEST',
  'p2p.fee_bps_unset': 'PRECONDITION_FAILED',
  'p2p.release_unpostable': 'BAD_REQUEST',
  'p2p.active_order_cap': 'CONFLICT',
  'p2p.config_unset': 'PRECONDITION_FAILED',
  'p2p.buying_restricted': 'CONFLICT',
  'p2p.pair_limit_exceeded': 'BAD_REQUEST',
  'p2p.verification_limits_invalid': 'PRECONDITION_FAILED',
  'p2p.verification_level_unwired': 'PRECONDITION_FAILED',
  'p2p.verification_limit_currency': 'BAD_REQUEST',
  'p2p.verification_order_min': 'BAD_REQUEST',
  'p2p.verification_order_max': 'BAD_REQUEST',
  'p2p.verification_daily_limit': 'BAD_REQUEST',
  'p2p.verification_lifetime_limit': 'BAD_REQUEST',
} as const;
/** An API key is refused a confirmation window: it never confirms a take or a release. */
const REFUSALS_STEP_UP_WINDOW = { 'auth.step_up_required': 'FORBIDDEN' } as const;
const REFUSALS_TAKE = {
  ...QUOTE_CHECKS,
  ...STEP_UP,
  'p2p.contact_required': 'FORBIDDEN',
  'p2p.contact_unverifiable': 'PRECONDITION_FAILED',
  'p2p.take_gate_unwired': 'PRECONDITION_FAILED',
  'p2p.contract_escrow_unavailable': 'PRECONDITION_FAILED',
  'p2p.counterparty_unverifiable': 'PRECONDITION_FAILED',
  'p2p.counterparty_unavailable': 'CONFLICT',
  'p2p.quote_not_found': 'NOT_FOUND',
  'p2p.quote_mismatch': 'BAD_REQUEST',
  'p2p.quote_expired': 'CONFLICT',
  'p2p.quote_changed': 'CONFLICT',
  'p2p.trade_exists': 'CONFLICT',
  'p2p.non_instant_not_accepted': 'BAD_REQUEST',
  'p2p.floating_not_allowed_for_method': 'BAD_REQUEST',
  'p2p.escrow_lock_uncertain': 'PRECONDITION_FAILED',
  'p2p.escrow_terms_unproven': 'PRECONDITION_FAILED',
  'p2p.trade_moved': 'CONFLICT',
  'p2p.insufficient_balance': 'CONFLICT',
  'p2p.offer_unfunded': 'CONFLICT',
} as const;
/** An unconfigured escrow is answered as data (`available: false` with its blocker), never refused. */
const REFUSALS_CONTRACT_ESCROW = {} as const;
const REFUSALS_ATTACH_CONTRACT_DEAL = {
  ...TRADE_MOVE,
  'p2p.contract_escrow_unavailable': 'PRECONDITION_FAILED',
  'p2p.escrow_deal_mismatch': 'CONFLICT',
  'p2p.escrow_kind_immutable': 'CONFLICT',
  'p2p.not_the_seller': 'FORBIDDEN',
  'p2p.trade_moved': 'CONFLICT',
} as const;
const REFUSALS_SYNC_CONTRACT_DEAL = {
  ...TRADE_MOVE,
  'p2p.escrow_deal_mismatch': 'CONFLICT',
  'p2p.contract_escrow_unavailable': 'PRECONDITION_FAILED',
  'p2p.trade_moved': 'CONFLICT',
  'p2p.escrow_terms_unproven': 'PRECONDITION_FAILED',
} as const;
const REFUSALS_MARK_FIAT_SENT = { ...TRADE_MOVE, 'p2p.not_the_buyer': 'FORBIDDEN' } as const;
const REFUSALS_CONFIRM_RECEIVED = {
  ...TRADE_MOVE,
  ...STEP_UP,
  ...ESCROW_HELD,
  'p2p.not_the_seller': 'FORBIDDEN',
  'p2p.dispute_already_open': 'CONFLICT',
  'p2p.release_unpostable': 'BAD_REQUEST',
} as const;
const REFUSALS_REMIND = {
  ...TRADE_MOVE,
  'p2p.not_the_buyer': 'FORBIDDEN',
  'p2p.config_unset': 'PRECONDITION_FAILED',
  'p2p.remind_rate_limited': 'CONFLICT',
  'p2p.remind_too_early': 'CONFLICT',
} as const;
const REFUSALS_REPORT_SENSITIVE_REMARK = {
  ...TRADE_MOVE,
  'p2p.remark_invalid': 'BAD_REQUEST',
  'p2p.remark_not_payee': 'FORBIDDEN',
  'p2p.remark_case_exists': 'CONFLICT',
} as const;
const REFUSALS_REMARK_CASE = TRADE_NOT_FOUND;
const REFUSALS_REPORT_MISMATCH = {
  ...TRADE_MOVE,
  'p2p.not_the_seller': 'FORBIDDEN',
  'p2p.mismatch_report_exists': 'CONFLICT',
  'p2p.invalid_amount': 'BAD_REQUEST',
  'p2p.unsupported_fiat': 'BAD_REQUEST',
} as const;
const REFUSALS_VALIDATE_PAYMENT = {
  ...TRADE_MOVE,
  ...STEP_UP,
  ...ESCROW_HELD,
  'p2p.not_the_seller': 'FORBIDDEN',
  'rail.bank': 'PRECONDITION_FAILED',
  'p2p.method_not_rail_validated': 'PRECONDITION_FAILED',
  'p2p.dispute_already_open': 'CONFLICT',
  'p2p.rail_mismatch': 'CONFLICT',
  'p2p.release_unpostable': 'BAD_REQUEST',
} as const;
const REFUSALS_CANCEL = {
  ...TRADE_MOVE,
  ...ESCROW_HELD,
  'p2p.not_the_seller': 'FORBIDDEN',
  'p2p.cancel_after_paid': 'CONFLICT',
  'p2p.dispute_already_open': 'CONFLICT',
  'p2p.cancel_reason_invalid': 'BAD_REQUEST',
  'p2p.escrow_lock_uncertain': 'PRECONDITION_FAILED',
} as const;
const REFUSALS_REQUEST_CANCEL = {
  ...TRADE_MOVE,
  'p2p.not_the_seller': 'FORBIDDEN',
  'p2p.owner_decision_pending': 'PRECONDITION_FAILED',
} as const;
const REFUSALS_GET = TRADE_NOT_FOUND;
const REFUSALS_LIST = { 'p2p.trade_list_limit_unset': 'PRECONDITION_FAILED' } as const;
const REFUSALS_PAGE = {
  'p2p.trade_list_limit_unset': 'PRECONDITION_FAILED',
  'p2p.cursor_invalid': 'BAD_REQUEST',
  'p2p.filter_invalid': 'BAD_REQUEST',
} as const;
const REFUSALS_QUOTE = { ...QUOTE_CHECKS, 'p2p.escrow_deadline_unset': 'PRECONDITION_FAILED' } as const;
const REFUSALS_LOCK_QUOTE = { ...REFUSALS_QUOTE, 'p2p.quote_not_found': 'NOT_FOUND', 'p2p.idempotency_conflict': 'CONFLICT' } as const;
const REFUSALS_EXPORT = {
  'p2p.config_unset': 'PRECONDITION_FAILED',
  'p2p.export_format_unbuilt': 'PRECONDITION_FAILED',
  'p2p.export_range_invalid': 'BAD_REQUEST',
  'p2p.export_range_too_large': 'BAD_REQUEST',
  'p2p.export_too_many_rows': 'BAD_REQUEST',
  'p2p.export_quota_reached': 'TOO_MANY_REQUESTS',
} as const;
const REFUSALS_RECEIPT = {
  ...TRADE_NOT_FOUND,
  'p2p.config_unset': 'PRECONDITION_FAILED',
  'p2p.receipt_not_available': 'BAD_REQUEST',
  'p2p.receipt_quota_reached': 'TOO_MANY_REQUESTS',
} as const;
/** Every reason a stranger may not read the destination is one not found, whatever the real reason. */
const REFUSALS_PAYMENT_INSTRUMENT = {
  'p2p.instrument_not_found': 'NOT_FOUND',
  'p2p.escrow_terms_unproven': 'PRECONDITION_FAILED',
  'p2p.instrument_kms_required': 'PRECONDITION_FAILED',
} as const;

/** The readable tabs of the order list, and which state machine statuses each holds (svc-p2p `order-list.ts`). */
export const ORDER_TABS = ['in_progress', 'in_dispute', 'completed', 'cancelled'] as const;
/** An order's readable status, derived on the server from its state, resolution and how it got there. */
export const DISPLAY_STATUSES = [
  'waiting_for_escrow',
  'waiting_for_buyer_to_pay',
  'waiting_for_seller_to_release',
  'appealing',
  'completed',
  'completed_by_dispute_ruling',
  'cancelled',
  'cancelled_by_timeout',
  'cancelled_by_dispute_ruling',
] as const;
/** What the seller found in their bank: less, more, or only part of the order's fiat. */
export const MISMATCH_KINDS = ['under', 'over', 'partial'] as const;
/** How the owner's band classified a mismatch report; `reported` while the band is blank. */
export const MISMATCH_CLASSIFICATIONS = ['within_tolerance', 'outside_tolerance', 'reported'] as const;
/** The export formats a caller may ask for. Only CSV is built; the others refuse `p2p.export_format_unbuilt`. */
export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
const TRADE_STATUSES = ['created', 'escrowed', 'fiat_sent', 'released', 'cancelled', 'disputed'] as const;

const OFFER = '33333333-3333-4333-8333-333333333333';
const QUOTE = '55555555-5555-4555-8555-555555555555';

/** How money on a method arrives in one market: at once, or within a window (null when the market leaves it blank). */
export const P2P_SETTLEMENT = z.union([
  z.object({ instant: z.literal(true) }),
  z.object({ instant: z.literal(false), windowSeconds: z.number().int().positive().nullable() }),
]);

/** One order on the wire, as every trade call returns it. */
export const P2P_TRADE = z.object({
  id: z.string().guid(),
  offerId: z.string().guid(),
  /** The order was taken through a share link. */
  sharedFrom: z.boolean(),
  /** The ad's own release window copied at take, or null when the published release clock applies. */
  releaseWindowSeconds: z.number().int().positive().nullable(),
  sellerId: z.string(),
  buyerId: z.string(),
  asset: z.string(),
  amount: amountString,
  fiatCurrency: z.string(),
  fiatAmount: amountString,
  price: amountString,
  method: z.string(),
  status: z.enum(TRADE_STATUSES),
  resolution: z.enum(['released', 'refunded', 'voided']).nullable(),
  deadlineAt: z.string().nullable(),
  createdAt: z.string(),
  escrowedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  settledAt: z.string().nullable(),
  /** Who holds the coins: the ledger, or the escrow contract (no ledger entry at all). Fixed at take. */
  escrowKind: z.enum(['ledger', 'contract']),
  /** The contract deal's terms (fixed at take) and, once the seller attached it, the deal. Null on a ledger order. Base units. */
  contract: z
    .object({
      chainId: z.number().int().positive(),
      token: z.string(),
      units: z.string().regex(/^[1-9][0-9]*$/),
      buyerWallet: z.string(),
      disputeWindowSeconds: z.number().int().positive(),
      timeout: z.literal('refund_seller'),
      dealId: z.string().nullable(),
      sellerWallet: z.string().nullable(),
    })
    .nullable(),
});

/** The buyer's reminders: how many went, the last, when the next may go (null when none can), and the owner's count. */
export const P2P_TRADE_REMINDERS = z.object({
  count: z.number().int().nonnegative(),
  lastAt: z.string().datetime().nullable(),
  nextAt: z.string().datetime().nullable(),
  max: z.number().int().positive().nullable(),
});

/** The seller's report of what arrived in their bank, and how the owner's band classified it (`toleranceBps`, the band used). */
export const P2P_TRADE_MISMATCH = z.object({
  kind: z.enum(MISMATCH_KINDS),
  amountReceived: amountString,
  expected: amountString,
  classification: z.enum(MISMATCH_CLASSIFICATIONS),
  toleranceBps: z.number().int().nonnegative().nullable(),
  reportedAt: z.string().datetime(),
});

/** A case a party's report of a payment-note remark opened. */
export const P2P_REMARK_CASE = z.object({
  id: z.string(),
  tradeId: z.string(),
  reporterId: z.string(),
  reportedId: z.string(),
  reporterRole: z.enum(['buyer', 'seller']),
  remark: z.string(),
  status: z.literal('open'),
  openedAt: z.string(),
});

/**
 * One order as its page reads it: the ad's terms when it was placed (null before terms were copied), the readable
 * status, the fee rate frozen at take and, for a released order, the split the ledger posted from it. A refund or a
 * void takes no fee, so those carry no split.
 */
export const P2P_TRADE_DETAIL = P2P_TRADE.extend({
  terms: z.string().nullable(),
  displayStatus: z.enum(DISPLAY_STATUSES),
  feeBps: z.number().int(),
  fee: amountString.nullable(),
  netAmount: amountString.nullable(),
  /** The method's profile in the market the buyer pays into, copied at take. */
  settlement: P2P_SETTLEMENT,
  /** While the escrow is held, the split a release would post; null once it is not held. */
  releasePreview: z.object({ fee: amountString, netAmount: amountString }).nullable(),
  /** What is still in escrow: zero once posted and for a void, null while `created` (the lock is not provably done). */
  escrowHeld: amountString.nullable(),
  reminders: P2P_TRADE_REMINDERS,
  mismatch: P2P_TRADE_MISMATCH.nullable(),
  /** What stops the bank rail checking this order's payment, or null when it can be checked. */
  paymentValidation: z.object({ blocker: z.enum(['rail.bank', 'p2p.method_not_rail_validated']).nullable() }),
  /** On a cancelled order, who cancelled it and the reason code they chose; null otherwise. */
  cancelReason: z.object({ by: z.enum(P2P_CANCELLED_BY), code: z.enum(P2P_CANCEL_REASONS).nullable() }).nullable(),
});

const stepUpApprovalId = z.string().min(1).max(128);
/** What every caller checks of a remark case: its own id and its order's are UUIDs. */
const remarkCaseIds = z.object({ id: z.string().guid(), tradeId: z.string().guid() });
const shareToken = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const stepUpWindow = z.object({ confirmedUntil: z.string().datetime().nullable() });
/** What every caller checks of a confirmation window: a real ISO date-time with its offset, or null. */
const stepUpWindowTimes = z.object({ confirmedUntil: z.iso.datetime({ offset: true }).nullable() });
const stepUpWindowAccept = {
  times: {
    says: 'confirmedUntil is an ISO 8601 date-time, or null',
    holds: (reply: unknown) => stepUpWindowTimes.safeParse(reply).success,
  },
} as const;
const TRADE_ID_SAMPLES = [
  { verdict: 'accept', input: { tradeId: TRADE } },
  { verdict: 'refuse', input: { tradeId: 'not-an-id' } },
] as const;

/** Until when this session's takes need no new confirmation, or null when the next take does. guard: merchantApi. */
export const P2P_TRADES_STEP_UP_WINDOW = defineProcedure({
  ...base,
  name: 'p2p.trades.stepUpWindow',
  kind: 'query',
  path: 'trades.stepUpWindow',
  access: READ,
  refusals: refuse(REFUSALS_STEP_UP_WINDOW),
  input: NO_INPUT,
  output: stepUpWindow,
  accept: stepUpWindowAccept,
  samples: [{ verdict: 'accept' }],
});

/**
 * Until when this session's releases need no new confirmation, or null when the next one does. A take's confirmation
 * never counts here. guard: merchantApi.
 */
export const P2P_TRADES_RELEASE_STEP_UP_WINDOW = defineProcedure({
  ...base,
  name: 'p2p.trades.releaseStepUpWindow',
  kind: 'query',
  path: 'trades.releaseStepUpWindow',
  access: READ,
  refusals: refuse(REFUSALS_STEP_UP_WINDOW),
  input: NO_INPUT,
  output: stepUpWindow,
  accept: stepUpWindowAccept,
  samples: [{ verdict: 'accept' }],
});

/**
 * Take an ad: the seller's coins lock in escrow (the ledger's, or a contract deal paying the buyer's own wallet). The
 * eligibility checks run before anything is reserved, then the fresh confirmation of exactly this take, unless the
 * session's window is live. guard: merchantApi.
 */
export const P2P_TRADES_TAKE = defineProcedure({
  ...base,
  name: 'p2p.trades.take',
  kind: 'mutation',
  path: 'trades.take',
  access: WRITE,
  refusals: refuse(REFUSALS_TAKE),
  input: z.object({
    offerId: z.string().guid(),
    tradeId: z.string().guid(),
    amount: amountString,
    method: z.string().min(1).max(64),
    /** The locked quote (`trades.lockQuote`) this take places, inside its window. */
    quoteId: z.string().guid().optional(),
    /** Identity's single-use confirmation of exactly this take. Optional inside a live window. */
    stepUpApprovalId: stepUpApprovalId.optional(),
    /** The share link the taker came by; required for a private ad, and marks the order shared. */
    shareToken: shareToken.optional(),
    /** Who holds the coins: `ledger` by default; `contract`, for the buyer of a sell ad, pays `buyerWallet`. */
    escrowKind: z.enum(['ledger', 'contract']).default('ledger'),
    buyerWallet: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
  }),
  output: P2P_TRADE,
  samples: [
    { verdict: 'accept', input: { offerId: OFFER, tradeId: TRADE, amount: '10', method: 'sepa' } },
    { verdict: 'refuse', input: { offerId: OFFER, tradeId: TRADE, amount: '-1', method: 'sepa' } },
    { verdict: 'refuse', input: { offerId: OFFER, tradeId: TRADE, amount: '10', method: 'sepa', buyerWallet: '0x12' } },
  ],
});

/**
 * The contract escrow as a person choosing it sees it for one asset: offered, or not with its blocker named; the
 * testnet's plain label; and mainnet, always off in this build (`audit.external`). Reads only. guard: merchantApi.
 */
export const P2P_TRADES_CONTRACT_ESCROW = defineProcedure({
  ...base,
  name: 'p2p.trades.contractEscrow',
  kind: 'query',
  path: 'trades.contractEscrow',
  access: READ,
  refusals: refuse(REFUSALS_CONTRACT_ESCROW),
  input: z.object({ asset: z.string().min(1).max(32) }),
  output: z.object({
    available: z.boolean(),
    blocker: z.string().nullable(),
    reason: z.string().nullable(),
    network: z.object({ chainId: z.number().int().positive(), label: z.string(), escrow: z.string() }).nullable(),
    token: z.object({ address: z.string(), decimals: z.number().int() }).nullable(),
    disputeWindowSeconds: z.number().int().positive().nullable(),
    timeout: z.literal('refund_seller'),
    mainnet: z.object({ available: z.literal(false), blocker: z.literal('audit.external') }),
    audited: z.literal(false),
  }),
  samples: [
    { verdict: 'accept', input: { asset: 'USDC' } },
    { verdict: 'refuse', input: { asset: '' } },
  ],
});

/**
 * The seller attaches the deal they opened and funded from their own wallet. The deal is read from the chain, never
 * taken from the caller, and must match the order exactly and be locked; the order is then escrowed. The same deal
 * again returns the order. No ledger call. guard: merchantApi.
 */
export const P2P_TRADES_ATTACH_CONTRACT_DEAL = defineProcedure({
  ...base,
  name: 'p2p.trades.attachContractDeal',
  kind: 'mutation',
  path: 'trades.attachContractDeal',
  access: WRITE,
  refusals: refuse(REFUSALS_ATTACH_CONTRACT_DEAL),
  input: z.object({ tradeId: z.string().guid(), dealId: z.string().regex(/^[1-9][0-9]{0,77}$/) }),
  output: P2P_TRADE,
  samples: [
    { verdict: 'accept', input: { tradeId: TRADE, dealId: '7' } },
    { verdict: 'refuse', input: { tradeId: TRADE, dealId: '0' } },
  ],
});

/**
 * Either party brings a contract order to its deal's chain state (released, refunded, disputed), read from the chain;
 * the same state twice changes the order once. No ledger call. guard: merchantApi.
 */
export const P2P_TRADES_SYNC_CONTRACT_DEAL = defineProcedure({
  ...base,
  name: 'p2p.trades.syncContractDeal',
  kind: 'mutation',
  path: 'trades.syncContractDeal',
  access: WRITE,
  refusals: refuse(REFUSALS_SYNC_CONTRACT_DEAL),
  input: tradeId,
  output: P2P_TRADE,
  samples: TRADE_ID_SAMPLES,
});

/** The buyer says the fiat is sent. guard: merchantApi. */
export const P2P_TRADES_MARK_FIAT_SENT = defineProcedure({
  ...base,
  name: 'p2p.trades.markFiatSent',
  kind: 'mutation',
  path: 'trades.markFiatSent',
  access: WRITE,
  refusals: refuse(REFUSALS_MARK_FIAT_SENT),
  input: tradeId,
  output: P2P_TRADE,
  samples: TRADE_ID_SAMPLES,
});

/**
 * The seller confirms the fiat landed and the escrow releases, confirmed with identity's single-use approval of this
 * release or inside the session's release window. A second press on an order this seller already released returns it
 * and asks for nothing. guard: merchantApi.
 */
export const P2P_TRADES_CONFIRM_RECEIVED = defineProcedure({
  ...base,
  name: 'p2p.trades.confirmReceived',
  kind: 'mutation',
  path: 'trades.confirmReceived',
  access: WRITE,
  refusals: refuse(REFUSALS_CONFIRM_RECEIVED),
  input: z.object({ tradeId: z.string().guid(), stepUpApprovalId: stepUpApprovalId.optional() }),
  output: P2P_TRADE,
  samples: [
    { verdict: 'accept', input: { tradeId: TRADE, stepUpApprovalId: 'appr-1' } },
    { verdict: 'refuse', input: { tradeId: TRADE, stepUpApprovalId: '' } },
  ],
});

/**
 * The buyer of a paid order reminds the seller to check the payment and release. Too early names when it may go; the
 * owner's count spent, or either owner figure blank, refuses. Nothing moves. guard: merchantApi.
 */
export const P2P_TRADES_REMIND = defineProcedure({
  ...base,
  name: 'p2p.trades.remind',
  kind: 'mutation',
  path: 'trades.remind',
  access: WRITE,
  refusals: refuse(REFUSALS_REMIND),
  input: tradeId,
  output: P2P_TRADE_REMINDERS,
  samples: TRADE_ID_SAMPLES,
});

/** The longest remark a report quotes. */
export const REMARK_MAX = 280;

/**
 * The seller reports a sensitive remark the buyer wrote in the payment note; a case opens against the buyer, who is
 * told. One per order: the same report again returns the first. guard: merchantApi.
 */
export const P2P_TRADES_REPORT_SENSITIVE_REMARK = defineProcedure({
  ...base,
  name: 'p2p.trades.reportSensitiveRemark',
  kind: 'mutation',
  path: 'trades.reportSensitiveRemark',
  access: WRITE,
  refusals: refuse(REFUSALS_REPORT_SENSITIVE_REMARK),
  input: z.object({
    /** The client's id for this report, made once per form: a lost reply sent again returns the same case. */
    caseId: z.string().guid(),
    tradeId: z.string().guid(),
    /** The remark as written in the payment note. Staff read it; the reported party is told a case opened. */
    remark: z.string().trim().min(1).max(REMARK_MAX),
  }),
  output: P2P_REMARK_CASE,
  accept: { ids: { says: 'the case id and the order id are UUIDs', holds: (reply) => remarkCaseIds.safeParse(reply).success } },
  samples: [
    { verdict: 'accept', input: { caseId: QUOTE, tradeId: TRADE, remark: 'for crypto' } },
    { verdict: 'refuse', input: { caseId: QUOTE, tradeId: TRADE, remark: '' } },
  ],
});

/**
 * The remark cases on this order as the caller may see them: their own report (or null), and whether the other party
 * reported them, with the case id and when, never the quote. A non-party gets not found. guard: merchantApi.
 */
export const P2P_TRADES_REMARK_CASE = defineProcedure({
  ...base,
  name: 'p2p.trades.remarkCase',
  kind: 'query',
  path: 'trades.remarkCase',
  access: READ,
  refusals: refuse(REFUSALS_REMARK_CASE),
  input: tradeId,
  output: z.object({
    mine: P2P_REMARK_CASE.nullable(),
    againstMe: z.object({ caseId: z.string(), openedAt: z.string() }).nullable(),
  }),
  accept: {
    ids: {
      says: 'the case ids and the order id are UUIDs',
      holds: (reply) =>
        z.object({ mine: remarkCaseIds.nullable(), againstMe: z.object({ caseId: z.string().guid() }).nullable() }).safeParse(reply)
          .success,
    },
  },
  samples: TRADE_ID_SAMPLES,
});

/**
 * The seller of a paid order reports an under-, over- or part payment found in their own bank. Answers the
 * classification; the order stays paid either way and nothing moves. guard: merchantApi.
 */
export const P2P_TRADES_REPORT_MISMATCH = defineProcedure({
  ...base,
  name: 'p2p.trades.reportMismatch',
  kind: 'mutation',
  path: 'trades.reportMismatch',
  access: WRITE,
  refusals: refuse(REFUSALS_REPORT_MISMATCH),
  input: z.object({ tradeId: z.string().guid(), kind: z.enum(MISMATCH_KINDS), amountReceived: amountString }),
  output: P2P_TRADE_MISMATCH,
  samples: [
    { verdict: 'accept', input: { tradeId: TRADE, kind: 'under', amountReceived: '90' } },
    { verdict: 'refuse', input: { tradeId: TRADE, kind: 'lost', amountReceived: '90' } },
  ],
});

/**
 * The seller of a paid order has the bank rail check the payment: an exact match releases once (`released`), nothing
 * arrived yet answers `pending`. A check that can release asks for the same confirmation as a release by hand.
 * guard: merchantApi.
 */
export const P2P_TRADES_VALIDATE_PAYMENT = defineProcedure({
  ...base,
  name: 'p2p.trades.validatePayment',
  kind: 'mutation',
  path: 'trades.validatePayment',
  access: WRITE,
  refusals: refuse(REFUSALS_VALIDATE_PAYMENT),
  input: z.object({ tradeId: z.string().guid(), stepUpApprovalId: stepUpApprovalId.optional() }),
  output: z.object({ outcome: z.enum(['released', 'pending']), trade: P2P_TRADE }),
  samples: [
    { verdict: 'accept', input: { tradeId: TRADE } },
    { verdict: 'refuse', input: { tradeId: TRADE, stepUpApprovalId: '' } },
  ],
});

/** Cancel: the escrow refunds the seller in full. A reason code from the caller's side's list wins over free text. guard: merchantApi. */
export const P2P_TRADES_CANCEL = defineProcedure({
  ...base,
  name: 'p2p.trades.cancel',
  kind: 'mutation',
  path: 'trades.cancel',
  access: WRITE,
  refusals: refuse(REFUSALS_CANCEL),
  input: z.object({
    tradeId: z.string().guid(),
    reason: z.string().max(200).optional(),
    reasonCode: z.enum(P2P_CANCEL_REASONS).optional(),
  }),
  output: P2P_TRADE,
  samples: [
    { verdict: 'accept', input: { tradeId: TRADE, reason: 'changed my mind' } },
    { verdict: 'refuse', input: { tradeId: TRADE, reasonCode: 'not_a_reason' } },
  ],
});

/**
 * The seller's cancellation request on a paid order, parked until the founders choose how a paid order may be
 * cancelled: the seller of a paid order is refused `p2p.owner_decision_pending`, and nothing is written. guard: merchantApi.
 */
export const P2P_TRADES_REQUEST_CANCEL = defineProcedure({
  ...base,
  name: 'p2p.trades.requestCancel',
  kind: 'mutation',
  path: 'trades.requestCancel',
  access: WRITE,
  refusals: refuse(REFUSALS_REQUEST_CANCEL),
  input: tradeId,
  output: P2P_TRADE,
  samples: TRADE_ID_SAMPLES,
});

/** One order, to its parties only: anyone else gets not found. guard: merchantApi. */
export const P2P_TRADES_GET = defineProcedure({
  ...base,
  name: 'p2p.trades.get',
  kind: 'query',
  path: 'trades.get',
  access: READ,
  refusals: refuse(REFUSALS_GET),
  input: tradeId,
  output: P2P_TRADE_DETAIL,
  accept: {
    feeRate: {
      says: 'feeBps is a rate from 0 to 9999 basis points',
      holds: (reply) => z.object({ feeBps: z.number().min(0).max(9_999) }).safeParse(reply).success,
    },
  },
  samples: TRADE_ID_SAMPLES,
});

/** The caller's orders. A missing page size refuses `p2p.trade_list_limit_unset`: blank is not 50. guard: merchantApi. */
export const P2P_TRADES_LIST = defineProcedure({
  ...base,
  name: 'p2p.trades.list',
  kind: 'query',
  path: 'trades.list',
  access: READ,
  refusals: refuse(REFUSALS_LIST),
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }).optional(),
  output: z.array(P2P_TRADE),
  samples: [
    { verdict: 'accept', input: { limit: 50 } },
    { verdict: 'refuse', input: { limit: 0 } },
  ],
});

/**
 * The order list: keyset pages newest first, filtered by tab, asset, side, dates and an order id prefix, with true
 * per-tab counts and the server's tab and readable status on each row. A missing page size refuses
 * `p2p.trade_list_limit_unset`. guard: merchantApi.
 */
export const P2P_TRADES_PAGE = defineProcedure({
  ...base,
  name: 'p2p.trades.page',
  kind: 'query',
  path: 'trades.page',
  access: READ,
  refusals: refuse(REFUSALS_PAGE),
  input: z.object({
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().max(512).optional(),
    tab: z.string().max(32).optional(),
    asset: z.string().max(32).optional(),
    side: z.string().max(8).optional(),
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
    orderId: z.string().max(64).optional(),
  }),
  output: z.object({
    trades: z.array(P2P_TRADE.extend({ tab: z.enum(ORDER_TABS), displayStatus: z.enum(DISPLAY_STATUSES) })),
    nextCursor: z.string().nullable(),
    counts: z.object({
      in_progress: z.number().int().nonnegative(),
      in_dispute: z.number().int().nonnegative(),
      completed: z.number().int().nonnegative(),
      cancelled: z.number().int().nonnegative(),
    }),
  }),
  samples: [
    { verdict: 'accept', input: { limit: 20, tab: 'in_progress' } },
    { verdict: 'refuse', input: { limit: 500 } },
  ],
});

/** A take sized in the coin (`amount`) or in the ad's fiat (`fiatAmount`): exactly one. */
const takeAmountShape = {
  offerId: z.string().guid(),
  amount: amountString.optional(),
  fiatAmount: amountString.optional(),
  method: z.string().min(1).max(64),
  /** The share link the taker came by; required for a private ad. */
  shareToken: shareToken.optional(),
};
const oneTakeAmount = (value: { amount?: string; fiatAmount?: string }) =>
  (value.amount === undefined) !== (value.fiatAmount === undefined);
const ONE_TAKE_AMOUNT = { message: 'p2p.invalid_amount: give the amount in the coin or in fiat, not both', path: ['amount'] };
const oneTakeAmountCheck = {
  'p2p.one_take_amount': { at: 'input', says: 'exactly one of amount (the coin) and fiatAmount (the fiat) is given' },
};
/** What every caller checks of a quote: an amount above zero, a fee rate below 100%, and a real end time with its offset. */
const quoteFigures = z.object({ amount: z.string().regex(/[1-9]/), feeBps: z.number().max(9_999) });
const previewFigures = quoteFigures.extend({ reservationExpiresAt: z.iso.datetime({ offset: true }) });
const lockedFigures = quoteFigures.extend({ expiresAt: z.iso.datetime({ offset: true }) });

/** What a take would lock, before it locks anything: exact decimals from the ad and the published fee. No row is written. guard: merchantApi. */
export const P2P_TRADES_QUOTE = defineProcedure({
  ...base,
  name: 'p2p.trades.quote',
  kind: 'query',
  path: 'trades.quote',
  access: READ,
  refusals: refuse(REFUSALS_QUOTE),
  checks: oneTakeAmountCheck,
  input: z.object(takeAmountShape).refine(oneTakeAmount, ONE_TAKE_AMOUNT),
  output: z.object({
    amount: amountString,
    price: amountString,
    fiatAmount: amountString,
    feeBps: z.number().int().nonnegative(),
    fee: amountString,
    netAmount: amountString,
    reservationExpiresAt: z.string(),
  }),
  accept: {
    figures: {
      says: 'the amount is above zero, feeBps is below 10000, and reservationExpiresAt is an ISO 8601 date-time',
      holds: (reply) => previewFigures.safeParse(reply).success,
    },
  },
  samples: [
    { verdict: 'accept', input: { offerId: OFFER, amount: '10', method: 'sepa' } },
    { verdict: 'accept', input: { offerId: OFFER, fiatAmount: '100', method: 'sepa' } },
    { verdict: 'refuse', input: { offerId: OFFER, amount: '10', fiatAmount: '100', method: 'sepa' }, by: 'p2p.one_take_amount' },
    { verdict: 'refuse', input: { offerId: OFFER, amount: '10', method: '' } },
  ],
});

/**
 * Lock the quote for its window: `trades.take` with this `quoteId` places exactly these terms, or refuses before
 * anything is reserved. A client-chosen `quoteId`: a retry returns the same quote. guard: merchantApi.
 */
export const P2P_TRADES_LOCK_QUOTE = defineProcedure({
  ...base,
  name: 'p2p.trades.lockQuote',
  kind: 'mutation',
  path: 'trades.lockQuote',
  access: WRITE,
  refusals: refuse(REFUSALS_LOCK_QUOTE),
  checks: oneTakeAmountCheck,
  input: z.object({ ...takeAmountShape, quoteId: z.string().guid() }).refine(oneTakeAmount, ONE_TAKE_AMOUNT),
  output: z.object({
    quoteId: z.string().guid(),
    amount: amountString,
    price: amountString,
    fiatAmount: amountString,
    feeBps: z.number().int().nonnegative(),
    fee: amountString,
    netAmount: amountString,
    expiresAt: z.string(),
    /** Time left by the service's clock when answered: count down from receipt, not from the device clock. */
    expiresInMs: z.number().int().nonnegative(),
  }),
  accept: {
    figures: {
      says: 'the amount is above zero, feeBps is below 10000, and expiresAt is an ISO 8601 date-time',
      holds: (reply) => lockedFigures.safeParse(reply).success,
    },
  },
  samples: [
    { verdict: 'accept', input: { offerId: OFFER, amount: '10', method: 'sepa', quoteId: QUOTE } },
    { verdict: 'refuse', input: { offerId: OFFER, method: 'sepa', quoteId: QUOTE }, by: 'p2p.one_take_amount' },
    { verdict: 'refuse', input: { offerId: OFFER, amount: '10', method: 'sepa' } },
  ],
});

/**
 * The caller's orders in a date range as CSV, under the owner's range and row caps and a daily quota per person (past
 * it TOO_MANY_REQUESTS, naming the next UTC midnight), with totals as decimal strings. One audit row per export.
 * guard: merchantApi.
 */
export const P2P_TRADES_EXPORT = defineProcedure({
  ...base,
  name: 'p2p.trades.export',
  kind: 'query',
  path: 'trades.export',
  access: READ,
  refusals: refuse(REFUSALS_EXPORT),
  input: z.object({ from: z.string().min(1), to: z.string().min(1), format: z.enum(EXPORT_FORMATS).optional() }),
  output: z.object({
    csv: z.string(),
    rows: z.number().int().nonnegative(),
    format: z.literal('csv'),
    totals: z.array(z.object({ asset: z.string(), fiatCurrency: z.string(), amount: amountString, fiatAmount: amountString })),
  }),
  samples: [
    { verdict: 'accept', input: { from: '2026-11-01', to: '2026-11-20', format: 'csv' } },
    { verdict: 'refuse', input: { from: '', to: '2026-11-20' } },
  ],
});

/** A receipt for one released order, the caller's own side only, under the owner's quotas: each call spends one. guard: merchantApi. */
export const P2P_TRADES_RECEIPT = defineProcedure({
  ...base,
  name: 'p2p.trades.receipt',
  kind: 'mutation',
  path: 'trades.receipt',
  access: READ,
  refusals: refuse(REFUSALS_RECEIPT),
  input: tradeId,
  output: z.object({
    receipt: z.object({
      tradeId: z.string().guid(),
      offerId: z.string().guid(),
      role: z.enum(['buyer', 'seller']),
      asset: z.string(),
      amount: amountString,
      fiatCurrency: z.string(),
      fiatAmount: amountString,
      price: amountString,
      feeBps: z.number().int().nonnegative(),
      method: z.string(),
      createdAt: z.string(),
      escrowedAt: z.string().nullable(),
      fiatSentAt: z.string().nullable(),
      resolvedAt: z.string().nullable(),
    }),
    dailyRemaining: z.number().int().nonnegative(),
    tradeRemaining: z.number().int().nonnegative(),
  }),
  samples: TRADE_ID_SAMPLES,
});

/**
 * Where to send the money: the only path to a seller's account details, its own call so every disclosure is one
 * access-log row. A party, or a moderator of a live dispute on the order, reads it; anyone else gets not found.
 * `p2p:read`, since a moderator holds no `p2p:write`. guard: merchantApi.
 */
export const P2P_TRADES_PAYMENT_INSTRUMENT = defineProcedure({
  ...base,
  name: 'p2p.trades.paymentInstrument',
  kind: 'query',
  path: 'trades.paymentInstrument',
  access: READ,
  refusals: refuse(REFUSALS_PAYMENT_INSTRUMENT),
  input: tradeId,
  output: z.object({
    tradeId: z.string().guid(),
    methodId: z.string(),
    country: z.string(),
    fiatCurrency: z.string(),
    label: z.string(),
    details: z.record(z.string(), z.string()),
    /** Each detail's label from the method schema, in its order. */
    fields: z.array(z.object({ key: z.string(), label: z.string() })),
    attachedAt: z.string(),
    /** The seller changed or removed this destination after the order was placed. The order still pays the details above. */
    payeeChange: z.object({ kind: z.enum(['changed', 'removed']) }).nullable(),
  }),
  samples: TRADE_ID_SAMPLES,
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
  P2P_TRADES_STEP_UP_WINDOW,
  P2P_TRADES_RELEASE_STEP_UP_WINDOW,
  P2P_TRADES_TAKE,
  P2P_TRADES_CONTRACT_ESCROW,
  P2P_TRADES_ATTACH_CONTRACT_DEAL,
  P2P_TRADES_SYNC_CONTRACT_DEAL,
  P2P_TRADES_MARK_FIAT_SENT,
  P2P_TRADES_CONFIRM_RECEIVED,
  P2P_TRADES_REMIND,
  P2P_TRADES_REPORT_SENSITIVE_REMARK,
  P2P_TRADES_REMARK_CASE,
  P2P_TRADES_REPORT_MISMATCH,
  P2P_TRADES_VALIDATE_PAYMENT,
  P2P_TRADES_CANCEL,
  P2P_TRADES_REQUEST_CANCEL,
  P2P_TRADES_GET,
  P2P_TRADES_LIST,
  P2P_TRADES_PAGE,
  P2P_TRADES_QUOTE,
  P2P_TRADES_LOCK_QUOTE,
  P2P_TRADES_EXPORT,
  P2P_TRADES_RECEIPT,
  P2P_TRADES_PAYMENT_INSTRUMENT,
] as const satisfies readonly ProcedureRecord[];
