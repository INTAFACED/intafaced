import { z } from 'zod';
import type { BlueprintExport } from '@intafaced/contracts/blueprint';

const timestamp = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(new Date(value).getTime()));
const integerCount = /^-?\d+$/;

/** This caller's check over the owner export (`BLUEPRINT_EXPORT`'s reply), before dropping profile, card and history.
 * The service reads these records sequentially: exportedAt is not an as-of proof.
 */
export function crewExportOwnedBy(owner: string) {
  return (record: BlueprintExport): boolean => {
    if (!timestamp.safeParse(record.exportedAt).success || (record.membership && !timestamp.safeParse(record.membership.joinedAt).success))
      return false;
    if (
      (record.blueprint && record.blueprint.userId !== owner) ||
      record.mentorMatches.some((row) => row.studentId !== owner) ||
      record.mentoringOthers.some((row) => row.mentorId !== owner)
    )
      return false;
    if (
      record.blueprint
        ? !record.card || record.card.size !== 'portrait' || record.card.width !== 1080 || record.card.height !== 1350
        : record.card !== null
    )
      return false;
    const { crew, membership, crewmates } = record;
    if (!crew && !membership) return crewmates.length === 0;
    if (!crew || !membership) return false;
    if (membership.userId !== owner || membership.crewId !== crew.id || !integerCount.test(crew.xp)) return false;
    const peers = new Set(crewmates.map((row) => row.userId));
    return !(
      peers.has(owner) ||
      peers.size !== crewmates.length ||
      crewmates.length + 1 > crew.capacity ||
      crewmates.some((row) => !timestamp.safeParse(row.joinedAt).success)
    );
  };
}
export type CrewEnvelope = BlueprintExport;

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
