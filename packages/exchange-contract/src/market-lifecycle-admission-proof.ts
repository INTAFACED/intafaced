import { createHash } from 'node:crypto';
import { z } from 'zod';
import { marketStateSnapshotSchema, type MarketAction, type MarketStateSnapshot } from './market-lifecycle.js';

/** Mutating matching doors that must carry an eligible admission proof. */
const MARKET_LIFECYCLE_ADMISSION_ACTIONS = ['PLACE', 'PLACE_POST_ONLY', 'AMEND'] as const;
const marketLifecycleAdmissionActionSchema = z.enum(MARKET_LIFECYCLE_ADMISSION_ACTIONS);

/**
 * Evidence binding for an eligible order admission.  The property order is
 * wire-compatible with the proof previously emitted by svc-trade.
 */
export const marketLifecycleAdmissionProofSchema = z
  .object({
    action: marketLifecycleAdmissionActionSchema,
    decision: z.literal('ELIGIBLE'),
    checkedAt: z.string().datetime({ offset: true }),
    snapshotId: z.string().regex(/^trade\.lifecycle\.snapshot:[a-f0-9]{64}$/),
    transitionId: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)),
    snapshot: marketStateSnapshotSchema,
  })
  .superRefine((proof, context) => {
    if (!proof.snapshot.allowedActions.includes(proof.action)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['action'], message: 'action must be allowed by the exact snapshot' });
    }
    if (proof.checkedAt !== proof.snapshot.observedAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['checkedAt'], message: 'checkedAt must bind to snapshot observedAt' });
    }
    if (proof.transitionId !== proof.snapshot.transitionId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['transitionId'], message: 'transitionId must match snapshot' });
    }
    if (JSON.stringify(proof.evidenceRefs) !== JSON.stringify(proof.snapshot.evidenceRefs)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidenceRefs'], message: 'evidenceRefs must match snapshot' });
    }
    // Hashed only when the snapshot itself parses: a broken snapshot is already refused by its own issues, and hashing it
    // with `.parse` threw out of `safeParse` (svc-matching answered 500 instead of 400).
    const snapshot = marketStateSnapshotSchema.safeParse(proof.snapshot);
    if (snapshot.success && snapshotIdOfParsed(snapshot.data) !== proof.snapshotId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['snapshotId'], message: 'snapshotId must hash the exact snapshot' });
    }
  });

export type MarketLifecycleAdmissionProof = z.infer<typeof marketLifecycleAdmissionProofSchema>;

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** Deterministic ID of the canonical parsed snapshot, compatible with svc-trade. */
export function snapshotIdFor(snapshot: MarketStateSnapshot): string {
  return snapshotIdOfParsed(marketStateSnapshotSchema.parse(snapshot));
}

function snapshotIdOfParsed(parsed: MarketStateSnapshot): string {
  return `trade.lifecycle.snapshot:${createHash('sha256').update(JSON.stringify(parsed)).digest('hex')}`;
}

/** Descriptive alias for callers that prefer the lifecycle-specific helper name. */
export const marketLifecycleSnapshotId = snapshotIdFor;

/**
 * Construct the immutable proof at the admission boundary.  Parsing the
 * snapshot and final proof makes malformed inputs return a typed ZodError;
 * this function does not decide market state or own any authority.
 */
export function createMarketLifecycleAdmissionProof(
  snapshot: MarketStateSnapshot,
  action: MarketAction,
  checkedAt = snapshot.observedAt,
): MarketLifecycleAdmissionProof {
  const parsedSnapshot = marketStateSnapshotSchema.parse(snapshot);
  const proof = marketLifecycleAdmissionProofSchema.parse({
    action,
    decision: 'ELIGIBLE',
    checkedAt,
    snapshotId: snapshotIdFor(parsedSnapshot),
    transitionId: parsedSnapshot.transitionId,
    evidenceRefs: [...parsedSnapshot.evidenceRefs],
    snapshot: parsedSnapshot,
  });
  return freezeDeep(proof);
}

/** Compatibility name for the service-local constructor during migration. */
export const createLifecycleAdmissionProof = createMarketLifecycleAdmissionProof;
