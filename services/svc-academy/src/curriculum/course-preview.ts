/**
 * AC-catalogue-03 — a course as a new learner sees it, for staff (Preview as new learner) and for a visitor holding a
 * private link to the course's unlisted page.
 *
 * The view is built from the stored course and outline, never sample data: each item shows its lock (`enrol` until the
 * reader enrols, `enrolment_closed` while the course is not published, `not_released` while no lesson revision is
 * published to learners). Reading it writes nothing: no
 * learner row, no event, no touch. A private link's key is 32 random bytes shown once; only its SHA-256 is stored, so
 * the key is a secret, not an idempotency key. An unknown, revoked or mismatched link, and a course that is archived
 * or deleted, give the same `academy.course_not_found`, so a guess learns nothing. Per-address limits on the public
 * read are svc-edge's. No money moves here.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type {
  AcademyCourseLearnerView,
  AcademyCourseState,
  AcademyCreatedPrivateLink,
  AcademyOutlineItemKind,
  AcademyPrivateLink,
} from '@intafaced/contracts';
import { academyPrivateLinkKeySchema } from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import { canonicalPrice } from './courses.js';

type LinkRow = {
  id: string;
  reason: string;
  created_by: string;
  created_at: Date;
  revoked_by: string | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
};
const linkOf = (r: LinkRow): AcademyPrivateLink => ({
  id: r.id,
  reason: r.reason,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  revokedBy: r.revoked_by,
  revokedAt: r.revoked_at?.toISOString() ?? null,
  revokeReason: r.revoke_reason,
});

const keyHash = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');

/** The states a private link opens in: the course is still being made or is open to learners. */
const LINK_OPENS: readonly AcademyCourseState[] = ['draft', 'published', 'concluded'];

export class CoursePreview {
  constructor(private readonly sql: Sql) {}

  /** Preview as new learner: the course exactly as a reader with no enrolment sees it. Staff only; writes nothing. */
  async preview(courseId: string): Promise<AcademyCourseLearnerView> {
    const view = await this.view(courseId);
    if (!view) throw new AcademyError('no course has this id', 'academy.course_not_found');
    return view;
  }

  /** The unlisted page through a private link. Anything that is not a live link to this course is not found. */
  async byLink(input: { slug: string; key: string }): Promise<AcademyCourseLearnerView> {
    if (!academyPrivateLinkKeySchema.safeParse(input.key).success) {
      throw new AcademyError('no course is open at this link', 'academy.course_not_found');
    }
    const [row] = await this.sql<Array<{ course_id: string }>>`
      SELECT l.course_id FROM academy.course_private_links l
      JOIN academy.courses c ON c.id = l.course_id
      WHERE l.key_sha256 = ${keyHash(input.key)} AND l.revoked_at IS NULL AND c.slug = ${input.slug}
        AND c.state IN ${this.sql(LINK_OPENS as AcademyCourseState[])}
    `;
    const view = row ? await this.view(row.course_id) : null;
    if (!view) throw new AcademyError('no course is open at this link', 'academy.course_not_found');
    return view;
  }

  /** The course's private links, newest first, without their keys. */
  async links(courseId: string): Promise<AcademyPrivateLink[]> {
    const [course] = await this.sql`SELECT 1 FROM academy.courses WHERE id = ${courseId}`;
    if (!course) throw new AcademyError('no course has this id', 'academy.course_not_found');
    const rows = await this.sql<LinkRow[]>`
      SELECT id, reason, created_by, created_at, revoked_by, revoked_at, revoke_reason
      FROM academy.course_private_links WHERE course_id = ${courseId}
      ORDER BY created_at DESC, id
    `;
    return rows.map(linkOf);
  }

  /** A new link to the unlisted page. The key comes back once, here, and is never stored or shown again. */
  async createLink(input: { courseId: string; reason: string; operatorId: string; now: Date }): Promise<AcademyCreatedPrivateLink> {
    const [course] = await this.sql<Array<{ slug: string; state: AcademyCourseState }>>`
      SELECT slug, state FROM academy.courses WHERE id = ${input.courseId}
    `;
    if (!course) throw new AcademyError('no course has this id', 'academy.course_not_found');
    if (!LINK_OPENS.includes(course.state)) {
      throw new AcademyError(`a private link opens nothing while the course is ${course.state}`, 'academy.private_link_course_closed');
    }
    const key = randomBytes(32).toString('base64url');
    const [row] = await this.sql<LinkRow[]>`
      INSERT INTO academy.course_private_links (course_id, key_sha256, reason, created_by, created_at)
      VALUES (${input.courseId}, ${keyHash(key)}, ${input.reason}, ${input.operatorId}, ${input.now})
      RETURNING id, reason, created_by, created_at, revoked_by, revoked_at, revoke_reason
    `;
    return {
      link: linkOf(row!),
      key,
      path: `/academy/learning/course/${encodeURIComponent(course.slug)}#key=${key}`,
    };
  }

  /** The link stops opening the page. A repeat answers with the revoked link as it was first revoked. */
  async revokeLink(input: { linkId: string; reason: string; operatorId: string; now: Date }): Promise<AcademyPrivateLink> {
    const [row] = await this.sql<LinkRow[]>`
      UPDATE academy.course_private_links
      SET revoked_by = ${input.operatorId}, revoked_at = ${input.now}, revoke_reason = ${input.reason}
      WHERE id = ${input.linkId} AND revoked_at IS NULL
      RETURNING id, reason, created_by, created_at, revoked_by, revoked_at, revoke_reason
    `;
    if (row) return linkOf(row);
    const [stored] = await this.sql<LinkRow[]>`
      SELECT id, reason, created_by, created_at, revoked_by, revoked_at, revoke_reason
      FROM academy.course_private_links WHERE id = ${input.linkId}
    `;
    if (!stored) throw new AcademyError('no private link has this id', 'academy.private_link_not_found');
    return linkOf(stored);
  }

  /** The course row and its outline from one snapshot, so a save in between never mixes two versions. */
  private view(courseId: string): Promise<AcademyCourseLearnerView | null> {
    return this.sql.begin('isolation level repeatable read read only', (tx) => this.viewIn(tx, courseId));
  }

  private async viewIn(tx: TransactionSql, courseId: string): Promise<AcademyCourseLearnerView | null> {
    const [course] = await tx<
      Array<{
        slug: string;
        title: string;
        summary: string | null;
        thumbnail_url: string | null;
        pricing: 'free' | 'paid';
        price: string | null;
        price_asset: string | null;
        state: AcademyCourseState;
      }>
    >`
      SELECT slug, title, summary, thumbnail_url, pricing, price, price_asset, state
      FROM academy.courses WHERE id = ${courseId}
    `;
    if (!course) return null;
    const rows = await tx<
      Array<{
        section_id: string;
        section_title: string;
        kind: AcademyOutlineItemKind | null;
        title: string | null;
        indent: number | null;
        live_revision: number | null;
      }>
    >`
      SELECT s.id AS section_id, s.title AS section_title, i.kind, i.title, i.indent, i.live_revision
      FROM academy.course_sections s
      LEFT JOIN academy.course_items i ON i.section_id = s.id
      WHERE s.course_id = ${courseId}
      ORDER BY s.position, i.position
    `;
    const sections: AcademyCourseLearnerView['sections'] = [];
    let current = null as { id: string; section: AcademyCourseLearnerView['sections'][number] } | null;
    for (const r of rows) {
      if (current?.id !== r.section_id) {
        current = { id: r.section_id, section: { title: r.section_title, items: [] } };
        sections.push(current.section);
      }
      if (r.kind === null || r.title === null) continue;
      current.section.items.push({
        kind: r.kind,
        title: r.title,
        indent: r.indent ?? 0,
        // A subheader is a label; a link has no lesson, so only enrolment stands between it and the reader.
        lock:
          r.kind === 'subheader'
            ? null
            : r.kind !== 'link' && r.live_revision === null
              ? 'not_released'
              : course.state === 'published'
                ? 'enrol'
                : 'enrolment_closed',
      });
    }
    return {
      slug: course.slug,
      title: course.title,
      summary: course.summary,
      thumbnailUrl: course.thumbnail_url,
      pricing: course.pricing,
      price: canonicalPrice(course.price),
      priceAsset: course.price_asset,
      state: course.state,
      sections,
    };
  }
}
