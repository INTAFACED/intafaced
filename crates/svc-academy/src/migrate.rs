//! `svc-academy migrate [--down]` (the TypeScript service's `scripts/migrate.ts`): applies every `*.sql` in
//! `crates/svc-academy/migrations` (the same files, by the same names, as `services/svc-academy/drizzle`) in name
//! order, tracked in `academy.__migrations`, each file once; `--down` reverses them. The `academy` schema comes from
//! the database bootstrap. The files are built into the binary; the runner is the kit's (`service_kit::migrate`).

use std::io::Write;

use service_kit::migrate::Migrations;

/// Every migration file, by name, as built into the binary.
pub const FILES: [(&str, &str); 110] = [
    (
        "0000_academy_init.down.sql",
        include_str!("../migrations/0000_academy_init.down.sql"),
    ),
    (
        "0000_academy_init.sql",
        include_str!("../migrations/0000_academy_init.sql"),
    ),
    (
        "0001_ambassadors.down.sql",
        include_str!("../migrations/0001_ambassadors.down.sql"),
    ),
    (
        "0001_ambassadors.sql",
        include_str!("../migrations/0001_ambassadors.sql"),
    ),
    (
        "0002_tournaments.down.sql",
        include_str!("../migrations/0002_tournaments.down.sql"),
    ),
    (
        "0002_tournaments.sql",
        include_str!("../migrations/0002_tournaments.sql"),
    ),
    (
        "0003_residencies.down.sql",
        include_str!("../migrations/0003_residencies.down.sql"),
    ),
    (
        "0003_residencies.sql",
        include_str!("../migrations/0003_residencies.sql"),
    ),
    (
        "0004_certs.down.sql",
        include_str!("../migrations/0004_certs.down.sql"),
    ),
    (
        "0004_certs.sql",
        include_str!("../migrations/0004_certs.sql"),
    ),
    (
        "0005_freeze_snapshot.down.sql",
        include_str!("../migrations/0005_freeze_snapshot.down.sql"),
    ),
    (
        "0005_freeze_snapshot.sql",
        include_str!("../migrations/0005_freeze_snapshot.sql"),
    ),
    (
        "0006_cert_enrollment_leave.down.sql",
        include_str!("../migrations/0006_cert_enrollment_leave.down.sql"),
    ),
    (
        "0006_cert_enrollment_leave.sql",
        include_str!("../migrations/0006_cert_enrollment_leave.sql"),
    ),
    (
        "0007_learning_state.down.sql",
        include_str!("../migrations/0007_learning_state.down.sql"),
    ),
    (
        "0007_learning_state.sql",
        include_str!("../migrations/0007_learning_state.sql"),
    ),
    (
        "0008_video_progress.down.sql",
        include_str!("../migrations/0008_video_progress.down.sql"),
    ),
    (
        "0008_video_progress.sql",
        include_str!("../migrations/0008_video_progress.sql"),
    ),
    (
        "0009_residency_cohorts.down.sql",
        include_str!("../migrations/0009_residency_cohorts.down.sql"),
    ),
    (
        "0009_residency_cohorts.sql",
        include_str!("../migrations/0009_residency_cohorts.sql"),
    ),
    (
        "0010_assessment_attempts.down.sql",
        include_str!("../migrations/0010_assessment_attempts.down.sql"),
    ),
    (
        "0010_assessment_attempts.sql",
        include_str!("../migrations/0010_assessment_attempts.sql"),
    ),
    (
        "0011_cert_grant_public_id.down.sql",
        include_str!("../migrations/0011_cert_grant_public_id.down.sql"),
    ),
    (
        "0011_cert_grant_public_id.sql",
        include_str!("../migrations/0011_cert_grant_public_id.sql"),
    ),
    (
        "0012_item_release.down.sql",
        include_str!("../migrations/0012_item_release.down.sql"),
    ),
    (
        "0012_item_release.sql",
        include_str!("../migrations/0012_item_release.sql"),
    ),
    (
        "0013_featured_item.down.sql",
        include_str!("../migrations/0013_featured_item.down.sql"),
    ),
    (
        "0013_featured_item.sql",
        include_str!("../migrations/0013_featured_item.sql"),
    ),
    (
        "0014_course_start.down.sql",
        include_str!("../migrations/0014_course_start.down.sql"),
    ),
    (
        "0014_course_start.sql",
        include_str!("../migrations/0014_course_start.sql"),
    ),
    (
        "0015_completion_events.down.sql",
        include_str!("../migrations/0015_completion_events.down.sql"),
    ),
    (
        "0015_completion_events.sql",
        include_str!("../migrations/0015_completion_events.sql"),
    ),
    (
        "0016_quizzes.down.sql",
        include_str!("../migrations/0016_quizzes.down.sql"),
    ),
    (
        "0016_quizzes.sql",
        include_str!("../migrations/0016_quizzes.sql"),
    ),
    (
        "0017_progress_planner.down.sql",
        include_str!("../migrations/0017_progress_planner.down.sql"),
    ),
    (
        "0017_progress_planner.sql",
        include_str!("../migrations/0017_progress_planner.sql"),
    ),
    (
        "0018_item_videos.down.sql",
        include_str!("../migrations/0018_item_videos.down.sql"),
    ),
    (
        "0018_item_videos.sql",
        include_str!("../migrations/0018_item_videos.sql"),
    ),
    (
        "0019_courses.down.sql",
        include_str!("../migrations/0019_courses.down.sql"),
    ),
    (
        "0019_courses.sql",
        include_str!("../migrations/0019_courses.sql"),
    ),
    (
        "0020_course_outline.down.sql",
        include_str!("../migrations/0020_course_outline.down.sql"),
    ),
    (
        "0020_course_outline.sql",
        include_str!("../migrations/0020_course_outline.sql"),
    ),
    (
        "0021_lesson_revisions.down.sql",
        include_str!("../migrations/0021_lesson_revisions.down.sql"),
    ),
    (
        "0021_lesson_revisions.sql",
        include_str!("../migrations/0021_lesson_revisions.sql"),
    ),
    (
        "0022_lesson_drafts.down.sql",
        include_str!("../migrations/0022_lesson_drafts.down.sql"),
    ),
    (
        "0022_lesson_drafts.sql",
        include_str!("../migrations/0022_lesson_drafts.sql"),
    ),
    (
        "0023_course_media.down.sql",
        include_str!("../migrations/0023_course_media.down.sql"),
    ),
    (
        "0023_course_media.sql",
        include_str!("../migrations/0023_course_media.sql"),
    ),
    (
        "0024_learn_hub.down.sql",
        include_str!("../migrations/0024_learn_hub.down.sql"),
    ),
    (
        "0024_learn_hub.sql",
        include_str!("../migrations/0024_learn_hub.sql"),
    ),
    (
        "0025_course_private_links.down.sql",
        include_str!("../migrations/0025_course_private_links.down.sql"),
    ),
    (
        "0025_course_private_links.sql",
        include_str!("../migrations/0025_course_private_links.sql"),
    ),
    (
        "0026_course_enrolments.down.sql",
        include_str!("../migrations/0026_course_enrolments.down.sql"),
    ),
    (
        "0026_course_enrolments.sql",
        include_str!("../migrations/0026_course_enrolments.sql"),
    ),
    (
        "20261024071500_course_assignments.down.sql",
        include_str!("../migrations/20261024071500_course_assignments.down.sql"),
    ),
    (
        "20261024071500_course_assignments.sql",
        include_str!("../migrations/20261024071500_course_assignments.sql"),
    ),
    (
        "20261024082338_assignment_peer_review.down.sql",
        include_str!("../migrations/20261024082338_assignment_peer_review.down.sql"),
    ),
    (
        "20261024082338_assignment_peer_review.sql",
        include_str!("../migrations/20261024082338_assignment_peer_review.sql"),
    ),
    (
        "20261024092059_assignment_grading.down.sql",
        include_str!("../migrations/20261024092059_assignment_grading.down.sql"),
    ),
    (
        "20261024092059_assignment_grading.sql",
        include_str!("../migrations/20261024092059_assignment_grading.sql"),
    ),
    (
        "20261024131123_certificate_issue_rules.down.sql",
        include_str!("../migrations/20261024131123_certificate_issue_rules.down.sql"),
    ),
    (
        "20261024131123_certificate_issue_rules.sql",
        include_str!("../migrations/20261024131123_certificate_issue_rules.sql"),
    ),
    (
        "20261024141500_certificate_revocations.down.sql",
        include_str!("../migrations/20261024141500_certificate_revocations.down.sql"),
    ),
    (
        "20261024141500_certificate_revocations.sql",
        include_str!("../migrations/20261024141500_certificate_revocations.sql"),
    ),
    (
        "20261024164302_learning_programmes.down.sql",
        include_str!("../migrations/20261024164302_learning_programmes.down.sql"),
    ),
    (
        "20261024164302_learning_programmes.sql",
        include_str!("../migrations/20261024164302_learning_programmes.sql"),
    ),
    (
        "20261024193000_course_discussion.down.sql",
        include_str!("../migrations/20261024193000_course_discussion.down.sql"),
    ),
    (
        "20261024193000_course_discussion.sql",
        include_str!("../migrations/20261024193000_course_discussion.sql"),
    ),
    (
        "20261024203000_course_messages.down.sql",
        include_str!("../migrations/20261024203000_course_messages.down.sql"),
    ),
    (
        "20261024203000_course_messages.sql",
        include_str!("../migrations/20261024203000_course_messages.sql"),
    ),
    (
        "20261024230349_course_quizzes.down.sql",
        include_str!("../migrations/20261024230349_course_quizzes.down.sql"),
    ),
    (
        "20261024230349_course_quizzes.sql",
        include_str!("../migrations/20261024230349_course_quizzes.sql"),
    ),
    (
        "20261024233902_course_quiz_kinds.down.sql",
        include_str!("../migrations/20261024233902_course_quiz_kinds.down.sql"),
    ),
    (
        "20261024233902_course_quiz_kinds.sql",
        include_str!("../migrations/20261024233902_course_quiz_kinds.sql"),
    ),
    (
        "20261025002915_course_release.down.sql",
        include_str!("../migrations/20261025002915_course_release.down.sql"),
    ),
    (
        "20261025002915_course_release.sql",
        include_str!("../migrations/20261025002915_course_release.sql"),
    ),
    (
        "20261025010412_course_item_rules.down.sql",
        include_str!("../migrations/20261025010412_course_item_rules.down.sql"),
    ),
    (
        "20261025010412_course_item_rules.sql",
        include_str!("../migrations/20261025010412_course_item_rules.sql"),
    ),
    (
        "20261025013318_course_gradebook.down.sql",
        include_str!("../migrations/20261025013318_course_gradebook.down.sql"),
    ),
    (
        "20261025013318_course_gradebook.sql",
        include_str!("../migrations/20261025013318_course_gradebook.sql"),
    ),
    (
        "20261027064319_grade_reports.down.sql",
        include_str!("../migrations/20261027064319_grade_reports.down.sql"),
    ),
    (
        "20261027064319_grade_reports.sql",
        include_str!("../migrations/20261027064319_grade_reports.sql"),
    ),
    (
        "20261030125407_bulk_grade_files.down.sql",
        include_str!("../migrations/20261030125407_bulk_grade_files.down.sql"),
    ),
    (
        "20261030125407_bulk_grade_files.sql",
        include_str!("../migrations/20261030125407_bulk_grade_files.sql"),
    ),
    (
        "20261030135753_quiz_score_events.down.sql",
        include_str!("../migrations/20261030135753_quiz_score_events.down.sql"),
    ),
    (
        "20261030135753_quiz_score_events.sql",
        include_str!("../migrations/20261030135753_quiz_score_events.sql"),
    ),
    (
        "20261030143102_quiz_curve_events.down.sql",
        include_str!("../migrations/20261030143102_quiz_curve_events.down.sql"),
    ),
    (
        "20261030143102_quiz_curve_events.sql",
        include_str!("../migrations/20261030143102_quiz_curve_events.sql"),
    ),
    (
        "20261031044841_course_late_policies.down.sql",
        include_str!("../migrations/20261031044841_course_late_policies.down.sql"),
    ),
    (
        "20261031044841_course_late_policies.sql",
        include_str!("../migrations/20261031044841_course_late_policies.sql"),
    ),
    (
        "20261107080451_learner_desk.down.sql",
        include_str!("../migrations/20261107080451_learner_desk.down.sql"),
    ),
    (
        "20261107080451_learner_desk.sql",
        include_str!("../migrations/20261107080451_learner_desk.sql"),
    ),
    (
        "20261109140911_course_price_withdrawn.down.sql",
        include_str!("../migrations/20261109140911_course_price_withdrawn.down.sql"),
    ),
    (
        "20261109140911_course_price_withdrawn.sql",
        include_str!("../migrations/20261109140911_course_price_withdrawn.sql"),
    ),
    (
        "20261112092541_course_purchases.down.sql",
        include_str!("../migrations/20261112092541_course_purchases.down.sql"),
    ),
    (
        "20261112092541_course_purchases.sql",
        include_str!("../migrations/20261112092541_course_purchases.sql"),
    ),
    (
        "20261112094652_course_enrolment_terms.down.sql",
        include_str!("../migrations/20261112094652_course_enrolment_terms.down.sql"),
    ),
    (
        "20261112094652_course_enrolment_terms.sql",
        include_str!("../migrations/20261112094652_course_enrolment_terms.sql"),
    ),
    (
        "20261112124542_certificate_designs.down.sql",
        include_str!("../migrations/20261112124542_certificate_designs.down.sql"),
    ),
    (
        "20261112124542_certificate_designs.sql",
        include_str!("../migrations/20261112124542_certificate_designs.sql"),
    ),
    (
        "20261112125128_room_pinned_lessons.down.sql",
        include_str!("../migrations/20261112125128_room_pinned_lessons.down.sql"),
    ),
    (
        "20261112125128_room_pinned_lessons.sql",
        include_str!("../migrations/20261112125128_room_pinned_lessons.sql"),
    ),
    (
        "20261112140000_staff_enrolment.down.sql",
        include_str!("../migrations/20261112140000_staff_enrolment.down.sql"),
    ),
    (
        "20261112140000_staff_enrolment.sql",
        include_str!("../migrations/20261112140000_staff_enrolment.sql"),
    ),
    (
        "20261112150000_course_team_moderation.down.sql",
        include_str!("../migrations/20261112150000_course_team_moderation.down.sql"),
    ),
    (
        "20261112150000_course_team_moderation.sql",
        include_str!("../migrations/20261112150000_course_team_moderation.sql"),
    ),
    (
        "20261112160000_academy_report_centre.down.sql",
        include_str!("../migrations/20261112160000_academy_report_centre.down.sql"),
    ),
    (
        "20261112160000_academy_report_centre.sql",
        include_str!("../migrations/20261112160000_academy_report_centre.sql"),
    ),
    (
        "20261115120000_certificate_exceptions.down.sql",
        include_str!("../migrations/20261115120000_certificate_exceptions.down.sql"),
    ),
    (
        "20261115120000_certificate_exceptions.sql",
        include_str!("../migrations/20261115120000_certificate_exceptions.sql"),
    ),
];

/// The runner's default target when `DATABASE_URL` is unset, as the TypeScript runner's.
pub const DEFAULT_URL: &str = "postgres://svc_academy:svc_academy@localhost:5433/intafaced";

/// svc-academy's migrations, for the kit's runner.
pub const MIGRATIONS: Migrations = Migrations {
    schema: "academy",
    files: &FILES,
    default_url: DEFAULT_URL,
};

/// Runs the migrations against `url`, writing the runner's lines to `out`.
pub fn run(url: &str, down: bool, out: &mut impl Write) -> Result<(), String> {
    MIGRATIONS.run(url, down, out)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    #[test]
    fn every_up_has_its_reversal_built_in() {
        for (up, _) in MIGRATIONS.ups() {
            let down = format!("{}.down.sql", up.strip_suffix(".sql").unwrap_or(up));
            assert!(MIGRATIONS.file(&down).is_ok(), "{up} has no {down}");
        }
        assert_eq!(MIGRATIONS.ups().len() * 2, FILES.len());
    }

    fn sql_files(dir: &std::path::Path) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|x| x == "sql"))
            .map(|p| {
                let name = p.file_name().unwrap().to_string_lossy().into_owned();
                (name, std::fs::read_to_string(&p).unwrap())
            })
            .collect();
        out.sort();
        out
    }

    #[test]
    fn the_built_in_files_are_the_directory_on_disk() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let on_disk: Vec<String> = sql_files(&dir).into_iter().map(|(n, _)| n).collect();
        let mut built: Vec<String> = FILES.iter().map(|(n, _)| (*n).to_owned()).collect();
        built.sort();
        assert_eq!(
            built, on_disk,
            "a migration on disk is not in FILES (or the reverse)"
        );
    }

    /// Until the switch, the TypeScript service runs the same migrations from its own folder: the two stay the same
    /// files, byte for byte.
    #[test]
    fn the_files_are_the_typescript_services() {
        let ts = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../services/svc-academy/drizzle");
        if !ts.exists() {
            return;
        }
        let ours = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        assert_eq!(
            sql_files(&ours),
            sql_files(&ts),
            "crates/svc-academy/migrations differs from services/svc-academy/drizzle"
        );
    }
}
