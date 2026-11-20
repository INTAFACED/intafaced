//! The two outside reads the lobbies make, both signed service calls with no user principal and both failing closed:
//! svc-token's stake (`stake-source.ts`, read only for a staked room) and svc-identity's rank perks (`host-rights.ts`,
//! read only to open a room). Neither is cached: a cached stake or perk outlives what earned it.

use std::sync::{Arc, OnceLock};

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::s2s::CallSigner;
use service_kit::schema::{Outcome, Schema, Value};

use crate::errors::{AcademyError, Refusal};
use crate::lobbies::scene::NoRefines;
use crate::ports::{HostRights, Stake};

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// A signed GET's request: `content-type` first, then the signer's headers over an empty body. `Err` is the message a
/// thrown signer or `new URL` gives.
fn signed_get(base: &str, path: &str, signer: &CallSigner) -> Result<HttpRequest, String> {
    let target = format!("{}{path}", base.strip_suffix('/').unwrap_or(base));
    let parsed = url::Url::parse(&target).map_err(|_| "Invalid URL".to_owned())?;
    let signed_target = match parsed.query() {
        Some(q) => format!("{}?{q}", parsed.path()),
        None => parsed.path().to_owned(),
    };
    let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    headers.extend(signer.sign("", "GET", &signed_target, "application/json")?);
    Ok(HttpRequest {
        method: "GET".to_owned(),
        url: target,
        headers,
        body: None,
        timeout_ms: None,
        refuse_redirect: false,
    })
}

/// `createStakeSource(baseUrl, internalSecret, s2s)`: `GET {TOKEN_URL}/internal/stake/{userId}` → `{ staked }`.
pub struct HttpStake {
    base: String,
    signer: CallSigner,
    fetch: Arc<dyn Fetch>,
}

impl HttpStake {
    /// `signer` is `serviceCallSigner({ service: 'svc-academy', audience: 'svc-token', ... })`.
    pub fn new(base: &str, signer: CallSigner, fetch: Arc<dyn Fetch>) -> HttpStake {
        HttpStake {
            base: base.to_owned(),
            signer,
            fetch,
        }
    }
}

fn stake_unavailable(message: String) -> Refusal {
    Refusal::Academy(AcademyError::new(message, "academy.stake_unavailable"))
}

impl Stake for HttpStake {
    fn stake_of(&self, user_id: &str) -> Result<Amount, Refusal> {
        let path = format!("/internal/stake/{}", encode_uri_component(user_id));
        let response = signed_get(&self.base, &path, &self.signer)
            .and_then(|req| self.fetch.fetch(&req).map_err(|e| e.message))
            .map_err(|m| stake_unavailable(format!("Stake gate unavailable: {m}")))?;
        if !response.ok() {
            return Err(stake_unavailable(format!(
                "Stake gate unavailable ({})",
                response.status
            )));
        }
        let staked = match json::parse(&response.body) {
            Ok(body) => match body.get("staked") {
                Some(Json::String(s)) => s.clone(),
                _ => {
                    return Err(stake_unavailable(
                        "Stake gate returned an unusable payload".to_owned(),
                    ));
                }
            },
            Err(_) => {
                return Err(stake_unavailable(
                    "Stake gate returned an unusable payload".to_owned(),
                ));
            }
        };
        parse_amount(&staked)
            .map_err(|_| stake_unavailable("Stake gate returned an unparseable amount".to_owned()))
    }
}

/// `rankPerksSchema` (`packages/contracts/src/identity.ts`), as the zod engine's tree.
const PERKS_TREE: &str = r#"{"nodes":[
{"t":"object","shape":[["feeDiscountBps",1],["p2pLimitMultiplier",2],["copyFollowerCap",3],["lobbyHostRights",4],["cardTier",5],["otcAccess",4],["launchpadTier",3]]},
{"t":"number","checks":[{"k":"int"},{"k":"gt","v":0,"incl":true},{"k":"lt","v":10000,"incl":true}]},
{"t":"number","checks":[{"k":"gt","v":1,"incl":true}]},
{"t":"number","checks":[{"k":"int"},{"k":"gt","v":0,"incl":true}]},
{"t":"boolean"},
{"t":"enum","values":["none","standard","metal","obsidian"]}
]}"#;

fn perks_tree() -> Result<&'static Schema, String> {
    static TREE: OnceLock<Result<Schema, String>> = OnceLock::new();
    TREE.get_or_init(|| {
        let doc = json::parse(PERKS_TREE).map_err(|e| e.message)?;
        Schema::from_json(&doc)
    })
    .as_ref()
    .map_err(Clone::clone)
}

/// `rankPerksSchema.safeParse(body)`: the perks as zod's output holds them, or none.
pub fn parse_perks(body: &Json) -> Option<Json> {
    let tree = perks_tree().ok()?;
    match tree.parse(0, Value::from_json(body), &NoRefines) {
        Ok(Outcome::Ok(v)) => v.to_json(),
        _ => None,
    }
}

/// `createHostRightsSource(baseUrl, internalSecret, s2s)`: `GET {IDENTITY_URL}/internal/rank/{userId}/perks`.
pub struct HttpHostRights {
    base: String,
    signer: CallSigner,
    fetch: Arc<dyn Fetch>,
}

impl HttpHostRights {
    /// `signer` is `serviceCallSigner({ service: 'svc-academy', audience: 'svc-identity', ... })`.
    pub fn new(base: &str, signer: CallSigner, fetch: Arc<dyn Fetch>) -> HttpHostRights {
        HttpHostRights {
            base: base.to_owned(),
            signer,
            fetch,
        }
    }
}

fn host_rights_unavailable(message: String) -> Refusal {
    Refusal::Academy(AcademyError::new(
        message,
        "academy.host_rights_unavailable",
    ))
}

impl HostRights for HttpHostRights {
    fn perks_of(&self, user_id: &str) -> Result<Json, Refusal> {
        let path = format!("/internal/rank/{}/perks", encode_uri_component(user_id));
        let response = signed_get(&self.base, &path, &self.signer)
            .and_then(|req| self.fetch.fetch(&req).map_err(|e| e.message))
            .map_err(|m| host_rights_unavailable(format!("Host rights unavailable: {m}")))?;
        if !response.ok() {
            return Err(host_rights_unavailable(format!(
                "Host rights unavailable ({})",
                response.status
            )));
        }
        let body = json::parse(&response.body).unwrap_or(Json::Null);
        parse_perks(&body).ok_or_else(|| {
            host_rights_unavailable(
                "Host rights payload did not match the published contract".to_owned(),
            )
        })
    }
}

/// `mayHost`: only the `lobbyHostRights` perk decides.
pub fn may_host(perks: &Json) -> bool {
    matches!(perks.get("lobbyHostRights"), Some(Json::Bool(true)))
}

// ── The L3 cards (`host-rights.ts`) ──────────────────────────────────────────────────────────────────────────────

fn bit(b: bool) -> &'static str {
    if b { "1" } else { "0" }
}

/// `hostRightsStatusLine`.
pub fn host_rights_status_line(perks: &Json) -> String {
    let m = may_host(perks);
    format!("mayHost={} lobbyHostRights={}", bit(m), bit(m))
}

/// `parseHostRightsStatusLine`.
pub fn parse_host_rights_status_line(line: &str) -> Option<(bool, bool)> {
    let t = service_kit::schema::js_trim(line);
    let (a, b) = t
        .strip_prefix("mayHost=")?
        .split_once(" lobbyHostRights=")?;
    let flag = |s: &str| match s {
        "1" => Some(true),
        "0" => Some(false),
        _ => None,
    };
    Some((flag(a)?, flag(b)?))
}

/// `hostRightsStatusLineConsistent`.
pub fn host_rights_status_line_consistent(line: &str) -> bool {
    parse_host_rights_status_line(line).is_some_and(|(a, b)| a == b)
}

/// `hostRightsExportHeader`, `hostRightsExportLine`.
pub fn host_rights_export_header() -> &'static str {
    "mayHost,lobbyHostRights"
}
pub fn host_rights_export_line(perks: &Json) -> String {
    let m = may_host(perks);
    format!("{},{}", bit(m), bit(m))
}
