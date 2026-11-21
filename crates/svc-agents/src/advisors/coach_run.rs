//! The Coach run (`coach/coach-run.ts`, RC-agents-02): one answer inside an Academy lesson that cites only lessons the
//! curriculum returned, run as a metered session on the fleet runtime (`open → think → settle → close`).
//!
//! The citations are chosen here, before the engine is called, so a citation is only ever a slug the curriculum
//! returned. Cheap refusals come before a session opens and bill nothing. The person's request id is the business key:
//! one row per (person, request id) in `coach_runs` holds the answer, so a retry returns the stored answer, and the
//! run's charge settles under its usage window's own charge key, so a retry after a crash settles once.

use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::time::Instant;

use super::grounding::{Grounding, Lesson, Ruling, SessionAsk, rule};
use super::text::{asks_about_own_holdings, asks_for_advice};
use crate::db::{self, StoreError};
use crate::gateway::digest_of_text;
use crate::gateway::providers::{ChatMessage, Role};
use crate::metering::meter::{self, MeterError};
use crate::metering::settle;
use crate::runtime::guardrails::{Guardrail, parse_guardrail};
use crate::runtime::{self, Rt, RunError, ThinkInput};

/// The agent id the Coach guardrail is registered under.
pub const COACH_AGENT_ID: &str = "coach";
/// The routing task the Coach calls. No default route names it: a deployment with no Coach model refuses.
pub const COACH_TASK: &str = "coach.answer";
/// At most this many lessons are cited for one answer.
pub const COACH_MAX_CITATIONS: usize = 3;
/// A running row younger than this is another request's live run, never a crashed one.
pub const COACH_RUN_LEASE_MS: i64 = 300_000;

/// `COACH_REFUSAL_CODES`.
pub const COACH_REFUSAL_CODES: [&str; 9] = [
    "agents.advice_forbidden",
    "agents.positions_not_decided",
    "agents.coach_curriculum_empty",
    "agents.coach_engine_unavailable",
    "agents.price_unset",
    "agents.spend_limit",
    "agents.funds_insufficient",
    "agents.request_id_replay",
    "agents.run_in_progress",
];

/// `coachAgentGuardrail`: no tools, the one Coach task, and a spend cap (`'0'` as shipped: no Coach rate or cap is
/// published, so a priced Coach route refuses rather than bill an amount nobody set).
pub fn coach_guardrail(max_spend_per_session: &str) -> Result<Guardrail, String> {
    let raw = json::parse(&format!(
        r#"{{"agentId":"{COACH_AGENT_ID}","version":1,"capacityMode":"research_only","tools":[],
            "limits":{{"maxActionsPerSession":4,"maxOutputTokensPerCall":1024,"maxSpendPerSession":"{max_spend_per_session}",
                       "allowedModules":[],"allowedTasks":["{COACH_TASK}"]}}}}"#
    ))
    .map_err(|e| e.message)?;
    parse_guardrail(&raw).map_err(|e| e.0)
}

// ── Retrieval over the curriculum spine ───────────────────────────────────────

const STOPWORDS: &str = "the and for are but not you your yours with what when where which who whom why how does did doing done will would \
could should can may might must this that these those there their them they then than from into onto over under \
about after before again more most less much many some any all each every very just also only own same such too \
its it is was were been being have has had having our ours out off down upon test me my mine myself explain tell \
next week matter matters lesson lessons";

/// `stemsOf`: lower-case word stems, a plural, `-ing` or `-ed` and a trailing `e` or `y` removed.
pub fn stems_of(text: &str) -> Vec<String> {
    let stop: Vec<&str> = STOPWORDS.split_whitespace().collect();
    let lowered = text.to_lowercase();
    let mut out: Vec<String> = Vec::new();
    for raw in lowered
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .filter(|w| !w.is_empty())
    {
        if raw.len() < 3 || stop.contains(&raw) {
            continue;
        }
        let mut stem = raw.to_owned();
        for suffix in ["ing", "ies", "es", "ed", "s"] {
            if stem.ends_with(suffix) && stem.len() - suffix.len() >= 3 {
                stem.truncate(stem.len() - suffix.len());
                break;
            }
        }
        if (stem.ends_with('e') || stem.ends_with('y')) && stem.len() > 3 {
            stem.pop();
        }
        if !out.contains(&stem) {
            out.push(stem);
        }
    }
    out
}

/// `citeLessons`: the lessons sharing a stem with the question in their title or slug, most shared first, then
/// curriculum order; empty when nothing matches.
pub fn cite_lessons(question: &str, items: &[Lesson]) -> Vec<Lesson> {
    let asked = stems_of(question);
    let mut scored: Vec<(usize, usize, &Lesson)> = items
        .iter()
        .enumerate()
        .filter_map(|(order, item)| {
            let stems = stems_of(&format!("{} {}", item.title, item.slug.replace('-', " ")));
            let score = asked.iter().filter(|s| stems.contains(s)).count();
            (score > 0).then_some((score, order, item))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored
        .into_iter()
        .take(COACH_MAX_CITATIONS)
        .map(|(_, _, l)| l.clone())
        .collect()
}

/// `nextLessonOf`: the lesson after the one the person is in, or after the first citation.
pub fn next_lesson_of(
    items: &[Lesson],
    lesson_slug: Option<&str>,
    citations: &[Lesson],
) -> Option<Lesson> {
    let from = match lesson_slug {
        Some(s) if !s.is_empty() && items.iter().any(|i| i.slug == s) => Some(s),
        _ => citations.first().map(|c| c.slug.as_str()),
    }?;
    let at = items.iter().position(|i| i.slug == from)?;
    items.get(at + 1).cloned()
}

/// `coachSystemPrompt`.
pub fn coach_system_prompt(citations: &[Lesson]) -> String {
    let mut lines =
        vec!["You are the Academy Coach. Explain using only these Academy lessons:".to_owned()];
    lines.extend(
        citations
            .iter()
            .map(|c| format!("- {} ({})", c.title, c.slug)),
    );
    lines.push(
        "Do not recommend trades, promise returns or discuss the reader\u{2019}s own positions."
            .to_owned(),
    );
    lines.join("\n")
}

/// `coachRunKey`.
pub fn coach_run_key(session_id: &str, request_id: &str) -> String {
    format!("agents:run:{session_id}:{request_id}")
}

// ── The stored run ─────────────────────────────────────────────────────────────

/// `CoachRunRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunRow {
    pub session_id: String,
    pub run_key: String,
    pub question_digest: String,
    pub status: String,
    pub answer: Option<String>,
    pub citations: Vec<Lesson>,
    pub next_lesson: Option<Lesson>,
    pub engine: Option<String>,
    pub billed_amount: Option<String>,
    pub created_at: Instant,
}

/// What an answered row stores.
pub struct Answered<'a> {
    pub answer: &'a str,
    pub citations: &'a [Lesson],
    pub next_lesson: Option<&'a Lesson>,
    pub engine: &'a str,
}

/// `CoachRunStore`.
pub trait RunStore {
    fn find(&self, user_id: &str, request_id: &str) -> Result<Option<RunRow>, StoreError>;
    /// Inserts a running row; false when the (person, request id) row already exists.
    fn claim(
        &self,
        user_id: &str,
        request_id: &str,
        session_id: &str,
        run_key: &str,
        digest: &str,
    ) -> Result<bool, StoreError>;
    fn answer(
        &self,
        user_id: &str,
        request_id: &str,
        answered: &Answered<'_>,
    ) -> Result<bool, StoreError>;
    /// What the ledger accepted for the session's windows: the charges that carry a ledger answer.
    fn charged(&self, session_id: &str) -> Result<Amount, StoreError>;
    fn settled(
        &self,
        user_id: &str,
        request_id: &str,
        billed_amount: &str,
    ) -> Result<(), StoreError>;
    fn lost(&self, user_id: &str, request_id: &str) -> Result<(), StoreError>;
    /// Removes a running row whose run refused before anything was metered.
    fn drop_running(&self, user_id: &str, request_id: &str) -> Result<(), StoreError>;
}

/// `createCoachRunStore(sql)`.
pub struct PgRunStore<'a>(pub &'a Pool);

fn lessons_of(text: &str) -> Vec<Lesson> {
    match json::parse(text) {
        Ok(Json::Array(items)) => items.iter().filter_map(Lesson::from_json).collect(),
        _ => Vec::new(),
    }
}

impl RunStore for PgRunStore<'_> {
    fn find(&self, user_id: &str, request_id: &str) -> Result<Option<RunRow>, StoreError> {
        let rows = db::with_client(self.0, |c| {
            Ok(c.query(
                &format!(
                    "SELECT session_id::text, run_key, question_digest, status, answer, citations::text, next_lesson::text,
                            engine, billed_amount::text, {}
                       FROM agents.coach_runs WHERE user_id = $1::text AND request_id = $2::text",
                    runtime::ms("created_at")
                ),
                &[&user_id, &request_id],
            )?)
        })?;
        let Some(r) = rows.first() else {
            return Ok(None);
        };
        let billed: Option<String> = r.try_get(8)?;
        let next: Option<String> = r.try_get(6)?;
        Ok(Some(RunRow {
            session_id: r.try_get(0)?,
            run_key: r.try_get(1)?,
            question_digest: r.try_get(2)?,
            status: r.try_get(3)?,
            answer: r.try_get(4)?,
            citations: lessons_of(&r.try_get::<_, String>(5)?),
            next_lesson: next
                .and_then(|n| json::parse(&n).ok())
                .and_then(|j| Lesson::from_json(&j)),
            engine: r.try_get(7)?,
            // numeric(38,18) reads back padded; the stored amount is the decimal string the fresh answer returned.
            billed_amount: billed
                .map(|b| parse_amount(&b).map(format_amount))
                .transpose()
                .map_err(|e| StoreError::new(e, None))?,
            created_at: Instant(r.try_get(9)?),
        }))
    }

    fn claim(
        &self,
        user_id: &str,
        request_id: &str,
        session_id: &str,
        run_key: &str,
        digest: &str,
    ) -> Result<bool, StoreError> {
        db::with_client(self.0, |c| {
            Ok(c.query(
                "INSERT INTO agents.coach_runs (user_id, request_id, session_id, run_key, question_digest, status)
                 VALUES ($1::text, $2::text, $3::text::uuid, $4::text, $5::text, 'running')
                 ON CONFLICT (user_id, request_id) DO NOTHING RETURNING request_id",
                &[&user_id, &request_id, &session_id, &run_key, &digest],
            )?
            .len()
                == 1)
        })
    }

    fn answer(
        &self,
        user_id: &str,
        request_id: &str,
        a: &Answered<'_>,
    ) -> Result<bool, StoreError> {
        let citations = Json::Array(a.citations.iter().map(Lesson::to_json).collect()).compact();
        let next = a.next_lesson.map(|l| l.to_json().compact());
        db::with_client(self.0, |c| {
            Ok(c.execute(
                "UPDATE agents.coach_runs
                    SET status = 'answered', answer = $3::text, citations = $4::text::jsonb,
                        next_lesson = $5::text::jsonb, engine = $6::text, answered_at = now()
                  WHERE user_id = $1::text AND request_id = $2::text AND status = 'running'",
                &[
                    &user_id,
                    &request_id,
                    &a.answer,
                    &citations,
                    &next,
                    &a.engine,
                ],
            )? == 1)
        })
    }

    fn charged(&self, session_id: &str) -> Result<Amount, StoreError> {
        let total: String = db::with_client(self.0, |c| {
            Ok(c.query_one(
                "SELECT coalesce(sum(charged_amount), 0)::text FROM agents.usage_windows
                  WHERE session_id = $1::text::uuid AND charge_tx_id IS NOT NULL",
                &[&session_id],
            )?
            .try_get(0)?)
        })?;
        parse_amount(&total).map_err(|e| StoreError::new(e, None))
    }

    fn settled(
        &self,
        user_id: &str,
        request_id: &str,
        billed_amount: &str,
    ) -> Result<(), StoreError> {
        db::with_client(self.0, |c| {
            c.execute(
                "UPDATE agents.coach_runs SET billed_amount = $3::text::numeric
                  WHERE user_id = $1::text AND request_id = $2::text",
                &[&user_id, &request_id, &billed_amount],
            )?;
            Ok(())
        })
    }

    fn lost(&self, user_id: &str, request_id: &str) -> Result<(), StoreError> {
        db::with_client(self.0, |c| {
            c.execute(
                "UPDATE agents.coach_runs SET status = 'lost'
                  WHERE user_id = $1::text AND request_id = $2::text AND status = 'running'",
                &[&user_id, &request_id],
            )?;
            Ok(())
        })
    }

    fn drop_running(&self, user_id: &str, request_id: &str) -> Result<(), StoreError> {
        db::with_client(self.0, |c| {
            c.execute(
                "DELETE FROM agents.coach_runs WHERE user_id = $1::text AND request_id = $2::text AND status = 'running'",
                &[&user_id, &request_id],
            )?;
            Ok(())
        })
    }
}

// ── The run ──────────────────────────────────────────────────────────────────

/// What the run billed, read back from its settlements; `Unpaid` keeps the code the settle failed with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Charge {
    Settled(String),
    Unpaid(String),
}

/// `CoachRunResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[expect(
    clippy::large_enum_variant,
    reason = "one result per call, built once and written out at once"
)]
pub enum CoachResult {
    Answered {
        answer: String,
        citations: Vec<Lesson>,
        next_lesson: Option<Lesson>,
        engine: String,
        session_id: String,
        run_key: String,
        asset_id: String,
        charge: Charge,
        replayed: bool,
    },
    NotCovered,
    Refused(&'static str),
}

impl CoachResult {
    /// `coach.runSession`'s answer, in its output schema's order.
    pub fn to_json(&self) -> Json {
        match self {
            CoachResult::Answered {
                answer,
                citations,
                next_lesson,
                engine,
                session_id,
                run_key,
                asset_id,
                charge,
                replayed,
            } => Json::obj([
                ("status", Json::str("answered")),
                ("answer", Json::str(answer.clone())),
                (
                    "citations",
                    Json::Array(citations.iter().map(Lesson::to_json).collect()),
                ),
                (
                    "nextLesson",
                    next_lesson.as_ref().map_or(Json::Null, Lesson::to_json),
                ),
                ("engine", Json::str(engine.clone())),
                ("sessionId", Json::str(session_id.clone())),
                ("runKey", Json::str(run_key.clone())),
                ("assetId", Json::str(asset_id.clone())),
                (
                    "charge",
                    match charge {
                        Charge::Settled(b) => Json::obj([
                            ("state", Json::str("settled")),
                            ("billedAmount", Json::str(b.clone())),
                        ]),
                        Charge::Unpaid(code) => Json::obj([
                            ("state", Json::str("unpaid")),
                            ("code", Json::str(code.clone())),
                        ]),
                    },
                ),
                ("replayed", Json::Bool(*replayed)),
            ]),
            CoachResult::NotCovered => Json::obj([
                ("status", Json::str("not_covered")),
                ("citations", Json::Array(Vec::new())),
            ]),
            CoachResult::Refused(code) => {
                Json::obj([("status", Json::str("refused")), ("code", Json::str(*code))])
            }
        }
    }
}

/// `CoachRunInput`: the signed principal's user id, never one read from the body.
pub struct CoachAsk<'a> {
    pub user_id: &'a str,
    pub request_id: &'a str,
    pub question: &'a str,
    pub lesson_slug: Option<&'a str>,
}

/// `errorCode`: a failure's own code, else `agents.settlement_failed`.
fn error_code(e: &MeterError) -> String {
    let code = match e {
        MeterError::Agent(a) => Some(a.code.to_owned()),
        MeterError::Ledger(l) => l.code.clone(),
        MeterError::Store(s) => s.code.clone(),
        MeterError::PaymentUnavailable | MeterError::Pricing(_) => None,
    };
    code.unwrap_or_else(|| "agents.settlement_failed".to_owned())
}

/// `refusalOf`: the run's refusal code for a failure of `think`, or none when it is not a refusal.
fn refusal_of(e: &RunError) -> Option<&'static str> {
    match e {
        RunError::Refused { refusal, .. } => [
            "agents.price_unset",
            "agents.spend_limit",
            "agents.funds_insufficient",
        ]
        .into_iter()
        .find(|c| *c == refusal.code),
        RunError::Agent(d) | RunError::MeteredReplay(d) => match d.error.code {
            "agents.route_not_found"
            | "agents.provider_unavailable"
            | "agents.capability_unavailable" => Some("agents.coach_engine_unavailable"),
            "agents.request_id_replay" => Some("agents.request_id_replay"),
            _ => None,
        },
        _ => None,
    }
}

/// `engineFor`: the Coach route's engine, or none when no route or provider serves it.
fn engine_for(x: &Rt<'_>) -> Option<String> {
    let table = x.gateway.routing_table(x.now);
    let route = table.routes.iter().find(|r| r.task == COACH_TASK)?;
    x.gateway
        .registered(&route.provider_id)
        .map(|p| p.engine().name().to_owned())
}

/// `settleRun`: settle the session's windows and close it. A settle failure leaves the window unpaid on its charge key
/// and the session open, so the next ask with the same id settles it. The billed amount is read back from the sealed
/// windows, so a retry after a crash past the post still shows what was charged.
fn settle_run(
    x: &Rt<'_>,
    store: &dyn RunStore,
    user_id: &str,
    request_id: &str,
    session_id: &str,
) -> Result<Charge, RunError> {
    if let Err(e) = settle::settle_session(x.m, x.pool, session_id, x.now) {
        return Ok(Charge::Unpaid(error_code(&e)));
    }
    let billed = format_amount(store.charged(session_id)?);
    runtime::close_session(x, session_id)?;
    store.settled(user_id, request_id, &billed)?;
    Ok(Charge::Settled(billed))
}

fn answered_from(row: &RunRow, asset_id: &str, charge: Charge, replayed: bool) -> CoachResult {
    CoachResult::Answered {
        answer: row.answer.clone().unwrap_or_default(),
        citations: row.citations.clone(),
        next_lesson: row.next_lesson.clone(),
        engine: row.engine.clone().unwrap_or_else(|| "unknown".to_owned()),
        session_id: row.session_id.clone(),
        run_key: row.run_key.clone(),
        asset_id: asset_id.to_owned(),
        charge,
        replayed,
    }
}

/// `runCoachAnswer`: answer one question, or refuse it with a typed code. Advice, own-holdings asks and an empty
/// curriculum first; then the stored run for this request id; then no Coach model and a topic the curriculum does not
/// cover: all before any session opens. Then a new metered run. `lease_now` is the clock the running-row lease reads.
pub fn run_coach_answer(
    x: &Rt<'_>,
    store: &dyn RunStore,
    grounding: &Grounding,
    ask: &CoachAsk<'_>,
    lease_now: Instant,
) -> Result<CoachResult, RunError> {
    let question = service_kit::schema::js_trim(ask.question);
    let ruling = rule(
        grounding,
        &SessionAsk {
            as_advice: asks_for_advice(question),
            include_positions: asks_about_own_holdings(question),
            ..SessionAsk::default()
        },
    );
    if let Ruling::Refuse { reason, .. } = ruling {
        match reason {
            "advice_forbidden" => return Ok(CoachResult::Refused("agents.advice_forbidden")),
            "positions_not_decided" => {
                return Ok(CoachResult::Refused("agents.positions_not_decided"));
            }
            "curriculum_empty" => return Ok(CoachResult::Refused("agents.coach_curriculum_empty")),
            // The licensed library, which this run does not cite: it grounds on the spine alone.
            _ => {}
        }
    }
    let fee = x.m.fee_asset_id.as_str();
    let digest = digest_of_text(&format!(
        "{}\n{question}",
        ask.lesson_slug.unwrap_or_default()
    ));

    // The stored run comes before the engine and curriculum checks: an answer already given is returned as it was.
    if let Some(stored) = store.find(ask.user_id, ask.request_id)? {
        if stored.question_digest != digest {
            return Ok(CoachResult::Refused("agents.request_id_replay"));
        }
        if stored.status == "answered" {
            let charge = match &stored.billed_amount {
                None => settle_run(x, store, ask.user_id, ask.request_id, &stored.session_id)?,
                Some(b) => Charge::Settled(b.clone()),
            };
            return Ok(answered_from(&stored, fee, charge, true));
        }
        if stored.status == "running" && lease_now.0 - stored.created_at.0 < COACH_RUN_LEASE_MS {
            return Ok(CoachResult::Refused("agents.run_in_progress"));
        }
        // A run that stopped before its answer was stored: whatever it metered settles once, on its own charge key.
        settle_run(x, store, ask.user_id, ask.request_id, &stored.session_id)?;
        if stored.status == "lost"
            || meter::has_request(x.pool, &stored.session_id, ask.request_id)?
        {
            // The engine ran and its text is gone: running it again would bill the same request twice.
            store.lost(ask.user_id, ask.request_id)?;
            return Ok(CoachResult::Refused("agents.request_id_replay"));
        }
        store.drop_running(ask.user_id, ask.request_id)?;
    }

    let Some(engine) = engine_for(x) else {
        return Ok(CoachResult::Refused("agents.coach_engine_unavailable"));
    };
    let citations = cite_lessons(question, &grounding.items);
    if citations.is_empty() {
        return Ok(CoachResult::NotCovered);
    }

    let session = runtime::open_session(x, ask.user_id, COACH_AGENT_ID)?;
    let run_key = coach_run_key(&session.id, ask.request_id);
    if !store.claim(ask.user_id, ask.request_id, &session.id, &run_key, &digest)? {
        // Another request with this id got there first; this session ran nothing.
        runtime::close_session(x, &session.id)?;
        return Ok(CoachResult::Refused("agents.request_id_replay"));
    }

    let system = coach_system_prompt(&citations);
    let messages = [ChatMessage {
        role: Role::User,
        content: question.to_owned(),
    }];
    let thought = runtime::think(
        x,
        &ThinkInput {
            session_id: &session.id,
            request_id: ask.request_id,
            task: COACH_TASK,
            system: Some(&system),
            messages: &messages,
            max_output_tokens: None,
            team_run: false,
        },
    );
    let text = match thought {
        Ok(t) => t.text,
        Err(e) => {
            let code = refusal_of(&e);
            let metered = meter::has_request(x.pool, &session.id, ask.request_id).unwrap_or(true);
            if metered {
                store.lost(ask.user_id, ask.request_id)?;
            } else {
                store.drop_running(ask.user_id, ask.request_id)?;
            }
            // Settling is bookkeeping here: its own failure leaves the window for the next settle.
            let _ = settle_run(x, store, ask.user_id, ask.request_id, &session.id);
            return match code {
                Some(c) => Ok(CoachResult::Refused(c)),
                None => Err(e),
            };
        }
    };

    let next_lesson = next_lesson_of(&grounding.items, ask.lesson_slug, &citations);
    let kept = store.answer(
        ask.user_id,
        ask.request_id,
        &Answered {
            answer: &text,
            citations: &citations,
            next_lesson: next_lesson.as_ref(),
            engine: &engine,
        },
    )?;
    let charge = settle_run(x, store, ask.user_id, ask.request_id, &session.id)?;
    // The row left `running` under this run (a recovery past the lease took it): the stored state is the answer.
    if !kept {
        return Ok(CoachResult::Refused("agents.request_id_replay"));
    }
    Ok(CoachResult::Answered {
        answer: text,
        citations,
        next_lesson,
        engine,
        session_id: session.id,
        run_key,
        asset_id: fee.to_owned(),
        charge,
        replayed: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lesson(slug: &str, title: &str) -> Lesson {
        Lesson {
            slug: slug.to_owned(),
            title: title.to_owned(),
        }
    }

    /// The Coach guardrail the boot writes (`registerCoachAgent`, recorded in `boot_agents.json`) is this one, cap 0.
    #[test]
    fn the_booted_coach_guardrail_is_the_shipped_one() {
        #![allow(clippy::unwrap_used, reason = "a test")]
        let booted = crate::boot::boot_agents().unwrap();
        let row = booted
            .iter()
            .find(|a| a.agent_id == COACH_AGENT_ID)
            .unwrap();
        assert_eq!(
            row.guardrail,
            crate::runtime::guardrails::serialise_guardrail(&coach_guardrail("0").unwrap())
        );
    }

    /// `coach-run.test.ts`: stems meet across forms, and citations are only curriculum rows, best first.
    #[test]
    fn retrieval_cites_only_curriculum_rows_best_first() {
        assert_eq!(
            stems_of("Sizing entries"),
            vec!["siz".to_owned(), "entr".to_owned()]
        );
        assert_eq!(
            stems_of("size entry"),
            vec!["siz".to_owned(), "entr".to_owned()]
        );
        let spine = [
            lesson("foundations-risk-first", "Risk first"),
            lesson(
                "foundations-position-sizing",
                "Position sizing without inventing numbers",
            ),
            lesson(
                "foundations-invalidation-first",
                "Invalidation before entry",
            ),
        ];
        let cited = cite_lessons(
            "TEST: why does position size matter more than entry?",
            &spine,
        );
        assert_eq!(cited, vec![spine[1].clone(), spine[2].clone()]);
        assert!(cite_lessons("weather on mars", &spine).is_empty());
        assert_eq!(
            next_lesson_of(&spine, Some("foundations-risk-first"), &cited),
            Some(spine[1].clone())
        );
        assert_eq!(next_lesson_of(&spine, None, &cited), Some(spine[2].clone()));
        assert_eq!(
            next_lesson_of(&spine, Some("elsewhere"), &[spine[2].clone()]),
            None
        );
        assert_eq!(
            coach_system_prompt(&cited[..1]),
            "You are the Academy Coach. Explain using only these Academy lessons:\n\
             - Position sizing without inventing numbers (foundations-position-sizing)\n\
             Do not recommend trades, promise returns or discuss the reader\u{2019}s own positions."
        );
    }
}
