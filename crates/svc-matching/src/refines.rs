//! The checks inside svc-matching's door schemas that are code, not zod parts, by the names `scripts/record-door.mjs`
//! gives them: the exchange contract's spine identifier (`spineIdSchema`), the market snapshot's allowed actions
//! (`marketStateSnapshotSchema`), the lifecycle admission proof that binds a submit to its snapshot
//! (`marketLifecycleAdmissionProofSchema`, `@intafaced/exchange-contract`), and the amend body's one rule
//! (`amendBodySchema`, `door-inputs.ts`).

use service_kit::json::Json;
use service_kit::schema::{Outcome, Refiner, Value, js_trim};
use sha2::{Digest, Sha256};

/// `marketLifecycleStateSchema`'s states that permit no trading action.
const NO_ACTION_STATES: [&str; 9] = [
    "DRAFT", "REVIEW", "APPROVED", "AUCTION", "REFUSED", "EXPIRED", "SETTLING", "SETTLED",
    "ARCHIVED",
];
const RISK_REDUCTION_ACTIONS: [&str; 3] = ["CANCEL", "REDUCE", "CLOSE"];
const CANCEL_ONLY_ACTIONS: [&str; 1] = ["CANCEL"];
const PRELAUNCH_ACTIONS: [&str; 1] = ["CANCEL"];
const POST_ONLY_ACTIONS: [&str; 6] = [
    "PLACE_POST_ONLY",
    "AMEND",
    "CANCEL",
    "REDUCE",
    "CLOSE",
    "QUOTE",
];

/// `value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)`.
fn spine_id(v: &Value) -> bool {
    let s = v.js_string();
    js_trim(&s) == s && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}

fn texts(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap_or_default()
        .iter()
        .map(Value::js_string)
        .collect()
}

fn issue(path: &[&str], message: impl Into<String>) -> (Vec<Json>, String) {
    (path.iter().map(|p| Json::str(*p)).collect(), message.into())
}

/// `marketStateSnapshotSchema`'s `superRefine`: unique actions, none in a state that permits none, and only the ones
/// the state allows.
fn snapshot_actions(v: &Value) -> Vec<(Vec<Json>, String)> {
    let actions = texts(v.get("allowedActions"));
    let state = v.get("state").js_string();
    let mut out = Vec::new();
    let unique = actions
        .iter()
        .enumerate()
        .all(|(i, a)| actions.iter().skip(i + 1).all(|b| a != b));
    if !unique {
        out.push(issue(&["allowedActions"], "allowed actions must be unique"));
    }
    if NO_ACTION_STATES.contains(&state.as_str()) && !actions.is_empty() {
        out.push(issue(
            &["allowedActions"],
            format!("{state} permits no trading action"),
        ));
    }
    let permitted: Option<&[&str]> = match state.as_str() {
        "PRELAUNCH" => Some(&PRELAUNCH_ACTIONS),
        "HALTED" | "REDUCE_ONLY" | "EXPIRING" | "DELISTING" => Some(&RISK_REDUCTION_ACTIONS),
        "CANCEL_ONLY" => Some(&CANCEL_ONLY_ACTIONS),
        "POST_ONLY" => Some(&POST_ONLY_ACTIONS),
        _ => None,
    };
    if let Some(permitted) = permitted {
        for (index, action) in actions.iter().enumerate() {
            if !permitted.contains(&action.as_str()) {
                out.push((
                    vec![Json::str("allowedActions"), Json::int(index_i64(index))],
                    format!("{state} cannot permit {action}"),
                ));
            }
        }
    }
    out
}

fn index_i64(i: usize) -> i64 {
    i64::try_from(i).unwrap_or(i64::MAX)
}

/// `JSON.stringify` of a value (`undefined` for none).
fn stringify(v: &Value) -> String {
    v.to_json()
        .map_or_else(|| "undefined".to_owned(), |j| j.compact())
}

/// `marketLifecycleAdmissionProofSchema`'s `superRefine`: the proof binds its action, time, transition and evidence to
/// the exact snapshot, and its id hashes the snapshot as parsed.
fn lifecycle_proof(v: &Value) -> Result<Vec<(Vec<Json>, String)>, String> {
    let snapshot = v.get("snapshot");
    let mut out = Vec::new();
    let action = v.get("action").js_string();
    if !texts(snapshot.get("allowedActions")).contains(&action) {
        out.push(issue(
            &["action"],
            "action must be allowed by the exact snapshot",
        ));
    }
    if v.get("checkedAt") != snapshot.get("observedAt") {
        out.push(issue(
            &["checkedAt"],
            "checkedAt must bind to snapshot observedAt",
        ));
    }
    if v.get("transitionId") != snapshot.get("transitionId") {
        out.push(issue(&["transitionId"], "transitionId must match snapshot"));
    }
    if stringify(v.get("evidenceRefs")) != stringify(snapshot.get("evidenceRefs")) {
        out.push(issue(&["evidenceRefs"], "evidenceRefs must match snapshot"));
    }
    // Hashed only when the snapshot itself parses, as the TypeScript does.
    if let Outcome::Ok(parsed) = crate::door::parse("snapshot", snapshot.clone())? {
        let digest = Sha256::digest(stringify(&parsed).as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        if v.get("snapshotId") != &Value::String(format!("trade.lifecycle.snapshot:{hex}")) {
            out.push(issue(
                &["snapshotId"],
                "snapshotId must hash the exact snapshot",
            ));
        }
    }
    Ok(out)
}

/// `amendBodySchema`'s `superRefine`: an amend changes something.
fn amend_changes_something(v: &Value) -> Vec<(Vec<Json>, String)> {
    let unset = |k: &str| matches!(v.get(k), Value::Undefined);
    if unset("qty") && unset("price") && unset("stopPrice") && unset("tif") {
        vec![(
            Vec::new(),
            "amend must change qty, price, stopPrice, or tif".to_owned(),
        )]
    } else {
        Vec::new()
    }
}

/// svc-matching's refines.
pub struct MatchingRefines;

impl Refiner for MatchingRefines {
    fn refine(&self, id: &str, value: &Value) -> Result<bool, String> {
        match id {
            "spine_id" => Ok(spine_id(value)),
            other => Err(format!("no refine named {other}")),
        }
    }

    fn super_refine(&self, id: &str, value: &Value) -> Result<Vec<(Vec<Json>, String)>, String> {
        match id {
            "snapshot_actions" => Ok(snapshot_actions(value)),
            "lifecycle_proof" => lifecycle_proof(value),
            "amend_changes_something" => Ok(amend_changes_something(value)),
            other => Err(format!("no superRefine named {other}")),
        }
    }
}
