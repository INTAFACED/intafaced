//! svc-blueprint's own refines: the `.refine(...)` checks its input schemas carry (`packages/contracts/src/blueprint.ts`),
//! by the name `scripts/record-door.mjs` gives each in `door/schemas.json`. Each takes the value zod hands a refine
//! (the part's parsed output) and answers as the TypeScript function does.

use service_kit::schema::{Refiner, Value};

/// Every refine the schemas name.
pub const NAMES: [&str; 1] = ["subject_or_share"];

/// The refines, for the kit's zod engine.
pub struct BlueprintRefines;

/// `value[key] !== undefined`.
fn given(fields: &[(String, Value)], key: &str) -> bool {
    fields
        .iter()
        .any(|(k, v)| k == key && !matches!(v, Value::Undefined))
}

impl Refiner for BlueprintRefines {
    fn refine(&self, id: &str, value: &Value) -> Result<bool, String> {
        match id {
            // `cardOfInput`: `(value) => value.userId !== undefined || value.shareId !== undefined`.
            "subject_or_share" => Ok(match value {
                Value::Object(o) => given(o, "userId") || given(o, "shareId"),
                _ => false,
            }),
            other => Err(format!("no refine named {other}")),
        }
    }
}
