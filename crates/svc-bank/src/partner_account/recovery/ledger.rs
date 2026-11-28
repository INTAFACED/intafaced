//! svc-ledger as this slice's recovery claims and closure check read it (packages/ledger-client's http-client.ts
//! `balances`, through svc-bank's read budget in ledger-client.ts): one owner's balances, signed as svc-bank. svc-bank
//! holds no balance; every figure here is the ledger's answer at the moment of asking.
//!
//! A recovery sweep posts a `bankTransfer` recipe in the `recovery` key space through svc-ledger's `postRecipe` door,
//! as every other slice posts (`spaces::ports::LedgerHttp::post_recipe`): svc-ledger builds the entries from the recipe
//! and its business inputs; none is ever assembled here. A door built without the service's environment ([`Unwired`])
//! posts nothing and the sweep is refused before anything is written.

use std::time::{Duration, Instant as Clock};

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, js_trim, parse_amount};
use service_kit::s2s::CallSigner;

/// One ledger account (`AccountRef`). `purpose` is part of the account's identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountRef {
    pub owner_type: String,
    pub owner_id: String,
    pub asset_id: String,
    pub kind: String,
    pub purpose: Option<String>,
}

impl AccountRef {
    /// `userAvailable` and the sweep's `{ ownerType, ownerId, assetId, kind: 'available' }`.
    pub fn available(owner_type: &str, owner_id: &str, asset_id: &str) -> AccountRef {
        AccountRef {
            owner_type: owner_type.to_owned(),
            owner_id: owner_id.to_owned(),
            asset_id: asset_id.to_owned(),
            kind: "available".to_owned(),
            purpose: None,
        }
    }

    /// `accountPurpose`: the trimmed purpose, or empty.
    pub fn purpose(&self) -> &str {
        self.purpose.as_deref().map_or("", js_trim)
    }

    /// The account as `postRecipe`'s input names it, in `AccountRef`'s key order; `purpose` only when it has one.
    pub fn json(&self) -> Json {
        let mut fields = vec![
            ("ownerType".to_owned(), Json::str(self.owner_type.clone())),
            ("ownerId".to_owned(), Json::str(self.owner_id.clone())),
            ("assetId".to_owned(), Json::str(self.asset_id.clone())),
            ("kind".to_owned(), Json::str(self.kind.clone())),
        ];
        if !self.purpose().is_empty() {
            fields.push(("purpose".to_owned(), Json::str(self.purpose())));
        }
        Json::Object(fields)
    }

    /// `accountKey`.
    pub fn key(&self) -> String {
        format!(
            "{}:{}:{}:{}:{}",
            self.owner_type,
            self.owner_id,
            self.asset_id,
            self.kind,
            self.purpose()
        )
    }
}

/// One balance the ledger reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Balance {
    pub account: AccountRef,
    pub amount: Amount,
}

/// `recipes.bankTransfer({ transferId, occurrence, from, to, amount, kind: 'manual', keySpace })`: what the recipe is
/// asked to post, never its entries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BankTransfer {
    pub transfer_id: String,
    pub occurrence: i64,
    pub from: AccountRef,
    pub to: AccountRef,
    pub amount: Amount,
    pub key_space: &'static str,
}

/// Why a post did not book: the ledger's own refusal (`LedgerError` with its code), or anything else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PostError {
    Ledger { code: String, message: String },
    Other(String),
}

/// `DEFINITE_POST_REFUSAL_CODES`: only these prove nothing was booked.
pub const DEFINITE_POST_REFUSALS: [&str; 5] = [
    "ledger.insufficient_funds",
    "ledger.invalid_entry",
    "ledger.unbalanced",
    "ledger.owner_identity_space",
    "ledger.frozen",
];

/// svc-ledger as the slice uses it.
pub trait Ledger: Send + Sync {
    /// `balances(ownerType, ownerId)`; `Err` is a read that failed.
    fn balances(&self, owner_type: &str, owner_id: &str) -> Result<Vec<Balance>, String>;
    /// Whether a post door is wired at all.
    fn posts(&self) -> bool;
    /// `post(recipes.bankTransfer(...))`: the booked transaction's id.
    fn bank_transfer(&self, transfer: &BankTransfer) -> Result<String, PostError>;
}

/// A door built without the service's environment (no `INTERNAL_SERVICE_SECRET`, which env.ts requires): every read
/// fails, as the TypeScript replay's unwired ledger does, and nothing posts.
pub struct Unwired;

impl Ledger for Unwired {
    fn balances(&self, _: &str, _: &str) -> Result<Vec<Balance>, String> {
        Err("svc-ledger is not wired".to_owned())
    }

    fn posts(&self) -> bool {
        false
    }

    fn bank_transfer(&self, _: &BankTransfer) -> Result<String, PostError> {
        Err(PostError::Other(
            "no svc-ledger post door is wired".to_owned(),
        ))
    }
}

/// The read budget (`READ_BUDGET`): 3 s an attempt, one retry after 150 ms, 5 s for the call.
const READ_TIMEOUT_MS: u64 = 3_000;
const READ_DEADLINE_MS: u64 = 5_000;
const RETRY_DELAY_MS: u64 = 150;
/// `RETRYABLE_STATUS`.
const RETRYABLE: [u16; 3] = [502, 503, 504];

/// svc-ledger over HTTP (`createLedgerClient`'s reader), signed as svc-bank for svc-ledger.
pub struct HttpLedger {
    pub base: String,
    pub signer: CallSigner,
    pub fetch: Box<dyn Fetch>,
    /// svc-ledger's `postRecipe` door, as every slice posts through it; `None` for a reader that never posts.
    pub post: Option<Box<dyn crate::spaces::ports::Ledger>>,
}

/// `recipes.bankTransfer`'s input for `t`, and the business key svc-ledger books it under.
pub fn bank_transfer_input(t: &BankTransfer) -> (Json, String) {
    let kind = if t.key_space == "sched" {
        "scheduled"
    } else {
        "manual"
    };
    (
        Json::obj([
            ("transferId", Json::str(t.transfer_id.clone())),
            ("occurrence", Json::int(t.occurrence)),
            ("from", t.from.json()),
            ("to", t.to.json()),
            (
                "amount",
                Json::str(service_kit::money::format_amount(t.amount)),
            ),
            ("kind", Json::str(kind)),
            ("keySpace", Json::str(t.key_space)),
        ]),
        crate::transfers::moves::bank_transfer_key(t.key_space, &t.transfer_id, t.occurrence),
    )
}

impl HttpLedger {
    /// `createLedgerTransport`'s call: `POST <base><path>` with the body signed over its exact bytes.
    pub fn call_json(&self, path: &str, body: &Json) -> Result<Json, String> {
        let base = self.base.strip_suffix('/').unwrap_or(&self.base);
        let target = format!("{base}{path}");
        let parsed = url::Url::parse(&target).map_err(|_| "Invalid URL".to_owned())?;
        let signed_target = match parsed.query() {
            Some(q) => format!("{}?{q}", parsed.path()),
            None => parsed.path().to_owned(),
        };
        let payload = body.compact();
        let started = Clock::now();
        let mut attempt = 0u32;
        loop {
            let spent = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            let left = READ_DEADLINE_MS.saturating_sub(spent);
            if left == 0 {
                return Err(format!(
                    "svc-ledger call to {path} exceeded its {READ_DEADLINE_MS}ms deadline"
                ));
            }
            let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
            headers.extend(self.signer.sign(
                &payload,
                "POST",
                &signed_target,
                "application/json",
            )?);
            let res = self.fetch.fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: target.clone(),
                headers,
                body: Some(payload.clone()),
                timeout_ms: Some(READ_TIMEOUT_MS.min(left)),
                refuse_redirect: false,
            });
            let failure = match res {
                Err(e) => e.message,
                Ok(r) if r.ok() => match json::parse(&r.body) {
                    Ok(v) => return Ok(v),
                    Err(e) => e.message,
                },
                Ok(r) if RETRYABLE.contains(&r.status) => {
                    format!("svc-ledger {path} answered {}", r.status)
                }
                Ok(r) => return Err(format!("svc-ledger {path} answered {}", r.status)),
            };
            let spent = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            if attempt >= 1 || READ_DEADLINE_MS.saturating_sub(spent) <= RETRY_DELAY_MS {
                return Err(failure);
            }
            std::thread::sleep(Duration::from_millis(RETRY_DELAY_MS));
            attempt += 1;
        }
    }
}

fn text_of(row: &Json, key: &str) -> Result<String, String> {
    match row.get(key) {
        Some(Json::String(s)) => Ok(s.clone()),
        _ => Err(format!("svc-ledger balances: {key} is not a string")),
    }
}

/// `balancesWire`: each row's account id, asset, kind, optional purpose and amount; '' (or none) is no purpose.
pub fn parse_balances(
    owner_type: &str,
    owner_id: &str,
    answer: &Json,
) -> Result<Vec<Balance>, String> {
    let Json::Array(rows) = answer else {
        return Err("svc-ledger balances: not a list".to_owned());
    };
    rows.iter()
        .map(|row| {
            if !matches!(row, Json::Object(_)) {
                return Err("svc-ledger balances: a row is not an object".to_owned());
            }
            text_of(row, "accountId")?;
            let purpose = match row.get("purpose") {
                None => None,
                Some(Json::String(p)) => Some(p.clone()).filter(|p| !p.is_empty()),
                Some(_) => return Err("svc-ledger balances: purpose is not a string".to_owned()),
            };
            Ok(Balance {
                account: AccountRef {
                    owner_type: owner_type.to_owned(),
                    owner_id: owner_id.to_owned(),
                    asset_id: text_of(row, "assetId")?,
                    kind: text_of(row, "kind")?,
                    purpose,
                },
                amount: parse_amount(&text_of(row, "amount")?)?,
            })
        })
        .collect()
}

impl Ledger for HttpLedger {
    fn balances(&self, owner_type: &str, owner_id: &str) -> Result<Vec<Balance>, String> {
        let body = Json::obj([
            ("ownerType", Json::str(owner_type)),
            ("ownerId", Json::str(owner_id)),
        ]);
        parse_balances(
            owner_type,
            owner_id,
            &self.call_json("/trpc/balances", &body)?,
        )
    }

    fn posts(&self) -> bool {
        self.post.is_some()
    }

    fn bank_transfer(&self, t: &BankTransfer) -> Result<String, PostError> {
        let Some(post) = self.post.as_ref() else {
            return Err(PostError::Other(
                "no svc-ledger post door is wired".to_owned(),
            ));
        };
        let (input, key) = bank_transfer_input(t);
        match post.post_recipe("bankTransfer", &input, &key) {
            Ok(tx) => Ok(tx.id),
            Err(crate::spaces::ports::PostFailure::Coded { code, message, .. }) => {
                Err(PostError::Ledger { code, message })
            }
            Err(crate::spaces::ports::PostFailure::Unknown(m)) => Err(PostError::Other(m)),
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "a test")]
    use super::*;
    use service_kit::http::{FetchError, HttpResponse};
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct Seen(Arc<Mutex<Vec<HttpRequest>>>, Vec<(u16, &'static str)>);

    impl Fetch for Seen {
        fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
            let mut seen = self.0.lock().unwrap();
            seen.push(req.clone());
            let (status, body) = self.1.get(seen.len() - 1).copied().unwrap_or((500, ""));
            Ok(HttpResponse {
                status,
                body: body.to_owned(),
            })
        }
    }

    fn ledger(answers: Vec<(u16, &'static str)>) -> (HttpLedger, Seen) {
        let seen = Seen(Arc::new(Mutex::new(Vec::new())), answers);
        let l = HttpLedger {
            base: "http://ledger:4001/".to_owned(),
            signer: CallSigner::new(
                "svc-bank",
                "svc-ledger",
                "a-ledger-test-secret-that-is-long-enough-0",
                None,
            ),
            fetch: Box::new(seen.clone()),
            post: None,
        };
        (l, seen)
    }

    #[test]
    fn balances_are_one_signed_post_and_keep_the_purpose() {
        let (l, seen) = ledger(vec![(
            200,
            r#"[{"accountId":"a","assetId":"EUR","kind":"hold","purpose":"order:1","amount":"2.5"},{"accountId":"b","assetId":"EUR","kind":"available","purpose":"","amount":"-1"}]"#,
        )]);
        let rows = l.balances("user", "u1").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].account.key(), "user:u1:EUR:hold:order:1");
        assert_eq!(rows[1].account.purpose, None);
        assert_eq!(
            rows[1].amount,
            Amount::from_scaled(-1_000_000_000_000_000_000)
        );
        let seen = seen.0.lock().unwrap();
        assert_eq!(seen[0].url, "http://ledger:4001/trpc/balances");
        assert_eq!(
            seen[0].body.as_deref(),
            Some(r#"{"ownerType":"user","ownerId":"u1"}"#)
        );
        assert_eq!(seen[0].headers[0].0, "content-type");
        assert!(seen[0].headers.len() > 1);
    }

    #[test]
    fn a_gateway_error_is_retried_once_and_a_refusal_is_not() {
        let (l, seen) = ledger(vec![(503, ""), (200, "[]")]);
        assert_eq!(l.balances("user", "u1").unwrap(), Vec::new());
        assert_eq!(seen.0.lock().unwrap().len(), 2);
        let (l, seen) = ledger(vec![(400, "{}"), (200, "[]")]);
        assert!(l.balances("user", "u1").is_err());
        assert_eq!(seen.0.lock().unwrap().len(), 1);
        assert!(Unwired.balances("user", "u").is_err());
    }

    /// svc-ledger's recipe door as the post sees it: each call recorded, answered in turn.
    struct Recipes(
        Arc<Mutex<Vec<(String, String, String)>>>,
        Mutex<Vec<Result<&'static str, crate::spaces::ports::PostFailure>>>,
    );

    impl crate::spaces::ports::Ledger for Recipes {
        fn balance(&self, _: &crate::spaces::ports::LedgerAccount) -> Result<Amount, String> {
            Err("not read here".to_owned())
        }
        fn balances(
            &self,
            _: &str,
            _: &str,
        ) -> Result<Vec<crate::spaces::ports::LedgerBalance>, String> {
            Err("not read here".to_owned())
        }
        fn assets(&self) -> Result<Vec<Json>, String> {
            Err("not read here".to_owned())
        }
        fn post_recipe(
            &self,
            recipe: &str,
            input: &Json,
            key: &str,
        ) -> Result<crate::spaces::ports::LedgerTx, crate::spaces::ports::PostFailure> {
            self.0
                .lock()
                .unwrap()
                .push((recipe.to_owned(), input.compact(), key.to_owned()));
            self.1
                .lock()
                .unwrap()
                .remove(0)
                .map(|id| crate::spaces::ports::LedgerTx {
                    id: id.to_owned(),
                    key: key.to_owned(),
                    posted_at: service_kit::time::Instant(0),
                    entries: Vec::new(),
                })
        }
    }

    #[test]
    fn a_sweep_posts_the_bank_transfer_recipe_under_the_key_its_row_records() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (mut l, _) = ledger(Vec::new());
        assert!(!l.posts(), "a reader with no post door posts nothing");
        assert!(matches!(
            l.bank_transfer(&BankTransfer {
                transfer_id: "c".to_owned(),
                occurrence: 1,
                from: AccountRef::available("user", "owner", "USDT"),
                to: AccountRef::available("user", "heir", "USDT"),
                amount: parse_amount("1").unwrap(),
                key_space: "recovery",
            }),
            Err(PostError::Other(_))
        ));
        l.post = Some(Box::new(Recipes(
            calls.clone(),
            Mutex::new(vec![
                Ok("tx-1"),
                Err(crate::spaces::ports::PostFailure::Coded {
                    code: "ledger.insufficient_funds".to_owned(),
                    message: "short".to_owned(),
                    attempts: 1,
                }),
                Err(crate::spaces::ports::PostFailure::Unknown(
                    "timeout".to_owned(),
                )),
            ]),
        )));
        assert!(l.posts());
        let from = AccountRef::available("user", "owner", "USDT");
        // The sweep row's key (`plan`): bank.transfer.recovery:<claim>:<account key>:<round>.
        let row_key = format!("bank.transfer.recovery:claim-1:{}:2", from.key());
        let t = BankTransfer {
            transfer_id: format!("claim-1:{}", from.key()),
            occurrence: 2,
            from,
            to: AccountRef::available("user", "heir", "USDT"),
            amount: parse_amount("12.5").unwrap(),
            key_space: "recovery",
        };
        assert_eq!(l.bank_transfer(&t), Ok("tx-1".to_owned()));
        assert_eq!(
            l.bank_transfer(&t),
            Err(PostError::Ledger {
                code: "ledger.insufficient_funds".to_owned(),
                message: "short".to_owned()
            })
        );
        assert_eq!(
            l.bank_transfer(&t),
            Err(PostError::Other("timeout".to_owned()))
        );
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].0, "bankTransfer");
        assert_eq!(calls[0].2, row_key);
        assert_eq!(
            calls[0].1,
            format!(
                r#"{{"transferId":"claim-1:{}","occurrence":2,"from":{{"ownerType":"user","ownerId":"owner","assetId":"USDT","kind":"available"}},"to":{{"ownerType":"user","ownerId":"heir","assetId":"USDT","kind":"available"}},"amount":"12.5","kind":"manual","keySpace":"recovery"}}"#,
                AccountRef::available("user", "owner", "USDT").key()
            )
        );
    }
}
