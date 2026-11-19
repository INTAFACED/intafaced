//! AC-progress-02: the learner's planner (`learning/planner.ts` `PlannerStore`). To-do items and one weekly goal, private
//! to the learner: every read and write is scoped to the caller's own rows. An add is named by its client key, so a
//! lost reply sent again returns the stored item; the same key for different text refuses `academy.request_reused`.
//! The per-learner cap is the owner's (`ACADEMY_PLANNER_TODO_LIMIT`): unset, adding refuses `academy.planner_limit_unset`.
//! Academy has no mail sender, so a goal reminder names `vendor.email`.

use postgres::Row;
use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::schema::js_trim;

use super::sql::{self, cell, exec, first, iso, ms, q};
use crate::errors::{AcademyError, Refusal};

/// The weekly goal's bounds: a goal of no items is no goal, and more than 100 a week is not a reading plan.
pub const GOAL_MIN: i64 = 1;
pub const GOAL_MAX: i64 = 100;
const WEEK_MS: i64 = 7 * 24 * 60 * 60 * 1000;

fn todo_columns() -> String {
    format!(
        "id::text, text, {}, {}",
        ms("created_at"),
        ms("done_at")
    )
}

/// `todoView`.
fn todo_view(row: &Row) -> Result<Json, Refusal> {
    let done: Option<i64> = cell(row, 3)?;
    Ok(Json::obj([
        ("id", Json::String(cell(row, 0)?)),
        ("text", Json::String(cell(row, 1)?)),
        ("createdAt", Json::str(iso(cell(row, 2)?))),
        ("doneAt", done.map_or(Json::Null, |d| Json::str(iso(d)))),
    ]))
}

fn n_of(row: Option<Row>) -> Result<i64, Refusal> {
    row.map_or(Ok(0), |r| cell::<i32>(&r, 0).map(i64::from))
}

pub struct Planner<'a> {
    pub pool: &'a Pool,
    /// `ACADEMY_PLANNER_TODO_LIMIT`, or none while the owner has not set it.
    pub todo_limit: Option<i64>,
}

impl Planner<'_> {
    /// `read(userId, now)`: the open items, how many were ever added (the revision), the goal and the mail rail.
    pub fn read(&self, user_id: &str, now: i64) -> Result<Json, Refusal> {
        let todos = sql::on_pool(self.pool, |c| {
            q(
                c,
                &format!(
                    "SELECT {} FROM academy.planner_todos WHERE user_id = $1::text::uuid AND removed_at IS NULL \
                     ORDER BY created_at, id",
                    todo_columns()
                ),
                &[&user_id],
            )
        })?;
        let revision = sql::on_pool(self.pool, |c| {
            n_of(first(
                c,
                "SELECT COUNT(*)::int AS n FROM academy.planner_todos WHERE user_id = $1::text::uuid",
                &[&user_id],
            )?)
        })?;
        let goal = self.goal(user_id, now)?;
        Ok(Json::obj([
            (
                "todos",
                Json::Array(todos.iter().map(todo_view).collect::<Result<_, _>>()?),
            ),
            ("todoLimit", self.todo_limit.map_or(Json::Null, Json::int)),
            ("revision", Json::int(revision)),
            ("goal", goal),
            ("reminderMail", Json::str("vendor.email")),
        ]))
    }

    /// The caller's weekly goal with the items they completed in the seven days up to `now`, or null.
    fn goal(&self, user_id: &str, now: i64) -> Result<Json, Refusal> {
        let since = iso(now - WEEK_MS);
        let until = iso(now);
        let row = sql::on_pool(self.pool, |c| {
            first(
                c,
                &format!(
                    "SELECT g.items_per_week, g.reminder, {}, \
                     (SELECT COUNT(*)::int FROM academy.cert_item_completions c \
                       WHERE c.user_id = g.user_id AND c.completed_at > $2::text::timestamptz \
                         AND c.completed_at <= $3::text::timestamptz) AS done \
                     FROM academy.learning_goals g WHERE g.user_id = $1::text::uuid",
                    ms("g.set_at")
                ),
                &[&user_id, &since, &until],
            )
        })?;
        let Some(g) = row else {
            return Ok(Json::Null);
        };
        Ok(Json::obj([
            ("itemsPerWeek", Json::int(i64::from(cell::<i32>(&g, 0)?))),
            ("reminder", Json::Bool(cell(&g, 1)?)),
            ("setAt", Json::str(iso(cell(&g, 2)?))),
            ("doneThisWeek", Json::int(i64::from(cell::<i32>(&g, 3)?))),
        ]))
    }

    /// `addTodo`: the stored item for a repeated key; a new one under the owner's cap.
    pub fn add_todo(
        &self,
        user_id: &str,
        client_key: &str,
        text: &str,
        now: i64,
    ) -> Result<Json, Refusal> {
        let text = js_trim(text).to_owned();
        let client_key = js_trim(client_key).to_owned();
        let at = iso(now);
        let lock = format!("{user_id}:planner");
        sql::serializable(self.pool, |tx| {
            exec(
                tx,
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                &[&lock],
            )?;
            let prior = first(
                tx,
                &format!(
                    "SELECT {} FROM academy.planner_todos WHERE user_id = $1::text::uuid AND client_key = $2",
                    todo_columns()
                ),
                &[&user_id, &client_key],
            )?;
            if let Some(prior) = prior {
                let stored: String = cell(&prior, 1)?;
                if stored != text {
                    return Err(AcademyError::new(
                        format!("academy.request_reused key={client_key}"),
                        "academy.request_reused",
                    )
                    .into());
                }
                return todo_view(&prior);
            }
            let Some(limit) = self.todo_limit else {
                return Err(AcademyError::new(
                    "academy.planner_limit_unset to-do items per learner",
                    "academy.planner_limit_unset",
                )
                .into());
            };
            let open = n_of(first(
                tx,
                "SELECT COUNT(*)::int AS n FROM academy.planner_todos WHERE user_id = $1::text::uuid AND removed_at IS NULL",
                &[&user_id],
            )?)?;
            if open >= limit {
                return Err(AcademyError::new(
                    format!("academy.planner_full limit={limit}"),
                    "academy.planner_full",
                )
                .into());
            }
            let row = first(
                tx,
                &format!(
                    "INSERT INTO academy.planner_todos (user_id, client_key, text, created_at) \
                     VALUES ($1::text::uuid, $2, $3, $4::text::timestamptz) RETURNING {}",
                    todo_columns()
                ),
                &[&user_id, &client_key, &text, &at],
            )?;
            todo_view(&row.ok_or_else(|| Refusal::db("INSERT returned no row", None))?)
        })
    }

    /// `setTodoDone`: done or not done; the same request twice leaves it as asked.
    pub fn set_todo_done(
        &self,
        user_id: &str,
        todo_id: &str,
        done: bool,
        now: i64,
    ) -> Result<Json, Refusal> {
        let at = iso(now);
        let row = sql::on_pool(self.pool, |c| {
            first(
                c,
                &format!(
                    "UPDATE academy.planner_todos \
                     SET done_at = CASE WHEN $3::bool THEN COALESCE(done_at, $4::text::timestamptz) ELSE NULL END \
                     WHERE id = $1::text::uuid AND user_id = $2::text::uuid AND removed_at IS NULL RETURNING {}",
                    todo_columns()
                ),
                &[&todo_id, &user_id, &done, &at],
            )
        })?;
        todo_view(&row.ok_or_else(todo_not_found)?)
    }

    /// `removeTodo`: the row stays, so its add cannot replay it back; removing it again answers the same.
    pub fn remove_todo(&self, user_id: &str, todo_id: &str, now: i64) -> Result<Json, Refusal> {
        let at = iso(now);
        let row = sql::on_pool(self.pool, |c| {
            first(
                c,
                "UPDATE academy.planner_todos SET removed_at = COALESCE(removed_at, $3::text::timestamptz) \
                 WHERE id = $1::text::uuid AND user_id = $2::text::uuid RETURNING id::text",
                &[&todo_id, &user_id, &at],
            )
        })?;
        let row = row.ok_or_else(todo_not_found)?;
        Ok(Json::obj([
            ("id", Json::String(cell(&row, 0)?)),
            ("removed", Json::Bool(true)),
        ]))
    }

    /// `setGoal`: the bounds first, then one upsert, then the goal as read back.
    pub fn set_goal(
        &self,
        user_id: &str,
        items_per_week: f64,
        reminder: bool,
        now: i64,
    ) -> Result<Json, Refusal> {
        let whole = items_per_week.is_finite() && items_per_week.fract() == 0.0;
        #[expect(clippy::cast_possible_truncation, reason = "a whole number in the bounds checked here")]
        let n = items_per_week as i64;
        if !whole || n < GOAL_MIN || n > GOAL_MAX {
            return Err(AcademyError::new(
                format!("academy.goal_invalid items per week must be {GOAL_MIN} to {GOAL_MAX}"),
                "academy.goal_invalid",
            )
            .into());
        }
        let n32 = i32::try_from(n).unwrap_or(i32::MAX);
        let at = iso(now);
        sql::on_pool(self.pool, |c| {
            exec(
                c,
                "INSERT INTO academy.learning_goals (user_id, items_per_week, reminder, set_at) \
                 VALUES ($1::text::uuid, $2, $3, $4::text::timestamptz) \
                 ON CONFLICT (user_id) DO UPDATE SET items_per_week = EXCLUDED.items_per_week, \
                 reminder = EXCLUDED.reminder, set_at = EXCLUDED.set_at",
                &[&user_id, &n32, &reminder, &at],
            )
        })?;
        self.goal(user_id, now)
    }

    /// `sendGoalReminder`: a goal with its reminder on is needed; nothing is sent, and the answer names `vendor.email`.
    pub fn send_goal_reminder(&self, user_id: &str) -> Result<Json, Refusal> {
        let row = sql::on_pool(self.pool, |c| {
            first(
                c,
                "SELECT reminder FROM academy.learning_goals WHERE user_id = $1::text::uuid",
                &[&user_id],
            )
        })?;
        let on = row.map(|r| cell::<bool>(&r, 0)).transpose()? == Some(true);
        if !on {
            return Err(AcademyError::new(
                "academy.goal_invalid no goal with its reminder on",
                "academy.goal_invalid",
            )
            .into());
        }
        Ok(Json::obj([
            ("sent", Json::Bool(false)),
            ("mail", Json::str("vendor.email")),
        ]))
    }
}

fn todo_not_found() -> Refusal {
    AcademyError::new("academy.todo_not_found", "academy.todo_not_found").into()
}
