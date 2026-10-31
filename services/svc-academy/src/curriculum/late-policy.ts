/**
 * AC-assignments-04, late policy part (ENGINE GR-5) — what a course's late policy takes off a late hand-in.
 *
 * Optional per course, both values entered by staff: a grace period in hours and a deduction per day as a share of the
 * assignment's points. A hand-in later than its due date (a learner's extension moves it) by more than the grace loses the
 * deduction for each started day past the grace, at most all of the points, never below 0. Worked out in hundredths, the
 * deduction rounded up so the score is cut, never raised. The entered grade is never changed: the late score is worked
 * out from it on each read. A policy takes off only from hand-ins made at or after the moment it was set, so nothing is
 * ever taken off under a rule the learner was not shown when they handed in; a change or a clear starts again from its own
 * moment. With no policy, or no due date, nothing is deducted. No money moves.
 */
import type { AcademyLatePolicy } from '@intafaced/contracts';
import { formatAmount, parseAmount, SCALE } from '@intafaced/ledger-client';
import type { Sql, TransactionSql } from 'postgres';

const HOUR_MS = 3_600_000n;
const DAY_MS = 86_400_000n;
/** One hundredth, in scaled units: grades are kept to hundredths. */
const CENT = SCALE / 100n;

/** Stored numeric values read back as the decimal strings the contract carries ("24.00" is "24", "0.1000" is "0.1"). */
export function policyOf(row: { grace_hours: string | null; deduction_per_day: string | null } | undefined): AcademyLatePolicy | null {
  if (!row || row.grace_hours === null || row.deduction_per_day === null) return null;
  return { graceHours: formatAmount(parseAmount(row.grace_hours)), deductionPerDay: formatAmount(parseAmount(row.deduction_per_day)) };
}

/** The course's late policy now, or null with none (never set, or cleared): what the assignment page states. */
export async function latePolicyOf(sql: Sql | TransactionSql, courseId: string): Promise<AcademyLatePolicy | null> {
  const [row] = await sql<Array<{ grace_hours: string | null; deduction_per_day: string | null }>>`
    SELECT grace_hours::text, deduction_per_day::text FROM academy.course_late_policies WHERE course_id = ${courseId}
  `;
  return policyOf(row);
}

/**
 * The score after the late policy, and the entered score when something was taken off (null when nothing was). `entered`
 * and `points` are decimal strings with at most two places, as grades are stored.
 */
export function lateScore(
  entered: string,
  points: string,
  submittedAt: Date,
  dueAt: Date | null,
  policy: AcademyLatePolicy | null,
): { score: string; entered: string | null } {
  if (policy === null || dueAt === null) return { score: entered, entered: null };
  const graceMs = (parseAmount(policy.graceHours) * HOUR_MS) / SCALE;
  const lateMs = BigInt(submittedAt.getTime() - dueAt.getTime()) - graceMs;
  if (lateMs <= 0n) return { score: entered, entered: null };
  const days = (lateMs + DAY_MS - 1n) / DAY_MS;
  // At most the whole of the points; the deduction is rounded up to the hundredth, so the score is cut, never raised.
  const asked = days * parseAmount(policy.deductionPerDay);
  const share = asked > SCALE ? SCALE : asked;
  const off = (((parseAmount(points) * share) / SCALE + CENT - 1n) / CENT) * CENT;
  const kept = parseAmount(entered) - off;
  const score = formatAmount(kept > 0n ? kept : 0n);
  return score === formatAmount(parseAmount(entered)) ? { score: entered, entered: null } : { score, entered };
}
