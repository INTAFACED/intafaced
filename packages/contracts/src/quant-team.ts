/**
 * Strategy teams (J-algo-dev-08, AL-team-01): a strategy's owner shares it with a teammate under a permission, one edit
 * lock keeps two people from saving over each other, and support reads the source only under the owner's time-boxed
 * grant, each read leaving an audit row.
 *
 * Browser safe. Nothing here is money: every strategy and run stays simulated.
 */
import { z } from 'zod';

/** What a teammate may do: open it, or open and save it. Live control (stopping a run) is a separate grant. */
export const QUANT_TEAM_ROLES = ['view', 'edit'] as const;
export type QuantTeamRole = (typeof QUANT_TEAM_ROLES)[number];

/** The longest support grant the screen offers: a bound on the input, in seconds (one week). */
export const QUANT_SUPPORT_GRANT_MAX_SECONDS = 604_800;
export const QUANT_SUPPORT_GRANT_MIN_SECONDS = 30;

export const quantCollaboratorSchema = z.object({
  memberId: z.string().guid(),
  role: z.enum(QUANT_TEAM_ROLES),
  liveControl: z.boolean(),
  addedAt: z.string(),
  updatedAt: z.string(),
});
export type QuantCollaborator = z.infer<typeof quantCollaboratorSchema>;

/** The edit lock as it reads now: who holds it and until when. Lapsed or never taken reads `held: false`. */
export const quantEditLockSchema = z.object({
  held: z.boolean(),
  holderId: z.string().guid().nullable(),
  mine: z.boolean(),
  expiresAt: z.string().nullable(),
});
export type QuantEditLock = z.infer<typeof quantEditLockSchema>;

export const quantSupportReadSchema = z.object({
  readAt: z.string(),
  reader: z.string(),
  granted: z.boolean(),
});

export const quantSupportGrantSchema = z.object({
  grantId: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  active: z.boolean(),
});
export type QuantSupportGrant = z.infer<typeof quantSupportGrantSchema>;

/** `team.get`, the owner's view: the collaborators, the lock, the support grants and every support read. */
export const quantTeamSchema = z.object({
  strategyId: z.string(),
  ownerId: z.string().guid(),
  collaborators: z.array(quantCollaboratorSchema),
  lock: quantEditLockSchema,
  grants: z.array(quantSupportGrantSchema),
  reads: z.array(quantSupportReadSchema),
  asOf: z.string(),
});
export type QuantTeam = z.infer<typeof quantTeamSchema>;

export const quantTeamSetInputSchema = z.object({
  strategyId: z.string().min(1).max(128),
  memberId: z.string().trim().min(1).max(64),
  role: z.enum(QUANT_TEAM_ROLES),
  liveControl: z.boolean(),
});

export const quantTeamRemoveInputSchema = z.object({
  strategyId: z.string().min(1).max(128),
  memberId: z.string().guid(),
});

export const quantSupportGrantInputSchema = z.object({
  strategyId: z.string().min(1).max(128),
  seconds: z.number().int(),
  /** The grants the screen read: the key of this grant is `quant.grant:<strategy>:<seq>`, so a retry is the same grant. */
  seq: z.number().int().min(0),
});

/** One strategy shared with the caller, as their list shows it. */
export const quantSharedStrategySchema = z.object({
  strategyId: z.string(),
  ownerId: z.string().guid(),
  name: z.string(),
  version: z.number().int().positive(),
  role: z.enum(QUANT_TEAM_ROLES),
  liveControl: z.boolean(),
});
export const quantSharedListSchema = z.object({ accountId: z.string().guid(), strategies: z.array(quantSharedStrategySchema) });

/** `team.open`: a shared strategy as the teammate reads it, with the newest version's source and the lock. */
export const quantSharedOpenSchema = z.object({
  strategyId: z.string(),
  ownerId: z.string().guid(),
  role: z.enum(QUANT_TEAM_ROLES),
  liveControl: z.boolean(),
  name: z.string(),
  version: z.number().int().positive(),
  source: z.string(),
  releaseNote: z.string(),
  versions: z.array(z.object({ version: z.number().int().positive(), name: z.string(), createdAt: z.string(), releaseNote: z.string() })),
  lock: quantEditLockSchema,
});
export type QuantSharedOpen = z.infer<typeof quantSharedOpenSchema>;

export const quantTeamSaveInputSchema = z.object({
  strategyId: z.string().min(1).max(128),
  /** The version the screen read: the save's key is `quant.team.save:<strategy>:<member>:v<n>`. */
  baseVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(128),
  releaseNote: z.string().max(2000).optional(),
});

/** `ops.strategy.source`, support's read: source only under an active grant, else metadata only. */
export const quantSupportSourceSchema = z.object({
  strategyId: z.string(),
  ownerId: z.string().guid(),
  name: z.string(),
  version: z.number().int().positive(),
  versions: z.number().int().nonnegative(),
  granted: z.boolean(),
  grantExpiresAt: z.string().nullable(),
  source: z.string().nullable(),
});
export type QuantSupportSource = z.infer<typeof quantSupportSourceSchema>;
