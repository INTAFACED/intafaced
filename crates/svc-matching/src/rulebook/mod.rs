//! The published rulebook (`rulebook.ts`): owner-authored text in seven fixed sections, journalled by the engine as
//! `rulebook_version` records through a two-person publish. Nothing here ships default text: with no version in force
//! the rulebook is unpublished. A version is append-only: once published it never changes, and a change is a new
//! version. The journal is the only source of the public rulebook.
//!
//! What `rulebook.ts` holds besides, and this does not: `readRulebook`, `presentRulebook`, `bestExecutionClaim` and
//! `certifiedVenueClaim`, which nothing calls.

pub mod refuse;

use service_kit::json::Json;
use service_kit::s2s::js_length;
use service_kit::schema::{Value, js_trim};
use service_kit::time::{Instant, v8_date_parse};
use sha2::{Digest, Sha256};

use crate::book::types::Reject;
use crate::errors::user_copy;

pub const RULEBOOK_UNPUBLISHED: &str = "matching.rulebook_unpublished";
pub const RULEBOOK_SECTION_UNSET: &str = "matching.rulebook_section_unset";
pub const RULEBOOK_IMMUTABLE: &str = "matching.rulebook_immutable";
pub const RULEBOOK_VERSION_UNSET: &str = "matching.rulebook_version_unset";
pub const RULEBOOK_EFFECTIVE_INVALID: &str = "matching.rulebook_effective_invalid";
/// The action a publish's approval is for.
pub const RULEBOOK_PUBLISH_ACTION: &str = "matching.rulebook_publish";

/// `RULEBOOK_SECTIONS`: each section's id and title, in reading order. A version missing any one refuses.
pub const RULEBOOK_SECTIONS: [(&str, &str); 7] = [
    ("participation", "participation"),
    ("matching", "matching"),
    ("cancellation", "cancellation"),
    ("settlement", "settlement"),
    ("liquidation", "liquidation"),
    ("fees", "fees"),
    ("market_data", "market data"),
];

/// `RULEBOOK_SECTION_MAX`: the longest section body accepted, in UTF-16 units.
pub const RULEBOOK_SECTION_MAX: usize = 20_000;

/// The seven bodies, in [`RULEBOOK_SECTIONS`]' order.
pub type Sections = Vec<String>;

/// An owner draft, read (`RulebookDraft`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draft {
    pub version: String,
    /// As requested, as `toISOString` writes it; `None` is "when published".
    pub effective_at: Option<String>,
    pub sections: Sections,
    /// sha256 over the version, the requested effective time and every section, in fixed order.
    pub digest: String,
}

/// One published version, as journalled (`RulebookVersion`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub version: String,
    pub effective_at: String,
    pub published_at: String,
    /// The version published just before this one, which it replaces; `None` for the first.
    pub supersedes: Option<String>,
    pub digest: String,
    pub sections: Sections,
    pub operator_id: String,
    pub confirm_operator_id: String,
    pub approval_id: String,
}

/// `rulebookUnpublishedRefuse()`.
pub fn unpublished_refuse() -> Reject {
    Reject::new(RULEBOOK_UNPUBLISHED, user_copy(RULEBOOK_UNPUBLISHED))
}

/// `rulebookImmutableRefuse(version)`.
pub fn immutable_refuse(version: &str) -> Reject {
    Reject::new(
        RULEBOOK_IMMUTABLE,
        format!("{version} is published and never changes; publish the change as a new version"),
    )
}

/// `rulebookDigest(version, effectiveAt, sections)`: the approval binds this exact draft.
pub fn digest(version: &str, effective_at: Option<&str>, sections: &[String]) -> String {
    let canonical = Json::obj([
        ("version", Json::str(version)),
        ("effectiveAt", effective_at.map_or(Json::Null, Json::str)),
        (
            "sections",
            Json::Array(
                RULEBOOK_SECTIONS
                    .iter()
                    .zip(sections)
                    .map(|((id, _), body)| {
                        Json::Array(vec![Json::str(*id), Json::str(body.clone())])
                    })
                    .collect(),
            ),
        ),
    ]);
    let hex: String = Sha256::digest(canonical.compact().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("sha256:{hex}")
}

/// `rulebookApprovalFields(draft)`: what the two-person approval is bound to.
pub fn approval_fields(draft: &Draft) -> [(&'static str, &str); 2] {
    [("version", &draft.version), ("digest", &draft.digest)]
}

/// `rulebookApprovalTarget(version)`: `rulebook_publish:<version>`.
pub fn approval_target(version: &str) -> String {
    format!("rulebook_publish:{version}")
}

/// `VERSION_RE`: a letter or digit, then up to 63 letters, digits, dots, dashes or underscores.
fn version_ok(v: &str) -> bool {
    let b = v.as_bytes();
    (1..=64).contains(&b.len())
        && b.first().is_some_and(u8::is_ascii_alphanumeric)
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// `/(?:Z|[+-]\d{2}:?\d{2})$/i`: the time states its zone.
fn has_zone(t: &str) -> bool {
    let b = t.as_bytes();
    if matches!(b.last(), Some(b'Z' | b'z')) {
        return true;
    }
    let digit = |i: usize| b.get(i).is_some_and(u8::is_ascii_digit);
    let signed = |i: usize| matches!(b.get(i), Some(b'+' | b'-'));
    let n = b.len();
    // `±HHMM` or `±HH:MM` at the end.
    (n >= 5 && signed(n - 5) && (n - 4..n).all(digit))
        || (n >= 6
            && signed(n - 6)
            && digit(n - 5)
            && digit(n - 4)
            && b.get(n - 3) == Some(&b':')
            && digit(n - 2)
            && digit(n - 1))
}

fn rejected(code: &str, message: impl Into<String>) -> Reject {
    Reject::new(code, message)
}

/// `readRulebookDraft(input)`: a blank version, any blank section, or an unreadable time refuses by name; nothing is
/// filled in.
pub fn read_draft(input: &Value) -> Result<Draft, Reject> {
    let version = input
        .get("version")
        .as_str()
        .map(js_trim)
        .unwrap_or_default();
    if version.is_empty() {
        return Err(rejected(
            RULEBOOK_VERSION_UNSET,
            "the rulebook version id is blank",
        ));
    }
    if !version_ok(version) {
        return Err(rejected(
            RULEBOOK_VERSION_UNSET,
            "the version id is 1 to 64 letters, digits, dots, dashes or underscores",
        ));
    }
    let raw = input.get("sections");
    let mut sections = Vec::with_capacity(RULEBOOK_SECTIONS.len());
    for (id, title) in RULEBOOK_SECTIONS {
        let body = raw.get(id).as_str().map(js_trim).unwrap_or_default();
        if body.is_empty() {
            return Err(rejected(
                RULEBOOK_SECTION_UNSET,
                format!("the {title} section is blank"),
            ));
        }
        if js_length(body) > RULEBOOK_SECTION_MAX {
            return Err(rejected(
                RULEBOOK_SECTION_UNSET,
                format!("the {title} section is longer than {RULEBOOK_SECTION_MAX} characters"),
            ));
        }
        sections.push(body.to_owned());
    }
    let raw_at = input
        .get("effectiveAt")
        .as_str()
        .map(js_trim)
        .unwrap_or_default();
    let effective_at = if raw_at.is_empty() {
        None
    } else {
        // A time with no zone would be read in this host's zone: the owner states UTC (Z) or an explicit offset.
        match v8_date_parse(raw_at) {
            Some(ms) if has_zone(raw_at) => Some(Instant(ms).iso()),
            _ => {
                return Err(rejected(
                    RULEBOOK_EFFECTIVE_INVALID,
                    "the effective time is not a date and time with Z or an offset",
                ));
            }
        }
    };
    let digest = digest(version, effective_at.as_deref(), &sections);
    Ok(Draft {
        version: version.to_owned(),
        effective_at,
        sections,
        digest,
    })
}

/// `Date.parse(text)`: `None` is `NaN`, which no comparison holds for.
fn at(text: &str) -> Option<i64> {
    v8_date_parse(text)
}

/// `rulebookEffectivePast(draft, now)`: a version may not take effect before it is published.
pub fn effective_past(draft: &Draft, now: i64) -> Option<Reject> {
    match draft.effective_at.as_deref() {
        None => None,
        Some(t) if at(t).is_some_and(|ms| ms >= now) => None,
        Some(_) => Some(rejected(
            RULEBOOK_EFFECTIVE_INVALID,
            "a version cannot take effect before it is published",
        )),
    }
}

/// `currentRulebook(versions, now)`: the latest published version whose effective time has come. A later publish
/// replaces every earlier one, a scheduled one included.
pub fn current(versions: &[Version], now: i64) -> Option<usize> {
    versions
        .iter()
        .rposition(|v| at(&v.effective_at).is_some_and(|ms| ms <= now))
}

/// `upcomingRulebooks`: versions published after the one in force, waiting for their effective time, soonest first.
fn upcoming(versions: &[Version], now: i64) -> Vec<&Version> {
    let after = current(versions, now).map_or(0, |i| i + 1);
    let mut out: Vec<&Version> = versions
        .iter()
        .skip(after)
        .filter(|v| at(&v.effective_at).is_some_and(|ms| ms > now))
        .collect();
    out.sort_by_key(|v| at(&v.effective_at));
    out
}

fn sections_view(sections: &[String]) -> Json {
    Json::Array(
        RULEBOOK_SECTIONS
            .iter()
            .zip(sections)
            .map(|((id, title), body)| {
                Json::obj([
                    ("id", Json::str(*id)),
                    ("title", Json::str(*title)),
                    ("body", Json::str(body.clone())),
                ])
            })
            .collect(),
    )
}

fn upcoming_view(versions: &[Version], now: i64) -> Json {
    Json::Array(
        upcoming(versions, now)
            .into_iter()
            .map(|v| {
                Json::obj([
                    ("version", Json::str(v.version.clone())),
                    ("effectiveAt", Json::str(v.effective_at.clone())),
                ])
            })
            .collect(),
    )
}

/// `presentPublishedRulebook`, the public `GET /rulebook`: the version in force with its sections, and any published
/// future version.
pub fn published_view(versions: &[Version], now: i64) -> Json {
    let upcoming = upcoming_view(versions, now);
    match current(versions, now).and_then(|i| versions.get(i)) {
        None => Json::obj([
            ("published", Json::Bool(false)),
            ("version", Json::Null),
            ("rejected", unpublished_refuse().to_json()),
            ("upcoming", upcoming),
        ]),
        Some(v) => Json::obj([
            ("published", Json::Bool(true)),
            ("version", Json::str(v.version.clone())),
            ("effectiveAt", Json::str(v.effective_at.clone())),
            ("publishedAt", Json::str(v.published_at.clone())),
            ("sections", sections_view(&v.sections)),
            ("upcoming", upcoming),
        ]),
    }
}

/// One version as `presentRulebookHistory` writes it.
fn history_entry(versions: &[Version], v: &Version, now: i64) -> Json {
    let current = current(versions, now).and_then(|i| versions.get(i));
    let upcoming = upcoming(versions, now);
    let previous = v
        .supersedes
        .as_ref()
        .and_then(|s| versions.iter().rev().find(|p| p.version == *s));
    let status = if current.is_some_and(|c| c.version == v.version) {
        "current"
    } else if upcoming.iter().any(|u| u.version == v.version) {
        "upcoming"
    } else {
        "superseded"
    };
    let changed: Vec<Json> = RULEBOOK_SECTIONS
        .iter()
        .enumerate()
        .filter(|(i, _)| previous.is_none_or(|p| p.sections.get(*i) != v.sections.get(*i)))
        .map(|(_, (id, _))| Json::str(*id))
        .collect();
    Json::obj([
        ("version", Json::str(v.version.clone())),
        ("status", Json::str(status)),
        ("effectiveAt", Json::str(v.effective_at.clone())),
        ("publishedAt", Json::str(v.published_at.clone())),
        (
            "supersedes",
            v.supersedes.clone().map_or(Json::Null, Json::String),
        ),
        ("changedSections", Json::Array(changed)),
        ("sections", sections_view(&v.sections)),
    ])
}

/// `presentRulebookHistory`, the public `GET /rulebook/versions`: every version, newest publish first, with the
/// sections each changed from the one it superseded.
pub fn history_view(versions: &[Version], now: i64) -> Json {
    let current = current(versions, now)
        .and_then(|i| versions.get(i))
        .map_or(Json::Null, |v| Json::str(v.version.clone()));
    Json::obj([
        ("current", current),
        (
            "versions",
            Json::Array(
                versions
                    .iter()
                    .rev()
                    .map(|v| history_entry(versions, v, now))
                    .collect(),
            ),
        ),
    ])
}

/// `rulebookHistory().versions.find((v) => v.version === version) ?? null`.
pub fn history_of(versions: &[Version], version: &str, now: i64) -> Json {
    versions
        .iter()
        .rev()
        .find(|v| v.version == version)
        .map_or(Json::Null, |v| history_entry(versions, v, now))
}

impl Version {
    /// The `rulebook_version` journal record, as `publishRulebook` appends it.
    pub fn record(&self) -> Json {
        Json::obj([
            ("kind", Json::str("rulebook_version")),
            ("at", Json::str(self.published_at.clone())),
            ("operatorId", Json::str(self.operator_id.clone())),
            (
                "confirmOperatorId",
                Json::str(self.confirm_operator_id.clone()),
            ),
            ("approvalId", Json::str(self.approval_id.clone())),
            ("version", Json::str(self.version.clone())),
            ("effectiveAt", Json::str(self.effective_at.clone())),
            (
                "supersedes",
                self.supersedes.clone().map_or(Json::Null, Json::String),
            ),
            ("digest", Json::str(self.digest.clone())),
            (
                "sections",
                Json::Object(
                    RULEBOOK_SECTIONS
                        .iter()
                        .zip(&self.sections)
                        .map(|((id, _), body)| ((*id).to_owned(), Json::str(body.clone())))
                        .collect(),
                ),
            ),
        ])
    }

    /// A `rulebook_version` record read back on a cold start.
    pub fn from_record(r: &crate::journal::record::JournalRecord) -> Version {
        let text = |k: &str| crate::journal::record::js_string(r.field(k));
        let sections = r.field("sections");
        Version {
            version: text("version"),
            effective_at: text("effectiveAt"),
            published_at: text("at"),
            supersedes: match r.field("supersedes") {
                None | Some(Json::Null) => None,
                v => Some(crate::journal::record::js_string(v)),
            },
            digest: text("digest"),
            sections: RULEBOOK_SECTIONS
                .iter()
                .map(|(id, _)| {
                    crate::journal::record::js_string(crate::journal::record::prop(sections, id))
                })
                .collect(),
            operator_id: text("operatorId"),
            confirm_operator_id: text("confirmOperatorId"),
            approval_id: text("approvalId"),
        }
    }
}
