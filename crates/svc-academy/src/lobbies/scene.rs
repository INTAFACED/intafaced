//! The 2D spatial scene (§8.3, `spatial/scene.ts`, `edit-policy.ts`, `scene-state.ts`): Scene v1's closed schema, its
//! size budget, its fingerprint, the concurrent host-edit policy and the durable-state reading.
//!
//! The schema runs on the kit's zod engine (`service_kit::schema`) from the tree below, which is `sceneV1Schema` part
//! for part; `tests/lobbies_parity.rs` holds it to zod's own verdicts and messages (`scripts/record-lobbies.mjs`). A
//! scene is a [`Value`] as zod's output holds it: unknown keys of the inner objects stripped, keys in schema order.

use std::sync::OnceLock;

use service_kit::json::{self, Json};
use service_kit::schema::{Outcome, Refiner, Schema, Value};
use sha2::{Digest, Sha256};

/// `SCENE_MAX_BYTES`: the UTF-8 bytes of `JSON.stringify(scene)`.
pub const SCENE_MAX_BYTES: usize = 64 * 1024;
/// `SCENE_VERSION`.
pub const SCENE_VERSION: i64 = 1;

/// `sceneV1Schema` (strict at the top, stripping inside), as the zod engine's tree.
const SCENE_TREE: &str = r#"{"nodes":[
{"t":"object","catchall":"strict","shape":[["version",1],["stage",2],["avatars",3],["props",4]]},
{"t":"literal","values":[1]},
{"t":"optional","in":5},
{"t":"optional","in":9},
{"t":"optional","in":15},
{"t":"object","shape":[["width",6],["height",6],["backgroundKey",7]]},
{"t":"number","checks":[{"k":"gt","v":0,"incl":false},{"k":"lt","v":10000,"incl":true}]},
{"t":"optional","in":8},
{"t":"string","checks":[{"k":"max_length","n":120}]},
{"t":"array","el":10,"checks":[{"k":"max_length","n":200}]},
{"t":"object","shape":[["id",11],["participantId",11],["position",12],["facing",13],["labelKey",7]]},
{"t":"string","checks":[{"k":"min_length","n":1},{"k":"max_length","n":64}]},
{"t":"object","shape":[["x",14],["y",14]]},
{"t":"optional","in":14},
{"t":"number"},
{"t":"array","el":16,"checks":[{"k":"max_length","n":500}]},
{"t":"object","shape":[["id",11],["kind",11],["position",12],["rotation",13]]}
]}"#;

/// The scene tree has no refines.
pub struct NoRefines;

impl Refiner for NoRefines {
    fn refine(&self, id: &str, _value: &Value) -> Result<bool, String> {
        Err(format!("no refine {id} in this tree"))
    }
}

fn tree() -> Result<&'static Schema, String> {
    static TREE: OnceLock<Result<Schema, String>> = OnceLock::new();
    TREE.get_or_init(|| {
        let doc = json::parse(SCENE_TREE).map_err(|e| e.message)?;
        Schema::from_json(&doc)
    })
    .as_ref()
    .map_err(Clone::clone)
}

/// Why a scene was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bad {
    Invalid,
    Oversized,
}

impl Bad {
    pub fn name(self) -> &'static str {
        match self {
            Bad::Invalid => "invalid",
            Bad::Oversized => "oversized",
        }
    }
}

/// `ParseSceneResult`.
#[derive(Debug, Clone, PartialEq)]
pub enum Parsed {
    Ok(Value),
    Err { reason: Bad, message: String },
}

/// `JSON.stringify(input ?? null)`.
pub fn stringify(input: &Value) -> String {
    match input {
        Value::Undefined => "null".to_owned(),
        v => v
            .to_json()
            .map_or_else(|| "null".to_owned(), |j| j.compact()),
    }
}

/// `parseScene`: the size budget first, then the schema; zod's messages joined with `; `.
pub fn parse_scene(input: &Value) -> Parsed {
    let bytes = stringify(input).len();
    if bytes > SCENE_MAX_BYTES {
        return Parsed::Err {
            reason: Bad::Oversized,
            message: format!("scene exceeds {SCENE_MAX_BYTES} bytes (got {bytes})"),
        };
    }
    let outcome = tree().and_then(|t| t.parse(0, input.clone(), &NoRefines).map_err(|e| e.0));
    match outcome {
        Ok(Outcome::Ok(scene)) => Parsed::Ok(scene),
        Ok(Outcome::Issues(issues)) => {
            let joined = issues
                .iter()
                .map(|i| i.message().to_owned())
                .collect::<Vec<_>>()
                .join("; ");
            Parsed::Err {
                reason: Bad::Invalid,
                message: if joined.is_empty() {
                    "scene failed schema".to_owned()
                } else {
                    joined
                },
            }
        }
        Err(broken) => Parsed::Err {
            reason: Bad::Invalid,
            message: broken,
        },
    }
}

/// `emptyScene()`: `{ version: 1 }`.
pub fn empty_scene() -> Value {
    Value::Object(vec![("version".to_owned(), Value::Number(1.0))])
}

/// The stored scene's parse, or the empty scene when it does not read (the historic `{}` default).
pub fn readable_or_empty(stored: &Value) -> Value {
    match parse_scene(stored) {
        Parsed::Ok(s) => s,
        Parsed::Err { .. } => empty_scene(),
    }
}

/// `assertScene`: the scene, or `academy.scene_invalid` with the parse's message.
pub fn assert_scene(input: &Value) -> Result<Value, crate::errors::AcademyError> {
    match parse_scene(input) {
        Parsed::Ok(s) => Ok(s),
        Parsed::Err { message, .. } => Err(crate::errors::AcademyError::new(
            message,
            "academy.scene_invalid",
        )),
    }
}

/// `sceneFingerprint`: sha256 hex of `JSON.stringify(scene)`.
pub fn fingerprint(scene: &Value) -> String {
    Sha256::digest(stringify(scene).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn list_len(scene: &Value, key: &str) -> usize {
    scene.get(key).as_array().map_or(0, <[Value]>::len)
}

/// `scene.stage != null`.
fn has_stage(scene: &Value) -> bool {
    !matches!(scene.get("stage"), Value::Undefined | Value::Null)
}

/// `sceneRequiresHostFingerprint`: the server scene has a stage, an avatar or a prop.
pub fn requires_host_fingerprint(scene: &Value) -> bool {
    has_stage(scene) || list_len(scene, "avatars") > 0 || list_len(scene, "props") > 0
}

/// `hasExpectedFingerprint`: a token that is not blank after JavaScript's trim.
pub fn has_expected_fingerprint(token: Option<&str>) -> bool {
    token.is_some_and(|t| !service_kit::schema::js_trim(t).is_empty())
}

/// `HostSceneWriteRefuseName`.
pub const FINGERPRINT_MISMATCH: &str = "fingerprint_mismatch";
pub const FINGERPRINT_REQUIRED: &str = "fingerprint_required";

/// `HostSceneWriteResult`.
#[derive(Debug, Clone, PartialEq)]
pub enum Write {
    Ok { scene: Value, fingerprint: String },
    Conflict { name: &'static str, message: String },
    Refused { reason: Bad, message: String },
    PresenceCollision { message: String },
}

fn presence_collision(scene: &Value) -> Option<String> {
    let mut ids: Vec<String> = Vec::new();
    let mut participants: Vec<String> = Vec::new();
    for a in scene.get("avatars").as_array().unwrap_or(&[]) {
        let id = a.get("id").js_string();
        if ids.contains(&id) {
            return Some(format!("duplicate avatar id {id}"));
        }
        ids.push(id);
        let participant = a.get("participantId").js_string();
        if participants.contains(&participant) {
            return Some(format!("duplicate participantId {participant}"));
        }
        participants.push(participant);
    }
    let mut prop_ids: Vec<String> = Vec::new();
    for p in scene.get("props").as_array().unwrap_or(&[]) {
        let id = p.get("id").js_string();
        if prop_ids.contains(&id) {
            return Some(format!("duplicate prop id {id}"));
        }
        prop_ids.push(id);
    }
    None
}

/// `decideHostSceneWrite`: a fingerprint is required on a non-empty scene, a given one must match, then the schema
/// and size, then the presence invariant. Never a merge.
pub fn decide_host_scene_write(current: &Value, next: &Value, expected: Option<&str>) -> Write {
    let token = expected
        .filter(|t| has_expected_fingerprint(Some(t)))
        .map(service_kit::schema::js_trim);
    if requires_host_fingerprint(current) && token.is_none() {
        return Write::Conflict {
            name: FINGERPRINT_REQUIRED,
            message: "scene fingerprint required after non-empty scene — reload and retry"
                .to_owned(),
        };
    }
    if let Some(token) = token
        && token != fingerprint(current)
    {
        return Write::Conflict {
            name: FINGERPRINT_MISMATCH,
            message: "scene fingerprint mismatch — reload and retry (concurrent host write)"
                .to_owned(),
        };
    }
    let scene = match parse_scene(next) {
        Parsed::Ok(s) => s,
        Parsed::Err { reason, message } => return Write::Refused { reason, message },
    };
    if let Some(message) = presence_collision(&scene) {
        return Write::PresenceCollision { message };
    }
    let fingerprint = fingerprint(&scene);
    Write::Ok { scene, fingerprint }
}

/// `hostSceneWriteRefuseName`.
pub fn refuse_name(result: &Write) -> Option<&'static str> {
    match result {
        Write::Conflict { name, .. } => Some(name),
        _ => None,
    }
}

// ── Durable state (`scene-state.ts`) ───────────────────────────────────────────────────────────────────────────────

/// `SCENE_EMPTY_REFUSE`.
pub const SCENE_EMPTY_REFUSE: &str = "academy.scene_empty";

/// `SceneStateResult`.
#[derive(Debug, Clone, PartialEq)]
pub enum State {
    Ok {
        scene: Value,
        /// `empty` or `populated`.
        occupancy: &'static str,
        /// `stored` or `empty_default`.
        source: &'static str,
    },
    Err {
        reason: Bad,
        message: String,
    },
}

/// `isDurableSceneEmpty`.
pub fn is_durable_scene_empty(scene: &Value) -> bool {
    !has_stage(scene) && list_len(scene, "avatars") == 0 && list_len(scene, "props") == 0
}

fn ok_from_scene(scene: Value, source: &'static str) -> State {
    let occupancy = if is_durable_scene_empty(&scene) {
        "empty"
    } else {
        "populated"
    };
    State::Ok {
        scene,
        occupancy,
        source,
    }
}

fn from_parse(input: &Value, source: &'static str) -> State {
    match parse_scene(input) {
        Parsed::Ok(s) => ok_from_scene(s, source),
        Parsed::Err { reason, message } => State::Err { reason, message },
    }
}

/// `persistSceneState`.
pub fn persist_scene_state(input: &Value) -> State {
    from_parse(input, "stored")
}

/// `loadSceneState`: missing, null or `{}` is the honest empty scene; anything else must read.
pub fn load_scene_state(stored: &Value) -> State {
    let blank = match stored {
        Value::Undefined | Value::Null => true,
        Value::Object(o) => o.is_empty(),
        _ => false,
    };
    if blank {
        return ok_from_scene(empty_scene(), "empty_default");
    }
    from_parse(stored, "stored")
}

/// `requirePopulatedScene`: the scene, or the named refusal's message.
pub fn require_populated_scene(scene: &Value) -> Result<&Value, &'static str> {
    if is_durable_scene_empty(scene) {
        Err("scene is empty — no stage, avatars, or props; refuse fake room")
    } else {
        Ok(scene)
    }
}

// ── The L3 cards (`scene.ts`) ─────────────────────────────────────────────────────────────────────────────────────

/// `sceneByteSize`.
pub fn byte_size(input: &Value) -> usize {
    stringify(input).len()
}

/// `sceneWithinSizeBudget`.
pub fn within_size_budget(input: &Value) -> bool {
    let n = byte_size(input);
    n > 0 && n <= SCENE_MAX_BYTES
}

/// `sceneAvatarCount`, `scenePropCount`.
pub fn avatar_count(scene: &Value) -> usize {
    list_len(scene, "avatars")
}
pub fn prop_count(scene: &Value) -> usize {
    list_len(scene, "props")
}

/// `sceneStatusLine`.
pub fn status_line(scene: &Value) -> String {
    format!(
        "v={} avatars={} props={} bytes={}",
        scene.get("version").js_string(),
        avatar_count(scene),
        prop_count(scene),
        byte_size(scene)
    )
}

/// `sceneStatusLineDetailed`.
pub fn status_line_detailed(scene: &Value) -> String {
    format!(
        "{} stage={} ok={}",
        status_line(scene),
        if has_stage(scene) { "1" } else { "0" },
        if within_size_budget(scene) { "1" } else { "0" }
    )
}

/// `parseSceneStatusLine`: `^v=(\d+) avatars=(\d+) props=(\d+) bytes=(\d+)$` after a trim.
pub fn parse_status_line(line: &str) -> Option<[u64; 4]> {
    let parts: Vec<&str> = service_kit::schema::js_trim(line).split(' ').collect();
    let [v, a, p, b] = parts.as_slice() else {
        return None;
    };
    let num = |s: &str, key: &str| {
        let d = s.strip_prefix(key)?;
        (!d.is_empty() && d.bytes().all(|c| c.is_ascii_digit())).then(|| d.parse::<u64>().ok())?
    };
    Some([
        num(v, "v=")?,
        num(a, "avatars=")?,
        num(p, "props=")?,
        num(b, "bytes=")?,
    ])
}

/// `sceneExportHeader`, `sceneExportLine`, `sceneExportText`.
pub fn export_header() -> &'static str {
    "version,avatars,props,bytes,hasStage"
}
pub fn export_line(scene: &Value) -> String {
    format!(
        "{},{},{},{},{}",
        scene.get("version").js_string(),
        avatar_count(scene),
        prop_count(scene),
        byte_size(scene),
        if has_stage(scene) { "1" } else { "0" }
    )
}
pub fn export_text(scene: &Value) -> String {
    format!("{}\n{}", export_header(), export_line(scene))
}

/// `SCENE_NAVIGABLE_SHELL_RESIDUAL`.
pub const SCENE_NAVIGABLE_SHELL_RESIDUAL: &str = "TRK-academy.spatial — navigable shell is Canvas.vue; VR client residual (socket.vr-client); do not invent a finished VR product";

/// `sceneNavigableShellIsResidual`.
pub fn navigable_shell_is_residual(residual: &str) -> bool {
    residual.contains("VR") && residual.contains("residual") && residual.contains("do not invent")
}

/// A scene as the wire carries it.
pub fn to_json(scene: &Value) -> Json {
    scene.to_json().unwrap_or(Json::Null)
}
