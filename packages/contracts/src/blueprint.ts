import { z } from 'zod';

/**
 * IDENTITY BLUEPRINT CONTRACT (§7.1).
 *
 * §7.1 names three read-only downstream consumers of `blueprints.profile`:
 * svc-trade (guardrail defaults), svc-academy (curriculum path, lobby routing)
 * and svc-agents (tone register). They read the profile through THIS file and
 * never import svc-blueprint — the same rule identity.ts establishes.
 *
 * Branding (Doctrine §0.7): the vocabulary in this file is *Identity Blueprint*,
 * *Neural Engine*, *Sovereign Intelligence*. Nothing else names the intelligence
 * that produces a profile, here or anywhere a user can see.
 */

// ── The five axes (§7.1) ─────────────────────────────────────────────────────
//
// Categorical, not scalar. Crew matching is about complementarity — "these two
// decide differently" is the question, and a distance between two numbers on an
// invented scale would answer it less honestly than set membership does.

export const decisionStyleSchema = z.enum(['analytical', 'intuitive', 'collaborative', 'decisive']);
export const riskTemperamentSchema = z.enum(['guarded', 'measured', 'assertive', 'bold']);
export const energyRhythmSchema = z.enum(['dawn', 'steady', 'surge', 'nocturnal']);
export const learningModeSchema = z.enum(['visual', 'narrative', 'hands_on', 'systematic']);
export const crewRoleSchema = z.enum(['anchor', 'scout', 'builder', 'catalyst']);

export type DecisionStyle = z.infer<typeof decisionStyleSchema>;
export type RiskTemperament = z.infer<typeof riskTemperamentSchema>;
export type EnergyRhythm = z.infer<typeof energyRhythmSchema>;
export type LearningMode = z.infer<typeof learningModeSchema>;
export type CrewRole = z.infer<typeof crewRoleSchema>;

/**
 * Default agent guardrails (§7.1: "default agent guardrails written to profile").
 *
 * These are limits and multipliers, never balances or amounts — svc-blueprint
 * holds no money and these numbers never reach the ledger. svc-trade reads them
 * as *defaults a user may raise*, not as a cap it enforces on our behalf.
 */
export const guardrailsSchema = z.object({
  /** Starting leverage ceiling offered in the UI. 1 = spot only. */
  maxLeverage: z.number().int().min(1).max(20),
  /** Soft daily drawdown prompt, as a percentage of portfolio value. */
  dailyLossPromptPct: z.number().int().min(1).max(100),
  /** Whether a market order asks for confirmation by default. */
  confirmBeforeMarketOrder: z.boolean(),
  /** Whether copy-trading is surfaced at all on day one. */
  copyTradingVisible: z.boolean(),
});
export type Guardrails = z.infer<typeof guardrailsSchema>;

/**
 * THE PROFILE. This is the only thing the Neural Engine returns that we keep.
 *
 * §10 PII isolation: raw birth data is an *input* to the engine and is never
 * persisted, never logged, and never appears on an event or a span. What lands
 * in `blueprints.profile` is this derived object and nothing else.
 */
export const blueprintProfileSchema = z.object({
  decisionStyle: decisionStyleSchema,
  riskTemperament: riskTemperamentSchema,
  energyRhythm: energyRhythmSchema,
  learningMode: learningModeSchema,
  crewRole: crewRoleSchema,
  /** svc-academy routes on this (§7.1 "curriculum path"). */
  curriculumPath: z.enum(['foundations', 'markets', 'builder', 'sovereign']),
  /** svc-agents reads this and nothing else about a user (§7.1 "tone register"). */
  toneRegister: z.enum(['direct', 'warm', 'socratic', 'terse']),
  guardrails: guardrailsSchema,
});
export type BlueprintProfile = z.infer<typeof blueprintProfileSchema>;

export const visibilitySchema = z.enum(['private', 'crew', 'public']);
export type Visibility = z.infer<typeof visibilitySchema>;

export const blueprintSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  /** Which engine build produced this profile — a re-run is comparable only within a version. */
  engineVersion: z.string().min(1),
  profile: blueprintProfileSchema,
  /**
   * The PRIMARY share asset (portrait), once a rasterizer has actually produced
   * one. Null is the honest and common state: the vector card always renders,
   * but turning it into a hosted PNG needs an external renderer, and this column
   * holds a URL only when one really came back. See `cardRenderSchema`.
   */
  cardAssetUrl: z.string().nullable(),
  visibility: visibilitySchema,
  createdAt: z.string().datetime({ offset: true }),
});
export type BlueprintRecord = z.infer<typeof blueprintSchema>;

// ── The share card (§7.1 "the acquisition artifact", §7.2 exit criterion) ────

/**
 * The two share sizes §7.2 names, and the only two.
 *
 * They are an enum rather than free width/height because "renders pixel-perfect
 * at share sizes (1080×1350, 1200×630)" is a claim about two specific canvases
 * that were designed, not about arbitrary rectangles. An API that accepted
 * `{ width, height }` would let a caller ask for 300×2000 and get something no
 * one has ever looked at — and the exit criterion would silently become untrue.
 */
export const cardSizeSchema = z.enum(['portrait', 'landscape']);
export type CardSize = z.infer<typeof cardSizeSchema>;

/**
 * Exact pixel dimensions. §7.2 names these numbers; this is where they live, so
 * the composer, the tests and any future renderer read one source.
 *
 * `portrait` is 1080×1350 — the 4:5 feed/story canvas. `landscape` is 1200×630,
 * the Open Graph card a link unfurls into.
 */
export const CARD_DIMENSIONS: Readonly<Record<CardSize, { readonly width: number; readonly height: number }>> = {
  portrait: { width: 1080, height: 1350 },
  landscape: { width: 1200, height: 630 },
};

/**
 * Whether a raster of this card exists, and if not, why not — as DATA.
 *
 * A discriminated union rather than a thrown error, because "we have the vector
 * card but no hosted PNG" is a normal, renderable state and not a request
 * failure. A surface can show the card and a truthful note about the PNG; if
 * this were a throw, the surface would have to catch an exception to display
 * something it successfully received.
 */
export const cardRasterSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('rendered'),
    url: z.string().url(),
    contentType: z.literal('image/png'),
    bytes: z.number().int().positive(),
  }),
  z.object({
    status: z.literal('unavailable'),
    /**
     * Typed so a surface can distinguish "this deployment has no renderer" —
     * permanent, nothing to retry — from "the renderer is down right now".
     */
    code: z.enum(['blueprint.card_renderer_unconfigured', 'blueprint.card_renderer_unreachable', 'blueprint.card_renderer_protocol']),
    reason: z.string().min(1),
  }),
]);
export type CardRaster = z.infer<typeof cardRasterSchema>;

export const cardRenderSchema = z.object({
  size: cardSizeSchema,
  /** Echoed from CARD_DIMENSIONS so a consumer never has to look them up. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /**
   * The card itself, as SVG. This is a complete, shareable, printable artifact
   * — not a preview of one. It is always present, because composing it needs
   * nothing outside this service.
   */
  svg: z.string().min(1),
  raster: cardRasterSchema,
  /**
   * Stage-1 share mode (implementable TRK blueprint.card).
   * `svg` = vector card is the share artifact (always available).
   * `png` = hosted raster URL is available for unfurl.
   */
  shareMode: z.enum(['svg', 'png']),
});
export type CardRender = z.infer<typeof cardRenderSchema>;

export const cardInput = z.object({
  size: cardSizeSchema.default('portrait'),
});

/**
 * Authenticated card read.
 *
 * `userId` is the subject of the old visibility link. `shareId` is one share
 * of one card (MC-blueprint-01). At least one is required. The viewer is still
 * the signed principal. A share id does not skip the visibility rule.
 */
export const cardOfInput = z
  .object({
    userId: z.string().uuid().optional(),
    shareId: z.string().uuid().optional(),
    size: cardSizeSchema.default('portrait'),
  })
  .refine((value) => value.userId !== undefined || value.shareId !== undefined, {
    message: 'A subject or a share is required',
  });

/** One share of one card size. The id is the `:cardId` on `/blueprint/shared/:cardId`. */
export const cardShareSchema = z.object({
  id: z.string().uuid(),
  size: cardSizeSchema,
  createdAt: z.string().datetime({ offset: true }),
  revokedAt: z.string().datetime({ offset: true }).nullable(),
  state: z.enum(['active', 'revoked']),
  /** How many times the card was opened through this share. Not a viewer count. */
  openCount: z.number().int().min(0),
});
export type CardShare = z.infer<typeof cardShareSchema>;

/**
 * Who opened a share, without a name, handle, avatar or account id.
 * The two kinds are the words the screen shows (MC-blueprint-01).
 */
export const openerKindSchema = z.enum(['crew member', 'signed-in account']);
export type OpenerKind = z.infer<typeof openerKindSchema>;

export const cardOpenerSchema = z.object({
  kind: openerKindSchema,
  firstOpened: z.string().datetime({ offset: true }),
  lastOpened: z.string().datetime({ offset: true }),
  openCount: z.number().int().min(1),
});
export type CardOpener = z.infer<typeof cardOpenerSchema>;

export const cardShareExportSchema = cardShareSchema.extend({
  openers: z.array(cardOpenerSchema),
});
export type CardShareExport = z.infer<typeof cardShareExportSchema>;

export const createShareInput = z.object({
  size: cardSizeSchema,
});

export const shareIdInput = z.object({
  shareId: z.string().uuid(),
});

/**
 * Change the caller's own visibility. `userId` is filled from the principal
 * at the router — same omit pattern as `onboardInput`.
 */
export const setVisibilityInput = z.object({
  userId: z.string().uuid(),
  visibility: visibilitySchema,
});

// ── Crews (§7.1, §33) ────────────────────────────────────────────────────────

export const crewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  formedAt: z.string().datetime({ offset: true }),
  season: z.number().int().min(1),
  /** Crew XP is a count, not money. It never touches the ledger. */
  xp: z.string(),
  lobbyId: z.string().uuid().nullable(),
  capacity: z.number().int().min(1),
});
export type Crew = z.infer<typeof crewSchema>;

export const crewMemberSchema = z.object({
  crewId: z.string().uuid(),
  userId: z.string().uuid(),
  role: crewRoleSchema,
  joinedAt: z.string().datetime({ offset: true }),
});
export type CrewMember = z.infer<typeof crewMemberSchema>;

export const mentorMatchSchema = z.object({
  studentId: z.string().uuid(),
  mentorId: z.string().uuid(),
  /** 0–10000. Basis points of fit, so the score is an integer and reproducible. */
  fitScore: z.number().int().min(0).max(10_000),
  status: z.enum(['shortlisted', 'accepted', 'declined', 'ended']),
});
export type MentorMatch = z.infer<typeof mentorMatchSchema>;

// ── Onboarding (§7.1 flow) ───────────────────────────────────────────────────

/**
 * One answer in the guided sequence. The session is conducted by the agents
 * gateway; what arrives here is already reduced to keyed answers.
 */
export const sessionResponseSchema = z.object({
  key: z.string().min(1).max(64),
  value: z.string().min(1).max(2_000),
});

/**
 * Birth data (§7.1 "guided sequence + birth data").
 *
 * PII, and treated as such: this crosses the wire to the engine and is then
 * dropped. There is no column for it, by design — a field that does not exist
 * cannot leak (§10).
 */
export const birthDataSchema = z.object({
  /** ISO date, `YYYY-MM-DD`. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** 24h local time, `HH:MM`. Optional — the engine degrades without it. */
  time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  /** Free-text place. Never geocoded here. */
  place: z.string().max(200).optional(),
});
export type BirthData = z.infer<typeof birthDataSchema>;

export const onboardInput = z.object({
  userId: z.string().uuid(),
  locale: z.string().min(2).max(10).default('en'),
  responses: z.array(sessionResponseSchema).min(1).max(64),
  birthData: birthDataSchema.optional(),
  visibility: visibilitySchema.default('private'),
  /**
   * Opt in to appearing on other people's mentor shortlists. Defaults off —
   * being listed as a mentor is a commitment of someone's time, and inferring
   * consent from a profile would be opting people in silently.
   */
  mentorAvailable: z.boolean().default(false),
});
export type OnboardInput = z.infer<typeof onboardInput>;

export const placementSchema = z.object({
  crewId: z.string().uuid(),
  crewName: z.string(),
  /** 0–10000 basis points of complementarity. */
  score: z.number().int().min(0).max(10_000),
  matchRunId: z.string().uuid(),
  /** True when no open crew existed and one was formed for this user. */
  crewFormed: z.boolean(),
});
export type Placement = z.infer<typeof placementSchema>;

export const onboardOutput = z.object({
  blueprint: blueprintSchema,
  placement: placementSchema,
  mentors: z.array(mentorMatchSchema),
});
export type OnboardOutput = z.infer<typeof onboardOutput>;

/**
 * §7.2 ownership: "export (JSON + card) and hard-delete endpoints — portable,
 * deletable, per the doc's promise." This is the export envelope; everything the
 * service holds about a user is reachable from it.
 */
export const blueprintExportSchema = z.object({
  exportedAt: z.string().datetime({ offset: true }),
  /**
   * 2 — `card` was added. §7.2 promises "export (JSON + card)", and an export
   * that omitted the card was JSON only. Bumped rather than added silently: the
   * literal exists so a consumer reading an archive can tell which shape it is
   * holding, and a new required field it cannot find is exactly the case it is
   * there to make legible.
   */
  schemaVersion: z.literal(2),
  blueprint: blueprintSchema.nullable(),
  /**
   * The share card, composed at export time (§7.2 "export (JSON + card)").
   *
   * Portrait — the primary artifact. Null only when there is no Blueprint to
   * draw. Derived on read rather than stored: it is a pure function of the
   * profile, so persisting it would create a second copy of personal data that
   * erasure would then have to chase.
   */
  card: cardRenderSchema.nullable(),
  crew: crewSchema.nullable(),
  membership: crewMemberSchema.nullable(),
  crewmates: z.array(z.object({ userId: z.string().uuid(), role: crewRoleSchema, joinedAt: z.string() })),
  matchRuns: z.array(
    z.object({
      id: z.string().uuid(),
      candidates: z.unknown(),
      scores: z.unknown(),
      placedCrewId: z.string().uuid().nullable(),
      ts: z.string().datetime({ offset: true }),
    }),
  ),
  mentorMatches: z.array(mentorMatchSchema),
  mentoringOthers: z.array(mentorMatchSchema),
  /**
   * The caller's shares and each share's opener rows (MC-blueprint-01).
   * Opener rows carry a kind, times and a count. They do not carry an account id.
   * Empty when the caller has no shares. An omitted key is an empty array.
   * Schema version stays 2: the customer export parser still requires that
   * literal and drops keys it does not know.
   */
  shares: z.array(cardShareExportSchema).default([]),
});
export type BlueprintExport = z.infer<typeof blueprintExportSchema>;

export const eraseReceiptSchema = z.object({
  userId: z.string().uuid(),
  erasedAt: z.string().datetime({ offset: true }),
  removed: z.object({
    blueprints: z.number().int().min(0),
    crewMemberships: z.number().int().min(0),
    matchRuns: z.number().int().min(0),
    mentorMatches: z.number().int().min(0),
    emptiedCrews: z.number().int().min(0),
    /** Shares this account owned, plus nothing else. */
    shares: z.number().int().min(0),
    /** Opens this account made, and opens of shares this account owned. */
    cardOpens: z.number().int().min(0),
  }),
});
export type EraseReceipt = z.infer<typeof eraseReceiptSchema>;

/**
 * The shape svc-blueprint must implement. A breaking change here is a compile
 * error in this package, caught in the contracts PR before a consumer is
 * touched (§15.2).
 */
export interface BlueprintContract {
  onboard(input: OnboardInput): Promise<OnboardOutput>;
  get(input: { userId: string }): Promise<BlueprintRecord | null>;
  card(input: { userId: string; size: CardSize }): Promise<CardRender>;
  /**
   * Visibility-gated card read. Without `shareId`, `subjectUserId` is whose card
   * (self always succeeds; `public` any authenticated principal; `crew` same crew;
   * `private` not found). With `shareId`, the subject is the share's owner; a
   * mismatched subject is the same not-found as a missing share (MC-blueprint-01).
   * Denied and missing are the same error — a private Blueprint is not enumerable.
   */
  cardFor(input: { viewerId: string; subjectUserId?: string; size: CardSize; shareId?: string }): Promise<CardRender>;
  setVisibility(input: { userId: string; visibility: Visibility }): Promise<BlueprintRecord>;
  createShare(input: { userId: string; size: CardSize }): Promise<CardShare>;
  listShares(input: { userId: string }): Promise<CardShare[]>;
  revokeShare(input: { userId: string; shareId: string }): Promise<CardShare>;
  shareOpeners(input: { userId: string; shareId: string }): Promise<CardOpener[]>;
  export(input: { userId: string }): Promise<BlueprintExport>;
  erase(input: { userId: string }): Promise<EraseReceipt>;
}

/**
 * What a user gets before the Blueprint session runs. Deliberately cautious:
 * an unknown user is treated as a new one, not as a bold one.
 */
export const BASE_GUARDRAILS: Guardrails = {
  maxLeverage: 1,
  dailyLossPromptPct: 5,
  confirmBeforeMarketOrder: true,
  copyTradingVisible: false,
};
