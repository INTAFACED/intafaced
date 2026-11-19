import { z } from 'zod';
import {
  blueprintExportSchema,
  blueprintSchema,
  cardInput,
  cardOfInput,
  cardOpenerSchema,
  cardRenderSchema,
  cardShareSchema,
  createShareInput,
  eraseReceiptSchema,
  mentorMatchSchema,
  onboardInput,
  onboardOutput,
  setVisibilityInput,
  shareIdInput,
} from './blueprint.js';
import { defineProcedure, NO_INPUT, type Refusals, type RefusalStatus } from './procedure.js';

/**
 * svc-blueprint's whole call surface, one record per call. The service mounts each from here (`mountRecords`), so its
 * path, guard, input, output and named refusals are this file, not its router. Every owner call acts on the signed
 * principal, never on an account id from the input; `cardOf` alone names whose share card to read.
 *
 * Refusals sent as INTERNAL_SERVER_ERROR (`blueprint.engine_unavailable`, `blueprint.engine_protocol`,
 * `blueprint.invalid_profile`, `blueprint.open_log_unavailable`) are failures, not named refusals, and are not listed.
 */

const READ = { caller: 'scope', scope: 'blueprint:read', module: 'blueprint' } as const;
const WRITE = { caller: 'scope', scope: 'blueprint:write', module: 'blueprint' } as const;
const base = { service: 'svc-blueprint', module: 'blueprint', transport: 'trpc' } as const;

const refuse = (codes: Readonly<Record<string, RefusalStatus>> = {}): Refusals => Object.freeze({ ...codes });
const NOT_FOUND = { 'blueprint.not_found': 'NOT_FOUND' } as const;

const ID = '22222222-2222-4222-8222-222222222222';
const ANSWER = { key: 'placeholder', value: 'a' };

export const BLUEPRINT_HEALTH = defineProcedure({
  ...base,
  name: 'blueprint.health',
  kind: 'query',
  path: 'health',
  access: { caller: 'public' },
  refusals: refuse(),
  input: NO_INPUT,
  output: z.object({ ok: z.boolean(), service: z.literal('svc-blueprint') }),
  samples: [{ verdict: 'accept' }],
});

/** The Blueprint session. Answers and birth data go to the Neural Engine and are dropped; nothing here persists them. */
export const BLUEPRINT_ONBOARD = defineProcedure({
  ...base,
  name: 'blueprint.onboard',
  kind: 'mutation',
  path: 'onboard',
  access: WRITE,
  refusals: refuse({
    ...NOT_FOUND,
    'blueprint.crew_not_found': 'NOT_FOUND',
    'blueprint.crew_full': 'CONFLICT',
    'blueprint.crew_capacity_unset': 'PRECONDITION_FAILED',
    'blueprint.mentor_shortlist_unset': 'PRECONDITION_FAILED',
    'blueprint.season_unset': 'PRECONDITION_FAILED',
  }),
  input: onboardInput.omit({ userId: true }),
  output: onboardOutput,
  samples: [
    { verdict: 'accept', input: { responses: [ANSWER] } },
    { verdict: 'accept', input: { responses: [ANSWER], birthData: { date: '1990-01-01' }, visibility: 'crew', mentorAvailable: true } },
    { verdict: 'refuse', input: { responses: [] } },
    { verdict: 'refuse', input: {} },
  ],
});

/** The caller's own Blueprint, or null before the session. */
export const BLUEPRINT_ME = defineProcedure({
  ...base,
  name: 'blueprint.me',
  kind: 'query',
  path: 'me',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: blueprintSchema.nullable(),
  samples: [{ verdict: 'accept' }],
});

/** The caller's own share card, whatever its visibility. */
export const BLUEPRINT_CARD = defineProcedure({
  ...base,
  name: 'blueprint.card',
  kind: 'query',
  path: 'card',
  access: READ,
  refusals: refuse(NOT_FOUND),
  input: cardInput,
  output: cardRenderSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'accept', input: { size: 'landscape' } },
    { verdict: 'refuse', input: { size: 'square' } },
  ],
});

/** Someone else's share card, by account or by share, gated by its visibility. Denied and missing are one NOT_FOUND. */
export const BLUEPRINT_CARD_OF = defineProcedure({
  ...base,
  name: 'blueprint.cardOf',
  checks: { 'blueprint.subject_or_share': { at: 'input', says: 'a subject account or a share id is given' } },
  kind: 'query',
  path: 'cardOf',
  access: READ,
  refusals: refuse(NOT_FOUND),
  input: cardOfInput,
  output: cardRenderSchema,
  samples: [
    { verdict: 'accept', input: { userId: ID } },
    { verdict: 'accept', input: { shareId: ID, size: 'landscape' } },
    { verdict: 'refuse', input: { size: 'portrait' }, by: 'blueprint.subject_or_share' },
    { verdict: 'refuse', input: { userId: 'not-an-id' } },
  ],
});

export const BLUEPRINT_SHARES_CREATE = defineProcedure({
  ...base,
  name: 'blueprint.shares.create',
  kind: 'mutation',
  path: 'shares.create',
  access: WRITE,
  refusals: refuse({
    ...NOT_FOUND,
    'blueprint.share_limit_unset': 'PRECONDITION_FAILED',
    'blueprint.share_limit_reached': 'CONFLICT',
  }),
  input: createShareInput,
  output: cardShareSchema,
  samples: [
    { verdict: 'accept', input: { size: 'portrait' } },
    { verdict: 'refuse', input: {} },
  ],
});

export const BLUEPRINT_SHARES_LIST = defineProcedure({
  ...base,
  name: 'blueprint.shares.list',
  kind: 'query',
  path: 'shares.list',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.array(cardShareSchema),
  samples: [{ verdict: 'accept' }],
});

export const BLUEPRINT_SHARES_REVOKE = defineProcedure({
  ...base,
  name: 'blueprint.shares.revoke',
  kind: 'mutation',
  path: 'shares.revoke',
  access: WRITE,
  refusals: refuse(NOT_FOUND),
  input: shareIdInput,
  output: cardShareSchema,
  samples: [
    { verdict: 'accept', input: { shareId: ID } },
    { verdict: 'refuse', input: { shareId: 'x' } },
  ],
});

export const BLUEPRINT_SHARES_OPENERS = defineProcedure({
  ...base,
  name: 'blueprint.shares.openers',
  kind: 'query',
  path: 'shares.openers',
  access: READ,
  refusals: refuse({ ...NOT_FOUND, 'blueprint.opens_list_limit_unset': 'PRECONDITION_FAILED' }),
  input: shareIdInput,
  output: z.array(cardOpenerSchema),
  samples: [
    { verdict: 'accept', input: { shareId: ID } },
    { verdict: 'refuse', input: {} },
  ],
});

export const BLUEPRINT_SET_VISIBILITY = defineProcedure({
  ...base,
  name: 'blueprint.setVisibility',
  kind: 'mutation',
  path: 'setVisibility',
  access: WRITE,
  refusals: refuse(NOT_FOUND),
  input: setVisibilityInput.omit({ userId: true }),
  output: blueprintSchema,
  samples: [
    { verdict: 'accept', input: { visibility: 'crew' } },
    { verdict: 'refuse', input: { visibility: 'everyone' } },
  ],
});

/** The caller's mentor shortlist, read directly (not through the export, which composes a card). */
export const BLUEPRINT_MENTORS = defineProcedure({
  ...base,
  name: 'blueprint.mentors',
  kind: 'query',
  path: 'mentors',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.array(mentorMatchSchema),
  samples: [{ verdict: 'accept' }],
});

/** Everything this service holds about the caller, as JSON, in one reply (portable). */
export const BLUEPRINT_EXPORT = defineProcedure({
  ...base,
  name: 'blueprint.export',
  kind: 'query',
  path: 'export',
  access: READ,
  refusals: refuse(),
  input: NO_INPUT,
  output: blueprintExportSchema,
  samples: [{ verdict: 'accept' }],
});

/** A hard delete that cascades (deletable). `blueprint:write` alone: a lost second factor never blocks erasure. */
export const BLUEPRINT_ERASE = defineProcedure({
  ...base,
  name: 'blueprint.erase',
  kind: 'mutation',
  path: 'erase',
  access: WRITE,
  refusals: refuse(),
  input: NO_INPUT,
  output: eraseReceiptSchema,
  samples: [{ verdict: 'accept' }],
});

export const BLUEPRINT_PROCEDURES = [
  BLUEPRINT_HEALTH,
  BLUEPRINT_ONBOARD,
  BLUEPRINT_ME,
  BLUEPRINT_CARD,
  BLUEPRINT_CARD_OF,
  BLUEPRINT_SHARES_CREATE,
  BLUEPRINT_SHARES_LIST,
  BLUEPRINT_SHARES_REVOKE,
  BLUEPRINT_SHARES_OPENERS,
  BLUEPRINT_SET_VISIBILITY,
  BLUEPRINT_MENTORS,
  BLUEPRINT_EXPORT,
  BLUEPRINT_ERASE,
] as const;
