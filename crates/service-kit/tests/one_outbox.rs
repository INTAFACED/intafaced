//! A service publishes an event only through its outbox (`service_kit::outbox`, INTAFACED/project-state#3867). A
//! service that committed and then called the bus itself lost the event whenever that call failed: svc-agents'
//! `agentUsageSettled` (intafaced#10084) was published by `m.bus.publish(...)` after the charge's commit, and a retry of
//! the window never sent it again. Written to the outbox in the change's own transaction, it is sent until the bus
//! takes it, so this test refuses, in every service crate's `src/`, a call to `.publish(` on a bus, a second `Bus`
//! trait implementation, and a publish beside the JetStream client: each names its line and the way to do it.
//!
//! Tests keep their fake buses: only `src/` is read. Each file still allowed is listed in `ALLOWED` with its reason,
//! and an entry that no longer matches anything fails too, so the list only shrinks.

use std::path::{Path, PathBuf};

/// Files that still publish by themselves, each with why. svc-ledger, svc-bank and svc-academy each built their own
/// outbox before service-kit had one; they move onto it next, in their own PRs (project-state#3867), and leave here then.
const ALLOWED: [(&str, &str); 11] = [
    (
        "svc-matching/src/engine/mod.rs",
        "the matching engine keeps no database: each event follows its command's append to the engine's journal, and a \
         restart replays the journal and announces its events again under the same keys, so the journal is its outbox",
    ),
    (
        "svc-matching/src/bus.rs",
        "the engine's JetStream publisher, the one the journal's events go out through",
    ),
    (
        "svc-ledger/src/posting/mod.rs",
        "ledger_tx_outbox's own relay, until svc-ledger moves onto service-kit's outbox",
    ),
    (
        "svc-ledger/src/freeze.rs",
        "ledger_freeze_outbox's own relay and bus, until svc-ledger moves onto service-kit's outbox",
    ),
    (
        "svc-ledger/src/reconciler.rs",
        "the reconciler's drift events, until svc-ledger moves onto service-kit's outbox",
    ),
    (
        "svc-bank/src/transfers/ports.rs",
        "svc-bank's bus, until svc-bank moves onto service-kit's outbox",
    ),
    (
        "svc-bank/src/transfers/notices.rs",
        "svc-bank's transfer notices, until svc-bank moves onto service-kit's outbox",
    ),
    (
        "svc-bank/src/loans/ports.rs",
        "svc-bank's loan events, until svc-bank moves onto service-kit's outbox",
    ),
    (
        "svc-academy/src/ports.rs",
        "svc-academy's bus, until svc-academy moves onto service-kit's outbox",
    ),
    (
        "svc-academy/src/certs/xp.rs",
        "svc-academy's certificate XP events, until svc-academy moves onto service-kit's outbox",
    ),
    (
        "svc-academy/src/community/moderation.rs",
        "svc-academy's moderation outbox relay, until svc-academy moves onto service-kit's outbox",
    ),
];

/// Every line of `text` that publishes by itself: what it does, by its 1-based line.
fn own_publishes(text: &str) -> Vec<(usize, &'static str)> {
    // Comment lines never publish; blanking them keeps every offset on its own line.
    let code: String = text
        .lines()
        .map(|l| {
            if l.trim_start().starts_with("//") {
                ""
            } else {
                l
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let line_of = |at: usize| code[..at].matches('\n').count() + 1;
    let names_jetstream = code.contains("JetStream");
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(i) = code[from..].find(".publish(") {
        let at = from + i;
        // The call's receiver: back to the start of its statement.
        let start = code[..at].rfind([';', '{', '}']).map_or(0, |s| s + 1);
        let receiver = code[start..at].to_lowercase();
        if receiver.contains("bus") {
            found.push((line_of(at), "calls the bus itself"));
        } else if names_jetstream {
            found.push((line_of(at), "publishes beside the JetStream client"));
        }
        from = at + 1;
    }
    for (n, line) in code.lines().enumerate() {
        let l = line.trim_start();
        if l.starts_with("impl") && (l.contains(" Bus for ") || l.contains("::Bus for ")) {
            found.push((n + 1, "implements a bus of its own"));
        }
    }
    found.sort_unstable();
    found.dedup_by_key(|f| f.0);
    found
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            rust_files(&path, out)?;
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
    Ok(())
}

#[test]
fn every_service_publishes_through_its_outbox() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut files = Vec::new();
    for entry in std::fs::read_dir(crates).unwrap() {
        let dir = entry.unwrap().path();
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        // service-kit holds the relay; vendor holds third-party crates kept byte for byte.
        if name != "service-kit" && name != "vendor" && dir.join("src").is_dir() {
            rust_files(&dir.join("src"), &mut files).unwrap();
        }
    }
    let mut refused = Vec::new();
    let mut allowed_used = std::collections::BTreeSet::new();
    for file in &files {
        let at = file
            .strip_prefix(crates)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let hits = own_publishes(&std::fs::read_to_string(file).unwrap());
        if hits.is_empty() {
            continue;
        }
        if ALLOWED.iter().any(|(f, _)| *f == at) {
            allowed_used.insert(at);
            continue;
        }
        for (line, what) in hits {
            refused.push(format!("crates/{at}:{line}: {what}"));
        }
    }
    assert!(
        refused.is_empty(),
        "A service publishes an event only through its outbox: write it with `Outbox::write` in the transaction of the \
         change it announces, then `Outbox::send` it after the commit; the timer's `Outbox::relay` sends whatever the \
         bus refused (crates/service-kit/src/outbox.rs; svc-agents' `db::OUTBOX` is the example). The one `Bus` trait is \
         `service_kit::outbox::Bus`.\n{}",
        refused.join("\n")
    );
    let stale: Vec<_> = ALLOWED
        .iter()
        .filter(|(f, _)| !allowed_used.contains(*f))
        .map(|(f, _)| *f)
        .collect();
    assert!(
        stale.is_empty(),
        "These files no longer publish by themselves: take them out of ALLOWED in crates/service-kit/tests/one_outbox.rs: \
         {stale:?}"
    );
}

/// Each service's outbox migration creates the table `service_kit::outbox::ddl` describes, byte for byte, so the relay's
/// queries match every service's table.
#[test]
fn each_outbox_migration_is_the_kit_table() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut seen = 0;
    for entry in std::fs::read_dir(crates).unwrap() {
        let migrations = entry.unwrap().path().join("migrations");
        let Ok(dir) = std::fs::read_dir(&migrations) else {
            continue;
        };
        for file in dir {
            let path = file.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            // `<version>_event_outbox.sql`: the kit's table, not a service's own older outbox.
            if name.split_once('_').map(|(_, rest)| rest) != Some("event_outbox.sql") {
                continue;
            }
            let sql = std::fs::read_to_string(&path).unwrap();
            let schema = sql
                .split("CREATE TABLE IF NOT EXISTS \"")
                .nth(1)
                .and_then(|rest| rest.split('"').next())
                .unwrap_or_default();
            assert!(
                sql.contains(&service_kit::outbox::ddl(schema)),
                "{} is not `service_kit::outbox::ddl(\"{schema}\")` byte for byte",
                path.display()
            );
            seen += 1;
        }
    }
    assert!(seen >= 1, "no service's migrations create an event outbox");
}

#[test]
fn reads_the_publish_that_lost_a_billed_settlement() {
    // crates/svc-agents/src/metering/settle.rs before #3867: the settlement's event, sent after the charge's commit.
    let lost = "        if result.amount > Amount::ZERO {
            let envelope = usage_settled_envelope(m, &result, &session.user_id, now)
                .map_err(|e| MeterError::Store(StoreError::new(e, None)))?;
            m.bus
                .publish(USAGE_SETTLED, &result.charge_key, &envelope)
                .map_err(|e| MeterError::Store(StoreError::new(e, None)))?;
        }";
    assert_eq!(own_publishes(lost), [(5, "calls the bus itself")]);
    assert_eq!(
        own_publishes("    x.m.bus.publish(subject, key, &env).map_err(RunError::Other)"),
        [(1, "calls the bus itself")]
    );
    assert_eq!(
        own_publishes(
            "use service_kit::nats::JetStream;\nfn f(js: &JetStream) { js.publish(s, k, b); }"
        ),
        [(2, "publishes beside the JetStream client")]
    );
    assert_eq!(
        own_publishes("impl Bus for NatsBus {\n}\nimpl crate::ports::Bus for Other {}"),
        [
            (1, "implements a bus of its own"),
            (3, "implements a bus of its own")
        ]
    );
    // A domain call named publish, and a comment, are not a bus.
    assert!(
        own_publishes("    lessons.publish(input, op, now)?;\n    // m.bus.publish(x)").is_empty()
    );
    assert!(own_publishes("    let n = OUTBOX.send(pool, m.bus.as_ref(), &key);").is_empty());
}
