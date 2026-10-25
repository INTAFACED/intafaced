/**
 * AC-release-access-02 — prerequisites and a learner's own due date on a course staff made.
 *
 * An assignment or quiz may require other assignments or quizzes of the same course; the learner's side counts one as met
 * once they have handed in, finished an attempt or answered the survey (`assertItemOpen` in course-release.ts). A lesson,
 * video, file or link records no completion here, so requiring one refuses `academy.prerequisite_unmeasured`. A set that
 * would make an item require itself, directly or through others, refuses `academy.prerequisite_cycle` naming the path,
 * and nothing is written. Staff move one enrolled learner's due date on an assignment later than the brief's, with a
 * reason, and the console shows who granted it and why. Every change is an event row. No money moves.
 */
import type { Sql, TransactionSql } from 'postgres';
import type {
  AcademyCourseItemRules,
  AcademyGrantCourseExtensionInput,
  AcademySetCourseItemPrerequisitesInput,
} from '@intafaced/contracts';
import { AcademyError } from '../errors.js';

type Db = Sql | TransactionSql;
const GATED = new Set(['assignment', 'quiz']);

/**
 * The first cycle the edges hold, as the path of item ids from an item back to itself, looked for from `start` first;
 * null when there is none. Pure. `edges` maps an item to the items it requires.
 */
export function findCycle(edges: ReadonlyMap<string, readonly string[]>, start?: string): string[] | null {
  const state = new Map<string, 'open' | 'done'>();
  const path: string[] = [];
  const visit = (node: string): string[] | null => {
    if (state.get(node) === 'done') return null;
    if (state.get(node) === 'open') return [...path.slice(path.indexOf(node)), node];
    state.set(node, 'open');
    path.push(node);
    for (const next of edges.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(node, 'done');
    return null;
  };
  for (const node of [...(start === undefined ? [] : [start]), ...[...edges.keys()].sort()]) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

export class CourseItemRules {
  constructor(private readonly sql: Sql) {}

  /** Each assignment and quiz in outline order with what it requires, and every learner's moved due date. */
  async adminView(courseId: string): Promise<AcademyCourseItemRules> {
    return this.viewIn(this.sql, courseId);
  }

  /** The whole set an item requires; the same set again answers as stored and writes nothing. */
  async setPrerequisites(
    input: AcademySetCourseItemPrerequisitesInput & { operatorId: string; now: Date },
  ): Promise<AcademyCourseItemRules> {
    return this.sql.begin(async (tx) => {
      await this.lockCourse(tx, input.courseId);
      const items = await tx<Array<{ id: string; kind: string }>>`
        SELECT id, kind FROM academy.course_items WHERE course_id = ${input.courseId}
      `;
      const kinds = new Map(items.map((i) => [i.id, i.kind]));
      const wanted = [...new Set(input.prerequisiteIds)].sort();
      if (!GATED.has(kinds.get(input.itemId) ?? ''))
        throw new AcademyError('no assignment or quiz of this course has that id', 'academy.outline_item_unknown');
      for (const id of wanted) {
        const kind = kinds.get(id);
        if (kind === undefined) throw new AcademyError(`no item of this course has the id ${id}`, 'academy.outline_item_unknown');
        if (id === input.itemId) throw new AcademyError(`academy.prerequisite_cycle path=${id}>${id}`, 'academy.prerequisite_cycle');
        if (!GATED.has(kind))
          throw new AcademyError(
            `a ${kind} records no completion on a course staff made, so it cannot be required`,
            'academy.prerequisite_unmeasured',
          );
      }
      const stored = await tx<Array<{ item_id: string; prerequisite_id: string }>>`
        SELECT p.item_id, p.prerequisite_id FROM academy.course_item_prerequisites p
        JOIN academy.course_items i ON i.id = p.item_id WHERE i.course_id = ${input.courseId}
      `;
      const edges = new Map<string, string[]>();
      for (const e of stored) edges.set(e.item_id, [...(edges.get(e.item_id) ?? []), e.prerequisite_id]);
      const current = (edges.get(input.itemId) ?? []).sort();
      if (JSON.stringify(current) === JSON.stringify(wanted)) return this.viewIn(tx, input.courseId);
      edges.set(input.itemId, wanted);
      const cycle = findCycle(edges, input.itemId);
      if (cycle) throw new AcademyError(`academy.prerequisite_cycle path=${cycle.join('>')}`, 'academy.prerequisite_cycle');

      await tx`DELETE FROM academy.course_item_prerequisites WHERE item_id = ${input.itemId}`;
      if (wanted.length > 0)
        await tx`
          INSERT INTO academy.course_item_prerequisites ${tx(wanted.map((id) => ({ item_id: input.itemId, prerequisite_id: id })))}
        `;
      await tx`
        INSERT INTO academy.course_item_prerequisite_sets (item_id, reason, set_by, set_at)
        VALUES (${input.itemId}, ${input.reason}, ${input.operatorId}, ${input.now})
        ON CONFLICT (item_id) DO UPDATE SET reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at
      `;
      await tx`
        INSERT INTO academy.course_item_rule_events (item_id, kind, user_id, detail, reason, actor_id, at)
        VALUES (${input.itemId}, 'prerequisites', null, ${tx.json({ prerequisites: wanted })}, ${input.reason}, ${input.operatorId}, ${input.now})
      `;
      return this.viewIn(tx, input.courseId);
    });
  }

  /**
   * One enrolled learner's own due date on an assignment with a due date, later than the brief's. A new grant replaces
   * the learner's earlier one; the same date and reason again writes nothing.
   */
  async grantExtension(input: AcademyGrantCourseExtensionInput & { operatorId: string; now: Date }): Promise<AcademyCourseItemRules> {
    return this.sql.begin(async (tx) => {
      await this.lockCourse(tx, input.courseId);
      const [item] = await tx<Array<{ kind: string; due_at: Date | null; withdrawn_at: Date | null; has_brief: boolean }>>`
        SELECT i.kind, a.due_at, a.withdrawn_at, (a.item_id IS NOT NULL) AS has_brief
        FROM academy.course_items i LEFT JOIN academy.course_assignments a ON a.item_id = i.id
        WHERE i.id = ${input.itemId} AND i.course_id = ${input.courseId}
      `;
      if (!item || item.kind !== 'assignment' || !item.has_brief)
        throw new AcademyError('no assignment of this course has that id', 'academy.assignment_not_found');
      if (item.withdrawn_at) throw new AcademyError('staff withdrew this assignment', 'academy.assignment_closed');
      const dueAt = new Date(input.dueAt);
      if (item.due_at === null) throw new AcademyError('the assignment has no due date to move', 'academy.window_invalid');
      if (dueAt.getTime() <= item.due_at.getTime())
        throw new AcademyError('the new due date is not after the assignment’s own', 'academy.window_invalid');
      const [enrolled] = await tx`
        SELECT 1 FROM academy.course_enrolments
        WHERE course_id = ${input.courseId} AND user_id = ${input.userId} AND left_at IS NULL
      `;
      if (!enrolled) throw new AcademyError(`academy.enrolment_required learner=${input.userId}`, 'academy.enrolment_required');
      const [stored] = await tx<Array<{ due_at: Date; reason: string }>>`
        SELECT due_at, reason FROM academy.course_item_extensions WHERE item_id = ${input.itemId} AND user_id = ${input.userId}
      `;
      if (stored && stored.due_at.getTime() === dueAt.getTime() && stored.reason === input.reason) return this.viewIn(tx, input.courseId);
      await tx`
        INSERT INTO academy.course_item_extensions (item_id, user_id, due_at, reason, granted_by, granted_at)
        VALUES (${input.itemId}, ${input.userId}, ${dueAt}, ${input.reason}, ${input.operatorId}, ${input.now})
        ON CONFLICT (item_id, user_id) DO UPDATE SET due_at = EXCLUDED.due_at, reason = EXCLUDED.reason,
          granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at
      `;
      await tx`
        INSERT INTO academy.course_item_rule_events (item_id, kind, user_id, detail, reason, actor_id, at)
        VALUES (${input.itemId}, 'extension', ${input.userId}, ${tx.json({ dueAt: dueAt.toISOString() })}, ${input.reason},
                ${input.operatorId}, ${input.now})
      `;
      return this.viewIn(tx, input.courseId);
    });
  }

  private async lockCourse(tx: Db, courseId: string) {
    const [course] = await tx`SELECT id FROM academy.courses WHERE id = ${courseId} FOR UPDATE`;
    if (!course) throw new AcademyError('no course has that id', 'academy.course_not_found');
  }

  private async viewIn(sql: Db, courseId: string): Promise<AcademyCourseItemRules> {
    const [course] = await sql`SELECT id FROM academy.courses WHERE id = ${courseId}`;
    if (!course) throw new AcademyError('no course has that id', 'academy.course_not_found');
    const items = await sql<
      Array<{
        id: string;
        title: string;
        kind: 'assignment' | 'quiz';
        due_at: Date | null;
        prerequisites: string[];
        reason: string | null;
        set_by: string | null;
        set_at: Date | null;
      }>
    >`
      SELECT i.id, i.title, i.kind, a.due_at,
        ARRAY(SELECT p.prerequisite_id::text FROM academy.course_item_prerequisites p WHERE p.item_id = i.id ORDER BY p.prerequisite_id)
          AS prerequisites,
        ps.reason, ps.set_by, ps.set_at
      FROM academy.course_items i
      JOIN academy.course_sections s ON s.id = i.section_id
      LEFT JOIN academy.course_assignments a ON a.item_id = i.id
      LEFT JOIN academy.course_item_prerequisite_sets ps ON ps.item_id = i.id
      WHERE i.course_id = ${courseId} AND i.kind IN ('assignment', 'quiz')
      ORDER BY s.position, i.position
    `;
    const extensions = await sql<
      Array<{ item_id: string; user_id: string; due_at: Date; reason: string; granted_by: string; granted_at: Date }>
    >`
      SELECT x.item_id, x.user_id, x.due_at, x.reason, x.granted_by, x.granted_at
      FROM academy.course_item_extensions x JOIN academy.course_items i ON i.id = x.item_id
      WHERE i.course_id = ${courseId}
      ORDER BY x.granted_at DESC, x.user_id
    `;
    return {
      courseId,
      items: items.map((i) => ({
        itemId: i.id,
        title: i.title,
        kind: i.kind,
        dueAt: i.due_at?.toISOString() ?? null,
        prerequisites: i.prerequisites,
        setBy: i.set_by,
        setAt: i.set_at?.toISOString() ?? null,
        reason: i.reason,
      })),
      extensions: extensions.map((x) => ({
        itemId: x.item_id,
        userId: x.user_id,
        dueAt: x.due_at.toISOString(),
        reason: x.reason,
        grantedBy: x.granted_by,
        grantedAt: x.granted_at.toISOString(),
      })),
    };
  }
}
