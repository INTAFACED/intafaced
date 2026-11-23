//! The TEST partner bank's own book on loopback (`partner/test-partner-record.ts`, `index.ts`): what a journey
//! compares the app with. Mounted only with the TEST partner, which refuses to start outside dev or test, and a caller
//! off loopback is refused. Read straight from the book, so no switch shapes it.
//!
//! `GET /test-partner/venue`, `POST /test-partner/{balances,accounts,moves,open-orders,onboarding,account-details,
//! direct-debits,dd-refund}`.

use service_kit::json::Json;
use service_kit::money::format_amount;
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::time::Instant;

use super::compliance::REQUIREMENTS;
use super::{AccountRef, LABEL, Move, TestPartner};
use crate::errors::Refusal;
use crate::partner_account::account_details::test_set;

/// The doors' base (`TEST_PARTNER_RECORD_BASE`) and the partner's venue id (`TEST_PARTNER_RECORD_ID`).
pub const BASE: &str = "/test-partner";
pub const RECORD_ID: &str = "test-partner-bank";
/// The routes Fastify mounts, with their methods.
pub const ROUTES: [(&str, &str); 9] = [
    ("GET", "/venue"),
    ("POST", "/balances"),
    ("POST", "/accounts"),
    ("POST", "/moves"),
    ("POST", "/open-orders"),
    ("POST", "/onboarding"),
    ("POST", "/account-details"),
    ("POST", "/direct-debits"),
    ("POST", "/dd-refund"),
];

/// `onLoopback`.
pub fn on_loopback(peer: &str) -> bool {
    matches!(peer, "127.0.0.1" | "::1" | "::ffff:127.0.0.1")
}

fn r(a: &AccountRef) -> Json {
    Json::obj([
        ("owner", Json::str(&a.user_id)),
        ("assetId", Json::str(&a.asset_id)),
        (
            "spaceId",
            a.space_id.as_deref().map_or(Json::Null, Json::str),
        ),
    ])
}

fn move_line(m: &Move) -> Json {
    Json::obj([
        ("id", Json::str(&m.id)),
        ("key", Json::str(&m.key)),
        ("from", r(&m.from)),
        ("to", r(&m.to)),
        ("amount", Json::str(format_amount(m.amount))),
        ("movedAt", Json::str(m.moved_at.iso())),
    ])
}

fn refund_line(f: &super::desks::Refund) -> Json {
    Json::obj([
        ("owner", Json::str(&f.user_id)),
        ("mandateId", Json::str(&f.mandate_id)),
        ("collectionId", Json::str(&f.collection_id)),
        ("assetId", Json::str(&f.asset_id)),
        ("amount", Json::str(format_amount(f.amount))),
        ("moveId", Json::str(&f.move_id)),
        ("refundedAt", Json::str(f.refunded_at.iso())),
    ])
}

fn answer_json(status: u16, body: Json) -> (u16, Json) {
    (status, body)
}

fn error(status: u16, message: &str) -> (u16, Json) {
    answer_json(status, Json::obj([("error", Json::str(message))]))
}

fn test(value: Json) -> (u16, Json) {
    answer_json(
        200,
        Json::obj([("label", Json::str("TEST")), ("value", value)]),
    )
}

/// `answerTestPartnerRecord`: one request below the base.
pub fn answer(
    partner: &TestPartner,
    method: &str,
    path: &str,
    body: &Value,
    now: Instant,
) -> (u16, Json) {
    match path {
        "/venue" => {
            if method != "GET" {
                return error(405, "GET only");
            }
            return answer_json(
                200,
                Json::obj([
                    ("label", Json::str("TEST")),
                    (
                        "venue",
                        Json::obj([
                            ("id", Json::str(RECORD_ID)),
                            ("displayName", Json::str(LABEL)),
                        ]),
                    ),
                ]),
            );
        }
        "/direct-debits" => {
            if method != "POST" {
                return error(405, "POST only");
            }
            let report = partner.lock().dd_report(now);
            return test(Json::obj([
                (
                    "mandates",
                    Json::Array(
                        report
                            .mandates
                            .iter()
                            .map(|(owner, mandate, blocked, _)| {
                                Json::obj([
                                    ("owner", Json::str(owner)),
                                    ("mandateId", Json::str(mandate)),
                                    (
                                        "state",
                                        Json::str(if blocked.is_some() {
                                            "blocked"
                                        } else {
                                            "active"
                                        }),
                                    ),
                                    (
                                        "blockedAt",
                                        blocked.map_or(Json::Null, |b| Json::str(b.iso())),
                                    ),
                                ])
                            })
                            .collect(),
                    ),
                ),
                (
                    "failures",
                    Json::Array(
                        report
                            .failures
                            .iter()
                            .map(|(owner, mandate, collection, code)| {
                                Json::obj([
                                    ("owner", Json::str(owner)),
                                    ("mandateId", Json::str(mandate)),
                                    ("collectionId", Json::str(collection)),
                                    ("code", Json::str(code)),
                                ])
                            })
                            .collect(),
                    ),
                ),
                (
                    "refunds",
                    Json::Array(report.refunds.iter().map(refund_line).collect()),
                ),
            ]));
        }
        "/dd-refund" => {
            if method != "POST" {
                return error(405, "POST only");
            }
            let (Some(owner), Some(mandate), Some(collection)) = (
                body.get("owner").as_str(),
                body.get("mandateId").as_str(),
                body.get("collectionId").as_str(),
            ) else {
                return error(400, "owner, mandateId and collectionId are required");
            };
            return match partner.lock().dd_refund(owner, mandate, collection, now) {
                Ok(f) => test(refund_line(&f)),
                Err(Refusal::Bank(e)) => answer_json(
                    409,
                    Json::obj([
                        ("error", Json::str(&e.message)),
                        ("code", Json::str(e.row.code)),
                    ]),
                ),
                Err(_) => error(500, "the TEST partner could not answer"),
            };
        }
        "/balances" | "/accounts" | "/moves" | "/open-orders" | "/onboarding"
        | "/account-details" => {}
        _ => return error(404, "no such path"),
    }
    if method != "POST" {
        return error(405, "POST only");
    }
    let account = body.get("account");
    if account.get("venueId").as_str() != Some(RECORD_ID) {
        return error(400, &format!("account.venueId must be {RECORD_ID}"));
    }
    let Some(owner) = account.get("owner").as_str().filter(|o| !o.is_empty()) else {
        return error(400, "account.owner (a user id) is required");
    };
    if !matches!(account.get("subAccount"), Value::Null | Value::Undefined) {
        return error(400, "the partner keeps no sub-accounts");
    }
    let state = partner.lock();
    if path == "/onboarding" {
        // Oldest first, as the partner opened them.
        let mut requests = state.compliance.requests(owner);
        requests.reverse();
        return test(Json::obj([
            (
                "requirements",
                Json::Array(REQUIREMENTS.iter().map(|r| Json::str(*r)).collect()),
            ),
            (
                "identityCaseAccepted",
                Json::Bool(state.board.read(owner, |s| s.identity_case == "accepted")),
            ),
            (
                "requests",
                Json::Array(
                    requests
                        .iter()
                        .map(|q| {
                            Json::obj([
                                ("id", Json::str(&q.id)),
                                ("title", Json::str(q.title)),
                                ("status", Json::str(q.status)),
                                ("dueAt", Json::str(q.due_at.iso())),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]));
    }
    if path == "/account-details" {
        // The details it issued the person in one currency and the holder name it keeps the account in (J-bank-30 #2),
        // from its switches, never through `salary.details`.
        let Some(currency) = body
            .get("currency")
            .as_str()
            .filter(|c| c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase()))
        else {
            return error(400, "currency (three capital letters) is required");
        };
        let (issued, holder) = state.board.read(owner, |s| {
            (s.account_details == "issued", s.holder_name.clone())
        });
        return test(Json::obj([
            ("issued", Json::Bool(issued)),
            (
                "holderName",
                holder.as_deref().map_or(Json::Null, Json::str),
            ),
            (
                "sets",
                Json::Array(if issued {
                    vec![test_set(owner, currency).json()]
                } else {
                    Vec::new()
                }),
            ),
        ]));
    }
    if path == "/open-orders" {
        // The one TEST order it reports open for the person, from its own switch (as its `openOrders` answers).
        return test(Json::Array(
            state
                .open_orders(owner)
                .iter()
                .map(|o| Json::obj([("id", Json::str(&o.id)), ("asset", Json::str(&o.asset_id))]))
                .collect(),
        ));
    }
    let book = state.record(owner);
    if path == "/accounts" {
        // Every account it holds for the person, main balances and spaces, each once, with the amount in it
        // (J-bank-01 #3 #5).
        return test(Json::Array(
            book.accounts
                .iter()
                .map(|(a, amount)| {
                    Json::obj([
                        ("asset", Json::str(&a.asset_id)),
                        (
                            "spaceId",
                            a.space_id.as_deref().map_or(Json::Null, Json::str),
                        ),
                        ("amount", Json::str(format_amount(*amount))),
                    ])
                })
                .collect(),
        ));
    }
    if path == "/moves" {
        return test(Json::Array(book.moves.iter().map(move_line).collect()));
    }
    // The person's main balance in each currency, in the venue read's row shape: nothing is locked at the partner.
    test(Json::Array(
        book.accounts
            .iter()
            .filter(|(a, _)| a.space_id.is_none())
            .map(|(a, amount)| {
                Json::obj([
                    ("asset", Json::str(&a.asset_id)),
                    ("free", Json::str(format_amount(*amount))),
                    ("locked", Json::str("0")),
                    ("total", Json::str(format_amount(*amount))),
                ])
            })
            .collect(),
    ))
}

/// The door for one request, when it is for a mounted route: loopback only. (The TypeScript also sends
/// `cache-control: no-store`; the kit's answer carries no headers, and nothing reads them on loopback.)
///
/// Fastify answers a method a route is not mounted for with its own 404, so only the mounted method reaches
/// `answer`; the body is Fastify's parse (`rest::read_body`).
pub fn door(
    partner: &TestPartner,
    method: &str,
    path: &str,
    peer: &str,
    body: impl FnOnce() -> Result<Value, Response>,
    now: Instant,
) -> Option<Response> {
    let below = path.strip_prefix(BASE)?;
    if !ROUTES.iter().any(|(m, p)| *m == method && *p == below) {
        return None;
    }
    // Fastify reads the body before the handler, so a body it refuses is refused before the loopback check.
    let body = match body() {
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
    let (status, out) = answer(partner, method, below, &body, now);
    Some(Response {
        status,
        body: out.compact(),
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use crate::partner::{Funding, MoveRequest};
    use service_kit::json;
    use service_kit::money::parse_amount;

    const ADA: &str = "0b5e7c1a-0000-4000-8000-00000000ada0";

    fn post(partner: &TestPartner, path: &str, body: &str) -> (u16, String) {
        let at = Instant::start_of_year(2026);
        let res = door(
            partner,
            "POST",
            &format!("{BASE}{path}"),
            "127.0.0.1",
            || Ok(Value::from_json(&json::parse(body).unwrap())),
            at,
        )
        .unwrap_or_else(|| panic!("{path} is not mounted"));
        (res.status, res.body)
    }

    fn person(extra: &str) -> String {
        format!(
            r#"{{"account":{{"venueId":"{RECORD_ID}","owner":"{ADA}","subAccount":null}}{extra}}}"#
        )
    }

    fn switch(partner: &TestPartner, change: &str) {
        let mut state = partner.lock();
        let next = state
            .board
            .get(ADA)
            .with(&Value::from_json(&json::parse(change).unwrap()));
        state.board.set(ADA, next);
    }

    /// J-bank-01 #3 #5 read `/accounts` for every account the partner holds, main balances and spaces.
    #[test]
    fn accounts_lists_each_main_balance_and_space_with_its_amount() {
        let partner = TestPartner::new().unwrap();
        let at = Instant::start_of_year(2026);
        {
            let mut state = partner.lock();
            state
                .fund(
                    ADA,
                    &Funding {
                        fund_id: "f1".to_owned(),
                        asset_id: "USDT".to_owned(),
                        amount: parse_amount("100").unwrap(),
                    },
                    at,
                )
                .unwrap();
            state.open_currency(ADA, "USDC", at).unwrap();
            state.open_currency(ADA, "USDC", at).unwrap();
            let mut space = AccountRef::main(ADA, "USDT");
            space.space_id = Some("s1".to_owned());
            state
                .move_raw(
                    &MoveRequest {
                        key: "space:s1:in".to_owned(),
                        from: AccountRef::main(ADA, "USDT"),
                        to: space,
                        amount: parse_amount("20").unwrap(),
                        payees: None,
                    },
                    at,
                )
                .unwrap();
        }
        assert_eq!(
            post(&partner, "/accounts", &person("")),
            (
                200,
                r#"{"label":"TEST","value":[{"asset":"USDT","spaceId":null,"amount":"80"},{"asset":"USDC","spaceId":null,"amount":"0"},{"asset":"USDT","spaceId":"s1","amount":"20"}]}"#.to_owned()
            )
        );
    }

    #[test]
    fn a_partner_that_is_down_opens_no_currency_account() {
        let partner = TestPartner::new().unwrap();
        switch(&partner, r#"{"down":true}"#);
        let at = Instant::start_of_year(2026);
        assert!(matches!(
            partner.lock().open_currency(ADA, "USDC", at),
            Err(Refusal::Bank(e)) if e.row.code == "bank.partner_unavailable"
        ));
        switch(&partner, r#"{"down":false}"#);
        assert_eq!(
            post(&partner, "/accounts", &person("")),
            (200, r#"{"label":"TEST","value":[]}"#.to_owned())
        );
    }

    #[test]
    fn open_orders_answers_the_switched_order_and_none_without_it() {
        let partner = TestPartner::new().unwrap();
        assert_eq!(
            post(&partner, "/open-orders", &person("")),
            (200, r#"{"label":"TEST","value":[]}"#.to_owned())
        );
        switch(&partner, r#"{"openOrder":"EUR"}"#);
        assert_eq!(
            post(&partner, "/open-orders", &person("")),
            (
                200,
                format!(
                    r#"{{"label":"TEST","value":[{{"id":"TEST-order:{ADA}:EUR","asset":"EUR"}}]}}"#
                )
            )
        );
    }

    /// J-bank-01 #6 and J-bank-30 #2 read the details the partner issued in one currency.
    #[test]
    fn account_details_answers_the_issued_set_its_holder_and_refuses_a_bad_currency() {
        let partner = TestPartner::new().unwrap();
        let (status, body) = post(
            &partner,
            "/account-details",
            &person(r#","currency":"EUR""#),
        );
        assert_eq!(status, 200, "{body}");
        assert_eq!(
            body,
            r#"{"label":"TEST","value":{"issued":false,"holderName":null,"sets":[]}}"#
        );
        switch(
            &partner,
            r#"{"accountDetails":"issued","holderName":"TEST Ada"}"#,
        );
        let number = format!("TEST-EUR-{}", ADA.replace('-', "").to_uppercase());
        assert_eq!(
            post(
                &partner,
                "/account-details",
                &person(r#","currency":"EUR""#)
            ),
            (
                200,
                format!(
                    r#"{{"label":"TEST","value":{{"issued":true,"holderName":"TEST Ada","sets":[{{"id":"test-partner:{ADA}:EUR","accountNumber":"{number}","sortCode":null,"routingNumber":null,"bsb":null,"iban":null,"bic":null,"partnerBank":"{LABEL}","restrictions":["TEST details: no real account exists and nothing can be received"]}}]}}}}"#
                )
            )
        );
        for bad in ["", r#","currency":"eur""#, r#","currency":"EURO""#] {
            assert_eq!(
                post(&partner, "/account-details", &person(bad)),
                (
                    400,
                    r#"{"error":"currency (three capital letters) is required"}"#.to_owned()
                )
            );
        }
    }
}
