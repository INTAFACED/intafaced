//! The owner settings register (`settings/register.ts`, AC-order-02): every class-a owner value the Academy refuses on
//! while blank, with its state (`set` / `not_set`), where it is kept, whether it is read-only and the refusal shown
//! while blank. State only: no value and no default ever leaves it. `admin.settingsStatus` answers it.

use service_kit::json::Json;
use service_kit::schema::js_trim;

/// The owner values the register reads: the loaded environment's JSON (`crate::env::AcademyEnv::json`), key for key.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings(pub Json);

impl Settings {
    /// Every value blank (the TypeScript router's default `settings = {}`).
    pub fn empty() -> Settings {
        Settings(Json::Object(Vec::new()))
    }

    fn filled(&self, key: &str) -> bool {
        matches!(self.0.get(key), Some(Json::String(s)) if !js_trim(s).is_empty())
    }

    #[allow(
        clippy::float_cmp,
        reason = "Number.isInteger: a whole number compares equal to its truncation"
    )]
    fn positive_int(&self, key: &str) -> bool {
        matches!(self.0.get(key), Some(Json::Number(n)) if n.is_finite() && n.trunc() == *n && *n >= 1.0)
    }

    fn number(&self, key: &str) -> bool {
        matches!(self.0.get(key), Some(Json::Number(_)))
    }

    fn non_empty_list(&self, key: &str) -> bool {
        matches!(self.0.get(key), Some(Json::Array(a)) if !a.is_empty())
    }
}

/// How a row's state is read from the settings.
enum Rule {
    Filled(&'static str),
    PositiveInt(&'static str),
    Number(&'static str),
    List(&'static str),
    /// Set to anything but `none`.
    Chosen(&'static str),
    All(&'static [Rule]),
    Never,
}

impl Rule {
    fn holds(&self, s: &Settings) -> bool {
        match self {
            Rule::Filled(k) => s.filled(k),
            Rule::PositiveInt(k) => s.positive_int(k),
            Rule::Number(k) => s.number(k),
            Rule::List(k) => s.non_empty_list(k),
            Rule::Chosen(k) => matches!(s.0.get(k), Some(Json::String(v)) if v != "none"),
            Rule::All(rules) => rules.iter().all(|r| r.holds(s)),
            Rule::Never => false,
        }
    }
}

#[derive(Clone, Copy)]
enum Store {
    Env,
    RefuseClosed,
}

/// `(key, state rule, store, refusal code)`, in the register's order. Refuse-closed rows are read-only.
const ROWS: [(&str, Rule, Store, Option<&str>); 41] = [
    (
        "course_payments",
        Rule::All(&[
            Rule::Filled("ACADEMY_PAYMENT_RPC_URL"),
            Rule::PositiveInt("ACADEMY_PAYMENT_CHAIN_ID"),
            Rule::Filled("ACADEMY_PAYMENT_TOKEN_ADDRESS"),
            Rule::Number("ACADEMY_PAYMENT_TOKEN_DECIMALS"),
            Rule::Filled("ACADEMY_PAYMENT_ASSET"),
            Rule::Filled("ACADEMY_PAYMENT_RECEIVER"),
            Rule::PositiveInt("ACADEMY_PAYMENT_CONFIRMATIONS"),
            Rule::Filled("LEDGER_URL"),
        ]),
        Store::Env,
        Some("academy.payments_off"),
    ),
    (
        "course_refund_signer",
        Rule::Filled("ACADEMY_REFUND_SIGNER_URL"),
        Store::Env,
        Some("academy.refund_sender_unset"),
    ),
    (
        "room_capacity",
        Rule::PositiveInt("ACADEMY_MAX_ROOM_CAPACITY"),
        Store::Env,
        Some("academy.room_capacity_unset"),
    ),
    (
        "paper_markets_limit",
        Rule::PositiveInt("ACADEMY_PAPER_MARKETS_LIMIT"),
        Store::Env,
        Some("academy.paper_markets_limit_unset"),
    ),
    (
        "paper_flag_source",
        Rule::Filled("TRADE_URL"),
        Store::Env,
        Some("academy.paper_flag_unverified"),
    ),
    (
        "live_video_provider",
        Rule::Chosen("ACADEMY_STREAM_PROVIDER"),
        Store::Env,
        Some("academy.stream_unavailable"),
    ),
    (
        "video_storage",
        Rule::All(&[
            Rule::Filled("ACADEMY_VIDEO_S3_ENDPOINT"),
            Rule::Filled("ACADEMY_VIDEO_S3_BUCKET"),
            Rule::Filled("ACADEMY_VIDEO_S3_ACCESS_KEY"),
            Rule::Filled("ACADEMY_VIDEO_S3_SECRET_KEY"),
        ]),
        Store::Env,
        Some("academy.video_storage_unconfigured"),
    ),
    (
        "video_s3_region",
        Rule::Filled("ACADEMY_VIDEO_S3_REGION"),
        Store::Env,
        Some("academy.video_s3_region_unset"),
    ),
    (
        "video_url_ttl",
        Rule::PositiveInt("ACADEMY_VIDEO_URL_TTL_SECONDS"),
        Store::Env,
        Some("academy.video_url_ttl_unset"),
    ),
    (
        "watch_threshold",
        Rule::PositiveInt("ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS"),
        Store::Env,
        Some("academy.watch_threshold_unset"),
    ),
    (
        "video_position_save",
        Rule::PositiveInt("ACADEMY_VIDEO_POSITION_SAVE_SECONDS"),
        Store::Env,
        None,
    ),
    (
        "cert_verify_rate",
        Rule::All(&[
            Rule::PositiveInt("ACADEMY_CERT_VERIFY_RATE_MAX"),
            Rule::PositiveInt("ACADEMY_CERT_VERIFY_RATE_WINDOW_SECONDS"),
        ]),
        Store::Env,
        Some("academy.verify_rate_unset"),
    ),
    (
        "ambassador_ifc_pay_law",
        Rule::Filled("ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON"),
        Store::RefuseClosed,
        Some("academy.ambassador_pay.rates_unset"),
    ),
    (
        "ambassador_revenue_share_law",
        Rule::Filled("ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON"),
        Store::RefuseClosed,
        Some("academy.ambassador_revenue_share.rates_unset"),
    ),
    (
        "section_limit",
        Rule::PositiveInt("ACADEMY_OUTLINE_MAX_SECTIONS"),
        Store::Env,
        Some("academy.outline_limits_unset"),
    ),
    (
        "item_limit",
        Rule::PositiveInt("ACADEMY_OUTLINE_MAX_ITEMS"),
        Store::Env,
        Some("academy.outline_limits_unset"),
    ),
    (
        "lesson_import_size_limit",
        Rule::PositiveInt("ACADEMY_LESSON_IMPORT_MAX_BYTES"),
        Store::Env,
        Some("academy.import_limit_unset"),
    ),
    (
        "grant_audit_page_size",
        Rule::PositiveInt("ACADEMY_GRANT_AUDIT_PAGE_SIZE"),
        Store::Env,
        Some("academy.grant_audit_list_limit_unset"),
    ),
    (
        "topics_list_limit",
        Rule::PositiveInt("ACADEMY_TOPICS_LIST_LIMIT"),
        Store::Env,
        Some("academy.topics_list_limit_unset"),
    ),
    (
        "lease_length",
        Rule::PositiveInt("ACADEMY_GRADER_LEASE_SECONDS"),
        Store::Env,
        Some("academy.grader_lease_unset"),
    ),
    (
        "grade_report_rows",
        Rule::PositiveInt("ACADEMY_GRADE_REPORT_ROWS"),
        Store::Env,
        Some("academy.report_limit_unset"),
    ),
    (
        "cert_issued_rows",
        Rule::PositiveInt("ACADEMY_CERT_ISSUED_ROWS"),
        Store::Env,
        Some("academy.report_limit_unset"),
    ),
    (
        "learner_summaries_page_size",
        Rule::PositiveInt("ACADEMY_LEARNER_SUMMARIES_PAGE_SIZE"),
        Store::Env,
        Some("academy.learner_summaries_list_limit_unset"),
    ),
    (
        "report_tasks_page_size",
        Rule::PositiveInt("ACADEMY_REPORT_TASKS_PAGE_SIZE"),
        Store::Env,
        Some("academy.report_tasks_list_limit_unset"),
    ),
    (
        "report_centre_retention",
        Rule::PositiveInt("ACADEMY_REPORT_CENTRE_RETENTION_MINUTES"),
        Store::Env,
        Some("academy.report_retention_unset"),
    ),
    (
        "report_sweep",
        Rule::PositiveInt("ACADEMY_REPORT_SWEEP_SECONDS"),
        Store::Env,
        Some("academy.report_sweep_unset"),
    ),
    (
        "bulk_file_max_bytes",
        Rule::PositiveInt("ACADEMY_BULK_FILE_MAX_BYTES"),
        Store::Env,
        Some("academy.bulk_limit_unset"),
    ),
    (
        "bulk_enrol_rows",
        Rule::PositiveInt("ACADEMY_BULK_ENROL_ROWS"),
        Store::Env,
        Some("academy.bulk_limit_unset"),
    ),
    (
        "bulk_email_inactive_days",
        Rule::PositiveInt("ACADEMY_BULK_EMAIL_INACTIVE_DAYS"),
        Store::Env,
        Some("academy.inactivity_period_unset"),
    ),
    (
        "report_retention_hours",
        Rule::PositiveInt("ACADEMY_REPORT_RETENTION_HOURS"),
        Store::Env,
        Some("academy.report_retention_unset"),
    ),
    (
        "learner_export_rows",
        Rule::PositiveInt("ACADEMY_LEARNER_EXPORT_ROWS"),
        Store::Env,
        Some("academy.report_limit_unset"),
    ),
    (
        "cert_issue_sweep",
        Rule::PositiveInt("ACADEMY_CERT_ISSUE_SWEEP_SECONDS"),
        Store::Env,
        Some("academy.cert_sweep_unset"),
    ),
    (
        "programme_max_courses",
        Rule::PositiveInt("ACADEMY_PROGRAMME_MAX_COURSES"),
        Store::Env,
        Some("academy.programme_limit_unset"),
    ),
    (
        "custom_role_limit",
        Rule::PositiveInt("ACADEMY_CUSTOM_ROLE_LIMIT"),
        Store::Env,
        Some("academy.role_limit_unset"),
    ),
    (
        "post_max_chars",
        Rule::PositiveInt("ACADEMY_POST_MAX_CHARS"),
        Store::Env,
        Some("academy.post_limit_unset"),
    ),
    (
        "post_image_max_bytes",
        Rule::PositiveInt("ACADEMY_POST_IMAGE_MAX_BYTES"),
        Store::Env,
        Some("academy.attachment_limit_unset"),
    ),
    (
        "message_max_chars",
        Rule::PositiveInt("ACADEMY_MESSAGE_MAX_CHARS"),
        Store::Env,
        Some("academy.message_limit_unset"),
    ),
    (
        "upload_size_limit",
        Rule::PositiveInt("ACADEMY_UPLOAD_MAX_BYTES"),
        Store::Env,
        Some("academy.upload_limits_unset"),
    ),
    (
        "upload_video_types",
        Rule::List("ACADEMY_UPLOAD_VIDEO_TYPES"),
        Store::Env,
        Some("academy.upload_limits_unset"),
    ),
    (
        "upload_handout_types",
        Rule::List("ACADEMY_UPLOAD_HANDOUT_TYPES"),
        Store::Env,
        Some("academy.upload_limits_unset"),
    ),
    (
        "tournament_prize_pool",
        Rule::Never,
        Store::RefuseClosed,
        Some("academy.prize_pool_unset"),
    ),
];

/// `PENDING_OWNER_SETTINGS`: owner values with no store yet; listed as not set, read-only, with no code of their own.
pub const PENDING_OWNER_SETTINGS: [&str; 9] = [
    "undelete_window",
    "dwell_seconds",
    "expiry_duration",
    "nudge_timings",
    "retention_period",
    "custom_role_count",
    "mail_recipient_limit",
    "mail_digest_limit",
    "assistant_provider",
];

fn row(key: &str, set: bool, store: &str, read_only: bool, code: Option<&str>) -> Json {
    Json::obj([
        ("key", Json::str(key)),
        ("state", Json::str(if set { "set" } else { "not_set" })),
        ("store", Json::str(store)),
        ("readOnly", Json::Bool(read_only)),
        ("refusalCode", code.map_or(Json::Null, Json::str)),
    ])
}

/// `settingsRegister(env)`.
pub fn register(settings: &Settings) -> Vec<Json> {
    let mut rows: Vec<Json> = ROWS
        .iter()
        .map(|(key, rule, store, code)| {
            let (store, read_only) = match store {
                Store::Env => ("env", false),
                Store::RefuseClosed => ("refuse_closed", true),
            };
            row(key, rule.holds(settings), store, read_only, *code)
        })
        .collect();
    rows.extend(
        PENDING_OWNER_SETTINGS
            .iter()
            .map(|key| row(key, false, "pending", true, None)),
    );
    rows
}

/// `admin.settingsStatus`'s answer: `{ rows }`.
pub fn status(settings: &Settings) -> Json {
    Json::obj([("rows", Json::Array(register(settings)))])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_register_sets_nothing_and_shows_no_value() {
        let rows = register(&Settings::empty());
        assert_eq!(rows.len(), 50);
        assert!(
            rows.iter()
                .all(|r| r.get("state") == Some(&Json::str("not_set")))
        );
    }

    #[test]
    fn a_positive_whole_number_sets_its_row_and_none_is_not_chosen() {
        let s = Settings(Json::obj([
            ("ACADEMY_MAX_ROOM_CAPACITY", Json::int(12)),
            ("ACADEMY_STREAM_PROVIDER", Json::str("none")),
            ("ACADEMY_REFUND_SIGNER_URL", Json::str("  ")),
        ]));
        let state = |key: &str| {
            register(&s)
                .into_iter()
                .find(|r| r.get("key") == Some(&Json::str(key)))
                .and_then(|r| r.get("state").cloned())
        };
        assert_eq!(state("room_capacity"), Some(Json::str("set")));
        assert_eq!(state("live_video_provider"), Some(Json::str("not_set")));
        assert_eq!(state("course_refund_signer"), Some(Json::str("not_set")));
    }
}
