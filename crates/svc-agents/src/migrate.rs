//! `svc-agents migrate [--down]` (`services/svc-agents/scripts/migrate.ts`): applies every `*.sql` in
//! `crates/svc-agents/migrations` (the TypeScript service's `drizzle` files, byte for byte, by the same names) in name
//! order, tracked in `agents.__migrations`, each file once; `--down` reverses them in reverse order. The `agents` schema
//! comes from the database bootstrap. The files are built into the binary. The runner is the kit's
//! (`service_kit::migrate`): the TypeScript runner's lines, and each file committed with its record under one lock.

use std::io::Write;

use service_kit::migrate::Migrations;

/// Every migration file, by name, as built into the binary.
pub const FILES: [(&str, &str); 86] = [
    (
        "0000_agents_init.down.sql",
        include_str!("../migrations/0000_agents_init.down.sql"),
    ),
    (
        "0000_agents_init.sql",
        include_str!("../migrations/0000_agents_init.sql"),
    ),
    (
        "0001_place_intents.down.sql",
        include_str!("../migrations/0001_place_intents.down.sql"),
    ),
    (
        "0001_place_intents.sql",
        include_str!("../migrations/0001_place_intents.sql"),
    ),
    (
        "0001_usage_sealed_recheck.down.sql",
        include_str!("../migrations/0001_usage_sealed_recheck.down.sql"),
    ),
    (
        "0001_usage_sealed_recheck.sql",
        include_str!("../migrations/0001_usage_sealed_recheck.sql"),
    ),
    (
        "0002_catalogue_charged_asset.down.sql",
        include_str!("../migrations/0002_catalogue_charged_asset.down.sql"),
    ),
    (
        "0002_catalogue_charged_asset.sql",
        include_str!("../migrations/0002_catalogue_charged_asset.sql"),
    ),
    (
        "0002_think_claims.down.sql",
        include_str!("../migrations/0002_think_claims.down.sql"),
    ),
    (
        "0002_think_claims.sql",
        include_str!("../migrations/0002_think_claims.sql"),
    ),
    (
        "0003_place_claim.down.sql",
        include_str!("../migrations/0003_place_claim.down.sql"),
    ),
    (
        "0003_place_claim.sql",
        include_str!("../migrations/0003_place_claim.sql"),
    ),
    (
        "0004_user_spend_limits.down.sql",
        include_str!("../migrations/0004_user_spend_limits.down.sql"),
    ),
    (
        "0004_user_spend_limits.sql",
        include_str!("../migrations/0004_user_spend_limits.sql"),
    ),
    (
        "0005_selected_sessions.down.sql",
        include_str!("../migrations/0005_selected_sessions.down.sql"),
    ),
    (
        "0005_selected_sessions.sql",
        include_str!("../migrations/0005_selected_sessions.sql"),
    ),
    (
        "20261029164239_own_agents.down.sql",
        include_str!("../migrations/20261029164239_own_agents.down.sql"),
    ),
    (
        "20261029164239_own_agents.sql",
        include_str!("../migrations/20261029164239_own_agents.sql"),
    ),
    (
        "20261029164837_own_agent_limits.down.sql",
        include_str!("../migrations/20261029164837_own_agent_limits.down.sql"),
    ),
    (
        "20261029164837_own_agent_limits.sql",
        include_str!("../migrations/20261029164837_own_agent_limits.sql"),
    ),
    (
        "20261029204423_coach_runs.down.sql",
        include_str!("../migrations/20261029204423_coach_runs.down.sql"),
    ),
    (
        "20261029204423_coach_runs.sql",
        include_str!("../migrations/20261029204423_coach_runs.sql"),
    ),
    (
        "20261029213000_audit_log_reads.down.sql",
        include_str!("../migrations/20261029213000_audit_log_reads.down.sql"),
    ),
    (
        "20261029213000_audit_log_reads.sql",
        include_str!("../migrations/20261029213000_audit_log_reads.sql"),
    ),
    (
        "20261029213405_team_agent_roles.down.sql",
        include_str!("../migrations/20261029213405_team_agent_roles.down.sql"),
    ),
    (
        "20261029213405_team_agent_roles.sql",
        include_str!("../migrations/20261029213405_team_agent_roles.sql"),
    ),
    (
        "20261029214719_sessions_agent_runs.down.sql",
        include_str!("../migrations/20261029214719_sessions_agent_runs.down.sql"),
    ),
    (
        "20261029214719_sessions_agent_runs.sql",
        include_str!("../migrations/20261029214719_sessions_agent_runs.sql"),
    ),
    (
        "20261030024029_own_agent_usage_alerts.down.sql",
        include_str!("../migrations/20261030024029_own_agent_usage_alerts.down.sql"),
    ),
    (
        "20261030024029_own_agent_usage_alerts.sql",
        include_str!("../migrations/20261030024029_own_agent_usage_alerts.sql"),
    ),
    (
        "20261104143745_own_agent_guardrails.down.sql",
        include_str!("../migrations/20261104143745_own_agent_guardrails.down.sql"),
    ),
    (
        "20261104143745_own_agent_guardrails.sql",
        include_str!("../migrations/20261104143745_own_agent_guardrails.sql"),
    ),
    (
        "20261104153508_own_agent_evaluations.down.sql",
        include_str!("../migrations/20261104153508_own_agent_evaluations.down.sql"),
    ),
    (
        "20261104153508_own_agent_evaluations.sql",
        include_str!("../migrations/20261104153508_own_agent_evaluations.sql"),
    ),
    (
        "20261104163552_own_agent_test_runs.down.sql",
        include_str!("../migrations/20261104163552_own_agent_test_runs.down.sql"),
    ),
    (
        "20261104163552_own_agent_test_runs.sql",
        include_str!("../migrations/20261104163552_own_agent_test_runs.sql"),
    ),
    (
        "20261104172126_own_agent_test_engine_runs.down.sql",
        include_str!("../migrations/20261104172126_own_agent_test_engine_runs.down.sql"),
    ),
    (
        "20261104172126_own_agent_test_engine_runs.sql",
        include_str!("../migrations/20261104172126_own_agent_test_engine_runs.sql"),
    ),
    (
        "20261104183600_own_agent_publishing.down.sql",
        include_str!("../migrations/20261104183600_own_agent_publishing.down.sql"),
    ),
    (
        "20261104183600_own_agent_publishing.sql",
        include_str!("../migrations/20261104183600_own_agent_publishing.sql"),
    ),
    (
        "20261104185906_own_agent_session_versions.down.sql",
        include_str!("../migrations/20261104185906_own_agent_session_versions.down.sql"),
    ),
    (
        "20261104185906_own_agent_session_versions.sql",
        include_str!("../migrations/20261104185906_own_agent_session_versions.sql"),
    ),
    (
        "20261104193937_own_agent_tokens.down.sql",
        include_str!("../migrations/20261104193937_own_agent_tokens.down.sql"),
    ),
    (
        "20261104193937_own_agent_tokens.sql",
        include_str!("../migrations/20261104193937_own_agent_tokens.sql"),
    ),
    (
        "20261105161416_own_agent_inbox_index.down.sql",
        include_str!("../migrations/20261105161416_own_agent_inbox_index.down.sql"),
    ),
    (
        "20261105161416_own_agent_inbox_index.sql",
        include_str!("../migrations/20261105161416_own_agent_inbox_index.sql"),
    ),
    (
        "20261105174349_own_agent_approval_decisions.down.sql",
        include_str!("../migrations/20261105174349_own_agent_approval_decisions.down.sql"),
    ),
    (
        "20261105174349_own_agent_approval_decisions.sql",
        include_str!("../migrations/20261105174349_own_agent_approval_decisions.sql"),
    ),
    (
        "20261105224907_own_agent_approval_notices.down.sql",
        include_str!("../migrations/20261105224907_own_agent_approval_notices.down.sql"),
    ),
    (
        "20261105224907_own_agent_approval_notices.sql",
        include_str!("../migrations/20261105224907_own_agent_approval_notices.sql"),
    ),
    (
        "20261106015203_own_agent_reviewer.down.sql",
        include_str!("../migrations/20261106015203_own_agent_reviewer.down.sql"),
    ),
    (
        "20261106015203_own_agent_reviewer.sql",
        include_str!("../migrations/20261106015203_own_agent_reviewer.sql"),
    ),
    (
        "20261106100000_own_agent_test_run_guards.down.sql",
        include_str!("../migrations/20261106100000_own_agent_test_run_guards.down.sql"),
    ),
    (
        "20261106100000_own_agent_test_run_guards.sql",
        include_str!("../migrations/20261106100000_own_agent_test_run_guards.sql"),
    ),
    (
        "20261107090741_agent_fleet_control.down.sql",
        include_str!("../migrations/20261107090741_agent_fleet_control.down.sql"),
    ),
    (
        "20261107090741_agent_fleet_control.sql",
        include_str!("../migrations/20261107090741_agent_fleet_control.sql"),
    ),
    (
        "20261108193804_own_agent_policy_rules.down.sql",
        include_str!("../migrations/20261108193804_own_agent_policy_rules.down.sql"),
    ),
    (
        "20261108193804_own_agent_policy_rules.sql",
        include_str!("../migrations/20261108193804_own_agent_policy_rules.sql"),
    ),
    (
        "20261108205922_own_agent_payment_methods.down.sql",
        include_str!("../migrations/20261108205922_own_agent_payment_methods.down.sql"),
    ),
    (
        "20261108205922_own_agent_payment_methods.sql",
        include_str!("../migrations/20261108205922_own_agent_payment_methods.sql"),
    ),
    (
        "20261110022953_navigator_onchain.down.sql",
        include_str!("../migrations/20261110022953_navigator_onchain.down.sql"),
    ),
    (
        "20261110022953_navigator_onchain.sql",
        include_str!("../migrations/20261110022953_navigator_onchain.sql"),
    ),
    (
        "20261110182103_navigator_orders.down.sql",
        include_str!("../migrations/20261110182103_navigator_orders.down.sql"),
    ),
    (
        "20261110182103_navigator_orders.sql",
        include_str!("../migrations/20261110182103_navigator_orders.sql"),
    ),
    (
        "20261111122144_own_agent_account_access.down.sql",
        include_str!("../migrations/20261111122144_own_agent_account_access.down.sql"),
    ),
    (
        "20261111122144_own_agent_account_access.sql",
        include_str!("../migrations/20261111122144_own_agent_account_access.sql"),
    ),
    (
        "20261113210533_own_agent_schedules_triggers.down.sql",
        include_str!("../migrations/20261113210533_own_agent_schedules_triggers.down.sql"),
    ),
    (
        "20261113210533_own_agent_schedules_triggers.sql",
        include_str!("../migrations/20261113210533_own_agent_schedules_triggers.sql"),
    ),
    (
        "20261113213343_own_agent_memory.down.sql",
        include_str!("../migrations/20261113213343_own_agent_memory.down.sql"),
    ),
    (
        "20261113213343_own_agent_memory.sql",
        include_str!("../migrations/20261113213343_own_agent_memory.sql"),
    ),
    (
        "20261114090000_session_background_runs.down.sql",
        include_str!("../migrations/20261114090000_session_background_runs.down.sql"),
    ),
    (
        "20261114090000_session_background_runs.sql",
        include_str!("../migrations/20261114090000_session_background_runs.sql"),
    ),
    (
        "20261114100000_agent_run_provenance.down.sql",
        include_str!("../migrations/20261114100000_agent_run_provenance.down.sql"),
    ),
    (
        "20261114100000_agent_run_provenance.sql",
        include_str!("../migrations/20261114100000_agent_run_provenance.sql"),
    ),
    (
        "20261115020000_usage_window_payment.down.sql",
        include_str!("../migrations/20261115020000_usage_window_payment.down.sql"),
    ),
    (
        "20261115020000_usage_window_payment.sql",
        include_str!("../migrations/20261115020000_usage_window_payment.sql"),
    ),
    (
        "20261115120000_usage_window_owed_by_business.down.sql",
        include_str!("../migrations/20261115120000_usage_window_owed_by_business.down.sql"),
    ),
    (
        "20261115120000_usage_window_owed_by_business.sql",
        include_str!("../migrations/20261115120000_usage_window_owed_by_business.sql"),
    ),
    (
        "20261115150000_agent_alerts_policy_overrides.down.sql",
        include_str!("../migrations/20261115150000_agent_alerts_policy_overrides.down.sql"),
    ),
    (
        "20261115150000_agent_alerts_policy_overrides.sql",
        include_str!("../migrations/20261115150000_agent_alerts_policy_overrides.sql"),
    ),
    (
        "20261115200000_agent_alert_notifications.down.sql",
        include_str!("../migrations/20261115200000_agent_alert_notifications.down.sql"),
    ),
    (
        "20261115200000_agent_alert_notifications.sql",
        include_str!("../migrations/20261115200000_agent_alert_notifications.sql"),
    ),
    (
        "20261116090000_route_changes.down.sql",
        include_str!("../migrations/20261116090000_route_changes.down.sql"),
    ),
    (
        "20261116090000_route_changes.sql",
        include_str!("../migrations/20261116090000_route_changes.sql"),
    ),
    (
        "20261117220744_self_freeze_applied.down.sql",
        include_str!("../migrations/20261117220744_self_freeze_applied.down.sql"),
    ),
    (
        "20261117220744_self_freeze_applied.sql",
        include_str!("../migrations/20261117220744_self_freeze_applied.sql"),
    ),
];

/// The runner's default target when `DATABASE_URL` is unset, as the TypeScript runner's.
pub const DEFAULT_URL: &str = "postgres://svc_agents:svc_agents@localhost:5433/intafaced";

/// svc-agents' migrations, for the kit's runner.
pub const MIGRATIONS: Migrations = Migrations {
    schema: "agents",
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
        assert_eq!(MIGRATIONS.ups().len(), 43);
        assert_eq!(MIGRATIONS.ups().len() * 2, FILES.len());
    }

    fn sql_files(dir: &std::path::Path) -> Vec<(String, Vec<u8>)> {
        let mut out: Vec<(String, Vec<u8>)> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|x| x == "sql"))
            .map(|p| {
                let name = p.file_name().unwrap().to_string_lossy().into_owned();
                (name, std::fs::read(&p).unwrap())
            })
            .collect();
        out.sort();
        out
    }

    #[test]
    fn the_built_in_files_are_the_directory_on_disk() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let on_disk: Vec<(String, Vec<u8>)> = sql_files(&dir);
        let mut built: Vec<(String, Vec<u8>)> = FILES
            .iter()
            .map(|(n, s)| ((*n).to_owned(), s.as_bytes().to_vec()))
            .collect();
        built.sort();
        assert!(built == on_disk, "FILES is not the migrations folder");
    }

    /// While the TypeScript service runs, its `drizzle` folder and this crate's `migrations` are one set of files.
    #[test]
    fn the_migrations_are_the_typescript_services_byte_for_byte() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let ts = root.join("../../services/svc-agents/drizzle");
        if !ts.exists() {
            return;
        }
        let ours = sql_files(&root.join("migrations"));
        let theirs = sql_files(&ts);
        let names = |v: &[(String, Vec<u8>)]| v.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>();
        assert_eq!(names(&ours), names(&theirs), "the same file names");
        for ((name, a), (_, b)) in ours.iter().zip(&theirs) {
            assert!(
                a == b,
                "{name} differs from services/svc-agents/drizzle/{name}"
            );
        }
    }
}
