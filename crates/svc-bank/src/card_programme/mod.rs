//! The card programme slice (`PORT.md`): the founder console's card programme desk (`ops/card-programme-ops.ts`,
//! `cards/programme/programme-ops.ts`, 16 calls: `ops.cardProgramme*` but the read below) and the programme's read and
//! funding (`ops/card-programme.ts`: `ops.cardProgramme`, `ops.cardProgrammeFunding`, `ops.requestCardProgrammeFunding`).
//!
//! Nothing here holds a balance or posts to the ledger. Card money is the card partner's: a funding instruction is told
//! to the partner and recorded, a reassign moves a card and never money, and the TEST card event simulator drives slice
//! `card-ops`' authorise, capture and reverse (which answer "not ported" until it is). Every change on the desk writes one
//! audit row, which the database refuses to edit; a staff member with the viewer role reads everything and changes
//! nothing.
//!
//! - `rules`: an authorisation rule's words and whether it would decline one authorisation (`programme/rules.ts`).
//! - `desk`: settings and the checklist, the rules (shadow, promote, roll back), staff and the audit log, the decision
//!   log and one authorisation, the report and its signed export, and the desk's first paint.
//! - `holders`: cardholders behind the KYC and KYB gate with screening, their cards and funds, bulk issue, reassign and
//!   the simulator's gate.
//! - `funding`: the programme read, programme funding and a funding instruction.
//! - `router`: the calls.

pub mod desk;
pub mod funding;
pub mod holders;
pub mod router;
pub mod rules;

use postgres::GenericClient;
use service_kit::json::{self, Json};
use service_kit::schema::Value;

use crate::errors::Refusal;
use crate::loans::prices::{Marks, PriceSource};
use crate::partner::refuse;
use crate::spaces::space::pg;

/// A rate source that answers nothing: the replay's `stub('cardRates')`, which throws, and `displayMarks` reads silent.
pub struct NoRates;

impl PriceSource for NoRates {
    fn marks(&self, _: &[String], _: &str) -> Marks {
        Marks::new()
    }
}

/// What the binary hands the slice (`index.ts`'s `cardProgramme` options, `receiptSecret` and the cards' `rates`).
pub struct Wiring {
    /// `BANK_CARDHOLDER_SANCTIONS`: the owner's cardholder sanctions list, names separated by `|`.
    pub sanctions: Option<String>,
    /// A dev or test stack (`APP_ENV` dev or test, not `NODE_ENV=production`): the only place the simulator runs.
    pub simulator_allowed: bool,
    /// The service secret exports are signed under (`INTERNAL_SERVICE_SECRET`); unset refuses an export.
    pub export_secret: Option<String>,
    /// The rate source the programme's stablecoin conversion reads (svc-trade's ticker).
    pub rates: Box<dyn PriceSource>,
}

impl Wiring {
    /// No list, no simulator, no secret and no rates: what a door gets until the binary hands one in.
    pub fn none() -> Wiring {
        Wiring {
            sanctions: None,
            simulator_allowed: false,
            export_secret: None,
            rates: Box::new(NoRates),
        }
    }
}

/// What every part of the slice is handed for one call: the cards slice's dependencies and this slice's wiring.
pub struct Deps<'a> {
    pub cards: &'a crate::cards::Deps<'a>,
    pub w: &'a Wiring,
}

impl Deps<'_> {
    pub fn store(&self) -> &crate::db::Store {
        self.cards.store()
    }

    /// `this.test`: the issuer's own simulated flag.
    pub fn test(&self) -> bool {
        self.cards.issuer().programme().simulated
    }
}

/// The desk's list length (`LIST`).
pub const LIST: i64 = 50;

/// `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
pub fn is_uuid(s: &str) -> bool {
    let groups: Vec<&str> = s.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// A JavaScript string's `length`: its UTF-16 units.
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `assertMayChange`: a viewer reads and changes nothing. An operator not on the staff list keeps what their session's
/// scopes allow.
pub fn assert_may_change(c: &mut impl GenericClient, actor: &str) -> Result<(), Refusal> {
    let role: Option<String> = c
        .query(
            "SELECT role FROM bank.card_programme_staff WHERE user_id = $1",
            &[&actor],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(|r| r.get(0));
    if role.as_deref() == Some("viewer") {
        return Err(refuse(
            "bank.card_programme_viewer",
            "Your card programme role is Viewer: you can read the programme but not change it (bank.card_programme_viewer)",
        ));
    }
    Ok(())
}

/// `audit`: one row, the values before and after as jsonb (null for none).
pub fn audit(
    c: &mut impl GenericClient,
    actor: &str,
    action: &str,
    target: &str,
    before: Option<&Json>,
    after: Option<&Json>,
) -> Result<(), Refusal> {
    let before = before.map(Json::compact);
    let after = after.map(Json::compact);
    c.execute(
        "INSERT INTO bank.card_programme_audit (actor, action, target, before, after) \
         VALUES ($1, $2, $3, $4::text::jsonb, $5::text::jsonb)",
        &[&actor, &action, &target, &before, &after],
    )
    .map_err(|e| pg(&e))?;
    Ok(())
}

/// A jsonb column read as text (`col::text`), as postgres.js hands it back.
pub fn jsonb(text: &str) -> Result<Json, Refusal> {
    json::parse(text).map_err(|e| Refusal::Other(e.message))
}

/// `schema.safeParse(value)` for one of the schemas the desk runs on a value it holds (`door/inputs.rs`'s
/// `HANDLER_SCHEMAS`): its output, or zod's issues.
pub fn safe_parse(
    name: &str,
    value: &Json,
) -> Result<Result<Json, Vec<service_kit::schema::Issue>>, Refusal> {
    match crate::door::inputs::parse_named(name, Value::from_json(value)).map_err(Refusal::Other)? {
        Ok(v) => Ok(Ok(v.to_json().unwrap_or(Json::Null))),
        Err(crate::door::inputs::Refused::Issues(i)) => Ok(Err(i)),
        Err(crate::door::inputs::Refused::Thrown(m)) => Err(Refusal::Other(m)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_uuid_is_five_hex_groups_of_any_case() {
        assert!(is_uuid("11111111-1111-4111-8111-11111111111A"));
        assert!(!is_uuid("11111111-1111-4111-8111-1111111111"));
        assert!(!is_uuid("placeholder"));
    }
}
