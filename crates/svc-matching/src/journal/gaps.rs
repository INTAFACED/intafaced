//! Transitions rebuilt from the journal and the gateway's timestamps (`journal-gaps.ts`). A hole is named, never healed
//! with an invented cancel or fill.

use service_kit::json::Json;

use super::record::{JournalRecord, is_str};

pub const JOURNAL_GAP: &str = "journal_gap";

/// A time the gateway stamped on an input, with its journal position when it knows one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayStamp {
    pub at: String,
    pub seq: Option<i64>,
    pub kind: Option<String>,
}

/// A named hole in the tape. A position is a record's whole-number `seq`; one that is not a whole number is `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalGap {
    pub after_seq: Option<i64>,
    pub before_seq: Option<i64>,
    pub after_at: Option<String>,
    pub before_at: Option<String>,
    pub message: String,
}

impl JournalGap {
    /// The gap as the TypeScript returns it.
    pub fn to_json(&self) -> Json {
        let seq = |s: Option<i64>| s.map_or(Json::Null, Json::int);
        let at = |a: &Option<String>| a.clone().map_or(Json::Null, Json::String);
        Json::obj([
            ("code", Json::str(JOURNAL_GAP)),
            ("afterSeq", seq(self.after_seq)),
            ("beforeSeq", seq(self.before_seq)),
            ("afterAt", at(&self.after_at)),
            ("beforeAt", at(&self.before_at)),
            ("message", Json::str(self.message.clone())),
        ])
    }
}

/// The journalled transitions, untouched, and the holes in them.
#[derive(Debug)]
pub struct TransitionReconstruction<'a> {
    pub transitions: &'a [JournalRecord],
    pub gaps: Vec<JournalGap>,
}

fn message(after: Option<i64>, before: Option<i64>) -> String {
    let name = |s: Option<i64>| s.map_or_else(|| "none".to_owned(), |s| s.to_string());
    format!(
        "journal gap after seq {} before seq {}; the engine does not invent a cancel or fill to close it",
        name(after),
        name(before)
    )
}

fn at_of(record: &JournalRecord) -> Option<String> {
    match record.field("at") {
        Some(Json::String(at)) => Some(at.clone()),
        _ => None,
    }
}

/// The gap between two records, either one absent at an end of the tape.
pub fn named_gap(after: Option<&JournalRecord>, before: Option<&JournalRecord>) -> JournalGap {
    let after_seq = after.and_then(JournalRecord::seq);
    let before_seq = before.and_then(JournalRecord::seq);
    JournalGap {
        after_seq,
        before_seq,
        after_at: after.and_then(at_of),
        before_at: before.and_then(at_of),
        message: message(after_seq, before_seq),
    }
}

/// The named hole when `next.seq` is not `prev.seq + 1`; `None` when the tape runs on.
pub fn seq_gap(prev: &JournalRecord, next: &JournalRecord) -> Option<JournalGap> {
    let runs_on = match (prev.seq(), next.seq()) {
        (Some(p), Some(n)) => p.checked_add(1) == Some(n),
        _ => false,
    };
    if runs_on {
        None
    } else {
        Some(named_gap(Some(prev), Some(next)))
    }
}

fn stamp_matches(record: &JournalRecord, stamp: &GatewayStamp) -> bool {
    match stamp.seq {
        Some(seq) => record.seq() == Some(seq),
        None => is_str(record.field("at"), &stamp.at),
    }
}

/// The journalled transitions as they are, and a named gap for every seq hole and every gateway stamp the journal
/// does not hold. It never makes up a submit, cancel, fill or amend.
pub fn reconstruct_transitions<'a>(
    records: &'a [JournalRecord],
    stamps: &[GatewayStamp],
) -> TransitionReconstruction<'a> {
    let mut gaps: Vec<JournalGap> = records
        .windows(2)
        .filter_map(|pair| match pair {
            [prev, next] => seq_gap(prev, next),
            _ => None,
        })
        .collect();
    for stamp in stamps {
        if records.iter().any(|record| stamp_matches(record, stamp)) {
            continue;
        }
        let after_seq = stamp.seq.and_then(|s| s.checked_sub(1));
        gaps.push(JournalGap {
            after_seq,
            before_seq: stamp.seq,
            after_at: None,
            before_at: Some(stamp.at.clone()),
            message: message(after_seq, stamp.seq),
        });
    }
    TransitionReconstruction {
        transitions: records,
        gaps,
    }
}
