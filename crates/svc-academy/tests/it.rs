//! The crate's one test binary (`autotests = false` in Cargo.toml): every other `tests/*.rs` and `tests/*/main.rs` is a
//! module here, so a test build links one binary, not one per file (intafaced#9589). Written by
//! `node tooling/scripts/rust-test-roots.mjs`; do not edit by hand. One file's tests: `--test it -- <file>::`.

#[path = "approval_hash.rs"]
mod approval_hash;
#[path = "assessment_assignments_db.rs"]
mod assessment_assignments_db;
#[path = "assessment_desk_db.rs"]
mod assessment_desk_db;
#[path = "assessment_gradebook_db.rs"]
mod assessment_gradebook_db;
#[path = "assessment_grading_db.rs"]
mod assessment_grading_db;
#[path = "assessment_legacy_db.rs"]
mod assessment_legacy_db;
#[path = "assessment_peer_db.rs"]
mod assessment_peer_db;
#[path = "assessment_pure.rs"]
mod assessment_pure;
#[path = "assessment_quizzes_db.rs"]
mod assessment_quizzes_db;
#[path = "assessment_release_db.rs"]
mod assessment_release_db;
#[path = "assessment_reports_db.rs"]
mod assessment_reports_db;
#[path = "assessment_trail_db.rs"]
mod assessment_trail_db;
#[path = "authoring_compose_pins.rs"]
mod authoring_compose_pins;
#[path = "authoring_course_item_rules.rs"]
mod authoring_course_item_rules;
#[path = "authoring_course_release.rs"]
mod authoring_course_release;
#[path = "authoring_courses.rs"]
mod authoring_courses;
#[path = "authoring_featured.rs"]
mod authoring_featured;
#[path = "authoring_learn_hub.rs"]
mod authoring_learn_hub;
#[path = "authoring_lessons.rs"]
mod authoring_lessons;
#[path = "authoring_media.rs"]
mod authoring_media;
#[path = "authoring_programmes.rs"]
mod authoring_programmes;
#[path = "authoring_release_access.rs"]
mod authoring_release_access;
#[path = "authoring_video.rs"]
mod authoring_video;
#[path = "boot.rs"]
mod boot;
#[path = "certs_db.rs"]
mod certs_db;
#[path = "certs_rules.rs"]
mod certs_rules;
#[path = "community_analytics.rs"]
mod community_analytics;
#[path = "community_analytics_router.rs"]
mod community_analytics_router;
#[path = "community_discussion.rs"]
mod community_discussion;
#[path = "community_learner_desk.rs"]
mod community_learner_desk;
#[path = "community_messages.rs"]
mod community_messages;
#[path = "community_metrics.rs"]
mod community_metrics;
#[path = "community_staff_enrolment.rs"]
mod community_staff_enrolment;
#[path = "community_team.rs"]
mod community_team;
#[path = "curriculum_golden.rs"]
mod curriculum_golden;
#[path = "curriculum_internal.rs"]
mod curriculum_internal;
#[path = "curriculum_release.rs"]
mod curriculum_release;
#[path = "curriculum_spine.rs"]
mod curriculum_spine;
#[path = "db_pg.rs"]
mod db_pg;
#[path = "env_parity.rs"]
mod env_parity;
#[path = "input_parity.rs"]
mod input_parity;
#[path = "join_cross_slice.rs"]
mod join_cross_slice;
#[path = "join_learner_desk.rs"]
mod join_learner_desk;
#[path = "join_settle.rs"]
mod join_settle;
#[path = "learner_course_learners.rs"]
mod learner_course_learners;
#[path = "learner_customer.rs"]
mod learner_customer;
#[path = "learner_desk.rs"]
mod learner_desk;
#[path = "learner_preview.rs"]
mod learner_preview;
#[path = "learner_progress.rs"]
mod learner_progress;
#[path = "learner_purchases.rs"]
mod learner_purchases;
#[path = "lobbies_parity.rs"]
mod lobbies_parity;
#[path = "lobbies_pg.rs"]
mod lobbies_pg;
#[path = "lobbies_units.rs"]
mod lobbies_units;
#[path = "procedure_records.rs"]
mod procedure_records;
#[path = "programme_ambassadors.rs"]
mod programme_ambassadors;
#[path = "programme_paper.rs"]
mod programme_paper;
#[path = "programme_paper_door.rs"]
mod programme_paper_door;
#[path = "programme_paper_guards.rs"]
mod programme_paper_guards;
#[path = "programme_support.rs"]
mod programme_support;
#[path = "programme_tournaments_freeze.rs"]
mod programme_tournaments_freeze;
#[path = "programme_tournaments_wire.rs"]
mod programme_tournaments_wire;
#[path = "serve.rs"]
mod serve;
#[path = "wire_replay.rs"]
mod wire_replay;

// The helpers the files share: `use crate::<helper>;`, never a `mod` of their own.
mod authoring_kit;
mod community_support;
mod join_support;
mod learner_courses;
mod prog_support;
mod support;

/// A `tests/*.rs` or `tests/*/main.rs` file this root does not list would never run.
#[test]
fn every_test_file_is_listed() {
    let root = include_str!("it.rs");
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let mut unlisted = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().into_string().unwrap();
        let module = if entry.path().join("main.rs").is_file() {
            Some(name.as_str())
        } else {
            name.strip_suffix(".rs").filter(|stem| *stem != "it")
        };
        if let Some(module) = module
            && !root.contains(&format!("\nmod {module};\n"))
        {
            unlisted.push(name);
        }
    }
    assert!(
        unlisted.is_empty(),
        "tests/it.rs does not list {unlisted:?}, so they never run: run `node tooling/scripts/rust-test-roots.mjs`"
    );
}
