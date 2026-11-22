//! The calls slice `spaces` makes out of svc-bank, each as the TypeScript makes it:
//!
//! - [`Ledger`]: svc-ledger's reads (`packages/ledger-client` `createHttpLedgerClient` through `src/ledger-client.ts`): `/trpc/balance`,
//!   `/trpc/balances` and the asset registry `/trpc/assetsList` (`createLedgerAssetRegistry`), each a signed POST of its JSON body, 3 s an
//!   attempt, one retry on a network failure, a 502/503/504 or an unreadable body, 5 s in all. svc-bank holds no balance:
//!   every figure a space shows is one of these reads, made at request time.
//! - [`Directory`]: svc-identity's business directory (`business/business-directory.ts`): handles for user ids and
//!   one exact lookup of an active person, 3 s, signed. With no `IDENTITY_URL` every read refuses as unset.
//! - [`Lookups`]: `BusinessLookupLimiter`, 30 directory lookups a minute per caller.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::{Duration, Instant as Clock};

use service_kit::http::{Fetch, HttpRequest, HttpResponse};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::s2s::CallSigner;

/// One ledger account (`AccountRef`), as the JSON body names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerAccount {
    pub owner_type: &'static str,
    pub owner_id: String,
    pub asset_id: String,
    pub kind: &'static str,
}

impl LedgerAccount {
    /// `userAvailable`.
    pub fn user_available(user_id: &str, asset_id: &str) -> LedgerAccount {
        LedgerAccount {
            owner_type: "user",
            owner_id: user_id.to_owned(),
            asset_id: asset_id.to_owned(),
            kind: "available",
        }
    }

    /// `subAccountAvailable`.
    pub fn sub_account_available(space_id: &str, asset_id: &str) -> LedgerAccount {
        LedgerAccount {
            owner_type: "subaccount",
            owner_id: space_id.to_owned(),
            asset_id: asset_id.to_owned(),
            kind: "available",
        }
    }

    /// The account as JSON, in `AccountRef`'s key order.
    pub fn json(&self) -> Json {
        Json::obj([
            ("ownerType", Json::str(self.owner_type)),
            ("ownerId", Json::str(self.owner_id.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("kind", Json::str(self.kind)),
        ])
    }
}

/// One of an owner's balances (`balancesWire`): `purpose` is blank for none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerBalance {
    pub asset_id: String,
    pub kind: String,
    pub purpose: String,
    pub amount: Amount,
}

/// svc-ledger's reads. An `Err` is a read that failed; its words are for the log only.
pub trait Ledger: Send + Sync {
    /// `balance(ref)`.
    fn balance(&self, account: &LedgerAccount) -> Result<Amount, String>;
    /// `balances(ownerType, ownerId)`.
    fn balances(&self, owner_type: &str, owner_id: &str) -> Result<Vec<LedgerBalance>, String>;
    /// `listed()`: the registry's `assets`, every published row in any state.
    fn assets(&self) -> Result<Vec<Json>, String>;
    /// `balance(ref).accountId`: the ledger's id for the account, `""` when it has none yet.
    fn account_id(&self, _account: &LedgerAccount) -> Result<String, String> {
        Err(UNWIRED.to_owned())
    }
    /// `getTx`: a booked transaction by id, with its legs; none when not booked.
    fn tx_by_id(&self, _tx_id: &str) -> Result<Option<LedgerTx>, String> {
        Err(UNWIRED.to_owned())
    }
    /// `getTxByKey`: the transaction booked under a business key, with its legs; none when the key is empty.
    fn tx_by_key(&self, _key: &str) -> Result<Option<LedgerTx>, String> {
        Err(UNWIRED.to_owned())
    }
    /// `postRecipe`: svc-ledger builds the post from a `packages/ledger-client` recipe and these business inputs, and
    /// books it. svc-bank never assembles ledger entries itself. `key` is the business key the recipe builds from these
    /// inputs: a receipt that names another is an unknown outcome, never a success.
    fn post_recipe(
        &self,
        _recipe: &str,
        _input: &Json,
        _key: &str,
    ) -> Result<LedgerTx, PostFailure> {
        Err(PostFailure::Unknown(UNWIRED.to_owned()))
    }
}

/// What a ledger nobody wired answers.
pub const UNWIRED: &str = "svc-bank in Rust: no ledger is wired";

/// A ledger nobody wired (the replay's stub): every read fails.
pub struct NoLedger;

impl Ledger for NoLedger {
    fn balance(&self, _: &LedgerAccount) -> Result<Amount, String> {
        Err("svc-bank in Rust: no ledger is wired".to_owned())
    }
    fn balances(&self, _: &str, _: &str) -> Result<Vec<LedgerBalance>, String> {
        Err("svc-bank in Rust: no ledger is wired".to_owned())
    }
    fn assets(&self) -> Result<Vec<Json>, String> {
        Err("svc-bank in Rust: no ledger is wired".to_owned())
    }
}

/// `READ_BUDGET`: 3 s an attempt, one retry, 5 s in all, the retry after 200 ms.
const ATTEMPT_MS: u64 = 3_000;
const RETRIES: u32 = 1;
const DEADLINE_MS: u64 = 5_000;
const RETRY_BASE_MS: u64 = 200;

/// svc-ledger over HTTP, signed as svc-bank for audience svc-ledger.
pub struct LedgerHttp {
    base: String,
    signer: CallSigner,
    fetch: Box<dyn Fetch>,
}

impl LedgerHttp {
    pub fn new(base: &str, signer: CallSigner, fetch: Box<dyn Fetch>) -> LedgerHttp {
        LedgerHttp {
            base: base.trim_end_matches('/').to_owned(),
            signer,
            fetch,
        }
    }

    /// `createLedgerTransport`'s `call` with the read budget.
    fn call(&self, path: &str, body: &Json) -> Result<Json, String> {
        self.call_with(path, body, READ).map_err(|f| f.message)
    }

    /// `createLedgerTransport`'s `call`: the body serialised once, signed and sent per attempt, within `budget`.
    fn call_with(&self, path: &str, body: &Json, budget: Budget) -> Result<Json, CallFailure> {
        let payload = body.compact();
        let started = Clock::now();
        let left = || {
            u64::try_from(started.elapsed().as_millis())
                .map_or(0, |spent| budget.deadline_ms.saturating_sub(spent))
        };
        let mut attempt = 0;
        loop {
            let timeout = budget.attempt_ms.min(left());
            let fail = |status, detail: Option<String>, message: String| CallFailure {
                status,
                detail,
                message,
                attempts: attempt + 1,
            };
            if timeout == 0 {
                return Err(fail(
                    None,
                    None,
                    format!(
                        "svc-ledger call to {path} exceeded its {}ms deadline",
                        budget.deadline_ms
                    ),
                ));
            }
            let target = format!("{}{path}", self.base);
            let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
            headers.extend(
                self.signer
                    .sign(&payload, "POST", path, "application/json")
                    .map_err(|e| fail(None, None, e))?,
            );
            let outcome = self.fetch.fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: target,
                headers,
                body: Some(payload.clone()),
                timeout_ms: Some(timeout),
                refuse_redirect: false,
            });
            let (retry, error) = match outcome {
                Ok(HttpResponse { status, body }) if (200..=299).contains(&status) => {
                    match json::parse(&body) {
                        Ok(j) => return Ok(j),
                        Err(e) => (true, fail(Some(status), None, e.message)),
                    }
                }
                Ok(HttpResponse { status, body }) => (
                    matches!(status, 502..=504),
                    fail(
                        Some(status),
                        Some(body.clone()),
                        format!("svc-ledger {path} answered {status}: {body}"),
                    ),
                ),
                Err(e) => (true, fail(None, None, e.message)),
            };
            let delay = RETRY_BASE_MS << attempt;
            if !retry || attempt >= budget.retries || left() <= delay {
                return Err(error);
            }
            std::thread::sleep(Duration::from_millis(delay));
            attempt += 1;
        }
    }
}

/// A call's time budget (`POST_BUDGET`, `READ_BUDGET`).
#[derive(Debug, Clone, Copy)]
pub struct Budget {
    pub attempt_ms: u64,
    pub retries: u32,
    pub deadline_ms: u64,
}

/// `READ_BUDGET`.
pub const READ: Budget = Budget {
    attempt_ms: ATTEMPT_MS,
    retries: RETRIES,
    deadline_ms: DEADLINE_MS,
};

/// `POST_BUDGET`: 10 s an attempt, two retries, 25 s in all. A retried post is the same body under the same key.
pub const POST: Budget = Budget {
    attempt_ms: 10_000,
    retries: 2,
    deadline_ms: 25_000,
};

/// Why a call gave up: the last answer's status and body when there was one, and how many attempts had started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallFailure {
    pub status: Option<u16>,
    pub detail: Option<String>,
    pub message: String,
    pub attempts: u32,
}

/// One leg of a booked transaction (`LedgerEntry` as `txById` and a post's receipt name it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxEntry {
    pub account_id: String,
    pub asset_id: String,
    /// `debit` or `credit`.
    pub direction: String,
    pub amount: Amount,
}

/// A booked transaction (`LedgerTx`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerTx {
    pub id: String,
    pub posted_at: service_kit::time::Instant,
    pub entries: Vec<TxEntry>,
}

/// Why a post did not answer with a transaction (`rehydrateLedgerHttpError`, `classifyPostOutcome`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PostFailure {
    /// svc-ledger named a code (`LedgerError`): `ledger.insufficient_funds`, `ledger.frozen`, ... `attempts` is how many
    /// attempts had started, so "the only attempt was refused" can be told from "the last of several was".
    Coded {
        code: String,
        message: String,
        attempts: u32,
    },
    /// Anything else: a timeout, a network failure, a 5xx with no code, an unreadable receipt. The post may have landed.
    Unknown(String),
}

/// `DEFINITE_POST_REFUSAL_CODES`: refusals the ledger makes before it commits anything under the key.
pub const DEFINITE_POST_REFUSALS: [&str; 5] = [
    "ledger.insufficient_funds",
    "ledger.invalid_entry",
    "ledger.unbalanced",
    "ledger.owner_identity_space",
    "ledger.frozen",
];

impl PostFailure {
    /// The code svc-ledger named, if any.
    pub fn code(&self) -> Option<&str> {
        match self {
            PostFailure::Coded { code, .. } => Some(code),
            PostFailure::Unknown(_) => None,
        }
    }

    /// `provesPostNotCommitted`: a definite refusal on the only attempt.
    pub fn proves_not_committed(&self) -> bool {
        matches!(self, PostFailure::Coded { code, attempts: 1, .. } if DEFINITE_POST_REFUSALS.contains(&code.as_str()))
    }

    /// `isInsufficientFunds`.
    pub fn insufficient(&self) -> bool {
        self.code() == Some("ledger.insufficient_funds")
    }

    pub fn message(&self) -> &str {
        match self {
            PostFailure::Coded { message, .. } | PostFailure::Unknown(message) => message,
        }
    }
}

/// `rehydrateLedgerHttpError`: svc-ledger's own code from its answer, else an unknown failure. The funds refusal with no
/// code but its words is read as `ledger.insufficient_funds`, as the TypeScript client reads it.
fn post_failure(f: CallFailure) -> PostFailure {
    let (Some(status), Some(detail)) = (f.status, f.detail.as_deref()) else {
        return PostFailure::Unknown(f.message);
    };
    let parsed = json::parse(detail).ok();
    let field = |k: &str| match parsed.as_ref().and_then(|p| p.get(k)) {
        Some(Json::String(s)) => Some(s.clone()),
        _ => None,
    };
    let code = field("code");
    let message = field("message").unwrap_or_else(|| detail.to_owned());
    let funds_words = detail.contains("insufficient_funds") || {
        let m = message.as_str();
        m.find("Insufficient ")
            .map(|at| &m[at + "Insufficient ".len()..])
            .is_some_and(|rest| {
                let word: String = rest
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect();
                !word.is_empty() && rest[word.len()..].starts_with(':')
            })
    };
    match code {
        Some(code) => PostFailure::Coded {
            code,
            message,
            attempts: f.attempts,
        },
        None if status == 400 && funds_words => PostFailure::Coded {
            code: "ledger.insufficient_funds".to_owned(),
            message,
            attempts: f.attempts,
        },
        None => PostFailure::Unknown(format!("svc-ledger failed ({status}): {detail}")),
    }
}

/// A booked transaction from `txById`'s or a receipt's JSON.
fn ledger_tx(id: &str, posted_at: &str, entries: &Json) -> Result<LedgerTx, String> {
    let at = service_kit::time::js_date(posted_at)
        .filter(|t| t.iso() == posted_at)
        .ok_or_else(|| "svc-ledger answer: postedAt is not an ISO instant".to_owned())?;
    let Json::Array(rows) = entries else {
        return Err("svc-ledger answer: entries is not a list".to_owned());
    };
    let entries = rows
        .iter()
        .map(|e| {
            let direction = text(e, "direction")?;
            if direction != "debit" && direction != "credit" {
                return Err("svc-ledger answer: direction".to_owned());
            }
            Ok(TxEntry {
                account_id: text(e, "accountId")?,
                asset_id: text(e, "assetId")?,
                direction,
                amount: parse_amount(&text(e, "amount")?)?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(LedgerTx {
        id: id.to_owned(),
        posted_at: at,
        entries,
    })
}

fn text(j: &Json, key: &str) -> Result<String, String> {
    match j.get(key) {
        Some(Json::String(s)) => Ok(s.clone()),
        _ => Err(format!("svc-ledger answer: {key} is not a string")),
    }
}

impl Ledger for LedgerHttp {
    fn balance(&self, account: &LedgerAccount) -> Result<Amount, String> {
        let answer = self.call("/trpc/balance", &account.json())?;
        text(&answer, "accountId")?;
        parse_amount(&text(&answer, "amount")?)
    }

    fn balances(&self, owner_type: &str, owner_id: &str) -> Result<Vec<LedgerBalance>, String> {
        let body = Json::obj([
            ("ownerType", Json::str(owner_type)),
            ("ownerId", Json::str(owner_id)),
        ]);
        let Json::Array(rows) = self.call("/trpc/balances", &body)? else {
            return Err("svc-ledger answer: balances is not a list".to_owned());
        };
        rows.iter()
            .map(|r| {
                text(r, "accountId")?;
                Ok(LedgerBalance {
                    asset_id: text(r, "assetId")?,
                    kind: text(r, "kind")?,
                    purpose: match r.get("purpose") {
                        None => String::new(),
                        Some(Json::String(p)) => p.clone(),
                        Some(_) => return Err("svc-ledger answer: purpose".to_owned()),
                    },
                    amount: parse_amount(&text(r, "amount")?)?,
                })
            })
            .collect()
    }

    fn assets(&self) -> Result<Vec<Json>, String> {
        let answer = self.call("/trpc/assetsList", &Json::Object(Vec::new()))?;
        match answer.get("assets") {
            Some(Json::Array(rows)) => Ok(rows.clone()),
            _ => Err("svc-ledger answer: assets is not a list".to_owned()),
        }
    }

    fn account_id(&self, account: &LedgerAccount) -> Result<String, String> {
        let answer = self.call("/trpc/balance", &account.json())?;
        text(&answer, "accountId")
    }

    fn tx_by_id(&self, tx_id: &str) -> Result<Option<LedgerTx>, String> {
        let answer = self.call("/trpc/txById", &Json::obj([("txId", Json::str(tx_id))]))?;
        match answer.get("found") {
            Some(Json::Bool(false)) => Ok(None),
            Some(Json::Bool(true)) => {
                if text(&answer, "txId")? != tx_id {
                    return Err("svc-ledger /trpc/txById answered a different txId".to_owned());
                }
                for k in ["idempotencyKey", "hash"] {
                    if service_kit::money::js_trim(&text(&answer, k)?).is_empty() {
                        return Err(format!("svc-ledger answer: {k} is blank"));
                    }
                }
                let entries = answer.get("entries").cloned().unwrap_or(Json::Null);
                if !matches!(&entries, Json::Array(e) if e.len() >= 2) {
                    return Err("svc-ledger answer: fewer than two legs".to_owned());
                }
                ledger_tx(tx_id, &text(&answer, "postedAt")?, &entries).map(Some)
            }
            _ => Err("svc-ledger answer: found is not a boolean".to_owned()),
        }
    }

    fn tx_by_key(&self, key: &str) -> Result<Option<LedgerTx>, String> {
        let answer = self.call(
            "/trpc/txByKey",
            &Json::obj([("idempotencyKey", Json::str(key))]),
        )?;
        match answer.get("found") {
            Some(Json::Bool(false)) => Ok(None),
            Some(Json::Bool(true)) => {
                let id = text(&answer, "txId")?;
                let tx = self.tx_by_id(&id)?.ok_or_else(|| {
                    format!(
                        "svc-ledger inconsistent: txByKey found {id} for the key but txById did not"
                    )
                })?;
                Ok(Some(tx))
            }
            _ => Err("svc-ledger answer: found is not a boolean".to_owned()),
        }
    }

    fn post_recipe(&self, recipe: &str, input: &Json, key: &str) -> Result<LedgerTx, PostFailure> {
        let body = Json::obj([("recipe", Json::str(recipe)), ("input", input.clone())]);
        let answer = self
            .call_with("/trpc/postRecipe", &body, POST)
            .map_err(post_failure)?;
        let unknown = |why: &str| {
            PostFailure::Unknown(format!(
                "svc-ledger invalid post acknowledgement; outcome unknown ({why})"
            ))
        };
        if text(&answer, "idempotencyKey").ok().as_deref() != Some(key) {
            return Err(unknown("the receipt names another key"));
        }
        let id = text(&answer, "txId").map_err(|e| unknown(&e))?;
        let at = text(&answer, "postedAt").map_err(|e| unknown(&e))?;
        let entries = answer
            .get("entries")
            .cloned()
            .unwrap_or(Json::Array(Vec::new()));
        ledger_tx(&id, &at, &entries).map_err(|e| unknown(&e))
    }
}

/// Why the directory could not answer (`BusinessDirectoryError`'s reason).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirError {
    Unset,
    Unavailable,
}

/// One exact lookup: a handle or an email, already in shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lookup {
    Handle(String),
    Email(String),
}

/// svc-identity's business directory (`BusinessDirectoryPort`).
pub trait Directory: Send + Sync {
    /// Public handles for these user ids; unknown ids are omitted.
    fn handles_of(&self, ids: &[String]) -> Result<BTreeMap<String, String>, DirError>;
    /// An active account, exact match: its id and handle, or none for unknown, frozen and closed.
    fn find_active(&self, query: &Lookup) -> Result<Option<(String, String)>, DirError>;
}

/// `unconfiguredBusinessDirectory`: no `IDENTITY_URL`, every read refuses as unset.
pub struct NoDirectory;

impl Directory for NoDirectory {
    fn handles_of(&self, _: &[String]) -> Result<BTreeMap<String, String>, DirError> {
        Err(DirError::Unset)
    }
    fn find_active(&self, _: &Lookup) -> Result<Option<(String, String)>, DirError> {
        Err(DirError::Unset)
    }
}

pub const HANDLES_PATH: &str = "/internal/business-directory/handles";
pub const RECIPIENT_PATH: &str = "/internal/business-directory/recipient";
const DIRECTORY_MS: u64 = 3_000;

/// `createIdentityBusinessDirectory`: POSTs signed as svc-bank for audience svc-identity, 3 s, no retry.
pub struct DirectoryHttp {
    base: String,
    signer: CallSigner,
    fetch: Box<dyn Fetch>,
}

impl DirectoryHttp {
    pub fn new(base: &str, signer: CallSigner, fetch: Box<dyn Fetch>) -> DirectoryHttp {
        DirectoryHttp {
            base: base.trim_end_matches('/').to_owned(),
            signer,
            fetch,
        }
    }

    fn post(&self, path: &str, body: &Json) -> Result<Json, DirError> {
        let payload = body.compact();
        let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
        headers.extend(
            self.signer
                .sign(&payload, "POST", path, "application/json")
                .map_err(|_| DirError::Unavailable)?,
        );
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: format!("{}{path}", self.base),
                headers,
                body: Some(payload),
                timeout_ms: Some(DIRECTORY_MS),
                refuse_redirect: false,
            })
            .map_err(|_| DirError::Unavailable)?;
        if res.status == 404 {
            return Err(DirError::Unset);
        }
        if !res.ok() {
            return Err(DirError::Unavailable);
        }
        json::parse(&res.body).map_err(|_| DirError::Unavailable)
    }
}

/// `z.string().min(1).max(n)` in UTF-16 units.
fn bounded(j: Option<&Json>, max: usize) -> Option<String> {
    match j {
        Some(Json::String(s)) if (1..=max).contains(&s.encode_utf16().count()) => Some(s.clone()),
        _ => None,
    }
}

impl Directory for DirectoryHttp {
    fn handles_of(&self, ids: &[String]) -> Result<BTreeMap<String, String>, DirError> {
        let mut unique: Vec<String> = Vec::new();
        for id in ids.iter().map(|i| i.trim()).filter(|i| !i.is_empty()) {
            if !unique.iter().any(|u| u == id) {
                unique.push(id.to_owned());
            }
        }
        if unique.is_empty() {
            return Ok(BTreeMap::new());
        }
        let body = Json::obj([(
            "userIds",
            Json::Array(unique.iter().map(Json::str).collect()),
        )]);
        let answer = self.post(HANDLES_PATH, &body)?;
        let Some(Json::Array(rows)) = answer.get("handles") else {
            return Err(DirError::Unavailable);
        };
        let mut out = BTreeMap::new();
        for r in rows {
            let (Some(id), Some(handle)) =
                (bounded(r.get("userId"), 128), bounded(r.get("handle"), 64))
            else {
                return Err(DirError::Unavailable);
            };
            out.insert(id, handle);
        }
        Ok(out)
    }

    fn find_active(&self, query: &Lookup) -> Result<Option<(String, String)>, DirError> {
        let body = match query {
            Lookup::Handle(h) => Json::obj([("handle", Json::str(h.clone()))]),
            Lookup::Email(e) => Json::obj([("email", Json::str(e.clone()))]),
        };
        let answer = self.post(RECIPIENT_PATH, &body)?;
        match answer.get("found") {
            Some(Json::Bool(false)) => Ok(None),
            Some(Json::Bool(true)) => {
                match (
                    bounded(answer.get("userId"), 128),
                    bounded(answer.get("handle"), 64),
                ) {
                    (Some(id), Some(handle)) => Ok(Some((id, handle))),
                    _ => Err(DirError::Unavailable),
                }
            }
            _ => Err(DirError::Unavailable),
        }
    }
}

/// `BusinessLookupLimiter`: at most 30 lookups a minute per caller, in this process.
pub struct Lookups {
    hits: Mutex<HashMap<String, Vec<i64>>>,
    max: usize,
    window_ms: i64,
}

impl Default for Lookups {
    fn default() -> Lookups {
        Lookups {
            hits: Mutex::new(HashMap::new()),
            max: 30,
            window_ms: 60_000,
        }
    }
}

impl Lookups {
    /// `tryTake` at `now` (ms).
    pub fn try_take(&self, caller: &str, now: i64) -> bool {
        let mut hits = self
            .hits
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let since = now - self.window_ms;
        let recent = hits.entry(caller.to_owned()).or_default();
        recent.retain(|t| *t > since);
        if recent.len() >= self.max {
            return false;
        }
        recent.push(now);
        true
    }
}
