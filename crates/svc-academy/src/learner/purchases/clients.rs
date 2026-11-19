//! The purchase module's outside clients, each as its TypeScript builds the request:
//!
//! - [`LedgerHttp`]: svc-ledger's `postRecipe` door (`purchase-ledger.ts` `createAcademyLedgerClient` over
//!   `packages/ledger-client` `createHttpRecipePoster`): signed per attempt for audience `svc-ledger`, 10 s per attempt,
//!   2 retries, 25 s in all, a retry only on a network failure, a timeout, a 502/503/504 or an unreadable 2xx body. The
//!   receipt must name the key, module and reason the recipe builds, or the outcome is unknown. It names a recipe and its
//!   inputs, never ledger entries (AGENTS.md floor 1).
//! - [`RefundHttp`]: the owner's refund signer (`refund-signer.ts`), 15 s.
//! - [`IdentityWallets`]: svc-identity's linked wallets (`linked-wallets.ts`), 3 s, a redirect refused.

use std::sync::Arc;
use std::time::{Duration, Instant as Clock};

use service_kit::http::{Fetch, FetchError, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::s2s::CallSigner;

use super::chain::is_tx_hash;
use crate::errors::Refusal;
use crate::ports::{Ledger, LinkedWallets, RefundSend, Refunds};

/// `LEDGER_ACK_INVALID_MESSAGE`.
pub const LEDGER_ACK_INVALID: &str = "svc-ledger invalid post acknowledgement; outcome unknown";
/// `LEDGER_POST_RECIPE.path`.
pub const POST_RECIPE_PATH: &str = "/trpc/postRecipe";
/// `ACADEMY_PURCHASE_MODULE`.
pub const ACADEMY_MODULE: &str = "academy";

/// `url.pathname + url.search` of an absolute URL.
pub fn path_of(url: &str) -> String {
    let after_scheme = url.find("://").map_or(url, |i| &url[i + 3..]);
    let path = after_scheme
        .find(['/', '?', '#'])
        .map_or("", |i| &after_scheme[i..]);
    let path = path.split('#').next().unwrap_or("");
    if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("/{path}")
    }
}

fn internal(message: impl Into<String>, code: Option<&str>) -> Refusal {
    Refusal::Internal {
        message: message.into(),
        code: code.map(str::to_owned),
    }
}

/// `POST_RECIPE_INPUT_INVALID`, refused before anything is sent.
const RECIPE_INPUT_INVALID: &str = "ledger.recipe_input_invalid";
const RECIPE_UNKNOWN: &str = "ledger.recipe_unknown";

fn is_amount(s: &str) -> bool {
    // ^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$, at most 64 characters.
    if s.len() > 64 {
        return false;
    }
    let (whole, fraction) = match s.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (s, None),
    };
    let whole_ok = whole == "0"
        || (!whole.is_empty()
            && !whole.starts_with('0')
            && whole.bytes().all(|c| c.is_ascii_digit()));
    let fraction_ok = fraction.is_none_or(|f| {
        (1..=18).contains(&f.len()) && f.bytes().all(|c| c.is_ascii_digit())
    });
    whole_ok && fraction_ok
}

fn is_counter(s: &str) -> bool {
    (1..=19).contains(&s.len()) && !s.starts_with('0') && s.bytes().all(|c| c.is_ascii_digit())
}

fn is_uuid(s: &str) -> bool {
    let groups: Vec<&str> = s.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
}

fn is_course(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && b.first().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn is_asset(s: &str) -> bool {
    let n = s.chars().count();
    (1..=32).contains(&n) && !s.chars().any(char::is_whitespace)
}

fn is_place_id(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 128
        && b.first().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b':' | b'_' | b'-'))
}

/// The receipt's reason each recipe builds, or none for a recipe the door does not post.
fn reason_of(recipe: &str) -> Option<&'static str> {
    match recipe {
        "academyPurchase" => Some("academy.purchase.posted"),
        "academyPurchaseRefund" => Some("academy.purchase.refunded"),
        _ => None,
    }
}

/// `postRecipeRequest`'s checks of the wire inputs (`academyPurchaseWire`, `academyRefundWire`), first failing field
/// named as zod names it.
fn check_inputs(recipe: &str, input: &Json) -> Result<(), Refusal> {
    let place_key = if recipe == "academyPurchase" { "to" } else { "from" };
    let Json::Object(fields) = input else {
        return Err(internal(format!("{recipe}: input: Invalid input"), Some(RECIPE_INPUT_INVALID)));
    };
    let str_field = |k: &str| match input.get(k) {
        Some(Json::String(s)) => Some(s.as_str()),
        _ => None,
    };
    type Check = (&'static str, fn(&str) -> bool);
    let checks: [Check; 6] = [
        ("course", is_course),
        ("userId", is_uuid),
        ("n", is_counter),
        ("assetId", is_asset),
        ("amount", is_amount),
        ("paymentId", |s| is_tx_hash(s)),
    ];
    for (key, ok) in checks {
        if !str_field(key).is_some_and(ok) {
            return Err(internal(format!("{recipe}: input.{key}: Invalid"), Some(RECIPE_INPUT_INVALID)));
        }
    }
    let place_ok = match input.get(place_key) {
        Some(Json::Object(p)) => {
            p.len() == 2
                && matches!(p.iter().find(|(k, _)| k == "kind"), Some((_, Json::String(k))) if k == "treasury-wallet")
                && matches!(p.iter().find(|(k, _)| k == "walletId"), Some((_, Json::String(w))) if is_place_id(w))
        }
        _ => false,
    };
    if !place_ok {
        return Err(internal(format!("{recipe}: input.{place_key}: Invalid"), Some(RECIPE_INPUT_INVALID)));
    }
    let known = ["course", "userId", "n", "assetId", "amount", "paymentId", place_key];
    if let Some((extra, _)) = fields.iter().find(|(k, _)| !known.contains(&k.as_str())) {
        return Err(internal(
            format!("{recipe}: input: Unrecognized key: \"{extra}\""),
            Some(RECIPE_INPUT_INVALID),
        ));
    }
    Ok(())
}

/// `rehydrateLedgerHttpError`, as far as a caller reads it: the code svc-ledger named, or none.
fn ledger_error(path: &str, status: u16, detail: &str) -> Refusal {
    let parsed = json::parse(detail).ok();
    let code = match parsed.as_ref().and_then(|p| p.get("code")) {
        Some(Json::String(c)) => Some(c.clone()),
        _ => None,
    };
    let message = match parsed.as_ref().and_then(|p| p.get("message")) {
        Some(Json::String(m)) => m.clone(),
        _ => detail.to_owned(),
    };
    let funds_unnamed = code.is_none()
        && status == 400
        && (detail.contains("insufficient_funds") || message.contains("Insufficient "));
    match code {
        Some(code) => internal(message, Some(&code)),
        // `InsufficientFundsError` rebuilt from the sentence carries `ledger.insufficient_funds`.
        None if funds_unnamed && message.contains(": requested ") => {
            internal(message, Some("ledger.insufficient_funds"))
        }
        None => internal(format!("svc-ledger {path} failed ({status}): {detail}"), None),
    }
}

/// svc-ledger's `postRecipe` door over HTTP.
pub struct LedgerHttp {
    pub base_url: String,
    pub signer: CallSigner,
    pub fetch: Arc<dyn Fetch>,
    pub timeout_ms: u64,
    pub retries: u32,
    pub retry_base_delay_ms: u64,
    pub deadline_ms: u64,
    pub sleep: fn(Duration),
}

impl LedgerHttp {
    /// `createAcademyLedgerClient(baseUrl, internalSecret, s2s)` with `POST_BUDGET`.
    pub fn new(base_url: &str, signer: CallSigner, fetch: Arc<dyn Fetch>) -> LedgerHttp {
        LedgerHttp {
            base_url: base_url.strip_suffix('/').unwrap_or(base_url).to_owned(),
            signer,
            fetch,
            timeout_ms: 10_000,
            retries: 2,
            retry_base_delay_ms: 150,
            deadline_ms: 25_000,
            sleep: std::thread::sleep,
        }
    }

    /// `createLedgerTransport`'s `call(path, body)`.
    fn call(&self, path: &str, payload: &str) -> Result<Json, Refusal> {
        let started = Clock::now();
        let remaining = || {
            i128::from(self.deadline_ms)
                - i128::try_from(started.elapsed().as_millis()).unwrap_or(i128::MAX)
        };
        let target = format!("{}{path}", self.base_url);
        let mut attempt: u32 = 0;
        loop {
            let backoff = |attempt: u32, error: Refusal| -> Result<(), Refusal> {
                let delay = self.retry_base_delay_ms.saturating_mul(1u64 << attempt.min(20));
                if attempt >= self.retries || remaining() <= i128::from(delay) {
                    return Err(error);
                }
                (self.sleep)(Duration::from_millis(delay));
                if remaining() <= 0 {
                    return Err(error);
                }
                Ok(())
            };
            let attempt_timeout = i128::from(self.timeout_ms).min(remaining());
            if attempt_timeout <= 0 {
                return Err(internal(
                    format!("svc-ledger call to {path} exceeded its {}ms deadline", self.deadline_ms),
                    None,
                ));
            }
            // Signed inside the attempt, as `fetch(target, { headers: { ...sign(...) } })` is: a signing failure is that
            // attempt's failure.
            let signed = self
                .signer
                .sign(payload, "POST", &path_of(&target), "application/json")
                .map_err(|e| FetchError { message: e });
            let sent = signed.and_then(|signed| {
                let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
                headers.extend(signed);
                self.fetch.fetch(&HttpRequest {
                    method: "POST".to_owned(),
                    url: target.clone(),
                    headers,
                    body: Some(payload.to_owned()),
                    timeout_ms: Some(u64::try_from(attempt_timeout).unwrap_or(u64::MAX)),
                    refuse_redirect: false,
                })
            });
            match sent {
                Err(e) => backoff(attempt, internal(e.message, None))?,
                Ok(res) if res.ok() => match json::parse(&res.body) {
                    Ok(body) => return Ok(body),
                    Err(e) => backoff(attempt, internal(e.message, None))?,
                },
                Ok(res) => {
                    let refusal = ledger_error(path, res.status, &res.body);
                    if ![502, 503, 504].contains(&res.status) {
                        return Err(refusal);
                    }
                    backoff(attempt, refusal)?;
                }
            }
            attempt += 1;
        }
    }
}

fn is_str(v: Option<&Json>) -> bool {
    matches!(v, Some(Json::String(_)))
}

/// `LEDGER_POST_RECIPE.output` and `parseLedgerPostAck`: a receipt that names this key, module and reason, with a
/// txId, a hash, an exact ISO `postedAt` and well-formed entries; anything else is an unknown outcome.
fn receipt_ok(raw: &Json, key: &str, reason: &str) -> bool {
    let str_is = |k: &str, want: &str| matches!(raw.get(k), Some(Json::String(s)) if s == want);
    let entries_ok = match raw.get("entries") {
        Some(Json::Array(es)) => es.iter().all(|e| {
            let filled = |k: &str| matches!(e.get(k), Some(Json::String(s)) if !s.is_empty());
            let amount = |k: &str| {
                matches!(e.get(k), Some(Json::String(a)) if service_kit::money::parse_amount(a).is_ok())
            };
            is_str(e.get("id"))
                && ["txId", "accountId", "assetId", "amount", "balanceAfter"].iter().all(|k| filled(k))
                && matches!(e.get("direction"), Some(Json::String(d)) if d == "debit" || d == "credit")
                && amount("amount")
                && amount("balanceAfter")
        }),
        _ => false,
    };
    let posted_at_ok = matches!(raw.get("postedAt"), Some(Json::String(p))
        if service_kit::time::js_date(p).is_some_and(|at| at.iso() == *p));
    matches!(raw, Json::Object(_))
        && matches!(raw.get("txId"), Some(Json::String(t)) if !t.is_empty() && !t.trim().is_empty())
        && matches!(raw.get("hash"), Some(Json::String(h)) if !h.is_empty() && !h.trim().is_empty())
        && str_is("idempotencyKey", key)
        && str_is("module", ACADEMY_MODULE)
        && str_is("reason", reason)
        && entries_ok
        && posted_at_ok
}

impl Ledger for LedgerHttp {
    /// `postRecipe({ recipe, input })`. The key is the one the recipe builds from the inputs; the receipt must name it.
    fn post_recipe(&self, recipe: &str, idempotency_key: &str, input: &Json) -> Result<Json, Refusal> {
        let Some(reason) = reason_of(recipe) else {
            return Err(internal(
                format!("postRecipe posts only academyPurchase, academyPurchaseRefund; got \"{recipe}\""),
                Some(RECIPE_UNKNOWN),
            ));
        };
        check_inputs(recipe, input)?;
        let payload = Json::obj([("recipe", Json::str(recipe)), ("input", input.clone())]).compact();
        let raw = self.call(POST_RECIPE_PATH, &payload)?;
        if !receipt_ok(&raw, idempotency_key, reason) {
            return Err(internal(LEDGER_ACK_INVALID, None));
        }
        Ok(raw)
    }
}

/// `httpRefundSender(url)`: one send per refund key; a lost or unclear answer is none.
pub struct RefundHttp {
    pub url: String,
    pub fetch: Arc<dyn Fetch>,
    pub timeout_ms: u64,
}

impl RefundHttp {
    pub fn new(url: &str, fetch: Arc<dyn Fetch>) -> RefundHttp {
        RefundHttp {
            url: url.to_owned(),
            fetch,
            timeout_ms: 15_000,
        }
    }
}

impl Refunds for RefundHttp {
    fn send(&self, input: &RefundSend) -> Result<Option<String>, Refusal> {
        #[expect(clippy::cast_precision_loss, reason = "a chain id is a small integer")]
        let body = Json::obj([
            ("key", Json::str(input.key.clone())),
            ("chainId", Json::Number(input.chain_id as f64)),
            ("token", Json::str(input.token.clone())),
            ("to", Json::str(input.to.clone())),
            ("amount", Json::str(input.amount.to_string())),
        ]);
        let req = HttpRequest {
            method: "POST".to_owned(),
            url: self.url.clone(),
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            body: Some(body.compact()),
            timeout_ms: Some(self.timeout_ms),
            refuse_redirect: false,
        };
        let Ok(res) = self.fetch.fetch(&req) else {
            return Ok(None);
        };
        if !res.ok() {
            return Ok(None);
        }
        let hash = match json::parse(&res.body).ok().as_ref().and_then(|b| b.get("hash")) {
            Some(Json::String(h)) => h.to_lowercase(),
            _ => return Ok(None),
        };
        Ok(is_tx_hash(&hash).then_some(hash))
    }
}

/// `createIdentityLinkedWallets(baseUrl, internalSecret, s2s)`.
pub struct IdentityWallets {
    pub target: String,
    pub signer: CallSigner,
    pub fetch: Arc<dyn Fetch>,
}

/// `LINKED_WALLETS_PATH`.
pub const LINKED_WALLETS_PATH: &str = "/internal/linked-wallets";

impl IdentityWallets {
    pub fn new(base_url: &str, signer: CallSigner, fetch: Arc<dyn Fetch>) -> IdentityWallets {
        IdentityWallets {
            target: format!("{}{LINKED_WALLETS_PATH}", base_url.trim_end_matches('/')),
            signer,
            fetch,
        }
    }
}

/// `linkedWalletsSchema`: `{state:'usable', wallets:[{address, linkedAt}]}` or `{state:'account_inactive'}`, strict.
pub fn linked_wallets_ok(v: &Json) -> bool {
    let Json::Object(fields) = v else {
        return false;
    };
    let only = |keys: &[&str]| fields.iter().all(|(k, _)| keys.contains(&k.as_str()));
    match v.get("state") {
        Some(Json::String(s)) if s == "account_inactive" => only(&["state"]),
        Some(Json::String(s)) if s == "usable" => {
            only(&["state", "wallets"])
                && matches!(v.get("wallets"), Some(Json::Array(ws)) if ws.iter().all(|w| {
                    matches!(w, Json::Object(f) if f.iter().all(|(k, _)| k == "address" || k == "linkedAt"))
                        && matches!(w.get("address"), Some(Json::String(a))
                            if a.len() == 42 && a.starts_with("0x")
                                && a[2..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
                        && matches!(w.get("linkedAt"), Some(Json::String(t)) if service_kit::time::zod_datetime(t, false).is_some())
                }))
        }
        _ => false,
    }
}

impl LinkedWallets for IdentityWallets {
    fn read(&self, user_id: &str) -> Option<Json> {
        let raw = Json::obj([("userId", Json::str(user_id))]).compact();
        let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
        headers.extend(
            self.signer
                .sign(&raw, "POST", &path_of(&self.target), "application/json")
                .ok()?,
        );
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: self.target.clone(),
                headers,
                body: Some(raw),
                timeout_ms: Some(3_000),
                refuse_redirect: true,
            })
            .ok()?;
        if !res.ok() {
            return None;
        }
        let body = json::parse(&res.body).ok()?;
        linked_wallets_ok(&body).then_some(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    use service_kit::http::HttpResponse;

    struct Script {
        answers: Mutex<Vec<Result<HttpResponse, FetchError>>>,
        seen: Mutex<Vec<HttpRequest>>,
    }

    impl Fetch for Script {
        fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
            self.seen.lock().unwrap().push(req.clone());
            self.answers.lock().unwrap().remove(0)
        }
    }

    fn script(answers: Vec<Result<HttpResponse, FetchError>>) -> Arc<Script> {
        Arc::new(Script {
            answers: Mutex::new(answers),
            seen: Mutex::new(Vec::new()),
        })
    }

    fn ok(status: u16, body: &str) -> Result<HttpResponse, FetchError> {
        Ok(HttpResponse {
            status,
            body: body.to_owned(),
        })
    }

    const KEY: &str = "academy:purchase:perps-101:11111111-1111-4111-8111-111111111111:1";

    fn input() -> Json {
        Json::obj([
            ("course", Json::str("perps-101")),
            ("userId", Json::str("11111111-1111-4111-8111-111111111111")),
            ("n", Json::str("1")),
            ("assetId", Json::str("USDC")),
            ("amount", Json::str("2.5")),
            ("paymentId", Json::str(format!("0x{}", "ab".repeat(32)))),
            (
                "to",
                Json::obj([
                    ("kind", Json::str("treasury-wallet")),
                    ("walletId", Json::str("0x00000000000000000000000000000000000000aa")),
                ]),
            ),
        ])
    }

    fn receipt(key: &str, reason: &str) -> String {
        format!(
            r#"{{"txId":"tx-1","idempotencyKey":"{key}","module":"academy","reason":"{reason}","hash":"h","postedAt":"2026-11-12T00:00:00.000Z","entries":[]}}"#
        )
    }

    fn ledger(fetch: Arc<Script>) -> LedgerHttp {
        let mut l = LedgerHttp::new(
            "http://ledger:4010/",
            CallSigner::new("svc-academy", "svc-ledger", "an-internal-secret-of-32-characters!", None),
            fetch,
        );
        l.sleep = |_| {};
        l
    }

    #[test]
    fn a_post_names_the_recipe_and_its_inputs_and_reads_a_receipt_for_this_key() {
        let f = script(vec![ok(200, &receipt(KEY, "academy.purchase.posted"))]);
        let got = ledger(f.clone()).post_recipe("academyPurchase", KEY, &input()).unwrap();
        assert_eq!(got.get("txId"), Some(&Json::str("tx-1")));
        let seen = f.seen.lock().unwrap();
        assert_eq!(seen[0].url, "http://ledger:4010/trpc/postRecipe");
        assert!(seen[0].body.as_deref().unwrap().starts_with(r#"{"recipe":"academyPurchase","input":{"course":"perps-101""#));
        assert_eq!(seen[0].timeout_ms, Some(10_000));
    }

    #[test]
    fn a_receipt_for_another_key_or_reason_is_an_unknown_outcome() {
        for body in [
            receipt("academy:purchase:other:x:1", "academy.purchase.posted"),
            receipt(KEY, "academy.purchase.refunded"),
            r#"{"txId":"tx-1"}"#.to_owned(),
        ] {
            let f = script(vec![ok(200, &body)]);
            let err = ledger(f).post_recipe("academyPurchase", KEY, &input()).unwrap_err();
            assert_eq!(err, internal(LEDGER_ACK_INVALID, None));
        }
    }

    #[test]
    fn a_502_is_tried_again_on_the_same_body_and_a_400_is_not() {
        let f = script(vec![ok(502, ""), ok(200, &receipt(KEY, "academy.purchase.posted"))]);
        assert!(ledger(f.clone()).post_recipe("academyPurchase", KEY, &input()).is_ok());
        let seen = f.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].body, seen[1].body);
        drop(seen);

        let f = script(vec![ok(412, r#"{"message":"frozen","code":"ledger.frozen"}"#)]);
        let err = ledger(f.clone()).post_recipe("academyPurchase", KEY, &input()).unwrap_err();
        assert_eq!(err, internal("frozen", Some("ledger.frozen")));
        assert_eq!(f.seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn three_lost_answers_give_up_with_no_code() {
        let lost = || Err(FetchError { message: "fetch failed".to_owned() });
        let f = script(vec![lost(), lost(), lost()]);
        let err = ledger(f.clone()).post_recipe("academyPurchase", KEY, &input()).unwrap_err();
        assert_eq!(err, internal("fetch failed", None));
        assert_eq!(f.seen.lock().unwrap().len(), 3);
    }

    #[test]
    fn inputs_the_door_refuses_are_refused_before_anything_is_sent() {
        let f = script(vec![]);
        let mut bad = input();
        if let Json::Object(fields) = &mut bad {
            fields[4].1 = Json::str("-1");
        }
        let err = ledger(f.clone()).post_recipe("academyPurchase", KEY, &bad).unwrap_err();
        assert!(matches!(err, Refusal::Internal { code: Some(c), .. } if c == RECIPE_INPUT_INVALID));
        let err = ledger(f.clone()).post_recipe("deposit", KEY, &input()).unwrap_err();
        assert!(matches!(err, Refusal::Internal { code: Some(c), .. } if c == RECIPE_UNKNOWN));
        assert!(f.seen.lock().unwrap().is_empty());
    }

    #[test]
    fn the_refund_signer_answers_a_hash_or_nothing() {
        let send = RefundSend {
            key: "academy:refund:c:u:1".to_owned(),
            chain_id: 8453,
            token: "0xt".to_owned(),
            to: "0xp".to_owned(),
            amount: 2_500_000,
        };
        let hash = format!("0x{}", "AB".repeat(32));
        let f = script(vec![ok(200, &format!(r#"{{"hash":"{hash}"}}"#)), ok(500, ""), ok(200, r#"{"hash":"0x12"}"#)]);
        let r = RefundHttp::new("http://signer/send", f.clone());
        assert_eq!(r.send(&send).unwrap(), Some(hash.to_lowercase()));
        assert_eq!(r.send(&send).unwrap(), None);
        assert_eq!(r.send(&send).unwrap(), None);
        assert_eq!(
            f.seen.lock().unwrap()[0].body.as_deref(),
            Some(r#"{"key":"academy:refund:c:u:1","chainId":8453,"token":"0xt","to":"0xp","amount":"2500000"}"#)
        );
    }

    #[test]
    fn linked_wallets_are_read_strictly_and_a_redirect_is_refused() {
        let f = script(vec![
            ok(200, r#"{"state":"usable","wallets":[{"address":"0x00000000000000000000000000000000000000aa","linkedAt":"2026-11-01T00:00:00.000Z"}]}"#),
            ok(200, r#"{"state":"usable","wallets":[{"address":"0xAA","linkedAt":"2026-11-01T00:00:00.000Z"}]}"#),
            ok(503, ""),
        ]);
        let w = IdentityWallets::new(
            "http://identity:4002/",
            CallSigner::new("svc-academy", "svc-identity", "an-internal-secret-of-32-characters!", None),
            f.clone(),
        );
        assert!(w.read("11111111-1111-4111-8111-111111111111").is_some());
        assert!(w.read("11111111-1111-4111-8111-111111111111").is_none());
        assert!(w.read("11111111-1111-4111-8111-111111111111").is_none());
        let seen = f.seen.lock().unwrap();
        assert_eq!(seen[0].url, "http://identity:4002/internal/linked-wallets");
        assert!(seen[0].refuse_redirect);
        assert_eq!(seen[0].timeout_ms, Some(3_000));
    }

    #[test]
    fn path_of_is_pathname_and_search() {
        assert_eq!(path_of("http://h:1/trpc/postRecipe"), "/trpc/postRecipe");
        assert_eq!(path_of("http://h:1"), "/");
        assert_eq!(path_of("http://h/a?b=1#c"), "/a?b=1");
    }
}
