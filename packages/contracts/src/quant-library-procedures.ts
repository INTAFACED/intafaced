import { z } from 'zod';
import { defineProcedure, type Refusals, type RefusalStatus } from './procedure.js';
import {
  QUANT_LIBRARY_TAGS,
  QUANT_LISTING_DESCRIPTION_MAX,
  QUANT_LISTING_TAGS_MAX,
  QUANT_LISTING_TITLE_MAX,
  QUANT_LISTING_VISIBILITIES,
  QUANT_REVIEW_TEXT_MAX,
  quantLibraryOptionsSchema,
  quantLibraryPageSchema,
  quantLineageReadSchema,
  quantLineageSchema,
  quantListingCheckSchema,
  quantListingPageSchema,
  quantListingPreviewSchema,
  quantListingSchema,
  quantMyListingsSchema,
} from './quant-library.js';

/**
 * svc-quant's strategy library (`library.*`, J-algo-dev-09, AL-library-01 and AL-library-02), one record per call: the
 * owner's publish checks and listings, browsing, invite-only access, clones, lineage and reviews. Nothing here is money:
 * every listing is free and every figure a stored historical simulation. svc-quant mounts each from here
 * (`routes/library.ts`) and the customer app calls each by its record.
 */

/** Served wherever quant's fiat plane is, with or without a principal; the handler resolves the account itself. */
const ACCESS = { caller: 'jurisdiction', module: 'quant', plane: 'fiat' } as const;

/** The status each refusal leaves with: svc-quant's `toTrpc` (`routes/core.ts`). */
const STATUS = {
  'quant.studio_not_found': 'NOT_FOUND',
  'quant.listing_not_found': 'NOT_FOUND',
  'quant.listing_access_denied': 'FORBIDDEN',
  'quant.listing_source_protected': 'FORBIDDEN',
  'quant.listing_stale': 'CONFLICT',
  'quant.database_url_unset': 'PRECONDITION_FAILED',
  'quant.database_pool_max_unset': 'PRECONDITION_FAILED',
  'quant.library_licences_unset': 'PRECONDITION_FAILED',
  'quant.realism_checklist_unset': 'PRECONDITION_FAILED',
  'quant.realism_checklist_unaccepted': 'PRECONDITION_FAILED',
  'quant.listing_check_failed': 'PRECONDITION_FAILED',
  'quant.review_needs_run': 'PRECONDITION_FAILED',
  'quant.params_invalid': 'BAD_REQUEST',
  'quant.list_cursor_invalid': 'BAD_REQUEST',
} as const satisfies Refusals;
type QuantRefusalCode = keyof typeof STATUS;
const pick = (codes: readonly QuantRefusalCode[]): Refusals =>
  Object.freeze(Object.fromEntries(codes.map((code): [string, RefusalStatus] => [code, STATUS[code]])));
/** Every call but `library.options` reads the library's database: no database wired refuses. */
const refuse = (...more: QuantRefusalCode[]): Refusals => pick(['quant.database_url_unset', 'quant.database_pool_max_unset', ...more]);

const base = { service: 'svc-quant', module: 'quant', transport: 'trpc', access: ACCESS } as const;

/** An operator or teammate may name the account; otherwise it is the caller's own (`resolveStudioAccount`). */
const accountField = { accountId: z.string().guid().optional() };
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const listingId = z.string().min(1).max(64);

const listingDetails = {
  strategyId: z.string().min(1).max(128),
  strategyVersion: z.number().int().positive(),
  title: z.string().max(QUANT_LISTING_TITLE_MAX),
  description: z.string().max(QUANT_LISTING_DESCRIPTION_MAX),
  tags: z.array(z.enum(QUANT_LIBRARY_TAGS)).max(QUANT_LISTING_TAGS_MAX),
  visibility: z.enum(QUANT_LISTING_VISIBILITIES),
  licence: z.string().max(200),
};
const DETAILS = {
  strategyId: 's-1',
  strategyVersion: 1,
  title: 'TEST trend',
  description: 'A moving-average cross.',
  tags: ['trend'],
  visibility: 'open',
  licence: 'MIT',
} as const;

export const QUANT_LIBRARY_OPTIONS = defineProcedure({
  ...base,
  name: 'quant.library.options',
  kind: 'query',
  path: 'library.options',
  // The owner's licence list and checklist are read from settings, null when blank: nothing refuses by name.
  refusals: pick([]),
  input: z.object({ ...accountField }).optional(),
  output: quantLibraryOptionsSchema,
  samples: [{ verdict: 'accept', input: {} }, { verdict: 'accept' }, { verdict: 'refuse', input: { accountId: 'not-a-uuid' } }],
});

export const QUANT_LIBRARY_CHECK = defineProcedure({
  ...base,
  name: 'quant.library.check',
  kind: 'query',
  path: 'library.check',
  // A blank licence list refuses first; then a blank title or description; then a strategy that is not the caller's.
  refusals: refuse('quant.library_licences_unset', 'quant.params_invalid', 'quant.studio_not_found'),
  input: z.object({ ...listingDetails, ...accountField }),
  output: quantListingCheckSchema,
  samples: [
    { verdict: 'accept', input: DETAILS },
    { verdict: 'refuse', input: { ...DETAILS, tags: ['trend', 'swing', 'momentum', 'breakout'] } },
    { verdict: 'refuse', input: { ...DETAILS, visibility: 'public' } },
    { verdict: 'refuse', input: { ...DETAILS, strategyVersion: 0 } },
  ],
});

/** The publish details, the checklist version the screen showed, and whether every item was accepted. */
export const QUANT_LIBRARY_PUBLISH = defineProcedure({
  ...base,
  name: 'quant.library.publish',
  kind: 'mutation',
  path: 'library.publish',
  // An older version refuses stale; then the checks run again (licences, text, strategy) and the first failing one
  // refuses by name; then the checklist, blank or not accepted at its current version.
  refusals: refuse(
    'quant.studio_not_found',
    'quant.listing_stale',
    'quant.library_licences_unset',
    'quant.params_invalid',
    'quant.listing_check_failed',
    'quant.realism_checklist_unset',
    'quant.realism_checklist_unaccepted',
  ),
  input: z.object({
    ...listingDetails,
    checklistVersion: z.string().max(200),
    checklistAccepted: z.boolean(),
    ...accountField,
  }),
  output: quantListingSchema,
  samples: [
    { verdict: 'accept', input: { ...DETAILS, checklistVersion: 'v1', checklistAccepted: true } },
    { verdict: 'refuse', input: DETAILS },
    { verdict: 'refuse', input: { ...DETAILS, checklistVersion: 'v1', checklistAccepted: 'yes' } },
  ],
});

export const QUANT_LIBRARY_MINE = defineProcedure({
  ...base,
  name: 'quant.library.mine',
  kind: 'query',
  path: 'library.mine',
  refusals: refuse(),
  input: z.object({ ...accountField }).optional(),
  output: quantMyListingsSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'accept', input: { accountId: ACCOUNT } },
    { verdict: 'refuse', input: { accountId: 'not-a-uuid' } },
  ],
});

/** Listings in registration order (oldest first), optionally of one tag. */
export const QUANT_LIBRARY_BROWSE = defineProcedure({
  ...base,
  name: 'quant.library.browse',
  kind: 'query',
  path: 'library.browse',
  refusals: refuse('quant.list_cursor_invalid'),
  input: z.object({
    tag: z.enum(QUANT_LIBRARY_TAGS).optional().nullable(),
    limit: z.number().int().min(1).max(50),
    cursor: z.string().max(40).optional().nullable(),
    ...accountField,
  }),
  output: quantLibraryPageSchema,
  samples: [
    { verdict: 'accept', input: { limit: 10 } },
    { verdict: 'accept', input: { tag: 'trend', limit: 10, cursor: '3' } },
    { verdict: 'refuse', input: { limit: 0 } },
    { verdict: 'refuse', input: { tag: 'arbitrage', limit: 10 } },
  ],
});

/** The title and the caller's access, which any signed-in person may read; a hidden listing reads as not found. */
export const QUANT_LIBRARY_PREVIEW = defineProcedure({
  ...base,
  name: 'quant.library.preview',
  kind: 'query',
  path: 'library.preview',
  refusals: refuse('quant.listing_not_found'),
  input: z.object({ listingId, ...accountField }),
  output: quantListingPreviewSchema,
  samples: [
    { verdict: 'accept', input: { listingId: 'l-1' } },
    { verdict: 'refuse', input: { listingId: '' } },
    { verdict: 'refuse', input: { listingId: 'x'.repeat(65) } },
  ],
});

/** The strategy page: an invite-only listing the caller holds no grant to refuses. */
export const QUANT_LIBRARY_GET = defineProcedure({
  ...base,
  name: 'quant.library.get',
  kind: 'query',
  path: 'library.get',
  refusals: refuse('quant.listing_not_found', 'quant.listing_access_denied'),
  input: z.object({ listingId, ...accountField }),
  output: quantListingPageSchema,
  samples: [
    { verdict: 'accept', input: { listingId: 'l-1' } },
    { verdict: 'refuse', input: {} },
    { verdict: 'refuse', input: { listingId: 'l-1', accountId: 'not-a-uuid' } },
  ],
});

/** Asks the owner of an invite-only listing for access; `seq` is the rows the screen read. */
export const QUANT_LIBRARY_REQUEST = defineProcedure({
  ...base,
  name: 'quant.library.request',
  kind: 'mutation',
  path: 'library.request',
  // Only another person's invite-only listing takes a request.
  refusals: refuse('quant.listing_not_found', 'quant.params_invalid'),
  input: z.object({ listingId, seq: z.number().int().nonnegative(), ...accountField }),
  output: quantListingPreviewSchema,
  samples: [
    { verdict: 'accept', input: { listingId: 'l-1', seq: 0 } },
    { verdict: 'refuse', input: { listingId: 'l-1', seq: -1 } },
    { verdict: 'refuse', input: { listingId: 'l-1' } },
  ],
});

const accessInput = z.object({ listingId, userId: z.string().max(64), seq: z.number().int().nonnegative(), ...accountField });
// The owner's only (another owner's listing reads as not found); the person must be another account, the listing invite-only.
const accessRefusals = refuse('quant.listing_not_found', 'quant.params_invalid');
const accessSamples = [
  { verdict: 'accept', input: { listingId: 'l-1', userId: OTHER, seq: 0 } },
  { verdict: 'refuse', input: { listingId: 'l-1', userId: OTHER } },
  { verdict: 'refuse', input: { listingId: 'l-1', userId: 'x'.repeat(65), seq: 0 } },
] as const;

/** The owner grants one person access to an invite-only listing. */
export const QUANT_LIBRARY_GRANT = defineProcedure({
  ...base,
  name: 'quant.library.grant',
  kind: 'mutation',
  path: 'library.grant',
  refusals: accessRefusals,
  input: accessInput,
  output: quantListingSchema,
  samples: accessSamples,
});

/** The owner revokes one person's access to an invite-only listing. */
export const QUANT_LIBRARY_REVOKE = defineProcedure({
  ...base,
  name: 'quant.library.revoke',
  kind: 'mutation',
  path: 'library.revoke',
  refusals: accessRefusals,
  input: accessInput,
  output: quantListingSchema,
  samples: accessSamples,
});

/** Copies the listed version into the caller's library as a new strategy at version 1, its lineage kept. */
export const QUANT_LIBRARY_CLONE = defineProcedure({
  ...base,
  name: 'quant.library.clone',
  kind: 'mutation',
  path: 'library.clone',
  // A protected listing never gives its source; an invite-only one needs a grant.
  refusals: refuse('quant.listing_not_found', 'quant.listing_access_denied', 'quant.listing_source_protected'),
  input: z.object({ listingId, ...accountField }),
  output: quantLineageSchema,
  samples: [
    { verdict: 'accept', input: { listingId: 'l-1' } },
    { verdict: 'refuse', input: { listingId: '' } },
    { verdict: 'refuse', input: { listingId: 7 } },
  ],
});

/** Where one of the caller's strategies came from; null for one they wrote. */
export const QUANT_LIBRARY_LINEAGE = defineProcedure({
  ...base,
  name: 'quant.library.lineage',
  kind: 'query',
  path: 'library.lineage',
  refusals: refuse('quant.studio_not_found'),
  input: z.object({ strategyId: z.string().min(1).max(128), ...accountField }),
  output: quantLineageReadSchema,
  samples: [
    { verdict: 'accept', input: { strategyId: 's-1' } },
    { verdict: 'refuse', input: { strategyId: '' } },
    { verdict: 'refuse', input: { strategyId: 'x'.repeat(129) } },
  ],
});

/** A review, once per person, only after their own clone of the listing has a finished run; screened for claims. */
export const QUANT_LIBRARY_REVIEW = defineProcedure({
  ...base,
  name: 'quant.library.review',
  kind: 'mutation',
  path: 'library.review',
  refusals: refuse(
    'quant.listing_not_found',
    'quant.listing_access_denied',
    'quant.params_invalid',
    'quant.review_needs_run',
    'quant.listing_check_failed',
  ),
  input: z.object({ listingId, text: z.string().max(QUANT_REVIEW_TEXT_MAX), ...accountField }),
  output: quantListingPageSchema,
  samples: [
    { verdict: 'accept', input: { listingId: 'l-1', text: 'Clear rules.' } },
    { verdict: 'refuse', input: { listingId: 'l-1' } },
    { verdict: 'refuse', input: { listingId: 'l-1', text: 'x'.repeat(QUANT_REVIEW_TEXT_MAX + 1) } },
  ],
});

/** What `library.check` reads: the publish details of one version. */
export type QuantListingCheckInput = Omit<z.infer<typeof QUANT_LIBRARY_CHECK.input>, 'accountId'>;
/** What `library.publish` reads: the details, the checklist version shown, and whether every item was accepted. */
export type QuantListingPublishInput = Omit<z.infer<typeof QUANT_LIBRARY_PUBLISH.input>, 'accountId'>;

export const QUANT_LIBRARY_PROCEDURES = [
  QUANT_LIBRARY_OPTIONS,
  QUANT_LIBRARY_CHECK,
  QUANT_LIBRARY_PUBLISH,
  QUANT_LIBRARY_MINE,
  QUANT_LIBRARY_BROWSE,
  QUANT_LIBRARY_PREVIEW,
  QUANT_LIBRARY_GET,
  QUANT_LIBRARY_REQUEST,
  QUANT_LIBRARY_GRANT,
  QUANT_LIBRARY_REVOKE,
  QUANT_LIBRARY_CLONE,
  QUANT_LIBRARY_LINEAGE,
  QUANT_LIBRARY_REVIEW,
] as const;
