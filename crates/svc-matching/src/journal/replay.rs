//! Replay (`journal-replay.ts`): every book rebuilt from the journalled inputs alone, in order, so replaying the same
//! records twice gives the same books. This holds the journal's own rules for that walk; the book applies each input.
//!
//! - Engine control records (halts, modes, listings, in-flight and surveillance evidence, rulebook versions) are not
//!   book inputs: the engine rebuilds that state itself, so replay skips them and never reads one as a cancel.
//! - A submit opens its market's book; a cancel, amend, mark or mass cancel never does. Journals written before the
//!   live door stopped journalling unknown markets still hold cancels for markets that never had an order, and replay
//!   must not invent an empty book for each.
//! - A session reported dead cancels its resting orders, and every later submit tagged with it is skipped.
//! - Replay from a snapshot takes only the records after its `journalSeq`, starting from the sessions dead by then.

use std::cmp::Ordering;
use std::collections::HashSet;

use service_kit::json::Json;
use service_kit::time::v8_date_parse;

use super::record::{JournalRecord, js_string, prop};

/// The kinds replay passes over.
pub const ENGINE_CONTROL_KINDS: [&str; 20] = [
    "halt",
    "resume",
    "reduce_only",
    "resume_reduce_only",
    "post_only",
    "resume_post_only",
    "prelaunch",
    "open",
    "expire",
    "delist",
    "maintenance",
    "end_maintenance",
    "halt_all",
    "resume_all",
    "split_brain",
    "clear_split_brain",
    "in_flight",
    "open_surveillance",
    "spread_list",
    "rulebook_version",
];

/// Why a cancel removes an order on replay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayCancel<'a> {
    /// The record's own reason (`record.reason ?? 'requested'`), on a full replay.
    Reason(&'a str),
    /// A caller cancel. Replay from a snapshot always cancels this way, and so treats any kind it does not know.
    Requested,
}

/// The books a replay rebuilds, keyed by market id. Each method applies one record to its market's book as the live
/// engine did. "Drops" means the book is removed when it is left empty without ever having printed, as live does.
pub trait ReplayBooks {
    fn has_market(&self, market_id: &str) -> bool;
    /// Opens the market's book when it has none, and drops it.
    fn submit(&mut self, market_id: &str, record: &JournalRecord, clock: Option<i64>);
    /// Drops the book.
    fn amend(&mut self, market_id: &str, record: &JournalRecord, clock: Option<i64>);
    /// Never drops the book.
    fn mark(&mut self, market_id: &str, record: &JournalRecord);
    /// Drops the book.
    fn mass_cancel(&mut self, market_id: &str, record: &JournalRecord);
    /// Never drops the book.
    fn cancel(&mut self, market_id: &str, record: &JournalRecord, why: ReplayCancel<'_>);
    /// Cancels the session's resting orders in every book, and drops each.
    fn session_dead(&mut self, session_id: &Json);
}

/// A record replay cannot place: its market id is not text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayError {
    pub seq: Option<i64>,
    pub kind: String,
}

impl std::fmt::Display for ReplayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "journal record seq {} ({}) names no market id replay can place",
            self.seq
                .map_or_else(|| "none".to_owned(), |s| s.to_string()),
            self.kind
        )
    }
}

impl std::error::Error for ReplayError {}

/// The clock a journalled input ran at (`journalClock`): `Date.parse(at)`, `None` where that is not a date.
pub fn journal_clock(at: Option<&Json>) -> Option<i64> {
    v8_date_parse(&js_string(at))
}

/// `Number(value)` for the comparison `record.seq > journalSeq`: `NaN` (here `None`) compares false either way.
fn js_number(value: Option<&Json>) -> Option<f64> {
    match value {
        Some(Json::Number(n)) => Some(*n),
        Some(Json::Null) => Some(0.0),
        Some(Json::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        Some(Json::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                Some(0.0)
            } else {
                t.parse::<f64>().ok().filter(|n| n.is_finite())
            }
        }
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Full,
    Tail,
}

fn market(record: &JournalRecord) -> Result<&str, ReplayError> {
    match record.field("marketId") {
        Some(Json::String(id)) => Ok(id),
        _ => Err(ReplayError {
            seq: record.seq(),
            kind: record.kind().unwrap_or("").to_owned(),
        }),
    }
}

fn walk<'r>(
    records: impl IntoIterator<Item = &'r JournalRecord>,
    dead: &mut HashSet<String>,
    books: &mut impl ReplayBooks,
    mode: Mode,
) -> Result<(), ReplayError> {
    for record in records {
        let kind = record.kind().unwrap_or("");
        if kind == "session_dead" {
            let session = record.field("sessionId").unwrap_or(&Json::Null);
            if let Json::String(id) = session {
                dead.insert(id.clone());
            }
            books.session_dead(session);
            continue;
        }
        if kind == "submit" {
            let session = prop(record.field("order"), "sessionId");
            if matches!(session, Some(Json::String(id)) if !id.is_empty() && dead.contains(id)) {
                continue;
            }
            books.submit(market(record)?, record, journal_clock(record.field("at")));
            continue;
        }
        if ENGINE_CONTROL_KINDS.contains(&kind) {
            continue;
        }
        let market_id = market(record)?;
        if !books.has_market(market_id) {
            continue;
        }
        match (kind, mode) {
            ("amend", _) => books.amend(market_id, record, journal_clock(record.field("at"))),
            ("mark", _) => books.mark(market_id, record),
            ("mass_cancel", _) => books.mass_cancel(market_id, record),
            ("cancel", Mode::Full) => {
                let why = match record.field("reason") {
                    Some(Json::String(reason)) => ReplayCancel::Reason(reason),
                    _ => ReplayCancel::Requested,
                };
                books.cancel(market_id, record, why);
            }
            (_, Mode::Tail) => books.cancel(market_id, record, ReplayCancel::Requested),
            (_, Mode::Full) => {}
        }
    }
    Ok(())
}

/// Rebuild every book from the start of the journal (`replayJournal`).
pub fn replay_journal(
    records: &[JournalRecord],
    books: &mut impl ReplayBooks,
) -> Result<(), ReplayError> {
    walk(records, &mut HashSet::new(), books, Mode::Full)
}

/// Replay forward from a snapshot (`replayFrom`): the books already restored from it, and the sessions dead at its
/// `journalSeq`.
pub fn replay_from(
    journal_seq: usize,
    dead_sessions: &[String],
    records: &[JournalRecord],
    books: &mut impl ReplayBooks,
) -> Result<(), ReplayError> {
    #[expect(
        clippy::cast_precision_loss,
        reason = "a journal's length is far below 2^53"
    )]
    let after = journal_seq as f64;
    let mut dead: HashSet<String> = dead_sessions
        .iter()
        .filter(|id| !id.is_empty())
        .cloned()
        .collect();
    let tail = records
        .iter()
        .filter(|record| js_number(record.field("seq")).is_some_and(|seq| seq > after));
    walk(tail, &mut dead, books, Mode::Tail)
}

/// JavaScript's default `sort()` order: UTF-16 code units.
pub fn js_sort_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// A snapshot of every book, consistent with the journal at `journal_seq`: replay resumes after it.
#[derive(Debug, Clone, PartialEq)]
pub struct EngineSnapshot<S> {
    pub journal_seq: usize,
    /// Sorted by market id, so a given state is one snapshot whatever order the markets opened in.
    pub books: Vec<S>,
    /// The sessions dead at `journal_seq`, without repeats or empty ids, sorted.
    pub dead_sessions: Vec<String>,
}

impl<S> EngineSnapshot<S> {
    /// `snapshotAll`.
    pub fn of(
        mut books: Vec<(String, S)>,
        journal_seq: usize,
        dead: impl IntoIterator<Item = String>,
    ) -> Self {
        books.sort_by(|(a, _), (b, _)| js_sort_cmp(a, b));
        let mut dead: Vec<String> = dead.into_iter().filter(|id| !id.is_empty()).collect();
        dead.sort_by(|a, b| js_sort_cmp(a, b));
        dead.dedup();
        EngineSnapshot {
            journal_seq,
            books: books.into_iter().map(|(_, state)| state).collect(),
            dead_sessions: dead,
        }
    }

    /// The snapshot as the TypeScript writes it, each book's state written by `state`.
    pub fn to_json(&self, state: impl Fn(&S) -> Json) -> Json {
        Json::obj([
            (
                "journalSeq",
                Json::int(i64::try_from(self.journal_seq).unwrap_or(i64::MAX)),
            ),
            ("books", Json::Array(self.books.iter().map(state).collect())),
            (
                "deadSessions",
                Json::Array(
                    self.dead_sessions
                        .iter()
                        .cloned()
                        .map(Json::String)
                        .collect(),
                ),
            ),
        ])
    }
}

/// Where periodic snapshots go.
pub trait SnapshotSink<S> {
    fn write(&mut self, snapshot: EngineSnapshot<S>);
}

/// The default sink: keeps the last snapshot in memory, so `/ready` and tests can see one.
#[derive(Debug)]
pub struct MemorySnapshotSink<S> {
    pub latest: Option<EngineSnapshot<S>>,
}

impl<S> Default for MemorySnapshotSink<S> {
    fn default() -> Self {
        MemorySnapshotSink { latest: None }
    }
}

impl<S> SnapshotSink<S> for MemorySnapshotSink<S> {
    fn write(&mut self, snapshot: EngineSnapshot<S>) {
        self.latest = Some(snapshot);
    }
}

/// Whether the journal's length calls for a snapshot: every `every` records, none when the owner set `every` to 0.
pub fn snapshot_due(journal_len: usize, every: u64) -> bool {
    let Ok(len) = u64::try_from(journal_len) else {
        return false;
    };
    every > 0 && len % every == 0
}
