import { z } from 'zod';
import { blueprintExportSchema } from '../../../../../packages/contracts/src/blueprint';

const timestamp = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(new Date(value).getTime()));
const integerCount = /^-?\d+$/;

/** Validate the whole owner export before dropping profile, card and history.
 * The service reads these records sequentially: exportedAt is not an as-of proof.
 */
export function crewExportForOwner(owner: string) {
  return blueprintExportSchema.superRefine((record, ctx) => {
    const reject = () => ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unverifiable owner crew export' });
    if (!timestamp.safeParse(record.exportedAt).success || (record.membership && !timestamp.safeParse(record.membership.joinedAt).success))
      reject();
    if (
      (record.blueprint && record.blueprint.userId !== owner) ||
      record.mentorMatches.some((row) => row.studentId !== owner) ||
      record.mentoringOthers.some((row) => row.mentorId !== owner)
    )
      reject();
    if (
      record.blueprint
        ? !record.card || record.card.size !== 'portrait' || record.card.width !== 1080 || record.card.height !== 1350
        : record.card !== null
    )
      reject();
    const { crew, membership, crewmates } = record;
    if (!crew && !membership) {
      if (crewmates.length) reject();
      return;
    }
    if (!crew || !membership) {
      reject();
      return;
    }
    if (membership.userId !== owner || membership.crewId !== crew.id || !integerCount.test(crew.xp)) reject();
    const peers = new Set(crewmates.map((row) => row.userId));
    if (
      peers.has(owner) ||
      peers.size !== crewmates.length ||
      crewmates.length + 1 > crew.capacity ||
      crewmates.some((row) => !timestamp.safeParse(row.joinedAt).success)
    )
      reject();
  });
}
export type CrewEnvelope = z.infer<ReturnType<typeof crewExportForOwner>>;

/** Only pass the envelope validated for this request’s captured owner. */
export function crewProjection(record: CrewEnvelope) {
  const common = { exportedAt: record.exportedAt, profileAvailable: record.blueprint !== null };
  if (!record.crew || !record.membership) return { ...common, status: 'unplaced' as const };
  return {
    ...common,
    status: 'placed' as const,
    crew: {
      id: record.crew.id,
      name: record.crew.name,
      season: record.crew.season,
      capacity: record.crew.capacity,
      xp: record.crew.xp,
    },
    members: [
      { userId: record.membership.userId, role: record.membership.role, joinedAt: record.membership.joinedAt, own: true },
      ...record.crewmates.map((row) => ({ userId: row.userId, role: row.role, joinedAt: row.joinedAt, own: false })),
    ],
  };
}
export type CrewRead = ReturnType<typeof crewProjection>;
