/**
 * AC-progress-02: the learner's planner. To-do items and one weekly goal, private to the learner: every read and write is
 * scoped to the caller's own rows. An add is named by its client key, so a lost reply sent again returns the stored item;
 * the same key for different text refuses `academy.request_reused`. The per-learner cap is the owner's to set: unset,
 * adding refuses `academy.planner_limit_unset`. Academy has no mail sender, so a goal reminder names `vendor.email`.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import type { AcademyPlanner, AcademyPlannerTodo } from '@intafaced/contracts';
import { AcademyError } from '../errors.js';

/** The weekly goal's bounds: a goal of no items is no goal, and more than 100 a week is not a reading plan. */
export const GOAL_ITEMS_PER_WEEK = { min: 1, max: 100 } as const;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type TodoSql = { id: string; text: string; created_at: Date; done_at: Date | null };
const todoView = (row: TodoSql): AcademyPlannerTodo => ({
  id: row.id,
  text: row.text,
  createdAt: row.created_at.toISOString(),
  doneAt: row.done_at?.toISOString() ?? null,
});

export class PlannerStore {
  constructor(
    private readonly sql: Sql,
    private readonly todoLimit: number | null,
  ) {}

  async read(userId: string, now: Date = new Date()): Promise<AcademyPlanner> {
    const [todos, revision, goal, done] = await Promise.all([
      this.sql<TodoSql[]>`
        SELECT id, text, created_at, done_at FROM academy.planner_todos
         WHERE user_id = ${userId} AND removed_at IS NULL
         ORDER BY created_at, id
      `,
      this.sql<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM academy.planner_todos WHERE user_id = ${userId}`,
      this.sql<Array<{ items_per_week: number; reminder: boolean; set_at: Date }>>`
        SELECT items_per_week, reminder, set_at FROM academy.learning_goals WHERE user_id = ${userId}
      `,
      this.sql<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM academy.cert_item_completions
         WHERE user_id = ${userId} AND completed_at > ${new Date(now.getTime() - WEEK_MS)} AND completed_at <= ${now}
      `,
    ]);
    const g = goal[0];
    return {
      todos: todos.map(todoView),
      todoLimit: this.todoLimit,
      revision: revision[0]?.n ?? 0,
      goal: g
        ? { itemsPerWeek: g.items_per_week, reminder: g.reminder, setAt: g.set_at.toISOString(), doneThisWeek: done[0]?.n ?? 0 }
        : null,
      reminderMail: 'vendor.email',
    };
  }

  async addTodo(input: { userId: string; clientKey: string; text: string; now?: Date }): Promise<AcademyPlannerTodo> {
    const text = input.text.trim();
    const clientKey = input.clientKey.trim();
    const now = input.now ?? new Date();
    return transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:planner`}, 0))`;
      const prior = await tx<Array<TodoSql>>`
        SELECT id, text, created_at, done_at FROM academy.planner_todos WHERE user_id = ${input.userId} AND client_key = ${clientKey}
      `;
      if (prior[0]) {
        if (prior[0].text !== text) throw new AcademyError(`academy.request_reused key=${clientKey}`, 'academy.request_reused');
        return todoView(prior[0]);
      }
      if (this.todoLimit === null)
        throw new AcademyError('academy.planner_limit_unset to-do items per learner', 'academy.planner_limit_unset');
      const open = await tx<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM academy.planner_todos WHERE user_id = ${input.userId} AND removed_at IS NULL
      `;
      if ((open[0]?.n ?? 0) >= this.todoLimit) {
        throw new AcademyError(`academy.planner_full limit=${this.todoLimit}`, 'academy.planner_full');
      }
      const rows = await tx<TodoSql[]>`
        INSERT INTO academy.planner_todos (user_id, client_key, text, created_at)
        VALUES (${input.userId}, ${clientKey}, ${text}, ${now})
        RETURNING id, text, created_at, done_at
      `;
      return todoView(rows[0]!);
    });
  }

  /** Mark one of the caller's items done or not done; the same request twice leaves it as asked. */
  async setTodoDone(input: { userId: string; todoId: string; done: boolean; now?: Date }): Promise<AcademyPlannerTodo> {
    const now = input.now ?? new Date();
    const rows = await this.sql<TodoSql[]>`
      UPDATE academy.planner_todos
         SET done_at = CASE WHEN ${input.done} THEN COALESCE(done_at, ${now}) ELSE NULL END
       WHERE id = ${input.todoId} AND user_id = ${input.userId} AND removed_at IS NULL
      RETURNING id, text, created_at, done_at
    `;
    if (!rows[0]) throw new AcademyError('academy.todo_not_found', 'academy.todo_not_found');
    return todoView(rows[0]);
  }

  /** Remove one of the caller's items. Removing it again answers the same; the row stays, so its add cannot replay it back. */
  async removeTodo(input: { userId: string; todoId: string; now?: Date }): Promise<{ id: string; removed: true }> {
    const now = input.now ?? new Date();
    const rows = await this.sql<Array<{ id: string }>>`
      UPDATE academy.planner_todos SET removed_at = COALESCE(removed_at, ${now})
       WHERE id = ${input.todoId} AND user_id = ${input.userId}
      RETURNING id
    `;
    if (!rows[0]) throw new AcademyError('academy.todo_not_found', 'academy.todo_not_found');
    return { id: rows[0].id, removed: true };
  }

  async setGoal(input: { userId: string; itemsPerWeek: number; reminder: boolean; now?: Date }): Promise<AcademyPlanner['goal']> {
    const { min, max } = GOAL_ITEMS_PER_WEEK;
    if (!Number.isInteger(input.itemsPerWeek) || input.itemsPerWeek < min || input.itemsPerWeek > max) {
      throw new AcademyError(`academy.goal_invalid items per week must be ${min} to ${max}`, 'academy.goal_invalid');
    }
    const now = input.now ?? new Date();
    await this.sql`
      INSERT INTO academy.learning_goals (user_id, items_per_week, reminder, set_at)
      VALUES (${input.userId}, ${input.itemsPerWeek}, ${input.reminder}, ${now})
      ON CONFLICT (user_id) DO UPDATE SET items_per_week = EXCLUDED.items_per_week, reminder = EXCLUDED.reminder, set_at = EXCLUDED.set_at
    `;
    return (await this.read(input.userId, now)).goal;
  }

  /**
   * Send the goal reminder now. A goal with its reminder on is needed (`academy.goal_invalid` otherwise). Academy has no
   * mail sender, so nothing is sent and the answer names `vendor.email`; nothing is queued to send later.
   */
  async sendGoalReminder(input: { userId: string }): Promise<{ sent: false; mail: 'vendor.email' }> {
    const rows = await this.sql<Array<{ reminder: boolean }>>`SELECT reminder FROM academy.learning_goals WHERE user_id = ${input.userId}`;
    if (!rows[0]?.reminder) throw new AcademyError('academy.goal_invalid no goal with its reminder on', 'academy.goal_invalid');
    return { sent: false, mail: 'vendor.email' };
  }
}
