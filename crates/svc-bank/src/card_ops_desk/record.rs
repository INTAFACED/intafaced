//! LOCAL TEST: the TEST card partner's own book on loopback (`cards/test-card-partner-record.ts`, mounted in
//! `index.ts`), as `partner::record` is the TEST partner bank's: what a journey compares the app's dispute credit,
//! balance, loss liability, holds and funding with (J-bank-26 #5 #6, J-bank-27 #3 #4). Read from the simulator's own
//! book (its credits and funding instructions) and the TEST partner card's holds, never through the card calls.
//!
//! `GET /test-card-partner/venue`, `POST /test-card-partner/{balances,credits,terms,holds,funding}` with
//! `{ account: { venueId, owner } }`. Mounted only when the issuer is the simulator (not in a live posture, which keeps
//! no record), and a caller off loopback is refused. The simulator keeps its book in this process only.

use service_kit::json::Json;
use service_kit::money::format_amount;
use service_kit::schema::Value;
use service_kit::server::{Request, Response};

use crate::cards::issuer::{Issuer, with_credits};
use crate::cards::reads::{HoldReads, test_card_holds};
use crate::cards::terms::{FiguresAsOf, PartnerTerms, Reserve};
use crate::door::BankDoor;
use crate::errors::Refusal;
use crate::partner::record::on_loopback;

/// `TEST_CARD_PARTNER_RECORD_BASE`.
pub const BASE: &str = "/test-card-partner";
/// `TEST_CARD_PARTNER_RECORD_ID`.
pub const RECORD_ID: &str = "test-card-partner";
/// The routes `index.ts` mounts, with their methods (`TEST_CARD_PARTNER_RECORD_PATHS`).
pub const ROUTES: [(&str, &str); 6] = [
    ("GET", "/venue"),
    ("POST", "/balances"),
    ("POST", "/credits"),
    ("POST", "/terms"),
    ("POST", "/holds"),
    ("POST", "/funding"),
];

/// The partner card's held and captured figures for one cardholder and asset (`PartnerCardHolds`' `figures` and
/// `captured`); `None` is "not known".
pub trait RecordHolds {
    fn held(&self, user_id: &str, asset_id: &str) -> Result<Option<String>, Refusal>;
    fn captured(&self, user_id: &str, asset_id: &str) -> Result<Option<String>, Refusal>;
}

/// The TEST partner card's own book, as the stack runs it.
pub struct BookHolds<'a>(pub crate::cards::reads::TestCardHolds<'a>);

impl RecordHolds for BookHolds<'_> {
    fn held(&self, user_id: &str, asset_id: &str) -> Result<Option<String>, Refusal> {
        Ok(self.0.figures(user_id, asset_id)?.held)
    }

    /// `captured`: what the partner has captured for this cardholder in this asset, or `None` when it keeps no book.
    fn captured(&self, user_id: &str, asset_id: &str) -> Result<Option<String>, Refusal> {
        let mut book = self
            .0
            .book
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if book.book_of(self.0.terms, user_id, asset_id).is_none() {
            return Ok(None);
        }
        let sum: service_kit::money::Amount = book
            .holds
            .values()
            .filter(|h| h.user_id == user_id && h.asset_id == asset_id)
            .map(|h| h.captured)
            .sum();
        Ok(Some(format_amount(sum)))
    }
}

fn error(status: u16, message: &str) -> (u16, Json) {
    (status, Json::obj([("error", Json::str(message))]))
}

fn test(value: Json) -> (u16, Json) {
    (
        200,
        Json::obj([("label", Json::str("TEST")), ("value", value)]),
    )
}

fn opt(v: Option<&String>) -> Json {
    v.cloned().map_or(Json::Null, Json::str)
}

/// `terms` of the TEST card partner's book: each null when it reports nothing.
fn terms_json(t: &PartnerTerms) -> Json {
    Json::obj([
        (
            "lossLiability",
            t.loss_liability
                .as_ref()
                .map_or(Json::Null, |(bearer, words)| {
                    Json::obj([
                        ("bearer", Json::str(bearer.clone())),
                        ("terms", Json::str(words.clone())),
                    ])
                }),
        ),
        ("funder", opt(t.funder.as_ref())),
        (
            "reserve",
            match &t.reserve {
                None => Json::Null,
                Some(Reserve::NotRequired) => Json::obj([("required", Json::Bool(false))]),
                Some(Reserve::Required { amount, asset_id }) => Json::obj([
                    ("required", Json::Bool(true)),
                    ("amount", Json::str(amount.clone())),
                    ("assetId", Json::str(asset_id.clone())),
                ]),
            },
        ),
        (
            "programmeFigures",
            t.programme_figures.as_ref().map_or(Json::Null, |f| {
                Json::Object(
                    f.iter()
                        .map(|(asset, (held, captured))| {
                            (
                                asset.clone(),
                                Json::obj([
                                    ("held", Json::str(held.clone())),
                                    ("captured", Json::str(captured.clone())),
                                ]),
                            )
                        })
                        .collect(),
                )
            }),
        ),
        (
            "figuresAsOf",
            match &t.figures_as_of {
                None => Json::Null,
                Some(FiguresAsOf::Now) => Json::str("now"),
                Some(FiguresAsOf::At(at)) => Json::str(at.clone()),
            },
        ),
        ("fundingAssetId", opt(t.funding_asset_id.as_ref())),
        (
            "fundingOffers",
            t.funding_offers.map_or(Json::Null, |o| {
                Json::obj([
                    ("fund", Json::Bool(o.fund)),
                    ("defund", Json::Bool(o.defund)),
                    ("autoReload", Json::Bool(o.auto_reload)),
                ])
            }),
        ),
    ])
}

/// `answerTestCardPartnerRecord`: one request below the base, as `[status, body]`. `None` from an issuer that keeps no
/// record (no issuer, or the simulator in a live posture). A holds read that fails is the handler's throw.
pub fn answer(
    issuer: &Issuer,
    holds: Option<&dyn RecordHolds>,
    method: &str,
    path: &str,
    body: &Value,
) -> Option<Result<(u16, Json), Refusal>> {
    let partner = issuer.sim_partner()?;
    if path == "/venue" {
        if method != "GET" {
            return Some(Ok(error(405, "GET only")));
        }
        return Some(Ok((
            200,
            Json::obj([
                ("label", Json::str("TEST")),
                (
                    "venue",
                    Json::obj([
                        ("id", Json::str(RECORD_ID)),
                        ("displayName", Json::str(issuer.programme().display_name)),
                    ]),
                ),
            ]),
        )));
    }
    if !ROUTES.iter().any(|(_, p)| *p == path) {
        return Some(Ok(error(404, "no such path")));
    }
    if method != "POST" {
        return Some(Ok(error(405, "POST only")));
    }
    let account = body.get("account");
    if account.get("venueId").as_str() != Some(RECORD_ID) {
        return Some(Ok(error(
            400,
            &format!("account.venueId must be {RECORD_ID}"),
        )));
    }
    let owner = match account.get("owner") {
        Value::String(s) if !s.is_empty() => s.as_str(),
        _ => return Some(Ok(error(400, "account.owner (a user id) is required"))),
    };
    if !matches!(account.get("subAccount"), Value::Null | Value::Undefined) {
        return Some(Ok(error(400, "the card partner keeps no sub-accounts")));
    }
    let book = issuer.sim_book()?;
    let balances = with_credits(partner.balances.as_ref(), owner, &book.credits);
    Some(Ok(match path {
        "/credits" => test(Json::Array(
            book.credits
                .iter()
                .filter(|(_, c)| c.user_id == owner)
                .map(|(_, c)| {
                    Json::obj([
                        ("partnerRef", Json::str(c.partner_ref.clone())),
                        ("assetId", Json::str(c.asset_id.clone())),
                        ("amount", Json::str(format_amount(c.amount))),
                        ("reversed", Json::Bool(c.reversed)),
                    ])
                })
                .collect(),
        )),
        // Its terms as it reports them, whatever cardholder is named.
        "/terms" => test(terms_json(partner)),
        "/funding" => test(Json::Array(
            book.funding
                .iter()
                .map(|f| {
                    Json::obj([
                        ("requestId", Json::str(f.request_id.clone())),
                        ("kind", Json::str(f.kind.clone())),
                        ("assetId", Json::str(f.asset_id.clone())),
                        ("amount", Json::str(f.amount.clone())),
                        ("threshold", opt(f.threshold.as_ref())),
                        ("partnerRef", Json::str(f.partner_ref.clone())),
                    ])
                })
                .collect(),
        )),
        "/holds" => {
            // The simulator's book is released before the holds are read: they keep their own.
            drop(book);
            let mut value = Vec::new();
            for (asset, _) in balances.iter().flatten() {
                let Some(h) = holds else { continue };
                let held = match h.held(owner, asset) {
                    Ok(v) => v,
                    Err(e) => return Some(Err(e)),
                };
                let captured = match h.captured(owner, asset) {
                    Ok(v) => v,
                    Err(e) => return Some(Err(e)),
                };
                let (Some(held), Some(captured)) = (held, captured) else {
                    continue;
                };
                value.push(Json::obj([
                    ("asset", Json::str(asset.clone())),
                    ("held", Json::str(held)),
                    ("captured", Json::str(captured)),
                ]));
            }
            test(Json::Array(value))
        }
        // What the partner reports the cardholder can spend, in the venue read's row shape: an asset it reports
        // nothing for is left out, never 0.
        _ => test(Json::Array(
            balances
                .iter()
                .flatten()
                .map(|(asset, amount)| {
                    Json::obj([
                        ("asset", Json::str(asset.clone())),
                        ("free", Json::str(amount.clone())),
                        ("locked", Json::str("0")),
                        ("total", Json::str(amount.clone())),
                    ])
                })
                .collect(),
        )),
    }))
}

/// The door for one request, when it is for a mounted route: loopback only. (The TypeScript also sends
/// `cache-control: no-store`; the kit's answer carries no headers, and nothing reads them on loopback.) Fastify answers
/// a method a route is not mounted for with its own 404, so only the mounted method reaches `answer`.
pub fn door(door: &BankDoor, req: &Request<'_>, peer: &str) -> Option<Response> {
    let issuer = &door.cards().issuer;
    issuer.sim_partner()?;
    let path = req.url.split_once('?').map_or(req.url, |(p, _)| p);
    let below = path.strip_prefix(BASE)?;
    if !ROUTES.iter().any(|(m, p)| *m == req.method && *p == below) {
        return None;
    }
    // Fastify reads the body before the handler, so a body it refuses is refused before the loopback check.
    let body = match crate::door::rest::read_body(req) {
        Ok(Value::Undefined) => Value::Null,
        Ok(b) => b,
        Err(res) => return Some(res),
    };
    if !on_loopback(peer) {
        return Some(Response {
            status: 403,
            body: Json::obj([("error", Json::str("loopback only"))]).compact(),
        });
    }
    let answered = door.cards_deps(door.now(), |d| {
        let holds = test_card_holds(d, &door.cards().holds).map(BookHolds);
        answer(
            issuer,
            holds.as_ref().map(|h| h as &dyn RecordHolds),
            req.method,
            below,
            &body,
        )
    })?;
    Some(match answered {
        Ok((status, out)) => Response {
            status,
            body: out.compact(),
        },
        // A throw in the handler is Fastify's 500.
        Err(e) => {
            let message = match e {
                Refusal::Bank(b) => b.message,
                Refusal::Trpc(t) => t.message,
                Refusal::Other(m) => m,
            };
            Response {
                status: 500,
                body: Json::obj([
                    ("statusCode", Json::int(500)),
                    ("error", Json::str("Internal Server Error")),
                    ("message", Json::str(message)),
                ])
                .compact(),
            }
        }
    })
}
