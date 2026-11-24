//! The rules every ledger applies to a post, as `@intafaced/ledger-client` holds them (`client.ts`, `types.ts`,
//! `accounts.ts`, `custody-layer.ts`, `memory-ledger.ts` `hashTx`): what a post is, the order its checks run in and
//! their exact refusals, what a reused key compares (`postFingerprint`, `replayMetaDiffers`), and the hash that chains
//! the book. The hash and the fingerprint are stored and recomputed by the TypeScript, so each is held byte for byte by
//! `tests/posting_parity.rs`.

use std::cmp::Ordering;

use service_kit::json::{self, Json};
use service_kit::money::{Amount, MAX_AMOUNT, format_amount, js_trim, parse_amount};
use sha2::{Digest, Sha256};

use crate::errors::{self, Failure};
use crate::posting::recorded::HELD_NEGATIVE;
use crate::refines::{describe_owner_id_space, is_valid_owner_id};

/// An exact sum of amounts. Each amount fits `numeric(38,18)`, but a sum of several may not fit an `i128`; the
/// TypeScript sums bigints, which never overflow. `hi * 10^36 + lo`, with `lo` and `hi` of one sign.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Wide {
    hi: i128,
    lo: i128,
}

const BASE: i128 = 1_000_000_000_000_000_000_000_000_000_000_000_000;

impl Wide {
    fn norm(hi: i128, lo: i128) -> Wide {
        let (mut hi, mut lo) = (hi + lo / BASE, lo % BASE);
        if hi > 0 && lo < 0 {
            hi -= 1;
            lo += BASE;
        } else if hi < 0 && lo > 0 {
            hi += 1;
            lo -= BASE;
        }
        Wide { hi, lo }
    }

    pub fn of(a: Amount) -> Wide {
        Wide::norm(0, a.scaled())
    }

    #[must_use]
    pub fn plus_amount(self, a: Amount) -> Wide {
        Wide::norm(self.hi, self.lo + a.scaled())
    }

    #[must_use]
    pub fn plus(self, o: Wide) -> Wide {
        Wide::norm(self.hi + o.hi, self.lo + o.lo)
    }

    #[must_use]
    pub fn negated(self) -> Wide {
        Wide {
            hi: -self.hi,
            lo: -self.lo,
        }
    }

    pub fn signum(self) -> i128 {
        if self.hi == 0 {
            self.lo.signum()
        } else {
            self.hi.signum()
        }
    }

    pub fn cmp_to(self, o: Wide) -> Ordering {
        self.plus(o.negated()).signum().cmp(&0)
    }

    /// The amount, when it fits `numeric(38,18)`.
    pub fn amount(self) -> Option<Amount> {
        let v = self.hi.checked_mul(BASE)?.checked_add(self.lo)?;
        let v = Amount::from_scaled(v);
        (-MAX_AMOUNT..=MAX_AMOUNT).contains(&v).then_some(v)
    }

    /// `formatAmount` of the exact value.
    pub fn format(self) -> String {
        if self.hi == 0 {
            return format_amount(Amount::from_scaled(self.lo));
        }
        let sign = if self.signum() < 0 { "-" } else { "" };
        let digits = format!("{}{:036}", self.hi.unsigned_abs(), self.lo.unsigned_abs());
        let (whole, frac) = digits.split_at(digits.len().saturating_sub(18));
        let frac = frac.trim_end_matches('0');
        if frac.is_empty() {
            format!("{sign}{whole}")
        } else {
            format!("{sign}{whole}.{frac}")
        }
    }
}

/// `Direction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Debit,
    Credit,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::Debit => "debit",
            Direction::Credit => "credit",
        }
    }
}

/// `AccountRef`, as the wire carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountRef {
    pub owner_type: String,
    pub owner_id: String,
    pub asset_id: String,
    pub kind: String,
    pub purpose: Option<String>,
}

impl AccountRef {
    /// `accountPurpose(ref)`: the purpose, trimmed; none is `''`.
    pub fn purpose(&self) -> &str {
        js_trim(self.purpose.as_deref().unwrap_or(""))
    }

    /// `accountKey(ref)`.
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

    fn treasury_under(&self, prefixes: &[&str]) -> bool {
        self.owner_type == "treasury" && prefixes.iter().any(|p| self.owner_id.starts_with(p))
    }

    /// `heldAsNegative`: an own-funds place or a receivable, whose negative balance is ours.
    pub fn held_as_negative(&self) -> bool {
        self.treasury_under(&HELD_NEGATIVE)
    }

    /// `balanceAllowed(ref, next)`.
    pub fn balance_allowed(&self, next: Wide) -> bool {
        if self.held_as_negative() {
            return next.signum() <= 0;
        }
        next.signum() >= 0 || self.owner_type == "treasury"
    }

    /// `heldForRefusal(ref, balance)`.
    pub fn held_for_refusal(&self, balance: Wide) -> Wide {
        if self.held_as_negative() {
            balance.negated()
        } else {
            balance
        }
    }

    /// `isCustomerBalanceAccount(ref)`.
    pub fn is_customer_balance(&self) -> bool {
        match self.owner_type.as_str() {
            "user" | "subaccount" => true,
            "module" => MERCHANT_MONEY_PREFIXES
                .iter()
                .any(|p| self.owner_id.starts_with(p)),
            _ => false,
        }
    }

    /// The account as the wire writes it (`ownerType`, `ownerId`, `assetId`, `kind`, then `purpose` when set).
    pub fn json(&self) -> Json {
        let mut o = vec![
            ("ownerType".to_owned(), Json::str(self.owner_type.clone())),
            ("ownerId".to_owned(), Json::str(self.owner_id.clone())),
            ("assetId".to_owned(), Json::str(self.asset_id.clone())),
            ("kind".to_owned(), Json::str(self.kind.clone())),
        ];
        if let Some(p) = &self.purpose {
            o.push(("purpose".to_owned(), Json::str(p.clone())));
        }
        Json::Object(o)
    }
}

/// `MERCHANT_MONEY_PREFIXES`: module accounts that hold a merchant's own money.
const MERCHANT_MONEY_PREFIXES: [&str; 2] = ["pay:clearing:", "pay:proceeds:"];

/// One leg: its account, direction and amount (unsigned on the wire, scaled inside).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub account: AccountRef,
    pub direction: Direction,
    pub amount: Amount,
}

impl Entry {
    /// `signedDelta(entry)`: a debit adds, a credit subtracts.
    pub fn delta(&self) -> Amount {
        match self.direction {
            Direction::Debit => self.amount,
            Direction::Credit => -self.amount,
        }
    }
}

/// `PostRequest`, as `postRequestSchema` parsed it.
#[derive(Debug, Clone, PartialEq)]
pub struct PostRequest {
    pub idempotency_key: String,
    pub module: String,
    pub reason: String,
    pub entries: Vec<Entry>,
    /// The meta object, when sent.
    pub meta: Option<Vec<(String, Json)>>,
    pub correlation_id: Option<String>,
}

impl PostRequest {
    /// `request.meta?.[field]`.
    pub fn meta(&self, field: &str) -> Option<&Json> {
        self.meta
            .as_ref()
            .and_then(|m| m.iter().find(|(k, _)| k == field).map(|(_, v)| v))
    }

    /// `movesCustomerBalance(request.entries)`.
    pub fn moves_customer_balance(&self) -> bool {
        self.entries.iter().any(|e| e.account.is_customer_balance())
    }
}

fn str_field(o: &Json, k: &str) -> Result<String, String> {
    match o.get(k) {
        Some(Json::String(s)) => Ok(s.clone()),
        _ => Err(format!("{k} is not a string")),
    }
}

fn opt_str(o: &Json, k: &str) -> Result<Option<String>, String> {
    match o.get(k) {
        None => Ok(None),
        Some(Json::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{k} is not a string")),
    }
}

/// The parsed `post` body, as the door's schema left it, read into a [`PostRequest`]. The schema already holds every
/// field to its type, so a failure here is the ledger's own fault.
pub fn read_post(body: &Json) -> Result<PostRequest, String> {
    let Some(Json::Array(raw)) = body.get("entries") else {
        return Err("entries is not a list".to_owned());
    };
    let mut entries = Vec::with_capacity(raw.len());
    for e in raw {
        let a = e.get("account").ok_or("an entry without an account")?;
        let direction = match e.get("direction") {
            Some(Json::String(d)) if d == "debit" => Direction::Debit,
            Some(Json::String(d)) if d == "credit" => Direction::Credit,
            _ => return Err("an entry without a direction".to_owned()),
        };
        entries.push(Entry {
            account: AccountRef {
                owner_type: str_field(a, "ownerType")?,
                owner_id: str_field(a, "ownerId")?,
                asset_id: str_field(a, "assetId")?,
                kind: str_field(a, "kind")?,
                purpose: opt_str(a, "purpose")?,
            },
            direction,
            amount: parse_amount(&str_field(e, "amount")?)?,
        });
    }
    let meta = match body.get("meta") {
        None => None,
        Some(Json::Object(m)) => Some(m.clone()),
        Some(_) => return Err("meta is not an object".to_owned()),
    };
    Ok(PostRequest {
        idempotency_key: str_field(body, "idempotencyKey")?,
        module: str_field(body, "module")?,
        reason: str_field(body, "reason")?,
        entries,
        meta,
        correlation_id: opt_str(body, "correlationId")?,
    })
}

fn invalid(message: impl Into<String>) -> Failure {
    Failure::ledger(errors::INVALID_ENTRY, message)
}

/// `assertIdempotencyKey`: at least 8 characters (UTF-16 units, as `length` counts them).
pub fn assert_idempotency_key(key: &str) -> Result<(), Failure> {
    if key.encode_utf16().count() < 8 {
        return Err(invalid(
            "An idempotency key of at least 8 characters is required on every post",
        ));
    }
    Ok(())
}

/// `assertOwnerIdentifierSpace`.
fn assert_owner_identifier_space(entries: &[Entry]) -> Result<(), Failure> {
    for e in entries {
        let (t, id) = (&e.account.owner_type, &e.account.owner_id);
        if !is_valid_owner_id(t, id) {
            return Err(Failure::ledger(
                errors::OWNER_IDENTITY_SPACE,
                format!(
                    "owner_type \"{t}\" requires {}, but got \"{id}\". An account is never opened for an owner whose \
                     identifier space is undeclared: a bigint member id where a user UUID belongs would open a SECOND \
                     conformant account for the same human, and every invariant would still report clean (§4.2, ADR \
                     2026-08-02).",
                    describe_owner_id_space(t)
                ),
            ));
        }
    }
    Ok(())
}

/// `assertBalanced`: two legs at least, each above zero, summing to zero per asset.
pub fn assert_balanced(entries: &[Entry]) -> Result<(), Failure> {
    if entries.len() < 2 {
        return Err(invalid(
            "A ledger transaction needs at least two entries — value moves between accounts, never from nowhere",
        ));
    }
    let mut per_asset: Vec<(&str, Wide)> = Vec::new();
    for e in entries {
        if e.amount < Amount::ZERO {
            return Err(invalid(format!(
                "Entry amounts are unsigned; direction carries the sign. Got {} on {}",
                format_amount(e.amount),
                e.account.key()
            )));
        }
        if e.amount == Amount::ZERO {
            return Err(invalid(format!(
                "Zero-amount entry on {} — a movement of nothing is not a movement",
                e.account.key()
            )));
        }
        let asset = e.account.asset_id.as_str();
        match per_asset.iter_mut().find(|(a, _)| *a == asset) {
            Some((_, sum)) => *sum = sum.plus_amount(e.delta()),
            None => per_asset.push((asset, Wide::of(e.delta()))),
        }
    }
    let off: Vec<String> = per_asset
        .iter()
        .filter(|(_, d)| d.signum() != 0)
        .map(|(a, d)| format!("{a} off by {}", d.format()))
        .collect();
    if !off.is_empty() {
        return Err(Failure::ledger(
            errors::UNBALANCED,
            format!(
                "Transaction does not sum to zero per asset: {}",
                off.join(", ")
            ),
        ));
    }
    Ok(())
}

/// `LOCK_KIND_LIST`.
const LOCK_KINDS: [&str; 4] = ["hold", "escrow", "stake", "collateral"];

/// `assertPairedLocks`: a lock grows only by what the same owner's available gives up in the same post.
fn assert_paired_locks(entries: &[Entry]) -> Result<(), Failure> {
    let mut gain: Vec<(String, Wide)> = Vec::new();
    let mut given: Vec<(String, Wide)> = Vec::new();
    let bump = |list: &mut Vec<(String, Wide)>, key: String, by: Amount| match list
        .iter_mut()
        .find(|(k, _)| *k == key)
    {
        Some((_, w)) => *w = w.plus_amount(by),
        None => list.push((key, Wide::of(by))),
    };
    for e in entries {
        let a = &e.account;
        let key = format!("{}:{}:{}", a.owner_type, a.owner_id, a.asset_id);
        let delta = e.delta();
        if LOCK_KINDS.contains(&a.kind.as_str()) {
            if delta > Amount::ZERO {
                bump(&mut gain, key, delta);
            }
        } else if a.kind == "available" {
            if delta < Amount::ZERO {
                bump(&mut given, key, -delta);
            }
        } else {
            return Err(invalid(format!(
                "Unknown account kind \"{}\" on {} — a kind outside the lock list is not available and cannot fund a \
                 hold, escrow, stake, or collateral (§4.2)",
                a.kind,
                a.key()
            )));
        }
    }
    for (key, gained) in &gain {
        let g = given
            .iter()
            .find(|(k, _)| k == key)
            .map_or(Wide::default(), |(_, w)| *w);
        if g.cmp_to(*gained) == Ordering::Less {
            return Err(invalid(format!(
                "Unfunded lock for {key}: {} moved into a locked account but only {} left the same owner's available \
                 balance — locks must be paired with an available counter-entry (§4.2)",
                gained.format(),
                g.format()
            )));
        }
    }
    Ok(())
}

/// `assertPurposedLocks`: every lock pot names its claim, and never a `legacy:` stamp.
fn assert_purposed_locks(entries: &[Entry]) -> Result<(), Failure> {
    const DOCTRINE: &str = "P0-3 / L3-4 / L1-L3-5 / §8.1";
    for e in entries {
        let a = &e.account;
        if !LOCK_KINDS.contains(&a.kind.as_str()) {
            continue;
        }
        let purpose = a.purpose();
        if purpose.is_empty() {
            return Err(invalid(format!(
                "lock pot account for {}:{} in {} has no purpose — a {} must name its claim (e.g. \"order:<id>\", \
                 \"trade:<id>\", \"token:stake:<id>\") so one claim cannot spend another's reservation ({DOCTRINE})",
                a.owner_type, a.owner_id, a.asset_id, a.kind
            )));
        }
        if purpose.starts_with("legacy:") {
            return Err(invalid(format!(
                "lock pot account for {}:{} in {} uses forbidden purpose \"{purpose}\" — the legacy: prefix was a \
                 one-time migration stamp, not a claim (migration 0008 / {DOCTRINE})",
                a.owner_type, a.owner_id, a.asset_id
            )));
        }
    }
    Ok(())
}

/// `assertAvailableUnpurposed`.
fn assert_available_unpurposed(entries: &[Entry]) -> Result<(), Failure> {
    for e in entries {
        let a = &e.account;
        if a.kind != "available" {
            continue;
        }
        if let Some(p) = a.purpose.as_deref().filter(|p| !js_trim(p).is_empty()) {
            return Err(invalid(format!(
                "available account for {}:{} in {} must not carry purpose \"{p}\" — available is fungible; only lock \
                 pots name a claim (P0-3 / §4.2)",
                a.owner_type, a.owner_id, a.asset_id
            )));
        }
    }
    Ok(())
}

/// `assertValidPost`, in its order: the key, the owners' identifier spaces, the balance, the paired locks, the
/// purposed locks, the unpurposed available pots.
pub fn assert_valid_post(r: &PostRequest) -> Result<(), Failure> {
    assert_idempotency_key(&r.idempotency_key)?;
    assert_owner_identifier_space(&r.entries)?;
    assert_balanced(&r.entries)?;
    assert_paired_locks(&r.entries)?;
    assert_purposed_locks(&r.entries)?;
    assert_available_unpurposed(&r.entries)
}

fn sha256_hex(parts: &[&[u8]]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// JavaScript's default sort: by UTF-16 code units.
pub fn js_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `postFingerprint(request)`: what a post moves, as one digest. THE ENCODING IS PERMANENT (stored digests outlive the
/// code): each entry's fields JSON-encoded, the entries sorted, then module, reason and entries JSON-encoded.
pub fn post_fingerprint(module: &str, reason: &str, entries: &[Entry]) -> String {
    let mut legs: Vec<String> = entries
        .iter()
        .map(|e| {
            Json::Array(vec![
                Json::str(e.account.owner_type.clone()),
                Json::str(e.account.owner_id.clone()),
                Json::str(e.account.asset_id.clone()),
                Json::str(e.account.kind.clone()),
                Json::str(e.account.purpose()),
                Json::str(e.direction.as_str()),
                // The scaled integer's digits, as bigint's `toString` gives them: the encoding is permanent.
                Json::str(e.amount.scaled().to_string()),
            ])
            .compact()
        })
        .collect();
    legs.sort_by(|a, b| js_cmp(a, b));
    let canonical = Json::Array(vec![
        Json::str(module),
        Json::str(reason),
        Json::Array(legs.into_iter().map(Json::String).collect()),
    ])
    .compact();
    sha256_hex(&[b"ledger-post-body-v1\0", canonical.as_bytes()])
}

/// `String(value)` for a value JSON can hold.
pub fn js_string(v: &Json) -> String {
    match v {
        Json::Null => "null".to_owned(),
        Json::Bool(b) => b.to_string(),
        Json::Number(n) => json::js_number_string(*n),
        Json::String(s) => s.clone(),
        Json::Array(items) => items
            .iter()
            .map(|i| match i {
                Json::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Json::Object(_) => "[object Object]".to_owned(),
    }
}

/// `WITHDRAW_META_BOUND`.
const WITHDRAW_META_BOUND: [&str; 3] = ["withdraw.held", "withdraw.settled", "withdraw.reversed"];

/// `replayMetaDiffers(posted, request)`: a retried withdrawal post naming another `fee` or `rail` than the booked one.
pub fn replay_meta_differs(
    posted: &Json,
    module: &str,
    reason: &str,
    asked: Option<&[(String, Json)]>,
) -> bool {
    if module != "ledger" || !WITHDRAW_META_BOUND.contains(&reason) {
        return false;
    }
    let of = |v: Option<&Json>| match v {
        None | Some(Json::Null) => String::new(),
        Some(v) => js_string(v),
    };
    ["fee", "rail"].iter().any(|f| {
        let a = asked.and_then(|m| m.iter().find(|(k, _)| k == f).map(|(_, v)| v));
        of(posted.get(f)) != of(a)
    })
}

/// `canonicalMeta(meta)`: keys sorted, at every depth, in the order a JavaScript object then keeps them.
pub fn canonical_meta(meta: Option<&[(String, Json)]>) -> Json {
    let Some(fields) = meta else {
        return Json::Object(Vec::new());
    };
    let mut sorted: Vec<(String, Json)> = fields
        .iter()
        .map(|(k, v)| (k.clone(), canonical_value(v)))
        .collect();
    sorted.sort_by(|(a, _), (b, _)| js_cmp(a, b));
    Json::Object(json::js_key_order(sorted))
}

fn canonical_value(v: &Json) -> Json {
    match v {
        Json::Array(items) => Json::Array(items.iter().map(canonical_value).collect()),
        Json::Object(o) => canonical_meta(Some(o)),
        other => other.clone(),
    }
}

/// `CustodyLayerOffError`.
pub fn custody_layer_off(module: &str, reason: &str) -> Failure {
    Failure::ledger(
        errors::CUSTODY_LAYER_OFF,
        format!(
            "The custodial layer is switched off: {module}/{reason} would move a customer balance in INTAFACED's ledger, \
             and INTAFACED holds no customer money (OWNER 226). Nothing was posted."
        ),
    )
}
