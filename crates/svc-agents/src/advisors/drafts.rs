//! The advisors that only draft or refuse: the Launch agent's pre-listing flags (`launch/pre-listing-assess.ts`), Risk &
//! Compliance's screening drafts and its refusal to stamp a KYC review (`risk-compliance/`), Growth's campaign
//! proposals (`growth/campaign-proposal.ts`) and the marketplace install (`fleet/install.ts`). None decides, publishes,
//! grants or invents: each answer says so in its own fields.

use service_kit::access::ScreeningView;
use service_kit::json::Json;
use service_kit::schema::js_trim;

use super::text::returns_claim;

/// The copy key every one of these answers carries.
pub const REFUSE_COPY: &str = "agents.error.capability_unavailable";

// ── Launch ────────────────────────────────────────────────────────────────────

/// `DeployerFacts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeployerFacts {
    pub lp_locks: i64,
    pub vestings: i64,
}

/// `DeployerReputationPort`: a deployer's facts, or none when unread.
pub type ReputationPort<'a> = &'a dyn Fn(&str) -> Option<DeployerFacts>;

/// `LaunchAssessInput`. The door passes no reputation port: the live chain reputation read is not wired anywhere.
#[derive(Default)]
pub struct LaunchAsk<'a> {
    pub deployer: Option<&'a str>,
    pub as_badge: bool,
    pub as_block_decision: bool,
    pub reputation: Option<ReputationPort<'a>>,
}

/// `assessPreListingRisk`, as `launch.assess` answers it. Empty deployer history is no score, never a clean badge.
pub fn launch_assess(input: &LaunchAsk<'_>) -> Json {
    let refuse = |reason: &str| {
        Json::obj([
            ("status", Json::str("refuse")),
            ("reason", Json::str(reason)),
            ("kind", Json::str("not_a_badge")),
            ("isBadge", Json::Bool(false)),
            ("isBlockDecision", Json::Bool(false)),
            ("inventedCleanBadge", Json::Bool(false)),
            ("userMessageKey", Json::str(REFUSE_COPY)),
        ])
    };
    if input.as_badge {
        return refuse("badge_forbidden");
    }
    if input.as_block_decision {
        return refuse("block_decision_forbidden");
    }
    let deployer = js_trim(input.deployer.unwrap_or_default());
    if deployer.is_empty() {
        return refuse("deployer_missing");
    }
    let normal = deployer.to_lowercase();
    let Some(facts) = input.reputation.and_then(|port| port(&normal)) else {
        return refuse("reputation_unread");
    };
    let (lp, vest) = (facts.lp_locks, facts.vestings);
    if lp == 0 && vest == 0 {
        return refuse("history_absent");
    }
    let mut flags = Vec::new();
    if lp == 0 {
        flags.push("no_lp_locks");
    }
    if vest == 0 {
        flags.push("no_vestings");
    }
    if lp > 0 && lp < 2 {
        flags.push("sparse_lp_locks");
    }
    if vest > 0 && vest < 2 {
        flags.push("sparse_vestings");
    }
    Json::obj([
        ("status", Json::str("annotation")),
        ("kind", Json::str("pattern_flags")),
        ("isBadge", Json::Bool(false)),
        ("isBlockDecision", Json::Bool(false)),
        ("deployer", Json::str(normal)),
        ("lpLocks", Json::int(lp)),
        ("vestings", Json::int(vest)),
        (
            "patternFlags",
            Json::Array(
                flags
                    .into_iter()
                    .map(|code| {
                        Json::obj([
                            ("code", Json::str(code)),
                            ("source", Json::str("deployer_reputation")),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("inventedCleanBadge", Json::Bool(false)),
        ("userMessageKey", Json::str(REFUSE_COPY)),
    ])
}

// ── Risk & Compliance ────────────────────────────────────────────────────────

/// `ScreeningDraftInput`.
#[derive(Default)]
pub struct ScreeningAsk<'a> {
    pub subject_id: Option<&'a str>,
    pub region: Option<&'a str>,
    pub as_decision: bool,
    pub write_reviewed_by: bool,
}

/// `draftScreeningSupport`, as `riskCompliance.draftScreening` answers it: a proposal for a person, never a decision;
/// an unset or empty list is unknown, never a cleared account. `business` is `SHIPPED_BUSINESS_BLOCKS`' regions.
pub fn draft_screening<'a>(
    input: &ScreeningAsk<'_>,
    screening: &ScreeningView<'_>,
    business: impl Iterator<Item = &'a str>,
) -> Json {
    let refuse = |reason: &str| {
        Json::obj([
            ("status", Json::str("refuse")),
            ("reason", Json::str(reason)),
            ("kind", Json::str("not_a_decision")),
            ("isDecision", Json::Bool(false)),
            ("userMessageKey", Json::str(REFUSE_COPY)),
            ("screeningDeclaration", Json::str(screening.declaration)),
            ("screeningConfigured", Json::Bool(screening.configured)),
            ("screeningSource", Json::str(screening.source)),
            ("inventedBlockedList", Json::Bool(false)),
        ])
    };
    if input.as_decision || input.write_reviewed_by {
        return refuse("decision_forbidden");
    }
    let subject = js_trim(input.subject_id.unwrap_or_default());
    let region = js_trim(input.region.unwrap_or_default()).to_uppercase();
    if subject.is_empty() || region.is_empty() {
        return refuse("inputs_missing");
    }
    if screening.declaration == "unset" || !screening.configured {
        return refuse("screening_unset");
    }
    if screening.declaration == "reviewed-empty" || screening.regions.is_empty() {
        return refuse("screening_empty");
    }
    let hits: Vec<Json> = screening
        .regions
        .iter()
        .filter(|(r, _)| *r == region)
        .map(|(r, why)| {
            Json::obj([
                ("region", Json::str(*r)),
                ("reason", Json::str(*why)),
                ("source", Json::str(screening.source)),
                ("authority", Json::str("screening")),
            ])
        })
        .collect();
    let business_hits = business.filter(|r| *r == region).count();
    Json::obj([
        ("status", Json::str("draft")),
        ("kind", Json::str("proposal")),
        ("isDecision", Json::Bool(false)),
        ("subjectId", Json::str(subject)),
        ("region", Json::str(region.clone())),
        ("screeningDeclaration", Json::str(screening.declaration)),
        ("screeningConfigured", Json::Bool(screening.configured)),
        ("screeningSource", Json::str(screening.source)),
        (
            "listHitCount",
            Json::int(i64::try_from(hits.len()).unwrap_or(i64::MAX)),
        ),
        (
            "businessHitCount",
            Json::int(i64::try_from(business_hits).unwrap_or(i64::MAX)),
        ),
        ("listHits", Json::Array(hits)),
        ("inventedBlockedList", Json::Bool(false)),
    ])
}

/// `refuseIdentityKycReviewWrite`: `reviewed_by` is an operator's column, whatever is asked.
pub fn refuse_kyc_review() -> Json {
    Json::obj([
        ("status", Json::str("refuse")),
        ("reason", Json::str("kyc_review_is_operator_only")),
        ("kind", Json::str("not_a_decision")),
        ("isDecision", Json::Bool(false)),
        ("column", Json::str("reviewed_by")),
        ("writable", Json::Bool(false)),
        ("userMessageKey", Json::str(REFUSE_COPY)),
    ])
}

// ── Growth ───────────────────────────────────────────────────────────────────

/// `GrowthWarehouse`: `envGrowthWarehouse()` is dark, and nothing wires a live one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Warehouse {
    pub configured: bool,
    pub may_label_live: bool,
}

/// `GrowthProposeInput`.
#[derive(Default)]
pub struct GrowthAsk<'a> {
    pub headline: Option<&'a str>,
    pub copy: Option<&'a str>,
    pub publish: bool,
    pub incentive_budget: Option<&'a str>,
    pub spend_amount: Option<&'a str>,
}

/// `proposeGrowthCampaign`, as `growth.propose` answers it: never publishes, never invents returns or budgets.
pub fn growth_propose(input: &GrowthAsk<'_>, warehouse: Warehouse) -> Json {
    let refuse = |reason: &str| {
        Json::obj([
            ("status", Json::str("refuse")),
            ("reason", Json::str(reason)),
            ("kind", Json::str("not_a_publication")),
            ("isPublication", Json::Bool(false)),
            ("published", Json::Bool(false)),
            ("warehouseConfigured", Json::Bool(warehouse.configured)),
            (
                "warehouseMayLabelLive",
                Json::Bool(warehouse.may_label_live),
            ),
            ("inventedReturns", Json::Bool(false)),
            ("inventedBudget", Json::Bool(false)),
            ("userMessageKey", Json::str(REFUSE_COPY)),
        ])
    };
    let headline = js_trim(input.headline.unwrap_or_default());
    let copy = js_trim(input.copy.unwrap_or_default());
    if input.publish {
        return refuse("autonomous_publish");
    }
    if !js_trim(input.incentive_budget.unwrap_or_default()).is_empty()
        || !js_trim(input.spend_amount.unwrap_or_default()).is_empty()
    {
        return refuse("budget_undecided");
    }
    if returns_claim(&format!("{headline}\n{copy}")) {
        return refuse("returns_claim");
    }
    if !warehouse.configured || !warehouse.may_label_live {
        return refuse("warehouse_dark");
    }
    if headline.is_empty() {
        return refuse("inputs_missing");
    }
    Json::obj([
        ("status", Json::str("proposal")),
        ("kind", Json::str("proposal")),
        ("isPublication", Json::Bool(false)),
        ("published", Json::Bool(false)),
        ("headline", Json::str(headline)),
        ("warehouseConfigured", Json::Bool(true)),
        ("warehouseMayLabelLive", Json::Bool(true)),
        ("inventedReturns", Json::Bool(false)),
        ("inventedBudget", Json::Bool(false)),
        ("userMessageKey", Json::str(REFUSE_COPY)),
    ])
}

// ── The marketplace install ──────────────────────────────────────────────────

const ID_MAX: usize = 64;
const TOOL_MAX: usize = 120;
const CLAIM_CAP: usize = 50;

/// JavaScript's `length`: UTF-16 code units.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `pinId`: trimmed, present, at most 64, and only `[a-zA-Z0-9._-]`.
fn pin_id(label: &str, value: &str) -> Result<String, String> {
    let v = js_trim(value);
    if v.is_empty() || js_len(v) > ID_MAX {
        return Err(format!("{label} is required"));
    }
    if !v
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(format!("{label} is not a package id"));
    }
    Ok(v.to_owned())
}

/// `pinClaims`: the first 50, trimmed, blank or too long dropped, each once.
fn pin_claims(values: &[&str], max_len: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in values.iter().take(CLAIM_CAP) {
        let v = js_trim(raw);
        if v.is_empty() || js_len(v) > max_len || out.iter().any(|o| o == v) {
            continue;
        }
        out.push(v.to_owned());
    }
    out
}

/// `MarketplaceInstallInput`.
pub struct InstallAsk<'a> {
    pub package_id: &'a str,
    pub version: &'a str,
    pub publisher: &'a str,
    pub claimed_tools: Vec<&'a str>,
    pub claimed_scopes: Vec<&'a str>,
}

/// `marketplaceInstallDoor`: recording a package is not a grant. Claims stay claims: the install's guardrail holds
/// no tool, its credential no scope, so nothing it claims is callable, and every authority field is false by type.
/// `Err` is the TypeScript's thrown `Error`, a 500 with its words.
pub fn marketplace_install(input: &InstallAsk<'_>) -> Result<Json, String> {
    let package_id = pin_id("packageId", input.package_id)?;
    let version = pin_id("version", input.version)?;
    let publisher = pin_id("publisher", input.publisher)?;
    let strings = |l: Vec<String>| Json::Array(l.into_iter().map(Json::str).collect());
    Ok(Json::obj([
        ("status", Json::str("installed")),
        ("packageId", Json::str(package_id)),
        ("version", Json::str(version)),
        ("publisher", Json::str(publisher)),
        (
            "claimedTools",
            strings(pin_claims(&input.claimed_tools, TOOL_MAX)),
        ),
        (
            "claimedScopes",
            strings(pin_claims(&input.claimed_scopes, ID_MAX)),
        ),
        ("grantCreated", Json::Bool(false)),
        ("tradingAuthority", Json::Bool(false)),
        ("withdrawCredentialIssued", Json::Bool(false)),
        ("callable", Json::Bool(false)),
        ("placeAllowed", Json::Bool(false)),
        ("withdrawAllowed", Json::Bool(false)),
    ]))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    fn field(j: &Json, k: &str) -> String {
        j.get(k).unwrap().compact()
    }

    /// `pre-listing-assess.test.ts`: absence is never a clean badge; sparse history is flagged.
    #[test]
    fn launch_refuses_absence_and_flags_patterns() {
        assert_eq!(
            field(&launch_assess(&LaunchAsk::default()), "reason"),
            "\"deployer_missing\""
        );
        let none = |_: &str| None;
        let empty = |_: &str| {
            Some(DeployerFacts {
                lp_locks: 0,
                vestings: 0,
            })
        };
        let sparse = |_: &str| {
            Some(DeployerFacts {
                lp_locks: 1,
                vestings: 0,
            })
        };
        let ask = |port: &dyn Fn(&str) -> Option<DeployerFacts>| {
            launch_assess(&LaunchAsk {
                deployer: Some(" 0xABC "),
                reputation: Some(port),
                ..LaunchAsk::default()
            })
        };
        assert_eq!(field(&ask(&none), "reason"), "\"reputation_unread\"");
        assert_eq!(field(&ask(&empty), "reason"), "\"history_absent\"");
        let flagged = ask(&sparse);
        assert_eq!(field(&flagged, "deployer"), "\"0xabc\"");
        assert_eq!(
            field(&flagged, "patternFlags"),
            r#"[{"code":"no_vestings","source":"deployer_reputation"},{"code":"sparse_lp_locks","source":"deployer_reputation"}]"#
        );
        let badge = launch_assess(&LaunchAsk {
            as_badge: true,
            as_block_decision: true,
            ..LaunchAsk::default()
        });
        assert_eq!(field(&badge, "reason"), "\"badge_forbidden\"");
    }

    /// `screening-draft.test.ts`: an unset or empty list refuses; a listed one echoes only its own rows.
    #[test]
    fn screening_drafts_are_proposals_from_the_list_alone() {
        let unset = ScreeningView {
            declaration: "unset",
            configured: false,
            source: "unconfigured",
            regions: vec![],
        };
        let ask = ScreeningAsk {
            subject_id: Some("s-1"),
            region: Some(" cu "),
            ..ScreeningAsk::default()
        };
        assert_eq!(
            field(&draft_screening(&ask, &unset, std::iter::empty()), "reason"),
            "\"screening_unset\""
        );
        let empty = ScreeningView {
            declaration: "reviewed-empty",
            configured: true,
            source: "memo",
            regions: vec![],
        };
        assert_eq!(
            field(&draft_screening(&ask, &empty, std::iter::empty()), "reason"),
            "\"screening_empty\""
        );
        let listed = ScreeningView {
            declaration: "listed",
            configured: true,
            source: "memo",
            regions: vec![("CU", "why"), ("IR", "why not")],
        };
        let draft = draft_screening(&ask, &listed, ["CU", "US"].into_iter());
        assert_eq!(field(&draft, "region"), "\"CU\"");
        assert_eq!(field(&draft, "listHitCount"), "1");
        assert_eq!(field(&draft, "businessHitCount"), "1");
        assert_eq!(
            field(&draft, "listHits"),
            r#"[{"region":"CU","reason":"why","source":"memo","authority":"screening"}]"#
        );
        let decide = ScreeningAsk {
            write_reviewed_by: true,
            ..ScreeningAsk::default()
        };
        assert_eq!(
            field(
                &draft_screening(&decide, &listed, std::iter::empty()),
                "reason"
            ),
            "\"decision_forbidden\""
        );
    }

    /// `campaign-proposal.test.ts`: publish, budgets and returns claims refuse before the dark warehouse.
    #[test]
    fn growth_never_publishes_or_invents() {
        let dark = Warehouse::default();
        let live = Warehouse {
            configured: true,
            may_label_live: true,
        };
        let reason = |a: &GrowthAsk<'_>, w| field(&growth_propose(a, w), "reason");
        assert_eq!(
            reason(
                &GrowthAsk {
                    publish: true,
                    ..GrowthAsk::default()
                },
                live
            ),
            "\"autonomous_publish\""
        );
        assert_eq!(
            reason(
                &GrowthAsk {
                    spend_amount: Some(" 5 "),
                    ..GrowthAsk::default()
                },
                live
            ),
            "\"budget_undecided\""
        );
        assert_eq!(
            reason(
                &GrowthAsk {
                    copy: Some("Best APY"),
                    ..GrowthAsk::default()
                },
                live
            ),
            "\"returns_claim\""
        );
        assert_eq!(
            reason(
                &GrowthAsk {
                    headline: Some("Hi"),
                    ..GrowthAsk::default()
                },
                dark
            ),
            "\"warehouse_dark\""
        );
        assert_eq!(reason(&GrowthAsk::default(), live), "\"inputs_missing\"");
        let proposal = growth_propose(
            &GrowthAsk {
                headline: Some(" Hi "),
                ..GrowthAsk::default()
            },
            live,
        );
        assert_eq!(field(&proposal, "headline"), "\"Hi\"");
        assert_eq!(field(&proposal, "published"), "false");
    }

    /// `install.test.ts`: claims are copied as annotations, never authority.
    #[test]
    fn an_install_records_claims_and_grants_nothing() {
        let done = marketplace_install(&InstallAsk {
            package_id: " pkg.one ",
            version: "1.0.0",
            publisher: "acme",
            claimed_tools: vec!["trade.place", " trade.place", "bank.withdraw", "  "],
            claimed_scopes: vec!["withdraw"],
        })
        .unwrap();
        assert_eq!(field(&done, "packageId"), "\"pkg.one\"");
        assert_eq!(
            field(&done, "claimedTools"),
            r#"["trade.place","bank.withdraw"]"#
        );
        for k in [
            "grantCreated",
            "tradingAuthority",
            "withdrawCredentialIssued",
            "callable",
            "placeAllowed",
            "withdrawAllowed",
        ] {
            assert_eq!(field(&done, k), "false");
        }
        let bad = |id| {
            marketplace_install(&InstallAsk {
                package_id: id,
                version: "1",
                publisher: "p",
                claimed_tools: vec![],
                claimed_scopes: vec![],
            })
        };
        assert_eq!(bad("  ").unwrap_err(), "packageId is required");
        assert_eq!(bad("a b").unwrap_err(), "packageId is not a package id");
    }
}
