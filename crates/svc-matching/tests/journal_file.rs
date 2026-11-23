//! The file journal, ported test for test from `services/svc-matching/src/engine/journal.test.ts`: a torn last line,
//! the clean rewrite at boot, a short write cut back, a rewrite that cannot finish, and the one writer lock with its
//! dead-writer recovery. The children the TypeScript starts (`journal-*-child.ts`) are this test binary run again
//! with `JOURNAL_CHILD` set, under the same `RLIMIT_FSIZE` launcher.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use service_kit::json::{self, Json};
use svc_matching::journal::{
    EngineJournal, FileJournal, JOURNAL_LOCKED, JournalCommand, JournalError, decode_all,
};

const AT: &str = "2026-01-01T00:00:00.000Z";
const PARTIAL_TAIL: &str =
    r#"{"seq":2,"kind":"cancel","marketId":"BTC/USDT","at":"x","orderId":"y"#;

fn complete_line() -> String {
    Json::obj([
        ("seq", Json::int(1)),
        ("kind", Json::str("submit")),
        ("marketId", Json::str("BTC/USDT")),
        ("at", Json::str(AT)),
        (
            "order",
            Json::obj([
                ("orderId", Json::str("00000000-0000-4000-8000-000000000001")),
                ("accountId", Json::str("a")),
                ("type", Json::str("limit")),
                ("side", Json::str("buy")),
                ("qty", Json::str("1")),
                ("price", Json::str("100")),
                ("stopPrice", Json::Null),
                ("tif", Json::str("GTC")),
            ]),
        ),
    ])
    .compact()
}

fn cancel(at: &str, order_id: &str) -> JournalCommand {
    JournalCommand(Json::obj([
        ("kind", Json::str("cancel")),
        ("marketId", Json::str("BTC/USDT")),
        ("at", Json::str(at)),
        ("orderId", Json::str(order_id)),
    ]))
}

fn temp_dir(prefix: &str) -> PathBuf {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).unwrap();
    let name: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let dir = std::env::temp_dir().join(format!("{prefix}{name}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn seqs(journal: &impl EngineJournal) -> Vec<i64> {
    journal.read().iter().map(|r| r.seq().unwrap()).collect()
}

// ── decodeAll — crash mid-write residual ─────────────────────────────────────────────────────────────────────────

#[test]
fn decode_skips_a_truncated_last_line_so_recovery_can_boot() {
    let body = format!(
        "{}\n{{\"seq\":2,\"kind\":\"cancel\",\"marketId\":\"BTC/USDT\",\"at\":\"2026-01-01T00:00:01.000Z\",\"orderId\":\"00000000-0000-4000-8000-000000000002",
        complete_line()
    );
    let records = decode_all(&body).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].seq(), Some(1));
}

#[test]
fn decode_still_loads_a_complete_journal_that_ends_with_a_newline() {
    assert_eq!(
        decode_all(&format!("{}\n", complete_line())).unwrap().len(),
        1
    );
}

#[test]
fn decode_refuses_a_corrupt_line_in_the_middle() {
    let body = format!("{{not-json}}\n{}\n", complete_line());
    assert!(matches!(
        decode_all(&body),
        Err(JournalError::Corrupt { line: 1, .. })
    ));
}

// ── FileJournal boot from a truncated file ───────────────────────────────────────────────────────────────────────

#[test]
fn opens_and_reads_past_a_partial_tail_without_dying() {
    let dir = temp_dir("matching-journal-");
    let path = dir.join("engine.ndjson");
    fs::write(&path, format!("{}\n{PARTIAL_TAIL}", complete_line())).unwrap();
    let mut journal = FileJournal::open(&path).unwrap();
    assert_eq!(journal.len(), 1);
    assert_eq!(journal.read()[0].seq(), Some(1));
    journal.close().unwrap();
}

/// A torn last line skipped by decode but left on disk would glue the next durable append onto the partial bytes, so a
/// later boot drops a real record or refuses as mid-file corruption.
#[test]
fn rewrites_a_clean_file_so_appends_after_a_truncated_boot_stay_bootable() {
    let dir = temp_dir("matching-journal-");
    let path = dir.join("engine.ndjson");
    fs::write(&path, format!("{}\n{PARTIAL_TAIL}", complete_line())).unwrap();

    let mut j1 = FileJournal::open(&path).unwrap();
    assert_eq!(j1.len(), 1);
    let appended = j1
        .append(&cancel(
            "2026-01-01T00:00:02.000Z",
            "00000000-0000-4000-8000-000000000003",
        ))
        .unwrap();
    assert_eq!(appended.seq(), Some(2));
    j1.close().unwrap();

    let raw = fs::read_to_string(&path).unwrap();
    let decoded = decode_all(&raw).unwrap();
    assert_eq!(
        decoded.iter().map(|r| r.seq().unwrap()).collect::<Vec<_>>(),
        [1, 2]
    );
    assert!(!raw.contains(PARTIAL_TAIL));

    let mut j2 = FileJournal::open(&path).unwrap();
    assert_eq!(j2.len(), 2);
    assert_eq!(seqs(&j2), [1, 2]);
    j2.close().unwrap();
}

#[test]
fn refuses_an_append_after_close_and_keeps_its_length() {
    let dir = temp_dir("matching-journal-");
    let path = dir.join("engine.ndjson");
    fs::write(&path, format!("{}\n", complete_line())).unwrap();
    let mut journal = FileJournal::open(&path).unwrap();
    journal.close().unwrap();
    let refused = journal.append(&cancel(
        "2026-01-01T00:00:03.000Z",
        "00000000-0000-4000-8000-000000000004",
    ));
    assert!(matches!(refused, Err(JournalError::Closed)));
    assert_eq!(journal.len(), 1);
}

#[test]
fn a_record_encode_refuses_is_not_written_or_admitted() {
    let dir = temp_dir("matching-journal-");
    let path = dir.join("engine.ndjson");
    let mut journal = FileJournal::open(&path).unwrap();
    let refused = journal.append(&JournalCommand(Json::obj([("kind", Json::str("fill"))])));
    assert!(matches!(refused, Err(JournalError::Encode(_))));
    assert_eq!(journal.len(), 0);
    let appended = journal.append(&cancel(AT, "o-1")).unwrap();
    assert_eq!(appended.seq(), Some(1));
    journal.close().unwrap();
    assert_eq!(
        decode_all(&fs::read_to_string(&path).unwrap())
            .unwrap()
            .len(),
        1
    );
}

// ── The RLIMIT_FSIZE children ────────────────────────────────────────────────────────────────────────────────────

const LAUNCHER: &str = "import os, resource, sys
limit = int(sys.argv[1])
soft, hard = resource.getrlimit(resource.RLIMIT_FSIZE)
resource.setrlimit(resource.RLIMIT_FSIZE, (limit, hard))
os.execv(sys.argv[2], sys.argv[2:])";

/// This test binary, run again as one child: `JOURNAL_CHILD` names which.
fn child_command(child: &str, limit: Option<u64>) -> Command {
    let exe = std::env::current_exe().unwrap();
    let mut cmd = match limit {
        Some(limit) => {
            let mut cmd = Command::new("python3");
            cmd.arg("-c").arg(LAUNCHER).arg(limit.to_string()).arg(&exe);
            cmd
        }
        None => Command::new(&exe),
    };
    cmd.args([
        // Its full name in the test binary, `journal_file::journal_child` (tests/it.rs), for `--exact`.
        concat!(module_path!(), "::journal_child")
            .split_once("::")
            .map_or("journal_child", |(_, name)| name),
        "--exact",
        "--nocapture",
        "--test-threads=1",
    ]);
    cmd.env("JOURNAL_CHILD", child);
    cmd
}

fn run_child(cmd: &mut Command) -> String {
    let out = cmd.output().unwrap();
    format!(
        "status={}\n{}{}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

fn publish(barrier: &Path, name: &str, data: &[u8]) {
    let tmp = barrier.join(format!(".tmp-{name}"));
    fs::write(&tmp, data).unwrap();
    fs::rename(&tmp, barrier.join(name)).unwrap();
}

/// The children. Run alone it does nothing; run with `JOURNAL_CHILD` it is one of the TypeScript's three children.
#[test]
fn journal_child() {
    let Ok(child) = std::env::var("JOURNAL_CHILD") else {
        return;
    };
    let path = PathBuf::from(std::env::var("JOURNAL_PATH").unwrap());
    match child.as_str() {
        // journal-short-write-child.ts: one append under the limit, and whether it was admitted.
        "short-write" => {
            let command =
                JournalCommand(json::parse(&std::env::var("JOURNAL_COMMAND").unwrap()).unwrap());
            let mut journal = FileJournal::open(&path).unwrap();
            let message = match journal.append(&command) {
                Ok(_) => "admitted".to_owned(),
                Err(e) => e.to_string(),
            };
            let status = Json::obj([
                ("message", Json::str(message)),
                ("length", Json::int(i64::try_from(journal.len()).unwrap())),
            ]);
            fs::write(std::env::var("JOURNAL_STATUS").unwrap(), status.compact()).unwrap();
            journal.close().unwrap();
        }
        // journal-rewrite-fault-child.ts: an open whose clean rewrite cannot fit under the limit.
        "rewrite-fault" => {
            let (opened, message) = match FileJournal::open(&path) {
                Ok(mut journal) => {
                    journal.close().unwrap();
                    (true, "opened".to_owned())
                }
                Err(e) => (false, e.to_string()),
            };
            let status = Json::obj([
                ("opened", Json::Bool(opened)),
                ("message", Json::str(message)),
            ]);
            fs::write(std::env::var("JOURNAL_STATUS").unwrap(), status.compact()).unwrap();
        }
        // journal-lock-recover-child.ts: one dead-lock recoverer.
        "recover" => {
            let barrier =
                PathBuf::from(std::env::var("MATCHING_JOURNAL_LOCK_RECOVER_BARRIER").unwrap());
            let pid = std::process::id();
            let attempt = (|| -> Result<(), JournalError> {
                let mut journal = FileJournal::open(&path)?;
                journal.append(&cancel(
                    "2026-01-01T00:00:02.000Z",
                    "00000000-0000-4000-8000-000000000003",
                ))?;
                let mut lock = path.as_os_str().to_owned();
                lock.push(".lock");
                publish(
                    &barrier,
                    &format!("appended-{pid}"),
                    &fs::read(PathBuf::from(lock))?,
                );
                let deadline = Instant::now() + Duration::from_secs(8);
                while !barrier.join("done").exists() {
                    assert!(Instant::now() < deadline, "timed out waiting for done");
                    sleep(Duration::from_millis(10));
                }
                journal.close()
            })();
            if let Err(e) = attempt {
                let code = e.code().unwrap_or("");
                publish(
                    &barrier,
                    &format!("failed-{pid}"),
                    format!("{code}\n{e}\n").as_bytes(),
                );
            }
        }
        other => panic!("unknown child {other}"),
    }
}

fn parse_counts(message: &str, prefix: &str) -> Option<(usize, usize)> {
    let rest = message.strip_prefix(prefix)?;
    let (wrote, rest) = rest.split_once(" of ")?;
    let (expected, _) = rest.split_once(" bytes")?;
    Some((wrote.parse().ok()?, expected.parse().ok()?))
}

fn status(path: &Path) -> Json {
    json::parse(&fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn truncates_a_short_write_back_to_the_previous_complete_prefix() {
    let dir = temp_dir("matching-journal-short-");
    let path = dir.join("engine.ndjson");
    let status_path = dir.join("status.json");
    let command = cancel(
        "2026-01-01T00:00:04.000Z",
        "00000000-0000-4000-8000-000000000005",
    );

    let mut setup = FileJournal::open(&path).unwrap();
    setup.append(&command).unwrap();
    let admitted = setup.len();
    setup.close().unwrap();
    let prefix = fs::read(&path).unwrap();

    // A new appending descriptor may write up to RLIMIT_FSIZE bytes in one call, so the limited line has to be longer
    // than that cap, and the cap still has to fit the prefix's rewrite, the lock file and the status file.
    let long = cancel(
        &format!("2026-01-01T00:00:04.000Z{}", "x".repeat(2000)),
        "00000000-0000-4000-8000-000000000005",
    );
    let probe_path = dir.join("probe.ndjson");
    let mut probe = FileJournal::open(&probe_path).unwrap();
    probe.append(&long).unwrap();
    let long_len = fs::metadata(&probe_path).unwrap().len();
    probe.close().unwrap();
    let limit = long_len / 2;
    assert!(limit > u64::try_from(prefix.len()).unwrap());
    assert!(limit < long_len);

    let output = run_child(
        child_command("short-write", Some(limit))
            .env("JOURNAL_PATH", &path)
            .env("JOURNAL_STATUS", &status_path)
            .env("JOURNAL_COMMAND", long.0.compact()),
    );
    assert!(status_path.exists(), "{output}");
    let status = status(&status_path);
    let Some(Json::String(message)) = status.get("message") else {
        panic!("{output}")
    };
    let (wrote, expected) = parse_counts(message, "short journal write: wrote ")
        .unwrap_or_else(|| panic!("{message}\n{output}"));
    assert!(wrote > 0);
    assert!(wrote < expected);
    assert_eq!(
        status.get("length"),
        Some(&Json::int(i64::try_from(admitted).unwrap()))
    );
    assert_eq!(fs::read(&path).unwrap(), prefix);

    let mut journal = FileJournal::open(&path).unwrap();
    assert_eq!(journal.len(), admitted);
    let appended = journal.append(&long).unwrap();
    assert_eq!(appended.seq(), Some(i64::try_from(admitted + 1).unwrap()));
    let raw = fs::read(&path).unwrap();
    assert_eq!(&raw[..prefix.len()], &prefix[..]);
    let added = String::from_utf8(raw[prefix.len()..].to_vec()).unwrap();
    assert!(added.ends_with('\n'));
    assert!(!added[..added.len() - 1].contains('\n'));
    assert_eq!(
        json::parse(&added[..added.len() - 1]).unwrap().get("seq"),
        Some(&Json::int(i64::try_from(admitted + 1).unwrap()))
    );
    let raw = String::from_utf8(raw).unwrap();
    let lines: Vec<&str> = raw.split('\n').filter(|l| !l.is_empty()).collect();
    assert_eq!(lines.len(), admitted + 1);
    assert!(lines.iter().all(|l| json::parse(l).is_ok()));
    assert_eq!(
        decode_all(&raw)
            .unwrap()
            .iter()
            .map(|r| r.seq().unwrap())
            .collect::<Vec<_>>(),
        (1..=i64::try_from(admitted + 1).unwrap()).collect::<Vec<_>>()
    );
    journal.close().unwrap();
}

#[test]
fn leaves_the_live_journal_untouched_when_the_replacement_write_is_not_durable() {
    use std::os::unix::fs::MetadataExt as _;
    let dir = temp_dir("matching-journal-rewrite-");
    let path = dir.join("engine.ndjson");
    let status_path = dir.join("status.json");
    let command = cancel(
        &format!("2026-01-01T00:00:05.000Z{}", "x".repeat(4000)),
        "00000000-0000-4000-8000-000000000006",
    );

    let mut setup = FileJournal::open(&path).unwrap();
    setup.append(&command).unwrap();
    let admitted = setup.len();
    setup.close().unwrap();
    let original = fs::read(&path).unwrap();
    let before = fs::metadata(&path).unwrap();
    let limit = 1024;
    assert!(original.len() > 1024);

    let output = run_child(
        child_command("rewrite-fault", Some(limit))
            .env("JOURNAL_PATH", &path)
            .env("JOURNAL_STATUS", &status_path),
    );
    assert!(status_path.exists(), "{output}");
    let status = status(&status_path);
    let Some(Json::String(message)) = status.get("message") else {
        panic!("{output}")
    };
    let (wrote, expected) = parse_counts(message, "short journal rewrite: wrote ")
        .unwrap_or_else(|| panic!("{message}\n{output}"));
    assert!(wrote > 0);
    assert!(wrote < expected);
    assert_eq!(status.get("opened"), Some(&Json::Bool(false)));

    let after = fs::metadata(&path).unwrap();
    assert_eq!(after.dev(), before.dev());
    assert_eq!(after.ino(), before.ino());
    assert_eq!(fs::read(&path).unwrap(), original);

    let mut journal = FileJournal::open(&path).unwrap();
    assert_eq!(journal.len(), admitted);
    let first = &journal.read()[0];
    for key in ["kind", "marketId", "at", "orderId"] {
        assert_eq!(first.field(key), command.0.get(key));
    }
    journal.close().unwrap();
}

// ── FileJournal exclusive writer lock ────────────────────────────────────────────────────────────────────────────

fn lock_of(path: &Path) -> PathBuf {
    let mut lock = path.as_os_str().to_owned();
    lock.push(".lock");
    PathBuf::from(lock)
}

#[test]
fn refuses_a_second_open_with_journal_locked_and_still_appends_and_fsyncs_on_the_holder() {
    let dir = temp_dir("matching-journal-lock-");
    let path = dir.join("engine.ndjson");

    let mut holder = FileJournal::open(&path).unwrap();
    let second = FileJournal::open(&path).unwrap_err();
    assert_eq!(second.code(), Some(JOURNAL_LOCKED));
    assert!(matches!(&second, JournalError::Locked { path: p } if p == &path));
    assert_eq!(
        second.to_string(),
        format!(
            "journal already has an exclusive writer: {}",
            path.display()
        )
    );

    let appended = holder
        .append(&cancel(
            "2026-01-01T00:00:02.000Z",
            "00000000-0000-4000-8000-000000000003",
        ))
        .unwrap();
    assert_eq!(appended.seq(), Some(1));
    holder.close().unwrap();

    assert_eq!(
        decode_all(&fs::read_to_string(&path).unwrap())
            .unwrap()
            .len(),
        1
    );
    assert!(!lock_of(&path).exists());

    let mut next = FileJournal::open(&path).unwrap();
    assert_eq!(next.len(), 1);
    assert_eq!(next.read()[0].seq(), Some(1));
    next.close().unwrap();
}

#[test]
fn takes_a_lock_whose_pid_is_this_process_but_whose_nonce_this_process_did_not_write() {
    let dir = temp_dir("matching-journal-reuse-");
    let path = dir.join("engine.ndjson");
    fs::write(&path, "").unwrap();
    fs::write(
        lock_of(&path),
        format!("{}\nnot-ours\n", std::process::id()),
    )
    .unwrap();

    let mut journal = FileJournal::open(&path).unwrap();
    assert_eq!(journal.len(), 0);
    journal.close().unwrap();
    assert!(!lock_of(&path).exists());
}

#[test]
fn releases_only_the_lock_nonce_this_process_still_holds() {
    let dir = temp_dir("matching-journal-release-");
    let path = dir.join("engine.ndjson");
    let mut journal = FileJournal::open(&path).unwrap();
    let replacement = format!("{}\nreplacement-nonce\n", std::process::id());
    fs::write(lock_of(&path), &replacement).unwrap();
    journal.close().unwrap();
    assert_eq!(fs::read_to_string(lock_of(&path)).unwrap(), replacement);
}

#[test]
fn a_live_writer_of_another_process_is_never_stolen() {
    let dir = temp_dir("matching-journal-live-");
    let path = dir.join("engine.ndjson");
    // pid 1 is always live and never this test.
    let lock = "1\nsomeone-elses\n";
    fs::write(lock_of(&path), lock).unwrap();
    let refused = FileJournal::open(&path).unwrap_err();
    assert_eq!(refused.code(), Some(JOURNAL_LOCKED));
    assert_eq!(fs::read_to_string(lock_of(&path)).unwrap(), lock);
}

fn dead_pid() -> i32 {
    for pid in 1_000_000..1_000_020 {
        let pid = rustix::process::Pid::from_raw(pid).unwrap();
        if rustix::process::test_kill_process(pid) == Err(rustix::io::Errno::SRCH) {
            return pid.as_raw_nonzero().get();
        }
    }
    panic!("could not find a dead pid");
}

fn wait_for(what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while !ready() {
        assert!(Instant::now() < deadline, "timeout waiting for {what}");
        sleep(Duration::from_millis(15));
    }
}

fn start_recoverer(path: &Path, barrier: &Path) -> Child {
    child_command("recover", None)
        .env("JOURNAL_PATH", path)
        .env("MATCHING_JOURNAL_LOCK_RECOVER_BARRIER", barrier)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

#[test]
fn does_not_let_a_slower_dead_lock_recoverer_unlink_the_winner_or_append() {
    let dir = temp_dir("matching-journal-recover-");
    let path = dir.join("engine.ndjson");
    let barrier = dir.join("barrier");
    fs::create_dir(&barrier).unwrap();
    fs::write(&path, "").unwrap();
    fs::write(lock_of(&path), format!("{}\ndead-nonce\n", dead_pid())).unwrap();

    let mut winner = start_recoverer(&path, &barrier);
    let mut slower = start_recoverer(&path, &barrier);
    let (w, s) = (winner.id(), slower.id());

    let result = std::panic::catch_unwind(|| {
        wait_for("both recoverers to observe the dead lock", || {
            barrier.join(format!("seen-{w}")).exists() && barrier.join(format!("seen-{s}")).exists()
        });
        fs::write(barrier.join(format!("release-{w}")), "1").unwrap();
        wait_for("winner to append", || {
            barrier.join(format!("appended-{w}")).exists()
        });
        let winner_lock = fs::read_to_string(barrier.join(format!("appended-{w}"))).unwrap();

        fs::write(barrier.join(format!("release-{s}")), "1").unwrap();
        wait_for("slower recoverer to finish", || {
            barrier.join(format!("failed-{s}")).exists()
                || barrier.join(format!("appended-{s}")).exists()
        });

        let appended: Vec<String> = fs::read_dir(&barrier)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("appended-"))
            .collect();
        assert_eq!(appended, [format!("appended-{w}")]);
        assert_eq!(fs::read_to_string(lock_of(&path)).unwrap(), winner_lock);
        assert!(
            fs::read_to_string(barrier.join(format!("failed-{s}")))
                .unwrap()
                .contains(JOURNAL_LOCKED)
        );
        assert_eq!(
            decode_all(&fs::read_to_string(&path).unwrap())
                .unwrap()
                .len(),
            1
        );
    });

    fs::write(barrier.join("done"), "1").unwrap();
    fs::write(barrier.join(format!("release-{w}")), "1").unwrap();
    fs::write(barrier.join(format!("release-{s}")), "1").unwrap();
    for child in [&mut winner, &mut slower] {
        let deadline = Instant::now() + Duration::from_secs(2);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            sleep(Duration::from_millis(15));
        }
    }
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}
