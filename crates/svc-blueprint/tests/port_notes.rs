//! `PORT.md`'s `## Slices` against the door: each line names a slice the door knows, and lists in backticks exactly
//! the calls `door::Slice::of` gives it; every record but the door's own is listed once. So the notes a slice's thread
//! starts from and the replay's owed counts never disagree.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::{BTreeMap, BTreeSet};

use svc_blueprint::door::{self, Slice};

const PORT: &str = include_str!("../PORT.md");

#[test]
fn the_port_notes_slices_are_the_doors() {
    let section = PORT
        .split("\n## Slices")
        .nth(1)
        .unwrap()
        .split("\n## ")
        .next()
        .unwrap();
    let mut listed: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for line in section.lines().filter(|l| l.starts_with("- `")) {
        let (head, calls) = line
            .split_once("):")
            .or_else(|| line.split_once("`:"))
            .unwrap();
        let name = head
            .trim_start_matches("- `")
            .split('`')
            .next()
            .unwrap()
            .to_owned();
        let calls: BTreeSet<String> = calls
            .split('`')
            .skip(1)
            .step_by(2)
            .map(str::to_owned)
            .collect();
        assert!(
            listed.insert(name.clone(), calls).is_none(),
            "{name} is listed twice"
        );
    }
    let mut want: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for c in door::calls().unwrap() {
        if c.slice != Slice::Door {
            want.entry(c.slice.name().to_owned())
                .or_default()
                .insert(c.path.clone());
        }
    }
    assert_eq!(
        listed, want,
        "PORT.md's slices are not the door's (door::Slice::of)"
    );
    let names: BTreeSet<&str> = Slice::ALL
        .iter()
        .filter(|s| **s != Slice::Door)
        .map(|s| s.name())
        .collect();
    assert_eq!(
        names,
        want.keys().map(String::as_str).collect(),
        "a slice owns no call"
    );
}
