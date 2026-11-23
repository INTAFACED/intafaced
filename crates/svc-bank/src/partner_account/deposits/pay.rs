//! Custody's side of deposits, as svc-bank asks it: svc-pay over the signed seam (`deposits/pay-custody-port.ts` over
//! `@intafaced/contracts/pay-custody-deposit-client`), and svc-ledger's asset registry (`createLedgerAssetRegistry`).
//!
//! `Ok(None)` from the custody port means custody is not answering (no URL, a short secret, a refusal, a non-2xx, a
//! reply outside its schema, a timeout): the service refuses `bank.deposit_custody_unset` and invents nothing. `Err`
//! is a port that failed outright, which the service answers as an opaque failure.

use std::collections::BTreeMap;

use service_kit::http::{Fetch, HttpRequest, UreqFetch};
use service_kit::json::{self, Json};
use service_kit::s2s::{legacy_headers, system_seconds};
use service_kit::time::zod_datetime;

use crate::partner_account::recovery::env_value;

/// One network an asset can be paid in on (`DepositNetwork`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Network {
    pub id: String,
    pub label: String,
    pub minimum_deposit: String,
    pub confirmations_required: i64,
    pub estimated_arrival_minutes: i64,
    pub unsupported: Option<Vec<String>>,
}

/// `DepositAsset`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    pub asset_id: String,
    pub networks: Vec<Network>,
}

/// `HaltedDepositPair`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Halted {
    pub asset_id: String,
    pub network_id: String,
    pub label: String,
    pub halt_note: Option<String>,
}

/// `CustodyDepositCatalogue`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Catalogue {
    pub assets: Vec<Asset>,
    pub halted: Vec<Halted>,
}

/// `CustodyDepositAddressRequest`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddressRequest {
    pub user_id: String,
    pub asset_id: String,
    pub network_id: String,
    pub address_index: Option<i64>,
    pub expires_at: Option<String>,
}

/// `CustodyDepositAddress`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issued {
    pub address: String,
    pub memo: Option<String>,
    pub qr_payload: Option<String>,
    pub expires_at: Option<String>,
}

/// `CustodyPendingDeposit`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pending {
    pub id: String,
    pub asset_id: String,
    pub network_id: String,
    pub amount: String,
    pub confirmations: i64,
    pub confirmations_required: Option<i64>,
}

/// `CustodyDepositRecordsQuery`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordsQuery {
    pub user_id: String,
    pub asset_id: Option<String>,
    pub network_id: Option<String>,
    pub statuses: Option<Vec<String>>,
    pub tx_hash: Option<String>,
    pub address: Option<String>,
    pub offset: i64,
    pub limit: i64,
}

/// A page of the person's deposit records, each in the record's own field order.
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub items: Vec<Json>,
    pub total: i64,
}

/// `CustodyDepositPort`.
pub trait Custody: Send + Sync {
    fn catalogue(&self) -> Result<Option<Catalogue>, String>;
    fn address(&self, req: &AddressRequest) -> Result<Option<Issued>, String>;
    fn pending(&self, user_id: &str) -> Result<Option<Vec<Pending>>, String>;
    fn records(&self, q: &RecordsQuery) -> Result<Option<Page>, String>;
}

/// One registry row, the fields deposits read (`RegistryAsset`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryAsset {
    pub id: String,
    pub precision: i64,
    pub state: String,
    pub allowed_actions: Vec<String>,
    pub networks: Vec<String>,
}

/// `AssetRegistryReads`: every published row, any state; `Err` is a read that failed.
pub trait Registry: Send + Sync {
    fn listed(&self) -> Result<Vec<RegistryAsset>, String>;
}

/// A door built without the service's environment (no `INTERNAL_SERVICE_SECRET`, which env.ts requires): no client is
/// wired, so every ask fails outright, as the TypeScript replay's unwired stubs do.
pub struct Unwired;

const UNWIRED: &str = "custody deposits are not wired";

impl Custody for Unwired {
    fn catalogue(&self) -> Result<Option<Catalogue>, String> {
        Err(UNWIRED.to_owned())
    }
    fn address(&self, _: &AddressRequest) -> Result<Option<Issued>, String> {
        Err(UNWIRED.to_owned())
    }
    fn pending(&self, _: &str) -> Result<Option<Vec<Pending>>, String> {
        Err(UNWIRED.to_owned())
    }
    fn records(&self, _: &RecordsQuery) -> Result<Option<Page>, String> {
        Err(UNWIRED.to_owned())
    }
}

impl Registry for Unwired {
    fn listed(&self) -> Result<Vec<RegistryAsset>, String> {
        Err("the asset registry is not wired".to_owned())
    }
}

fn utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JavaScript's `\s`.
fn has_space(s: &str) -> bool {
    s.chars().any(service_kit::money::is_js_whitespace)
}

fn no_space(s: &str, max: usize) -> bool {
    !s.is_empty() && utf16(s) <= max && !has_space(s)
}

fn asset_id_ok(s: &str) -> bool {
    (1..=16).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn network_id_ok(s: &str) -> bool {
    (1..=32).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `decimalSchema`: `/^(0|[1-9]\d{0,29})(\.\d{1,18})?$/`.
fn decimal_ok(s: &str) -> bool {
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (s, None),
    };
    let digits = |t: &str| t.bytes().all(|b| b.is_ascii_digit());
    let whole_ok = whole == "0"
        || (!whole.is_empty() && whole.len() <= 30 && digits(whole) && !whole.starts_with('0'));
    whole_ok && frac.is_none_or(|f| (1..=18).contains(&f.len()) && digits(f))
}

fn int_in(v: Option<&Json>, min: i64, max: i64) -> Option<i64> {
    let Some(Json::Number(n)) = v else {
        return None;
    };
    let i: i64 = json::js_number_string(*n).parse().ok()?;
    (min..=max).contains(&i).then_some(i)
}

fn text<'a>(v: &'a Json, key: &str) -> Option<&'a str> {
    match v.get(key) {
        Some(Json::String(s)) => Some(s),
        _ => None,
    }
}

/// A key that may be a string within bounds, or null.
fn nullable(v: &Json, key: &str, ok: impl Fn(&str) -> bool) -> Option<Option<String>> {
    match v.get(key) {
        Some(Json::Null) => Some(None),
        Some(Json::String(s)) if ok(s) => Some(Some(s.clone())),
        _ => None,
    }
}

fn strict(v: &Json, keys: &[&str]) -> bool {
    matches!(v, Json::Object(f) if f.iter().all(|(k, _)| keys.contains(&k.as_str())))
}

fn datetime_ok(s: &str) -> bool {
    zod_datetime(s, false).is_some()
}

/// `payCustodyDepositCatalogueSchema`, grouped by asset in first-seen order as the port groups it.
fn parse_catalogue(v: &Json) -> Option<Catalogue> {
    if !strict(v, &["entries", "halted"]) {
        return None;
    }
    let Some(Json::Array(entries)) = v.get("entries") else {
        return None;
    };
    if entries.len() > 500 {
        return None;
    }
    let mut assets: Vec<Asset> = Vec::new();
    for e in entries {
        let keys = [
            "assetId",
            "networkId",
            "label",
            "minimumDeposit",
            "confirmationsRequired",
            "estimatedArrivalMinutes",
            "memoRequired",
            "sharedAddressGroup",
            "unsupported",
        ];
        if !strict(e, &keys) {
            return None;
        }
        let asset_id = text(e, "assetId").filter(|s| asset_id_ok(s))?;
        let network_id = text(e, "networkId").filter(|s| network_id_ok(s))?;
        let label = text(e, "label").filter(|s| (1..=64).contains(&utf16(s)))?;
        let minimum = text(e, "minimumDeposit").filter(|s| decimal_ok(s))?;
        let confirmations = int_in(e.get("confirmationsRequired"), 1, 100_000)?;
        let arrival = int_in(e.get("estimatedArrivalMinutes"), 1, 100_000)?;
        if !matches!(e.get("memoRequired"), Some(Json::Bool(_))) {
            return None;
        }
        nullable(e, "sharedAddressGroup", |s| (1..=64).contains(&utf16(s)))?;
        let unsupported = match e.get("unsupported") {
            None => None,
            Some(Json::Array(cases)) => {
                if cases.is_empty() || cases.len() > 20 {
                    return None;
                }
                let mut out: Vec<String> = Vec::new();
                for c in cases {
                    let Json::String(c) = c else { return None };
                    if !(1..=280).contains(&utf16(c))
                        || service_kit::money::js_trim(c) != c
                        || out.contains(c)
                    {
                        return None;
                    }
                    out.push(c.clone());
                }
                Some(out)
            }
            Some(_) => return None,
        };
        let network = Network {
            id: network_id.to_owned(),
            label: label.to_owned(),
            minimum_deposit: minimum.to_owned(),
            confirmations_required: confirmations,
            estimated_arrival_minutes: arrival,
            unsupported,
        };
        match assets.iter_mut().find(|a| a.asset_id == asset_id) {
            Some(a) => a.networks.push(network),
            None => assets.push(Asset {
                asset_id: asset_id.to_owned(),
                networks: vec![network],
            }),
        }
    }
    let halted = match v.get("halted") {
        None => Vec::new(),
        Some(Json::Array(rows)) if rows.len() <= 500 => rows
            .iter()
            .map(|h| {
                if !strict(h, &["assetId", "networkId", "label", "haltNote"]) {
                    return None;
                }
                Some(Halted {
                    asset_id: text(h, "assetId").filter(|s| asset_id_ok(s))?.to_owned(),
                    network_id: text(h, "networkId")
                        .filter(|s| network_id_ok(s))?
                        .to_owned(),
                    label: text(h, "label")
                        .filter(|s| (1..=64).contains(&utf16(s)))?
                        .to_owned(),
                    halt_note: nullable(h, "haltNote", |s| (1..=280).contains(&utf16(s)))?,
                })
            })
            .collect::<Option<Vec<_>>>()?,
        Some(_) => return None,
    };
    Some(Catalogue { assets, halted })
}

/// `payCustodyDepositAddressReplySchema`'s issued address, or `None` for a refusal or a reply outside it.
fn parse_address_reply(v: &Json) -> Option<Option<(Issued, i64)>> {
    match text(v, "state") {
        Some("refused") => {
            let refusals = [
                "pay.deposit_pair_unpublished",
                "pay.deposit_source_unset",
                "pay.deposit_address_expiry_past",
            ];
            (strict(v, &["state", "code"])
                && text(v, "code").is_some_and(|c| refusals.contains(&c)))
            .then_some(None)
        }
        Some("issued") => {
            if !strict(v, &["state", "address"]) {
                return None;
            }
            let a = v.get("address")?;
            if !strict(
                a,
                &["address", "memo", "qrPayload", "addressIndex", "expiresAt"],
            ) {
                return None;
            }
            let address = text(a, "address").filter(|s| no_space(s, 256))?;
            let memo = nullable(a, "memo", |s| (1..=128).contains(&utf16(s)))?;
            let qr = nullable(a, "qrPayload", |s| (1..=512).contains(&utf16(s)))?;
            let index = match a.get("addressIndex") {
                None => 0,
                some => int_in(some, 0, 9999)?,
            };
            let expires_at = match a.get("expiresAt") {
                None | Some(Json::Null) => None,
                Some(Json::String(s)) if datetime_ok(s) => Some(s.clone()),
                Some(_) => return None,
            };
            Some(Some((
                Issued {
                    address: address.to_owned(),
                    memo,
                    qr_payload: qr,
                    expires_at,
                },
                index,
            )))
        }
        _ => None,
    }
}

/// `PAY_CUSTODY_DEPOSIT_STATUSES`.
pub const STATUSES: [&str; 11] = [
    "detected",
    "confirming",
    "credited",
    "below_minimum",
    "held_for_screening",
    "held_for_release",
    "on_hold",
    "held_travel_rule",
    "rejected",
    "reversed",
    "needs_review",
];

const REASONS: [&str; 14] = [
    "below_minimum",
    "amount_mismatch",
    "unknown_asset",
    "minimum_unset",
    "confirmations_unset",
    "chain_reorg",
    "reversal_unfunded",
    "address_expired",
    "address_frozen",
    "travel_rule_unset",
    "travel_rule_declaration",
    "travel_rule_review",
    "travel_rule_counterparty",
    "travel_rule_expired",
];

const RECORD_KEYS: [&str; 14] = [
    "id",
    "assetId",
    "networkId",
    "address",
    "txHash",
    "outputIndex",
    "amount",
    "confirmations",
    "confirmationsRequired",
    "status",
    "reason",
    "minimumDeposit",
    "detectedAt",
    "creditedAt",
];

/// `payCustodyDepositRecordSchema`: the record, rebuilt in the schema's field order, or `None` outside it.
fn parse_record(r: &Json) -> Option<Json> {
    if !strict(r, &RECORD_KEYS) {
        return None;
    }
    let ok = text(r, "id").is_some_and(|s| (1..=128).contains(&utf16(s)))
        && text(r, "assetId").is_some_and(asset_id_ok)
        && text(r, "networkId").is_some_and(network_id_ok)
        && text(r, "address").is_some_and(|s| no_space(s, 256))
        && text(r, "txHash").is_some_and(|s| no_space(s, 128))
        && int_in(r.get("outputIndex"), 0, 1_000_000).is_some()
        && text(r, "amount").is_some_and(decimal_ok)
        && int_in(r.get("confirmations"), 0, 1_000_000).is_some()
        && (matches!(r.get("confirmationsRequired"), Some(Json::Null))
            || int_in(r.get("confirmationsRequired"), 1, 100_000).is_some())
        && text(r, "status").is_some_and(|s| STATUSES.contains(&s))
        && nullable(r, "reason", |s| REASONS.contains(&s)).is_some()
        && nullable(r, "minimumDeposit", decimal_ok).is_some()
        && text(r, "detectedAt").is_some_and(datetime_ok)
        && nullable(r, "creditedAt", datetime_ok).is_some();
    ok.then(|| {
        Json::Object(
            RECORD_KEYS
                .iter()
                .map(|k| ((*k).to_owned(), r.get(k).cloned().unwrap_or(Json::Null)))
                .collect(),
        )
    })
}

/// `payCustodyDepositRecordsReplySchema`.
fn parse_records(v: &Json) -> Option<Page> {
    if !strict(v, &["items", "total"]) {
        return None;
    }
    let Some(Json::Array(items)) = v.get("items") else {
        return None;
    };
    if items.len() > 200 {
        return None;
    }
    Some(Page {
        items: items.iter().map(parse_record).collect::<Option<Vec<_>>>()?,
        total: int_in(v.get("total"), 0, 9_007_199_254_740_991)?,
    })
}

/// `payCustodyDepositRecordsInputSchema` held to the query, as the body the client sends; `None` outside it.
fn records_body(q: &RecordsQuery) -> Option<Json> {
    let mut f: Vec<(String, Json)> = Vec::new();
    if !(1..=128).contains(&utf16(&q.user_id)) {
        return None;
    }
    f.push(("userId".to_owned(), Json::str(q.user_id.clone())));
    if let Some(a) = &q.asset_id {
        if !asset_id_ok(a) {
            return None;
        }
        f.push(("assetId".to_owned(), Json::str(a.clone())));
    }
    if let Some(n) = &q.network_id {
        if !network_id_ok(n) {
            return None;
        }
        f.push(("networkId".to_owned(), Json::str(n.clone())));
    }
    if let Some(s) = &q.statuses {
        if s.is_empty()
            || s.len() > STATUSES.len()
            || !s.iter().all(|x| STATUSES.contains(&x.as_str()))
        {
            return None;
        }
        f.push((
            "statuses".to_owned(),
            Json::Array(s.iter().map(|x| Json::str(x.clone())).collect()),
        ));
    }
    if let Some(t) = &q.tx_hash {
        if !no_space(t, 128) {
            return None;
        }
        f.push(("txHash".to_owned(), Json::str(t.clone())));
    }
    if let Some(a) = &q.address {
        if !no_space(a, 256) {
            return None;
        }
        f.push(("address".to_owned(), Json::str(a.clone())));
    }
    if !(0..=1_000_000).contains(&q.offset) || !(1..=200).contains(&q.limit) {
        return None;
    }
    f.push(("offset".to_owned(), Json::int(q.offset)));
    f.push(("limit".to_owned(), Json::int(q.limit)));
    Some(Json::Object(f))
}

/// `payCustodyDepositAddressInputSchema` held to the request, as the body the client sends; `None` outside it.
fn address_body(r: &AddressRequest) -> Option<Json> {
    if !(1..=128).contains(&utf16(&r.user_id))
        || !asset_id_ok(&r.asset_id)
        || !network_id_ok(&r.network_id)
    {
        return None;
    }
    let mut f = vec![
        ("userId".to_owned(), Json::str(r.user_id.clone())),
        ("assetId".to_owned(), Json::str(r.asset_id.clone())),
        ("networkId".to_owned(), Json::str(r.network_id.clone())),
    ];
    if let Some(i) = r.address_index {
        if !(0..=9999).contains(&i) {
            return None;
        }
        f.push(("addressIndex".to_owned(), Json::int(i)));
    }
    if let Some(e) = &r.expires_at {
        if !datetime_ok(e) {
            return None;
        }
        f.push(("expiresAt".to_owned(), Json::str(e.clone())));
    }
    let extra = r.address_index.unwrap_or(0) > 0;
    if extra != r.expires_at.is_some() {
        return None;
    }
    Some(Json::Object(f))
}

/// svc-pay's custody deposit paths over HTTP (`createPayCustodyDepositClient` and `createPayCustodyDepositPort`).
pub struct HttpPay {
    /// The checked base URL, or none when `PAY_URL` is missing or not a plain http(s) URL.
    pub base: Option<String>,
    pub secret: String,
    pub fetch: Box<dyn Fetch>,
}

/// `new URL(payUrl)`: http or https, no credentials, query or fragment; its `href` without a trailing slash.
pub fn pay_base(raw: Option<&str>) -> Option<String> {
    let url = url::Url::parse(raw?).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some_and(|q| !q.is_empty())
        || url.fragment().is_some_and(|f| !f.is_empty())
    {
        return None;
    }
    let href = url.to_string();
    Some(
        href.strip_suffix('/')
            .map_or_else(|| href.clone(), str::to_owned),
    )
}

impl HttpPay {
    /// One bounded, signed POST; any failure is `None`.
    fn post<T>(&self, path: &str, payload: &Json, parse: impl Fn(&Json) -> Option<T>) -> Option<T> {
        let base = self.base.as_ref()?;
        if self.secret.encode_utf16().count() < 32 {
            return None;
        }
        let body = payload.compact();
        let mut headers = vec![
            ("content-type".to_owned(), "application/json".to_owned()),
            ("cache-control".to_owned(), "no-store".to_owned()),
        ];
        headers.extend(legacy_headers("svc-bank", &self.secret, &body, system_seconds()).ok()?);
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: format!("{base}{path}"),
                headers,
                body: Some(body),
                timeout_ms: Some(3_000),
                refuse_redirect: true,
            })
            .ok()?;
        if !res.ok() {
            return None;
        }
        parse(&json::parse(&res.body).ok()?)
    }
}

impl Custody for HttpPay {
    fn catalogue(&self) -> Result<Option<Catalogue>, String> {
        Ok(self.post(
            "/internal/custody-deposits/catalogue",
            &Json::Object(Vec::new()),
            parse_catalogue,
        ))
    }

    fn address(&self, req: &AddressRequest) -> Result<Option<Issued>, String> {
        let Some(body) = address_body(req) else {
            return Ok(None);
        };
        let Some(Some((issued, index))) = self.post(
            "/internal/custody-deposits/address",
            &body,
            parse_address_reply,
        ) else {
            return Ok(None);
        };
        // An extra address must come back as the one asked for, with its stored expiry; anything else is not repeated.
        let asked = req.address_index.unwrap_or(0);
        if index != asked || (asked > 0 && issued.expires_at.is_none()) {
            return Ok(None);
        }
        Ok(Some(issued))
    }

    fn pending(&self, user_id: &str) -> Result<Option<Vec<Pending>>, String> {
        // One more than the door publishes, so a full page is seen as too many and never silently cut.
        let page = self.records(&RecordsQuery {
            user_id: user_id.to_owned(),
            asset_id: None,
            network_id: None,
            statuses: Some(vec!["detected".to_owned(), "confirming".to_owned()]),
            tx_hash: None,
            address: None,
            offset: 0,
            limit: 101,
        })?;
        Ok(page.map(|p| {
            p.items
                .iter()
                .map(|r| Pending {
                    id: text(r, "id").unwrap_or_default().to_owned(),
                    asset_id: text(r, "assetId").unwrap_or_default().to_owned(),
                    network_id: text(r, "networkId").unwrap_or_default().to_owned(),
                    amount: text(r, "amount").unwrap_or_default().to_owned(),
                    confirmations: int_in(r.get("confirmations"), 0, 1_000_000).unwrap_or(0),
                    confirmations_required: int_in(r.get("confirmationsRequired"), 1, 100_000),
                })
                .collect()
        }))
    }

    fn records(&self, q: &RecordsQuery) -> Result<Option<Page>, String> {
        let Some(body) = records_body(q) else {
            return Ok(None);
        };
        Ok(self.post("/internal/custody-deposits/records", &body, parse_records))
    }
}

/// svc-ledger's `/trpc/assetsList`, every state (`createLedgerAssetRegistry`'s `listed`).
pub struct HttpRegistry {
    pub reads: super::super::recovery::ledger::HttpLedger,
}

/// `assetsListOutputSchema`'s rows, the fields deposits read; anything outside it fails the read.
pub fn parse_registry(v: &Json) -> Result<Vec<RegistryAsset>, String> {
    let bad = || "svc-ledger assetsList answered outside its schema".to_owned();
    let Some(Json::Array(rows)) = v.get("assets") else {
        return Err(bad());
    };
    rows.iter()
        .map(|r| {
            let strings = |key: &str| -> Option<Vec<String>> {
                match r.get(key) {
                    Some(Json::Array(a)) => a
                        .iter()
                        .map(|x| match x {
                            Json::String(s) => Some(s.clone()),
                            _ => None,
                        })
                        .collect(),
                    _ => None,
                }
            };
            let networks = match r.get("networks") {
                Some(Json::Array(a)) => a
                    .iter()
                    .map(|n| text(n, "networkId").map(str::to_owned))
                    .collect::<Option<Vec<_>>>(),
                _ => None,
            };
            let row = || -> Option<RegistryAsset> {
                Some(RegistryAsset {
                    id: text(r, "id")?.to_owned(),
                    precision: int_in(r.get("precision"), 0, 18)?,
                    state: text(r, "state")
                        .filter(|s| ["active", "halted", "retired"].contains(s))?
                        .to_owned(),
                    allowed_actions: strings("allowedActions")?,
                    networks: networks?,
                })
            };
            row().ok_or_else(bad)
        })
        .collect()
}

impl Registry for HttpRegistry {
    fn listed(&self) -> Result<Vec<RegistryAsset>, String> {
        parse_registry(
            &self
                .reads
                .call_json("/trpc/assetsList", &Json::Object(Vec::new()))?,
        )
    }
}

/// The custody port and the registry, as the deposit service holds them.
pub type Ports = (Box<dyn Custody>, Box<dyn Registry>);

/// The custody port and the registry from the environment (`PAY_URL`, `LEDGER_URL`, `INTERNAL_SERVICE_SECRET`).
pub fn from_env(env: &BTreeMap<String, String>) -> Result<Ports, String> {
    let Some(signer) = super::super::recovery::call_signer(env, "svc-ledger")? else {
        return Ok((Box::new(Unwired), Box::new(Unwired)));
    };
    let pay = HttpPay {
        base: pay_base(env_value(env, "PAY_URL")),
        secret: env_value(env, "INTERNAL_SERVICE_SECRET")
            .unwrap_or_default()
            .to_owned(),
        fetch: Box::new(UreqFetch::new()),
    };
    let registry = HttpRegistry {
        reads: super::super::recovery::ledger::HttpLedger {
            base: env_value(env, "LEDGER_URL")
                .unwrap_or("http://localhost:4001")
                .to_owned(),
            signer,
            fetch: Box::new(UreqFetch::new()),
            post: None,
        },
    };
    Ok((Box::new(pay), Box::new(registry)))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "a test")]
    use super::*;
    use service_kit::http::{FetchError, HttpResponse};
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct Pay(Arc<Mutex<Vec<HttpRequest>>>, &'static str);

    impl Fetch for Pay {
        fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
            self.0.lock().unwrap().push(req.clone());
            Ok(HttpResponse {
                status: 200,
                body: self.1.to_owned(),
            })
        }
    }

    fn pay(body: &'static str) -> (HttpPay, Pay) {
        let seen = Pay(Arc::new(Mutex::new(Vec::new())), body);
        (
            HttpPay {
                base: pay_base(Some("http://pay:4005/")),
                secret: "a-pay-test-secret-that-is-long-enough-0".to_owned(),
                fetch: Box::new(seen.clone()),
            },
            seen,
        )
    }

    #[test]
    fn the_catalogue_is_grouped_by_asset_in_the_order_pay_lists_it() {
        let (p, seen) = pay(
            r#"{"entries":[{"assetId":"USDC","networkId":"ethereum","label":"Ethereum","minimumDeposit":"1","confirmationsRequired":12,"estimatedArrivalMinutes":5,"memoRequired":false,"sharedAddressGroup":null},{"assetId":"BTC","networkId":"bitcoin","label":"Bitcoin","minimumDeposit":"0.0001","confirmationsRequired":2,"estimatedArrivalMinutes":30,"memoRequired":false,"sharedAddressGroup":null,"unsupported":["Ordinals"]},{"assetId":"USDC","networkId":"base","label":"Base","minimumDeposit":"1","confirmationsRequired":1,"estimatedArrivalMinutes":1,"memoRequired":false,"sharedAddressGroup":"evm"}],"halted":[{"assetId":"ETH","networkId":"ethereum","label":"Ethereum","haltNote":null}]}"#,
        );
        let c = p.catalogue().unwrap().unwrap();
        assert_eq!(c.assets.len(), 2);
        assert_eq!(c.assets[0].networks.len(), 2);
        assert_eq!(
            c.assets[1].networks[0].unsupported,
            Some(vec!["Ordinals".to_owned()])
        );
        assert_eq!(c.halted[0].asset_id, "ETH");
        let seen = seen.0.lock().unwrap();
        assert_eq!(
            seen[0].url,
            "http://pay:4005/internal/custody-deposits/catalogue"
        );
        assert_eq!(seen[0].body.as_deref(), Some("{}"));
        assert_eq!(
            seen[0].headers[1],
            ("cache-control".to_owned(), "no-store".to_owned())
        );
        assert!(seen[0].refuse_redirect);
    }

    #[test]
    fn a_reply_outside_its_schema_or_a_short_secret_is_not_answering() {
        let (p, _) = pay(r#"{"entries":[{"assetId":"USDC"}]}"#);
        assert_eq!(p.catalogue().unwrap(), None);
        let (mut p, seen) = pay(r#"{"entries":[]}"#);
        p.secret = "short".to_owned();
        assert_eq!(p.catalogue().unwrap(), None);
        assert!(seen.0.lock().unwrap().is_empty());
        assert_eq!(pay_base(Some("ftp://pay")), None);
        assert_eq!(pay_base(Some("http://u:p@pay")), None);
        assert_eq!(pay_base(None), None);
    }

    #[test]
    fn an_extra_address_must_come_back_as_the_one_asked_for_with_its_expiry() {
        let req = |index: Option<i64>, exp: Option<&str>| AddressRequest {
            user_id: "u".to_owned(),
            asset_id: "USDC".to_owned(),
            network_id: "ethereum".to_owned(),
            address_index: index,
            expires_at: exp.map(str::to_owned),
        };
        let (p, seen) =
            pay(r#"{"state":"issued","address":{"address":"0xabc","memo":null,"qrPayload":null}}"#);
        assert_eq!(
            p.address(&req(None, None)).unwrap().unwrap().address,
            "0xabc"
        );
        assert_eq!(
            seen.0.lock().unwrap()[0].body.as_deref(),
            Some(r#"{"userId":"u","assetId":"USDC","networkId":"ethereum"}"#)
        );
        assert_eq!(
            p.address(&req(Some(1), Some("2030-01-01T00:00:00.000Z")))
                .unwrap(),
            None
        );
        let (p, _) = pay(
            r#"{"state":"issued","address":{"address":"0xdef","memo":null,"qrPayload":null,"addressIndex":1,"expiresAt":"2030-01-01T00:00:00.000Z"}}"#,
        );
        assert_eq!(
            p.address(&req(Some(1), Some("2030-01-01T00:00:00.000Z")))
                .unwrap()
                .unwrap()
                .expires_at
                .as_deref(),
            Some("2030-01-01T00:00:00.000Z")
        );
        let (p, _) = pay(r#"{"state":"refused","code":"pay.deposit_source_unset"}"#);
        assert_eq!(p.address(&req(None, None)).unwrap(), None);
    }

    #[test]
    fn records_are_asked_with_the_query_held_to_pays_input() {
        let (p, seen) = pay(r#"{"items":[],"total":0}"#);
        let q = RecordsQuery {
            user_id: "u".to_owned(),
            asset_id: None,
            network_id: None,
            statuses: Some(vec!["credited".to_owned()]),
            tx_hash: Some("a b".to_owned()),
            address: None,
            offset: 0,
            limit: 50,
        };
        assert_eq!(p.records(&q).unwrap(), None);
        assert!(seen.0.lock().unwrap().is_empty());
        let q = RecordsQuery { tx_hash: None, ..q };
        assert_eq!(p.records(&q).unwrap().unwrap().total, 0);
        assert_eq!(
            seen.0.lock().unwrap()[0].body.as_deref(),
            Some(r#"{"userId":"u","statuses":["credited"],"offset":0,"limit":50}"#)
        );
        assert!(decimal_ok("0.5") && decimal_ok("10") && !decimal_ok("01") && !decimal_ok("1."));
    }
}
