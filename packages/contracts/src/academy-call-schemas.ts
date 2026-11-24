import { z } from 'zod';
import { academyIssuedCertDesignSchema } from './academy-cert-designs.js';
import { academyVideoPositionSchema } from './academy-catalogue.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** The schemas svc-academy's records share, moved from the service so the records and every caller read one copy. */

export const curriculumInventoryOut = z.object({
  contentSource: z.enum(['platform-native-expansion', 'licensed-import-pending']),
  spine: z.object({
    total: z.number().int(),
    playbooks: z.number().int(),
    workbooks: z.number().int(),
    lessons: z.number().int(),
  }),
  titleTarget: z.object({ playbooks: z.number().int(), workbooks: z.number().int() }),
  titlePromiseMet: z.boolean(),
  residualPlaybooks: z.number().int(),
  residualWorkbooks: z.number().int(),
});

export const curriculumDepthOut = z.object({
  total: z.number().int(),
  deep: z.number().int(),
  thin: z.number().int(),
  thinSlugs: z.array(z.string()),
  minBodyChars: z.number().int(),
  shortestBodyChars: z.number().int(),
  totalBodyChars: z.number().int(),
  allDeep: z.boolean(),
});

export const curriculumImportStatusOut = z.object({
  contentSource: z.enum(['platform-native-expansion', 'licensed-import-pending']),
  titlePromiseMet: z.boolean(),
  residualPlaybooks: z.number().int(),
  residualWorkbooks: z.number().int(),
  stage1Pipeline: z.literal(true),
  stage2CatalogExpanded: z.boolean(),
  stage3Polish: z.object({
    deepLinksVerified: z.boolean(),
    i18nStrategyHonest: z.boolean(),
    ready: z.boolean(),
  }),
  /** D26-P1-C5 — real lesson substance, not char-count theater. */
  substanceBarMet: z.boolean(),
  theaterSlugs: z.array(z.string()),
});

/**
 * The module identity records against the award. `academy`, never `identity` —
 * `sourceModule` answers "who awarded this", and identity awarding itself would
 * make every cert XP row untraceable to the thing that earned it.
 */
export const CERT_XP_SOURCE_MODULE = 'academy' as const;

/**
 * One action for the whole cert path, with the cert named in `meta`.
 *
 * This mirrors svc-p2p, which emits `action: 'trade.released'` and puts the
 * trade id in `meta` rather than minting an action string per trade. Identity
 * groups XP by action; a per-cert action would make that grouping useless the
 * day a second cert exists.
 */
export const CERT_XP_ACTION = 'cert.granted' as const;

export const certXpPlaneOut = z.object({
  publisherId: z.string(),
  emitEnabled: z.boolean(),
  sourceModule: z.literal(CERT_XP_SOURCE_MODULE),
  action: z.literal(CERT_XP_ACTION),
  rankWriter: z.literal('svc-identity'),
  policies: z.array(z.object({ certId: z.string(), xpDelta: z.number().int() })),
});

export const PAPER_OPS_FLAG_ID = 'academy.paper-trading' as const;

/**
 * Paper trading Stage-3 — ops enable/kill without touching live trade
 * (TRK-academy.paper-trading).
 *
 * Academy consumer kill-switch only. Live markets / placeOrder stay on trade.
 * No prices, fills, balances, or ledger posts here.
 */
export const PAPER_OPS_ENV_KEY = 'ACADEMY_PAPER_TRADING_ENABLED' as const;

/** The only venue a sealed result may claim. There is no second one. */
export const SIMULATED_VENUE = 'paper' as const;

/** Matches Blueprint `curriculumPath` — the only paths the catalog knows. */
export const curriculumPath = z.enum(['foundations', 'markets', 'builder', 'sovereign']);

export const residencyStatus = z.enum(['applied', 'accepted', 'rejected', 'withdrawn']);

/** Public IFC / residency pay door — typed refuse only (no quote amounts). */
export const publicAmbassadorPayQuoteOut = z.object({
  status: z.literal('refuse'),
  ok: z.literal(false),
  payable: z.literal(false),
  inventedIfc: z.literal(false),
  kind: z.enum(['ifc_pay', 'revenue_share', 'residency']),
  code: z.enum([
    'academy.ambassador_pay.rates_unset',
    'academy.ambassador_pay.class_m',
    'academy.ambassador_pay.recipe_unset',
    'academy.ambassador_pay.invent_refused',
    'academy.ambassador_pay.residency_not_accepted',
    'academy.ambassador_revenue_share.rates_unset',
    'academy.ambassador_revenue_share.class_m',
    'academy.ambassador_revenue_share.recipe_unset',
    'academy.ambassador_revenue_share.invent_refused',
    'academy.ambassador_revenue_share.residency_not_accepted',
  ]),
  reason: z.enum(['unset', 'invent', 'class_m']),
  rateAuthorityPublished: z.boolean(),
  residual: z.string(),
  message: z.string(),
});

export const curriculumKind = z.enum(['playbook', 'workbook', 'lesson']);

export const curriculumSummaryOut = z.object({
  slug: z.string(),
  title: z.string(),
  kind: curriculumKind,
  path: curriculumPath,
  order: z.number().int(),
  summary: z.string(),
  /** Derived from the body, never hand-typed — see `readingMinutes` in curriculum/content.ts. */
  estimatedMinutes: z.number().int().positive(),
});

export const curriculumKeyTermOut = z.object({ term: z.string(), definition: z.string() });

/**
 * The teaching scaffolding that turns a markdown blob into a screen: what a
 * reader should be able to do, the vocabulary the body assumes, and the
 * questions that reveal whether they got it. Nothing here is graded — grading
 * and XP belong to the `cert*` procedures.
 */
export const curriculumTeachingOut = {
  objectives: z.array(z.string()).min(1),
  keyTerms: z.array(curriculumKeyTermOut).min(1),
  selfCheck: z.array(z.string()).min(1),
};

export const curriculumItemOut = curriculumSummaryOut.extend({
  body: z.string(),
  ...curriculumTeachingOut,
});

export const ambassadorStatus = z.enum(['active', 'frozen']);

export const ambassadorOut = z.object({
  userId: z.string().guid(),
  status: ambassadorStatus,
  appointedBy: z.string().guid(),
  appointedAt: z.iso.datetime({ offset: true }),
  frozenAt: z.iso.datetime({ offset: true }).nullable(),
  frozenBy: z.string().guid().nullable(),
  freezeReason: z.string().nullable(),
});

export const operatorApprovalIds = {
  confirmOperatorId: z.string().max(128).nullish(),
  approvalId: z.string().max(128).nullish(),
  operationId: z.string().max(128).nullish(),
};

export const seasonStatus = z.enum(['scheduled', 'live', 'frozen', 'ended']);

export const seasonOut = z.object({
  id: z.string().guid(),
  slug: z.string(),
  title: z.string(),
  status: seasonStatus,
  rulesSummary: z.string(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).nullable(),
});

export const standingOut = z.object({
  seasonId: z.string().guid(),
  userId: z.string().guid(),
  score: z.number().int(),
  updatedAt: z.iso.datetime({ offset: true }),
  rank: z.number().int(),
});

export const sessionStatus = z.enum(['scheduled', 'live', 'ended', 'cancelled']);

export const sessionOut = z.object({
  id: z.string().guid(),
  roomId: z.string().guid(),
  title: z.string(),
  hostId: z.string().guid(),
  status: sessionStatus,
  startsAt: z.date(),
  endsAt: z.date().nullable(),
  /** Null when no SFU is configured — the lobby still runs as text and presence. */
  streamProvider: z.string().nullable(),
  scene: z.record(z.string(), z.unknown()),
  /** Always on read — client supplies this as expectedFingerprint on updateScene. */
  sceneFingerprint: z.string().min(1),
  seated: z.boolean(),
  role: z.enum(['host', 'speaker', 'attendee']).nullable(),
});

export const completionPageOut = z.object({
  items: z.array(z.object({ itemSlug: z.string(), completedAt: z.iso.datetime({ offset: true }) })),
  nextCursor: z.string().nullable(),
});

export const certGrantOut = z.object({
  userId: z.string().guid(),
  certId: z.string(),
  grantedAt: z.iso.datetime({ offset: true }),
  idempotencyKey: z.string(),
  publicId: z.string().regex(/^[0-9a-f]{32}$/),
  /** `revoked` once staff revoked it (AC-certificates-03); the public check then says revoked too. */
  status: z.enum(['valid', 'revoked']).optional(),
  /** AC-certificates-03: the design revision this certificate prints, or null when it was issued before any was active. */
  design: academyIssuedCertDesignSchema.nullable().optional(),
});

export const enrollmentOut = z.object({
  userId: z.string().guid(),
  pathSlug: z.string(),
  enrolledAt: z.iso.datetime({ offset: true }),
});

export const leaveOut = enrollmentOut.extend({ leftAt: z.iso.datetime({ offset: true }) });

export const videoProgressOut = academyVideoPositionSchema;
