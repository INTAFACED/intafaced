//! Any reserve a partner holds of ours (`partner/reserves.ts`, `POST /internal/capital/partner-reserves`; J-ops-console-24
//! #1), as each partner adapter reports it, for svc-ops' capital monitor alone. The door's 401 and 403 are `door::jobs`';
//! this is its answer once svc-ops is the caller.
//!
//! Two partners can hold one: the partner bank and the card partner. A reserve whose amount the partner has not told us
//! is `not_known`, never zero and never `none`. A partner this deployment has no adapter for is absent. Nothing here
//! reads or writes the ledger.

use service_kit::json::Json;
use service_kit::server::Response;
use service_kit::time::Instant;

use crate::cards::issuer::Issuer;
use crate::cards::terms::{PartnerTerms, Reserve};
use crate::door::BankDoor;
use crate::errors::Refusal;
use crate::partner::{LABEL, TestPartner};

fn status(s: &str) -> Json {
    Json::obj([("status", Json::str(s))])
}

/// `partnerReservesRead`: the TEST partner bank (it never reports an amount: required with none told is "not known"),
/// then the card partner's own reserve at its own time.
pub fn read(partner: Option<&TestPartner>, card: Option<&PartnerTerms>, now: Instant) -> Json {
    let mut partners = Vec::new();
    // `programmeReserve`: the TEST partner bank requires a reserve and never says how much.
    if partner.is_some() {
        partners.push(Json::obj([
            ("partner", Json::str("bank")),
            ("label", Json::str(LABEL)),
            ("test", Json::Bool(true)),
            ("reserve", status("not_known")),
        ]));
    }
    if let Some(terms) = card {
        // The partner's own time for its reserve: one it sent with no time is "not known", never our read time.
        let reserve = match (&terms.reserve, terms.figures_as_of_at(now)) {
            (None, _) | (_, None) => status("not_known"),
            (Some(Reserve::Required { amount, asset_id }), Some(at)) => Json::obj([
                ("status", Json::str("reported")),
                ("assetId", Json::str(asset_id.clone())),
                ("amount", Json::str(amount.clone())),
                ("asOf", Json::str(at.iso())),
            ]),
            (Some(Reserve::NotRequired), Some(_)) => status("none"),
        };
        partners.push(Json::obj([
            ("partner", Json::str("card")),
            (
                "label",
                Json::str(if terms.test {
                    "TEST partner card"
                } else {
                    "Card partner"
                }),
            ),
            ("test", Json::Bool(terms.test)),
            ("reserve", reserve),
        ]));
    }
    Json::obj([
        ("asOf", Json::str(now.iso())),
        ("partners", Json::Array(partners)),
    ])
}

/// `cardTermsOrNone`: the card partner's terms, or `None` when no card issuer is configured. Any other refusal is
/// thrown, never read as none.
pub fn card_terms_or_none(issuer: &Issuer) -> Result<Option<PartnerTerms>, Refusal> {
    match issuer.partner_terms() {
        Ok(t) => Ok(Some(t)),
        Err(Refusal::Bank(e)) if e.row.code == "bank.no_card_issuer" => Ok(None),
        Err(e) => Err(e),
    }
}

/// The door's answer for svc-ops: the read, or what Fastify answers for an error the handler throws (500 with the
/// error's own code and message).
pub fn door(door: &BankDoor) -> Response {
    let now = door.now();
    match card_terms_or_none(&door.cards().issuer) {
        Ok(card) => Response {
            status: 200,
            body: read(door.partner().partner.as_ref(), card.as_ref(), now).compact(),
        },
        Err(e) => {
            let (code, message) = match &e {
                Refusal::Bank(b) => (Some(b.row.code), b.message.clone()),
                Refusal::Trpc(t) => (None, t.message.clone()),
                Refusal::Other(m) => (None, m.clone()),
            };
            let mut fields = vec![("statusCode", Json::int(500))];
            if let Some(code) = code {
                fields.push(("code", Json::str(code)));
            }
            fields.push(("error", Json::str("Internal Server Error")));
            fields.push(("message", Json::str(message)));
            Response {
                status: 500,
                body: Json::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
                    .compact(),
            }
        }
    }
}
