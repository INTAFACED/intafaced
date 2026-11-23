import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { lapseOutput, partnerForCustomer, rebindForCustomer, SESSION_KEY_PATTERN, SHARE_SURFACES } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `affiliates.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

/** My latest partner application, or null. */
export const IDENTITY_AFFILIATES_MY_PARTNER_APPLICATION = defineProcedure({
  ...base,
  name: 'identity.affiliates.myPartnerApplication',
  kind: 'query',
  path: 'affiliates.myPartnerApplication',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: partnerForCustomer.nullable(),
  samples: [{ verdict: 'accept' }],
});

/**
 * Partner eligibility (J-campaigns-07 #1): my qualified invitees against the owner's required count. A blank count
 * refuses with `partner.eligibility_unset`; nothing is recorded by reading it.
 */
export const IDENTITY_AFFILIATES_PARTNER_ELIGIBILITY = defineProcedure({
  ...base,
  name: 'identity.affiliates.partnerEligibility',
  kind: 'query',
  path: 'affiliates.partnerEligibility',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ requiredCount: z.number().int().positive(), qualifiedCount: z.number().int().nonnegative(), eligible: z.boolean() }),
  samples: [{ verdict: 'accept' }],
});

/** Files my partner application (J-campaigns-07 #2). Pressing twice files one; an open or approved one comes back. */
export const IDENTITY_AFFILIATES_APPLY_PARTNER = defineProcedure({
  ...base,
  name: 'identity.affiliates.applyPartner',
  kind: 'mutation',
  path: 'affiliates.applyPartner',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({}).strict().optional(),
  output: partnerForCustomer,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * My own sub-tree as an approved partner (J-campaigns-07 #4): the people below me, level by level to the programme
 * depth; anyone deeper is counted, never named. Blank depth refuses with `affiliate.programme_depth_unset`.
 */
export const IDENTITY_AFFILIATES_MY_SUB_TREE = defineProcedure({
  ...base,
  name: 'identity.affiliates.mySubTree',
  kind: 'query',
  path: 'affiliates.mySubTree',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    depth: z.number().int().positive(),
    members: z.array(z.object({ handle: z.string(), level: z.number().int().positive(), joinedAt: z.string() })),
    beyondDepth: z.number().int().nonnegative(),
  }),
  samples: [{ verdict: 'accept' }],
});

/**
 * One-tap share token mapped to this principal's user id (the referrer).
 * Idempotent while unrevoked. Hits are a counter, not money.
 */
export const IDENTITY_AFFILIATES_CREATE_SHARE = defineProcedure({
  ...base,
  name: 'identity.affiliates.createShare',
  kind: 'mutation',
  path: 'affiliates.createShare',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    token: z.string().guid(),
    referrerId: z.string().guid(),
    hits: z.number().int(),
  }),
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_AFFILIATES_REVOKE_SHARE = defineProcedure({
  ...base,
  name: 'identity.affiliates.revokeShare',
  kind: 'mutation',
  path: 'affiliates.revokeShare',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    token: z.string().guid(),
    referrerId: z.string().guid(),
    hits: z.number().int(),
    revokedAt: z.string(),
  }),
  samples: [{ verdict: 'accept' }],
});

/** This person's short referral code, or null before they asked for one (CM-referral-01). */
export const IDENTITY_AFFILIATES_MY_CODE = defineProcedure({
  ...base,
  name: 'identity.affiliates.myCode',
  kind: 'query',
  path: 'affiliates.myCode',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ code: z.string(), createdAt: z.string() }).nullable(),
  samples: [{ verdict: 'accept' }],
});

/** Makes this person's code on the first call; repeats return the same one. Blank length refuses. */
export const IDENTITY_AFFILIATES_CREATE_CODE = defineProcedure({
  ...base,
  name: 'identity.affiliates.createCode',
  kind: 'mutation',
  path: 'affiliates.createCode',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ code: z.string(), createdAt: z.string() }),
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_AFFILIATES_MY_REFERRER = defineProcedure({
  ...base,
  name: 'identity.affiliates.myReferrer',
  kind: 'query',
  path: 'affiliates.myReferrer',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: z
    .object({
      userId: z.string().guid(),
      referrerId: z.string().guid(),
      attributedAt: z.string(),
    })
    .nullable(),
  samples: [{ verdict: 'accept' }],
});

/**
 * Where this person's referral relationship stands against the owner's inactivity period (J-campaigns-05 #7): the
 * date it ends without a fee event, and their latest ended relationship. A blank period reads `unset`; no end date
 * is invented.
 */
export const IDENTITY_AFFILIATES_MY_LAPSE = defineProcedure({
  ...base,
  name: 'identity.affiliates.myLapse',
  kind: 'query',
  path: 'affiliates.myLapse',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    state: z.enum(['unset', 'none', 'active']),
    periodSeconds: z.number().int().nullable(),
    lastActivityAt: z.string().nullable(),
    endsAt: z.string().nullable(),
    ended: lapseOutput.nullable(),
  }),
  samples: [{ verdict: 'accept' }],
});

export const IDENTITY_AFFILIATES_MY_ANCESTORS = defineProcedure({
  ...base,
  name: 'identity.affiliates.myAncestors',
  kind: 'query',
  path: 'affiliates.myAncestors',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(z.string().guid()),
  samples: [{ verdict: 'accept' }],
});

/**
 * Affiliate self-view of durable commission accruals only.
 * Always scoped to ctx.principal.userId — no beneficiaryId input (foreign refuse by design).
 * Empty list when no rows / rates unpublished (never invents rates or amounts).
 * Limit required — omit never invents 100. Owner/query may pass 100 explicitly.
 * Payout is a separate admin procedure (affiliates.payout) — refuse-closed without owner rates + ledger.
 */
export const IDENTITY_AFFILIATES_MY_ACCRUALS = defineProcedure({
  ...base,
  name: 'identity.affiliates.myAccruals',
  kind: 'query',
  path: 'affiliates.myAccruals',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(500) }),
  output: z.object({
    rows: z.array(
      z.object({
        feeEventId: z.string(),
        beneficiaryId: z.string().guid(),
        payerId: z.string().guid(),
        hop: z.number().int(),
        rate: z.string(),
        feeAmount: z.string(),
        commissionAmount: z.string(),
        asset: z.string(),
        accruedAt: z.string(),
        sourceModule: z.string(),
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Visits per surface on the caller's live link, every surface listed (zero when none). No live link: share.not_found. */
export const IDENTITY_AFFILIATES_SHARE_STATS = defineProcedure({
  ...base,
  name: 'identity.affiliates.shareStats',
  kind: 'query',
  path: 'affiliates.shareStats',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    token: z.string().guid(),
    surfaces: z.array(z.object({ surface: z.enum(SHARE_SURFACES), visits: z.number().int().nonnegative() })),
  }),
  samples: [{ verdict: 'accept' }],
});

/**
 * One-tap share (RC-campaigns-06, J-campaigns-05 #2): a signed tag for the caller's live link on one surface,
 * `<token>.<surface>.<signature>`. It never makes a link (no live link: `share.not_found`). A blank signing key
 * refuses `share.key_unset`; the key is never returned.
 */
export const IDENTITY_AFFILIATES_SHARE_TAG = defineProcedure({
  ...base,
  name: 'identity.affiliates.shareTag',
  kind: 'mutation',
  path: 'affiliates.shareTag',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ surface: z.enum(SHARE_SURFACES) }),
  output: z.object({ tag: z.string(), token: z.string().guid(), surface: z.enum(SHARE_SURFACES) }),
  samples: [
    { verdict: 'accept', input: { surface: 'promotion' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Whether this person may still attach a referrer through a link, measured on the server from the account's
 * creation (J-campaigns-05 #4 and #5). A blank owner window reads `unset`; nothing is invented.
 */
export const IDENTITY_AFFILIATES_ATTACH_WINDOW = defineProcedure({
  ...base,
  name: 'identity.affiliates.attachWindow',
  kind: 'query',
  path: 'affiliates.attachWindow',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    state: z.enum(['unset', 'open', 'closed']),
    accountCreatedAt: z.string(),
    windowSeconds: z.number().int().nullable(),
    closesAt: z.string().nullable(),
    /** Set when an earlier relationship lapsed: the window runs again from then (RF-4). */
    reopenedAt: z.string().nullable(),
  }),
  samples: [{ verdict: 'accept' }],
});

/** This person's latest referrer change request and its state, or null. */
export const IDENTITY_AFFILIATES_MY_REBIND = defineProcedure({
  ...base,
  name: 'identity.affiliates.myRebind',
  kind: 'query',
  path: 'affiliates.myRebind',
  access: { caller: 'scope', scope: 'identity:read' },
  refusals: {},
  input: NO_INPUT,
  output: rebindForCustomer.nullable(),
  samples: [{ verdict: 'accept' }],
});

/** The person withdraws their own open request. */
export const IDENTITY_AFFILIATES_WITHDRAW_REBIND = defineProcedure({
  ...base,
  name: 'identity.affiliates.withdrawRebind',
  kind: 'mutation',
  path: 'affiliates.withdrawRebind',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ requestId: z.string().uuid() }),
  output: rebindForCustomer,
  samples: [
    { verdict: 'accept', input: { requestId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Public visit of a signed share tag. An edited tag is refused `share.tag_invalid` and counts nothing; a revoked
 * link `share.revoked`; one browser session counts once per surface (`counted: false` after). Returns the link's
 * token for the invitation page, never a count, the referrer's id or an email (counts are the referrer's own read). Limited per IP by the
 * owner's value; a blank one keeps this door shut (`share.rate_unset`). Attribution stays with shareHits.
 */
export const IDENTITY_AFFILIATES_SHARE_TAG_HIT = defineProcedure({
  ...base,
  name: 'identity.affiliates.shareTagHit',
  kind: 'mutation',
  path: 'affiliates.shareTagHit',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ tag: z.string().min(1).max(200), sessionKey: z.string().regex(SESSION_KEY_PATTERN) }),
  output: z.object({
    token: z.string().guid(),
    surface: z.enum(SHARE_SURFACES),
    counted: z.boolean(),
  }),
  samples: [
    { verdict: 'accept', input: { tag: 'USDC', sessionKey: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Public hit. Signed-out: increment only. Signed-in: increment then
 * attribute via the same `affiliates.attribute` path (one tree).
 * Revoked / gone profile: named refuse, no later attribute.
 */
export const IDENTITY_AFFILIATES_SHARE_HITS = defineProcedure({
  ...base,
  name: 'identity.affiliates.shareHits',
  kind: 'mutation',
  path: 'affiliates.shareHits',
  access: { caller: 'public' },
  refusals: {},
  input: z.object({ token: z.string().guid() }),
  output: z.object({ hits: z.number().int(), attributed: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { token: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Ask for a reviewed change of referrer (J-campaigns-05 #5): the invitation link names the new referrer, the
 * person gives a reason, and a second person decides. Only when a link attach cannot apply (window closed or
 * unset, or a referrer is already set). Asking again for the same link returns the open request.
 */
export const IDENTITY_AFFILIATES_REQUEST_REBIND = defineProcedure({
  ...base,
  name: 'identity.affiliates.requestRebind',
  kind: 'mutation',
  path: 'affiliates.requestRebind',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ token: z.string().uuid(), reason: z.string().min(3).max(500) }),
  output: rebindForCustomer,
  samples: [
    { verdict: 'accept', input: { token: '11111111-1111-4111-8111-111111111111', reason: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});
