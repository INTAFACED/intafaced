/**
 * AC-assignments-04, late policy part (ENGINE GR-5) — what a course's late policy takes off a late hand-in.
 *
 * Optional per course, both values entered by staff: a grace period in hours and a deduction per day as a share of the
 * assignment's points. A hand-in later than its due date (a learner's extension moves it) by more than the grace loses the
 * deduction for each started day past the grace, at most all of the points, never below 0. Worked out in hundredths, the
 * deduction rounded up so the score is cut, never raised. The entered grade is never changed: the late score is worked
 * out from it on each read. With no policy, or no due date, nothing is deducted. No money moves.
 */
import type { AcademyLatePolicy } from '@intafaced/contracts';
import type { Sql, TransactionSql } from 'postgres';

const HOUR_MS = 3_600_000n;
const DAY_MS = 86_400_000n;

/** A decimal string with at most `places` decimals as an integer count of 10^-places. */
function scaled(value: string, places: number): bigint {
  const [whole, frac = ''] = value.split('.');
  return BigInt(whole! + frac.padEnd(places, '0').slice(0, places));
}

/** Hundredths as a canonical decimal string ("7", "6.5", "0.25"). */
function hundredthsText(n: bigint): string {
  const whole = n / 100n;
  const frac = (n % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Stored numeric values read back as the decimal strings the contract carries ("24.00" is "24", "0.1000" is "0.1"). */
export function policyOf(row: { grace_hours: string | null; deduction_per_day: string | null } | undefined): AcademyLatePolicy | null {
  if (!row || row.grace_hours === null || row.deduction_per_day === null) return null;
  const trim = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);
  return { graceHours: trim(row.grace_hours), deductionPerDay: trim(row.deduction_per_day) };
}

/** The course's late policy now, or null with none (never set, or cleared). */
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
  const lateMs = BigInt(submittedAt.getTime() - dueAt.getTime()) - (scaled(policy.graceHours, 2) * HOUR_MS) / 100n;
  if (lateMs <= 0n) return { score: entered, entered: null };
  const days = (lateMs + DAY_MS - 1n) / DAY_MS;
  // Shares in ten-thousandths: at most the whole of the points.
  const asked = days * scaled(policy.deductionPerDay, 4);
  const share = asked > 10_000n ? 10_000n : asked;
  const off = (scaled(points, 2) * share + 9_999n) / 10_000n;
  const kept = scaled(entered, 2) - off;
  const score = hundredthsText(kept > 0n ? kept : 0n);
  return score === hundredthsText(scaled(entered, 2)) ? { score: entered, entered: null } : { score, entered };
}
