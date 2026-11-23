//! Named gaps, ported from `services/svc-matching/src/engine/journal-gaps.test.ts`, and the journal's rules for a
//! replay (`journal-replay.ts`) run over a book that writes down every input it is given. The books themselves, and
//! the replay to the exact book, are the `book` slice's (`PORT.md`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeSet;

use service_kit::json::{self, Json};
use svc_matching::journal::gaps::{GatewayStamp, JOURNAL_GAP, reconstruct_transitions, seq_gap};
use svc_matching::journal::replay::{
    ENGINE_CONTROL_KINDS, EngineSnapshot, MemorySnapshotSink, ReplayBooks, ReplayCancel,
    SnapshotSink, journal_clock, replay_from, replay_journal, snapshot_due,
};
use svc_matching::journal::{EngineJournal, JournalCommand, JournalRecord, MemoryJournal};

const MARKET: &str = "BTC/USDT";
const ASK: &str = "11111111-1111-4111-8111-111111111111";
const LATER: &str = "33333333-3333-4333-8333-333333333333";
const T0: &str = "2026-09-02T22:00:00.000Z";
const T1: &str = "2026-09-02T22:00:01.000Z";
const T2: &str = "2026-09-02T22:00:02.000Z";

fn rec(text: &str) -> JournalRecord {
    JournalRecord(json::parse(text).unwrap())
}

fn ask_submit(seq: Option<i64>, at: &str, id: &str, price: &str) -> Json {
    let mut fields = vec![
        ("kind".to_owned(), Json::str("submit")),
        ("marketId".to_owned(), Json::str(MARKET)),
        ("at".to_owned(), Json::str(at)),
        (
            "order".to_owned(),
            Json::obj([
                ("orderId", Json::str(id)),
                ("accountId", Json::str("mm")),
                ("type", Json::str("limit")),
                ("side", Json::str("sell")),
                ("qty", Json::str("2")),
                ("price", Json::str(price)),
                ("stopPrice", Json::Null),
                ("tif", Json::str("GTC")),
            ]),
        ),
    ];
    if let Some(seq) = seq {
        fields.push(("seq".to_owned(), Json::int(seq)));
    }
    Json::Object(fields)
}

fn holey_ask_tape() -> Vec<JournalRecord> {
    vec![
        JournalRecord(ask_submit(Some(1), T0, ASK, "100")),
        JournalRecord(ask_submit(Some(4), T2, LATER, "101")),
    ]
}

fn stamp(at: &str, seq: Option<i64>, kind: Option<&str>) -> GatewayStamp {
    GatewayStamp {
        at: at.to_owned(),
        seq,
        kind: kind.map(str::to_owned),
    }
}

fn kinds(records: &[JournalRecord]) -> Vec<&str> {
    records.iter().map(|r| r.kind().unwrap()).collect()
}

// ── journal-gaps — named holes, never a healed tape ──────────────────────────────────────────────────────────────

#[test]
fn a_contiguous_journal_with_matching_gateway_stamps_has_no_gaps_and_no_extra_transitions() {
    let mut journal = MemoryJournal::new();
    journal
        .append(&JournalCommand(ask_submit(None, T0, ASK, "100")))
        .unwrap();
    journal
        .append(&JournalCommand(ask_submit(None, T1, LATER, "101")))
        .unwrap();
    let records = journal.read();
    let stamps = [
        stamp(T0, records[0].seq(), None),
        stamp(T1, records[1].seq(), None),
    ];
    let rebuilt = reconstruct_transitions(records, &stamps);
    assert!(rebuilt.gaps.is_empty());
    assert!(std::ptr::eq(rebuilt.transitions, records));
    assert_eq!(rebuilt.transitions.len(), records.len());
    assert!(seq_gap(&records[0], &records[1]).is_none());
}

#[test]
fn a_seq_hole_from_1_to_4_is_a_named_gap_with_no_invented_cancel_or_fill() {
    let holey = holey_ask_tape();
    let rebuilt = reconstruct_transitions(
        &holey,
        &[stamp(T0, Some(1), None), stamp(T2, Some(4), None)],
    );
    assert!(std::ptr::eq(rebuilt.transitions, holey.as_slice()));
    assert_eq!(kinds(rebuilt.transitions), ["submit", "submit"]);
    assert_eq!(rebuilt.gaps.len(), 1);
    let gap = &rebuilt.gaps[0];
    assert_eq!(gap.to_json().get("code"), Some(&Json::str(JOURNAL_GAP)));
    assert_eq!(gap.after_seq, Some(1));
    assert_eq!(gap.before_seq, Some(4));
    assert_eq!(gap.after_at.as_deref(), Some(T0));
    assert_eq!(gap.before_at.as_deref(), Some(T2));
    let direct = seq_gap(&holey[0], &holey[1]).unwrap();
    assert_eq!((direct.after_seq, direct.before_seq), (Some(1), Some(4)));
    assert!(gap.message.contains("after seq 1"));
    assert!(gap.message.contains("before seq 4"));
    let lower = gap.message.to_lowercase();
    assert!(!lower.contains("fill was applied") && !lower.contains("cancel was applied"));
    assert_eq!(
        gap.message,
        "journal gap after seq 1 before seq 4; the engine does not invent a cancel or fill to close it"
    );
}

#[test]
fn a_gateway_stamp_with_a_seq_or_time_not_on_the_journal_is_a_named_gap_not_a_made_up_event() {
    let records = vec![JournalRecord(ask_submit(Some(1), T0, ASK, "100"))];
    let by_seq = reconstruct_transitions(&records, &[stamp(T1, Some(2), Some("fill"))]);
    assert!(std::ptr::eq(by_seq.transitions, records.as_slice()));
    assert_eq!(kinds(by_seq.transitions), ["submit"]);
    assert_eq!(by_seq.gaps.len(), 1);
    assert_eq!(by_seq.gaps[0].before_seq, Some(2));
    assert_eq!(by_seq.gaps[0].after_seq, Some(1));
    assert_eq!(by_seq.gaps[0].after_at, None);
    assert_eq!(by_seq.gaps[0].before_at.as_deref(), Some(T1));

    let by_at = reconstruct_transitions(&records, &[stamp("2026-09-02T22:00:09.000Z", None, None)]);
    assert_eq!(by_at.transitions.len(), 1);
    assert_eq!(by_at.gaps.len(), 1);
    assert_eq!(by_at.gaps[0].before_seq, None);
    assert!(
        by_at.gaps[0]
            .message
            .contains("after seq none before seq none")
    );
    // A stamp with no seq matches by time.
    assert!(
        reconstruct_transitions(&records, &[stamp(T0, None, None)])
            .gaps
            .is_empty()
    );
}

#[test]
fn replaying_a_holey_tape_gives_the_book_only_the_journalled_inputs() {
    let holey = holey_ask_tape();
    let rebuilt = reconstruct_transitions(
        &holey,
        &[
            stamp(T0, Some(1), None),
            stamp(T1, Some(2), Some("fill")),
            stamp(T2, Some(4), None),
        ],
    );
    assert_eq!(kinds(rebuilt.transitions), ["submit", "submit"]);
    let mut books = Recording::default();
    replay_journal(rebuilt.transitions, &mut books).unwrap();
    assert_eq!(
        books.log,
        [format!("submit {MARKET} 1"), format!("submit {MARKET} 4")]
    );
}

#[test]
fn in_flight_stays_in_flight_on_reconstruct_and_is_not_turned_into_a_cancel() {
    let records = vec![rec(&format!(
        r#"{{"kind":"in_flight","marketId":"{MARKET}","at":"{T0}","seq":1,"orderId":"{ASK}","mutation":"cancel","inFlight":true,"qty":"2"}}"#
    ))];
    let rebuilt = reconstruct_transitions(&records, &[stamp(T0, Some(1), None)]);
    assert!(std::ptr::eq(rebuilt.transitions, records.as_slice()));
    assert_eq!(kinds(rebuilt.transitions), ["in_flight"]);
    assert!(rebuilt.gaps.is_empty());
    let mut books = Recording::default();
    books.markets.insert(MARKET.to_owned());
    replay_journal(&records, &mut books).unwrap();
    assert!(books.log.is_empty());
}

// ── replay's rules ───────────────────────────────────────────────────────────────────────────────────────────────

/// A book that writes down each input replay hands it.
#[derive(Default)]
struct Recording {
    markets: BTreeSet<String>,
    log: Vec<String>,
}

impl Recording {
    fn note(&mut self, what: &str, market: &str, record: &JournalRecord) {
        self.log
            .push(format!("{what} {market} {}", record.seq().unwrap()));
    }
}

impl ReplayBooks for Recording {
    fn has_market(&self, market_id: &str) -> bool {
        self.markets.contains(market_id)
    }
    fn submit(&mut self, market_id: &str, record: &JournalRecord, _clock: Option<i64>) {
        self.markets.insert(market_id.to_owned());
        self.note("submit", market_id, record);
    }
    fn amend(&mut self, market_id: &str, record: &JournalRecord, _clock: Option<i64>) {
        self.note("amend", market_id, record);
    }
    fn mark(&mut self, market_id: &str, record: &JournalRecord) {
        self.note("mark", market_id, record);
    }
    fn mass_cancel(&mut self, market_id: &str, record: &JournalRecord) {
        self.note("mass_cancel", market_id, record);
    }
    fn cancel(&mut self, market_id: &str, record: &JournalRecord, why: ReplayCancel<'_>) {
        let why = match why {
            ReplayCancel::Reason(r) => r.to_owned(),
            ReplayCancel::Requested => "requested".to_owned(),
        };
        self.note(&format!("cancel({why})"), market_id, record);
    }
    fn session_dead(&mut self, session_id: &Json) {
        self.log
            .push(format!("session_dead {}", session_id.compact()));
    }
}

fn submit(seq: i64, market: &str, session: Option<&str>) -> String {
    let session = session.map_or(String::new(), |s| format!(r#","sessionId":"{s}""#));
    format!(
        r#"{{"seq":{seq},"kind":"submit","marketId":"{market}","at":"{T0}","order":{{"orderId":"o{seq}","accountId":"a","type":"limit","side":"buy","qty":"1","price":"1","stopPrice":null,"tif":"GTC"{session}}}}}"#
    )
}

fn on(seq: i64, kind: &str, market: &str, extra: &str) -> String {
    format!(r#"{{"seq":{seq},"kind":"{kind}","marketId":"{market}","at":"{T0}"{extra}}}"#)
}

fn tape(lines: &[String]) -> Vec<JournalRecord> {
    lines.iter().map(|l| rec(l)).collect()
}

#[test]
fn engine_control_records_are_passed_over_and_never_read_as_a_cancel() {
    let mut lines = vec![submit(1, "M", None)];
    for (i, kind) in ENGINE_CONTROL_KINDS.iter().enumerate() {
        lines.push(on(
            i64::try_from(i).unwrap() + 2,
            kind,
            "M",
            r#","orderId":"o1""#,
        ));
    }
    let mut books = Recording::default();
    replay_journal(&tape(&lines), &mut books).unwrap();
    assert_eq!(books.log, ["submit M 1"]);
    // From a snapshot, an unknown kind on a live market is a caller cancel; a control kind is still passed over.
    let mut books = Recording::default();
    books.markets.insert("M".to_owned());
    replay_from(0, &[], &tape(&lines[1..]), &mut books).unwrap();
    assert!(books.log.is_empty());
}

#[test]
fn a_cancel_amend_mark_or_mass_cancel_never_opens_a_market() {
    let lines = [
        on(1, "cancel", "PHANTOM", r#","orderId":"x""#),
        on(
            2,
            "amend",
            "PHANTOM",
            r#","orderId":"x","expectedVersion":1,"patch":{}"#,
        ),
        on(3, "mark", "PHANTOM", r#","mark":"1""#),
        on(4, "mass_cancel", "PHANTOM", r#","accountId":"a""#),
        submit(5, "M", None),
        on(
            6,
            "cancel",
            "M",
            r#","orderId":"o5","reason":"hold_unconfirmed""#,
        ),
        on(7, "cancel", "M", r#","orderId":"o5","reason":null"#),
        on(8, "cancel", "M", r#","orderId":"o5""#),
        on(
            9,
            "amend",
            "M",
            r#","orderId":"o5","expectedVersion":1,"patch":{}"#,
        ),
        on(10, "mark", "M", r#","mark":"1""#),
        on(11, "mass_cancel", "M", r#","accountId":"a""#),
        on(12, "fill", "M", r#","orderId":"o5""#),
    ];
    let mut books = Recording::default();
    replay_journal(&tape(&lines), &mut books).unwrap();
    assert_eq!(
        books.log,
        [
            "submit M 5",
            "cancel(hold_unconfirmed) M 6",
            "cancel(requested) M 7",
            "cancel(requested) M 8",
            "amend M 9",
            "mark M 10",
            "mass_cancel M 11",
        ]
    );
    assert_eq!(books.markets.iter().collect::<Vec<_>>(), ["M"]);
}

#[test]
fn a_dead_session_skips_every_later_submit_tagged_with_it() {
    let lines = [
        submit(1, "M", Some("s1")),
        r#"{"seq":2,"kind":"session_dead","at":"x","sessionId":"s1"}"#.to_owned(),
        submit(3, "M", Some("s1")),
        submit(4, "M", Some("s2")),
        submit(5, "N", None),
        submit(6, "M", Some("")),
        r#"{"seq":7,"kind":"session_dead","at":"x","sessionId":""}"#.to_owned(),
        submit(8, "M", Some("")),
    ];
    let mut books = Recording::default();
    replay_journal(&tape(&lines), &mut books).unwrap();
    assert_eq!(
        books.log,
        [
            "submit M 1",
            r#"session_dead "s1""#,
            "submit M 4",
            "submit N 5",
            "submit M 6",
            r#"session_dead """#,
            "submit M 8",
        ]
    );
}

#[test]
fn replay_from_a_snapshot_takes_the_tail_starts_from_its_dead_sessions_and_cancels_as_the_caller() {
    let lines = [
        submit(1, "M", None),
        submit(2, "M", Some("s-old")),
        submit(3, "M", Some("s-old")),
        on(
            4,
            "cancel",
            "M",
            r#","orderId":"o1","reason":"hold_unconfirmed""#,
        ),
        on(5, "fill", "M", r#","orderId":"o1""#),
        r#"{"seq":6,"kind":"session_dead","at":"x","sessionId":"s-new"}"#.to_owned(),
        submit(7, "M", Some("s-new")),
        on(8, "cancel", "GONE", r#","orderId":"o1""#),
    ];
    let mut books = Recording::default();
    books.markets.insert("M".to_owned());
    replay_from(
        2,
        &["s-old".to_owned(), String::new()],
        &tape(&lines),
        &mut books,
    )
    .unwrap();
    assert_eq!(
        books.log,
        [
            "cancel(requested) M 4",
            "cancel(requested) M 5",
            r#"session_dead "s-new""#
        ]
    );
}

#[test]
fn a_record_with_no_text_market_id_refuses_the_replay() {
    let lines = [r#"{"seq":1,"kind":"submit","marketId":5,"at":"x","order":{}}"#.to_owned()];
    let err = replay_journal(&tape(&lines), &mut Recording::default()).unwrap_err();
    assert_eq!(err.seq, Some(1));
    assert_eq!(err.kind, "submit");
}

#[test]
fn the_journal_clock_reads_the_time_as_date_parse_does() {
    assert_eq!(journal_clock(Some(&Json::str(T0))), Some(1_788_386_400_000));
    assert_eq!(journal_clock(Some(&Json::str("not a time"))), None);
    assert_eq!(journal_clock(None), None);
}

#[test]
fn a_snapshot_is_one_value_for_one_state_and_goes_to_the_sink_on_its_cadence() {
    let snap = EngineSnapshot::of(
        vec![
            ("b".to_owned(), 2),
            ("\u{e9}".to_owned(), 3),
            ("B".to_owned(), 1),
        ],
        12,
        ["s2", "", "s1", "s2"].map(str::to_owned),
    );
    assert_eq!(snap.books, [1, 2, 3]);
    assert_eq!(snap.dead_sessions, ["s1", "s2"]);
    assert_eq!(
        snap.to_json(|n| Json::int(*n)).compact(),
        r#"{"journalSeq":12,"books":[1,2,3],"deadSessions":["s1","s2"]}"#
    );
    let mut sink = MemorySnapshotSink::default();
    assert!(sink.latest.is_none());
    sink.write(snap.clone());
    assert_eq!(sink.latest, Some(snap));

    assert!(snapshot_due(10, 5));
    assert!(!snapshot_due(11, 5));
    assert!(!snapshot_due(10, 0));
}
