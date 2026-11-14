/**
 * AC-enrolment-01, AC-catalogue-03 — a course's seat cap, enrolment window and visibility. Staff set each with a reason,
 * and the one row per course keeps who set it last and why. No row means no cap, no window and published: nothing is
 * given a cap, a window or a visibility it was not set. A hidden or unpublished course leaves the catalogue and closes
 * enrolment; its page still opens by its address and says why. Enrolments already made are kept either way.
 */
import type { AcademyEnrolmentClosedReason } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { AcademyError } from '../errors.js';
import type { CurriculumPath } from './catalog.js';
import { publishedCourse } from './course-enrolment.js';

export const COURSE_VISIBILITIES = ['published', 'hidden', 'unpublished'] as const;
export type CourseVisibility = (typeof COURSE_VISIBILITIES)[number];

export type CourseTerms = {
  seatCap: number | null;
  opensAt: Date | null;
  closesAt: Date | null;
  visibility: CourseVisibility;
};

export const NO_TERMS: CourseTerms = { seatCap: null, opensAt: null, closesAt: null, visibility: 'published' };

type TermsSql = { seat_cap: number | null; opens_at: Date | null; closes_at: Date | null; visibility: CourseVisibility };

const fromRow = (row: TermsSql | undefined): CourseTerms =>
  row ? { seatCap: row.seat_cap, opensAt: row.opens_at, closesAt: row.closes_at, visibility: row.visibility } : { ...NO_TERMS };

/**
 * Why the course itself is closed for enrolment at `now`, or null when it is open. Unpublished and hidden come first,
 * then the window, then a full cap: the reason a person can do least about is the one shown.
 */
export function courseClosedReason(terms: CourseTerms, seatsTaken: number, now: Date): AcademyEnrolmentClosedReason | null {
  if (terms.visibility === 'unpublished') return 'unpublished';
  if (terms.visibility === 'hidden') return 'hidden';
  if (terms.opensAt !== null && now.getTime() < terms.opensAt.getTime()) return 'window_not_started';
  if (terms.closesAt !== null && now.getTime() >= terms.closesAt.getTime()) return 'window_ended';
  if (terms.seatCap !== null && seatsTaken >= terms.seatCap) return 'full';
  return null;
}

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) throw new AcademyError('academy.reason_required', 'academy.reason_required');
  return trimmed;
}

export class CourseTermsStore {
  constructor(private readonly sql: Sql) {}

  async read(path: CurriculumPath): Promise<CourseTerms> {
    const rows = await this.sql<TermsSql[]>`
      SELECT seat_cap, opens_at, closes_at, visibility FROM academy.course_enrolment_terms WHERE path = ${path}
    `;
    return fromRow(rows[0]);
  }

  /** The courses staff hid or unpublished, which the catalogue leaves out. */
  async unlisted(): Promise<Set<string>> {
    const rows = await this.sql<Array<{ path: string }>>`
      SELECT path FROM academy.course_enrolment_terms WHERE visibility <> 'published'
    `;
    return new Set(rows.map((row) => row.path));
  }

  /** `seatCap: null` takes the cap off. A cap is a whole number above zero; a blank reason is refused, never filled in. */
  async setSeatCap(input: { slug: string; seatCap: number | null; reason: string; operatorId: string; now?: Date }) {
    if (input.seatCap !== null && !(Number.isSafeInteger(input.seatCap) && input.seatCap > 0))
      throw new AcademyError('academy.seat_cap_invalid: a cap is a whole number above zero', 'academy.cert_invalid');
    return this.write(input, { seatCap: input.seatCap });
  }

  /** Either end may be null (no limit on that side); both null takes the window off. Opens must come before closes. */
  async setWindow(input: { slug: string; opensAt: Date | null; closesAt: Date | null; reason: string; operatorId: string; now?: Date }) {
    if (input.opensAt !== null && input.closesAt !== null && input.opensAt.getTime() >= input.closesAt.getTime())
      throw new AcademyError('academy.window_invalid: the window opens before it closes', 'academy.window_invalid');
    return this.write(input, { opensAt: input.opensAt, closesAt: input.closesAt });
  }

  async setVisibility(input: { slug: string; visibility: CourseVisibility; reason: string; operatorId: string; now?: Date }) {
    if (!COURSE_VISIBILITIES.includes(input.visibility))
      throw new AcademyError('academy.course_visibility_invalid', 'academy.cert_invalid');
    return this.write(input, { visibility: input.visibility });
  }

  /** One upsert that changes only the fields given and keeps the rest, with who set it and why. */
  private async write(
    input: { slug: string; reason: string; operatorId: string; now?: Date },
    change: Partial<CourseTerms>,
  ): Promise<CourseTerms & { slug: CurriculumPath; reason: string; setAt: Date }> {
    const slug = publishedCourse(input.slug);
    const reason = requireReason(input.reason);
    const setAt = input.now ?? new Date();
    const next = { ...(await this.read(slug)), ...change };
    const rows = await this.sql<TermsSql[]>`
      INSERT INTO academy.course_enrolment_terms (path, seat_cap, opens_at, closes_at, visibility, reason, set_by, set_at)
      VALUES (${slug}, ${next.seatCap}, ${next.opensAt}, ${next.closesAt}, ${next.visibility}, ${reason}, ${input.operatorId}, ${setAt})
      ON CONFLICT (path) DO UPDATE SET
        seat_cap = ${'seatCap' in change ? this.sql`EXCLUDED.seat_cap` : this.sql`academy.course_enrolment_terms.seat_cap`},
        opens_at = ${'opensAt' in change ? this.sql`EXCLUDED.opens_at` : this.sql`academy.course_enrolment_terms.opens_at`},
        closes_at = ${'closesAt' in change ? this.sql`EXCLUDED.closes_at` : this.sql`academy.course_enrolment_terms.closes_at`},
        visibility = ${'visibility' in change ? this.sql`EXCLUDED.visibility` : this.sql`academy.course_enrolment_terms.visibility`},
        reason = EXCLUDED.reason,
        set_by = EXCLUDED.set_by,
        set_at = EXCLUDED.set_at
      RETURNING seat_cap, opens_at, closes_at, visibility
    `;
    return { slug, ...fromRow(rows[0]), reason, setAt };
  }
}
