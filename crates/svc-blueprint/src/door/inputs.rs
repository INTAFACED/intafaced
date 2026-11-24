//! Every call's input check: the zod schemas of svc-blueprint's records (`packages/contracts/src/blueprint-procedures.ts`)
//! as `services/svc-blueprint/src/router.ts` mounts them, recorded as a tree in `schemas.json` (by
//! `scripts/record-door.mjs`) and run by the kit's zod engine (`service_kit::schema`) with the Blueprint's refines
//! (`crate::refines`). `tests/input_parity.rs` holds every schema to zod's own verdicts.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use service_kit::json::{self, Json};
use service_kit::schema::{self, Issue, Outcome, Schema, Value};

use crate::refines::BlueprintRefines;

/// The recorded tree, as `scripts/record-door.mjs` writes it.
pub const SCHEMAS_JSON: &str = include_str!("schemas.json");

struct Inputs {
    schema: Schema,
    roots: BTreeMap<String, usize>,
}

fn load() -> Result<Inputs, String> {
    let doc = json::parse(SCHEMAS_JSON).map_err(|e| e.message)?;
    let schema = Schema::from_json(&doc)?;
    let Some(Json::Object(inputs)) = doc.get("inputs") else {
        return Err("schemas.json: no inputs".to_owned());
    };
    let mut roots = BTreeMap::new();
    for (path, id) in inputs {
        let Json::Number(n) = id else {
            return Err(format!("schemas.json: {path} names no part"));
        };
        let id = format!("{n}")
            .parse::<usize>()
            .map_err(|e| format!("schemas.json: {path}: {e}"))?;
        roots.insert(path.clone(), id);
    }
    Ok(Inputs { schema, roots })
}

fn inputs() -> Result<&'static Inputs, String> {
    static INPUTS: OnceLock<Result<Inputs, String>> = OnceLock::new();
    INPUTS.get_or_init(load).as_ref().map_err(Clone::clone)
}

/// Why an input was refused.
#[derive(Debug, Clone, PartialEq)]
pub enum Refused {
    /// zod's issues: tRPC answers 400 with them as pretty JSON.
    Issues(Vec<Issue>),
    /// A refine threw: tRPC answers 400 with its message.
    Thrown(String),
}

impl Refused {
    /// The message tRPC's 400 carries.
    pub fn message(&self) -> String {
        match self {
            Refused::Issues(i) => schema::message(i),
            Refused::Thrown(m) => m.clone(),
        }
    }
}

/// Whether a call reads an input at all.
pub fn has_schema(path: &str) -> Result<bool, String> {
    Ok(inputs()?.roots.contains_key(path))
}

/// The number of parts in the recorded tree (each schema's parts once).
pub fn part_count() -> Result<usize, String> {
    Ok(inputs()?.schema.len())
}

/// `procedure.input(schema)` as tRPC runs it: the parsed input (`undefined` for a call with no schema), or why not.
/// `Err(String)` only when the recorded tree itself cannot be read.
pub fn parse(path: &str, input: Option<&Json>) -> Result<Result<Value, Refused>, String> {
    let inputs = inputs()?;
    let value = input.map_or(Value::Undefined, Value::from_json);
    let Some(root) = inputs.roots.get(path) else {
        return Ok(Ok(value));
    };
    Ok(match inputs.schema.parse(*root, value, &BlueprintRefines) {
        Ok(Outcome::Ok(v)) => Ok(v),
        Ok(Outcome::Issues(i)) => Err(Refused::Issues(i)),
        Err(t) => Err(Refused::Thrown(t.0)),
    })
}

/// `schema.safeParse(value)` for one recorded part.
pub fn parse_part(part: usize, value: Value) -> Result<Result<Value, Refused>, String> {
    Ok(
        match inputs()?.schema.parse(part, value, &BlueprintRefines) {
            Ok(Outcome::Ok(v)) => Ok(v),
            Ok(Outcome::Issues(i)) => Err(Refused::Issues(i)),
            Err(t) => Err(Refused::Thrown(t.0)),
        },
    )
}
