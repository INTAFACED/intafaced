//! An operator's corrective reversal of a posted transaction (OPS-ledger-desk-02): `POST /trpc/operatorReverse`, which
//! svc-ops alone may call once two founders approved the correction on its desk.
//!
//! The ledger builds the post itself, from the stored original: [`operator_reverse`] is
//! `packages/ledger-client/src/recipes/operator-reverse.ts`'s `operatorReverse`, case for case (the tests below are
//! that file's). Every leg of the original, its direction flipped, the same amount, under
//! `ops:reversal:<originalTxId>:<n>` with `meta.reverses` naming the original. The caller names the original and the
//! desk's stored ordinal `n`, never a leg. The post is booked with [`crate::posting::book`], so the custody switch, the
//! freeze, the balance checks, the chain and the replay of a booked key all apply unchanged. It is not a recipe of the
//! gate's catalog, so `/trpc/post` refuses a hand-assembled reversal (`ledger.recipe_required`).
//!
//! One original has one reversal. The door refuses a second key with `ledger.reversal_already_reversed`, naming the
//! first; the database holds the rule for a race (`ledger_tx_one_operator_reversal_idx`, migration
//! `20261123173000_operator_reversal_once.sql`): of two keys racing, one books, and the other's insert fails, after
//! which the door finds the winner and answers the same refusal.

use postgres::{GenericClient, IsolationLevel};
use service_kit::json::Json;
use service_kit::money::{js_trim, parse_amount};
use service_kit::schema::{Outcome as Parsed, Value};
use service_kit::time::Instant;

use crate::db::{Store, StoreError};
use crate::errors::{self, Failure};
use crate::posting::Posting;
use crate::posting::rules::{AccountRef, Direction, Entry, PostRequest};

pub const MODULE: &str = "ops";
pub const REASON: &str = "operator.reversal";
pub const ALREADY_REVERSED: &str = "ledger.reversal_already_reversed";
pub const TX_NOT_FOUND: &str = "ledger.tx_not_found";

fn invalid(message: &str) -> Failure {
    Failure::ledger(errors::INVALID_ENTRY, message)
}

/// A UUID in either case, as the recipe's pattern takes it.
fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// A whole number from one, at most 19 digits, as a decimal string.
fn is_ordinal(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=19).contains(&b.len())
        && matches!(b.first(), Some(b'1'..=b'9'))
        && b.iter().all(u8::is_ascii_digit)
}

/// `operatorReversalKey(originalTxId, ordinal)`.
pub fn reversal_key(original_tx_id: &str, ordinal: &str) -> Result<String, Failure> {
    if !is_uuid(original_tx_id) {
        return Err(invalid(
            "A reversal names the original transaction by its id (a UUID)",
        ));
    }
    if !is_ordinal(ordinal) {
        return Err(invalid(
            "A reversal ordinal is a whole number from one, as a decimal string",
        ));
    }
    Ok(format!(
        "ops:reversal:{}:{ordinal}",
        original_tx_id.to_ascii_lowercase()
    ))
}

/// `operatorReverse(input)`: the original's legs, each flipped, keyed and linked to it.
pub fn operator_reverse(
    original_tx_id: &str,
    entries: &[Entry],
    ordinal: &str,
    why: &str,
    case_ref: &str,
) -> Result<PostRequest, Failure> {
    let idempotency_key = reversal_key(original_tx_id, ordinal)?;
    let why = js_trim(why);
    if why.is_empty() {
        return Err(invalid(
            "A reversal needs the reason the operators approved",
        ));
    }
    let case_ref = js_trim(case_ref);
    if case_ref.is_empty() {
        return Err(invalid(
            "A reversal needs the case reference of its approval",
        ));
    }
    if entries.is_empty() {
        return Err(invalid("A reversal needs the original transaction legs"));
    }
    Ok(PostRequest {
        idempotency_key,
        module: MODULE.to_owned(),
        reason: REASON.to_owned(),
        entries: entries
            .iter()
            .map(|e| Entry {
                account: e.account.clone(),
                direction: match e.direction {
                    Direction::Debit => Direction::Credit,
                    Direction::Credit => Direction::Debit,
                },
                amount: e.amount,
            })
            .collect(),
        meta: Some(vec![
            (
                "reverses".to_owned(),
                Json::str(original_tx_id.to_ascii_lowercase()),
            ),
            ("caseRef".to_owned(), Json::str(case_ref)),
            ("why".to_owned(), Json::str(why)),
        ]),
        correlation_id: None,
    })
}

// ── The book ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// The transaction that reversed `original` (its id and key), if one is booked.
pub fn reversed_by(
    c: &mut impl GenericClient,
    original: &str,
) -> Result<Option<(String, String)>, StoreError> {
    let rows = c.query(
        "SELECT id::text, idempotency_key FROM ledger.ledger_tx
          WHERE module = 'ops' AND reason = 'operator.reversal' AND meta->>'reverses' = $1",
        &[&original],
    )?;
    match rows.first() {
        Some(r) => Ok(Some((r.try_get(0)?, r.try_get(1)?))),
        None => Ok(None),
    }
}

/// The original's legs as the book stored them, in entry order; none when no transaction has that id.
pub fn original_legs(
    c: &mut impl GenericClient,
    original: &str,
) -> Result<Option<Vec<Entry>>, StoreError> {
    if c.query(
        "SELECT 1 FROM ledger.ledger_tx WHERE id = $1::text::uuid",
        &[&original],
    )?
    .is_empty()
    {
        return Ok(None);
    }
    let rows = c.query(
        "SELECT a.owner_type::text, a.owner_id, a.asset_id, a.kind::text, a.purpose, e.direction::text, e.amount::text
           FROM ledger.ledger_entries e JOIN ledger.accounts a ON a.id = e.account_id
          WHERE e.tx_id = $1::text::uuid ORDER BY e.id ASC",
        &[&original],
    )?;
    let mut legs = Vec::with_capacity(rows.len());
    for r in &rows {
        let purpose: String = r.try_get(4)?;
        let direction: String = r.try_get(5)?;
        let amount: String = r.try_get(6)?;
        legs.push(Entry {
            account: AccountRef {
                owner_type: r.try_get(0)?,
                owner_id: r.try_get(1)?,
                asset_id: r.try_get(2)?,
                kind: r.try_get(3)?,
                purpose: (!purpose.is_empty()).then_some(purpose),
            },
            direction: match direction.as_str() {
                "debit" => Direction::Debit,
                "credit" => Direction::Credit,
                other => {
                    return Err(StoreError::new(
                        format!("ledger_entries.direction {other} is not a direction"),
                        None,
                    ));
                }
            },
            amount: parse_amount(&amount)
                .map_err(|e| StoreError::new(format!("ledger_entries.amount: {e}"), None))?,
        });
    }
    Ok(Some(legs))
}

// ── The door ─────────────────────────────────────────────────────────────────────────────────────────────────────

fn body(message: &str, code: &str) -> Vec<(String, Json)> {
    vec![
        ("message".to_owned(), Json::str(message)),
        ("code".to_owned(), Json::str(code)),
    ]
}

/// 409 `ledger.reversal_already_reversed`, naming the first reversing transaction.
fn already_reversed(original: &str, first: &str) -> (u16, Json) {
    let mut o = body(
        &format!("Transaction {original} is already reversed by {first}; it is reversed once"),
        ALREADY_REVERSED,
    );
    o.push(("reversedBy".to_owned(), Json::str(first)));
    (409, Json::Object(o))
}

fn text<'a>(input: &'a Value, key: &str) -> &'a str {
    input.get(key).as_str().unwrap_or("")
}

/// `operatorReverse` past the door's caller check and its input schema (`operatorReverse` in `door/schemas.json`).
pub fn answer(store: &Store, posting: &Posting, input: &Value) -> (u16, Json) {
    let original = text(input, "originalTxId").to_ascii_lowercase();
    let ordinal = text(input, "ordinal");
    let key = match reversal_key(&original, ordinal) {
        Ok(k) => k,
        Err(f) => return errors::http_error(&f),
    };
    let read = store.begin(IsolationLevel::RepeatableRead, true, |c| {
        Ok((original_legs(c, &original)?, reversed_by(c, &original)?))
    });
    let (legs, first) = match read {
        Ok(r) => r,
        Err(_) => return errors::http_error(&Failure::Fault),
    };
    let Some(legs) = legs else {
        return (
            404,
            Json::Object(body(&format!("no transaction {original}"), TX_NOT_FOUND)),
        );
    };
    if let Some((first, first_key)) = first
        && first_key != key
    {
        return already_reversed(&original, &first);
    }
    let post = match operator_reverse(
        &original,
        &legs,
        ordinal,
        text(input, "reason"),
        text(input, "caseRef"),
    ) {
        Ok(p) => p,
        Err(f) => return errors::http_error(&f),
    };
    match crate::posting::book(store, posting, &post) {
        Ok(tx) => {
            let reply = Json::obj([
                ("txId", Json::str(tx.id.clone())),
                ("idempotencyKey", Json::str(tx.idempotency_key.clone())),
                ("postedAt", Json::str(Instant(tx.posted_at_ms).iso())),
                ("reverses", Json::str(original.clone())),
            ]);
            // The ledger's own reply breaking its record is this service's fault, a 500.
            match crate::door::parse("operatorReverseReply", Value::from_json(&reply)) {
                Ok(Parsed::Ok(checked)) => (200, checked.to_json().unwrap_or(reply)),
                _ => errors::http_error(&Failure::Fault),
            }
        }
        Err(failure) => {
            // A reversal that lost a race to another key fails on the one-reversal index: name the winner.
            let winner = store
                .pool()
                .and_then(|p| crate::db::with_client(p, |c| reversed_by(c, &original)));
            match winner {
                Ok(Some((first, first_key))) if first_key != key => {
                    already_reversed(&original, &first)
                }
                _ => errors::http_error(&failure),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::panic,
        clippy::indexing_slicing,
        reason = "a test: a failure is the point"
    )]
    use super::*;
    use service_kit::money::Amount;

    // The cases of `packages/ledger-client/src/recipes/operator-reverse.test.ts`, case for case.
    const ORIGINAL: &str = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const CUSTOMER: &str = "11111111-1111-4111-8111-111111111111";

    fn available(owner_type: &str, owner_id: &str, asset: &str) -> AccountRef {
        AccountRef {
            owner_type: owner_type.to_owned(),
            owner_id: owner_id.to_owned(),
            asset_id: asset.to_owned(),
            kind: "available".to_owned(),
            purpose: None,
        }
    }

    fn leg(account: AccountRef, direction: Direction, amount: &str) -> Entry {
        Entry {
            account,
            direction,
            amount: parse_amount(amount).unwrap(),
        }
    }

    fn legs() -> Vec<Entry> {
        vec![
            leg(
                available("treasury", "rail:local-test", "USDT"),
                Direction::Credit,
                "10.5",
            ),
            leg(
                available("user", CUSTOMER, "USDT"),
                Direction::Debit,
                "10.5",
            ),
            leg(
                available("user", CUSTOMER, "BTC"),
                Direction::Credit,
                "0.000000000000000001",
            ),
            leg(
                available("house", "fees:trade", "BTC"),
                Direction::Debit,
                "0.000000000000000001",
            ),
        ]
    }

    fn reverse(ordinal: &str, why: &str, case_ref: &str) -> Result<PostRequest, Failure> {
        operator_reverse(ORIGINAL, &legs(), ordinal, why, case_ref)
    }

    fn ok() -> PostRequest {
        reverse("1", " LOCAL TEST posted to the wrong account ", " case-7 ").unwrap()
    }

    fn message(r: Result<PostRequest, Failure>) -> String {
        match r {
            Err(Failure::Ledger { code, message }) if code == errors::INVALID_ENTRY => message,
            other => panic!("not an invalid entry: {other:?}"),
        }
    }

    #[test]
    fn keys_the_reversal_by_the_original_id_lower_cased_and_the_stored_ordinal_and_links_it_in_meta()
     {
        let post = reverse("12", " LOCAL TEST posted to the wrong account ", " case-7 ").unwrap();
        assert_eq!(
            post.idempotency_key,
            "ops:reversal:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:12"
        );
        assert_eq!(post.module, "ops");
        assert_eq!(post.reason, "operator.reversal");
        assert_eq!(
            post.meta,
            Some(vec![
                (
                    "reverses".to_owned(),
                    Json::str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
                ),
                ("caseRef".to_owned(), Json::str("case-7")),
                (
                    "why".to_owned(),
                    Json::str("LOCAL TEST posted to the wrong account")
                ),
            ])
        );
    }

    #[test]
    fn flips_each_leg_same_account_same_amount_in_the_same_order() {
        let post = ok();
        let original = legs();
        assert_eq!(post.entries.len(), original.len());
        for (r, o) in post.entries.iter().zip(&original) {
            assert_eq!(r.account, o.account);
            assert_eq!(r.amount, o.amount);
            assert_ne!(r.direction, o.direction);
        }
        assert_eq!(post.entries[0].direction, Direction::Debit);
        assert_eq!(post.entries[1].direction, Direction::Credit);
    }

    #[test]
    fn nets_to_zero_per_asset_and_per_account_with_the_original() {
        let mut per_asset: Vec<(String, Amount)> = Vec::new();
        let mut per_account: Vec<(String, Amount)> = Vec::new();
        for e in legs().iter().chain(&ok().entries) {
            for (list, k) in [
                (&mut per_asset, e.account.asset_id.clone()),
                (&mut per_account, e.account.key()),
            ] {
                match list.iter_mut().find(|(key, _)| *key == k) {
                    Some((_, sum)) => *sum += e.delta(),
                    None => list.push((k, e.delta())),
                }
            }
        }
        assert!(per_asset.iter().all(|(_, s)| *s == Amount::ZERO));
        assert!(per_account.iter().all(|(_, s)| *s == Amount::ZERO));
        let mut assets: Vec<&str> = per_asset.iter().map(|(a, _)| a.as_str()).collect();
        assets.sort_unstable();
        assert_eq!(assets, ["BTC", "USDT"]);
    }

    #[test]
    fn refuses_an_ordinal_that_is_not_a_whole_number_from_one() {
        for ordinal in [
            "0",
            "-1",
            "1.5",
            "01",
            "",
            " 1",
            "1e3",
            "12345678901234567890",
        ] {
            assert_eq!(
                message(reverse(ordinal, "w", "c")),
                "A reversal ordinal is a whole number from one, as a decimal string",
                "{ordinal}"
            );
        }
        assert!(
            reverse("1234567890123456789", "w", "c")
                .unwrap()
                .idempotency_key
                .ends_with(":1234567890123456789")
        );
    }

    #[test]
    fn refuses_a_blank_reason_or_case_reference() {
        for why in ["", "   "] {
            assert_eq!(
                message(reverse("1", why, "c")),
                "A reversal needs the reason the operators approved"
            );
        }
        for case_ref in ["", "\t "] {
            assert_eq!(
                message(reverse("1", "w", case_ref)),
                "A reversal needs the case reference of its approval"
            );
        }
    }

    #[test]
    fn refuses_an_original_with_no_entries_and_an_original_not_named_by_a_uuid() {
        assert_eq!(
            message(operator_reverse(ORIGINAL, &[], "1", "w", "c")),
            "A reversal needs the original transaction legs"
        );
        assert_eq!(
            message(operator_reverse("not-a-uuid", &legs(), "1", "w", "c")),
            "A reversal names the original transaction by its id (a UUID)"
        );
    }
}
