//! svc-agents' own refines: the `.refine(...)` checks its TypeScript schemas carry, by the name
//! `scripts/record-door.mjs` gives each in `door/schemas.json`. Each takes the value zod hands a refine (the part's
//! parsed output) and answers as the TypeScript function does.

use service_kit::schema::{Refiner, Value};

/// Every refine the schemas name.
pub const NAMES: [&str; 1] = ["at_most_eight_keys"];

/// The refines, for the kit's zod engine.
pub struct AgentsRefines;

impl Refiner for AgentsRefines {
    fn refine(&self, id: &str, value: &Value) -> Result<bool, String> {
        match id {
            // `(args) => Object.keys(args).length <= 8`: a tool call's arguments (`own/routes.ts`).
            "at_most_eight_keys" => Ok(match value {
                Value::Object(o) => o.len() <= 8,
                _ => true,
            }),
            other => Err(format!("no refine named {other}")),
        }
    }
}
