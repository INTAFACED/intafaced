//! `deposits.*` (`deposits/deposit-service.ts`, `router.ts` `deposits`): customer crypto deposits. The catalogue,
//! the addresses and the incoming rows are custody's (svc-pay); this service posts nothing to the ledger and derives no
//! key. The catalogue is narrowed to svc-ledger's asset registry: a pair is open, and given an address, only while the
//! registry lists the asset as active, allowing deposits, on that network.
//!
//! Extra addresses: besides the first (number 0, which never expires) a person may make more for one asset on one
//! network, each with an optional label and an expiry `BANK_DEPOSIT_ADDRESS_EXPIRY_DAYS` after it is made, at most
//! `BANK_DEPOSIT_ADDRESS_CAP` open at once, the first included. Either setting blank refuses before custody is asked.
//! A number is never reused.

pub mod pay;

use std::collections::BTreeMap;

use service_kit::json::Json;
use service_kit::money::{format_amount, is_js_whitespace, js_trim, parse_amount};
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::time::{Instant, zod_datetime};

use self::pay::{
    AddressRequest, Catalogue, Custody, Issued, RecordsQuery, Registry, RegistryAsset,
};
use super::Deps;
use super::recovery::{db, env_value, iso, refusing_tx};
use crate::db::StoreError;
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::partner::refuse;

/// `BANK_DEPOSIT_ADDRESS_CAP_ENV`.
pub const CAP_ENV: &str = "BANK_DEPOSIT_ADDRESS_CAP";
/// `BANK_DEPOSIT_ADDRESS_EXPIRY_DAYS_ENV`.
pub const EXPIRY_ENV: &str = "BANK_DEPOSIT_ADDRESS_EXPIRY_DAYS";
const PENDING_CAP: usize = 100;
const MAX_ADDRESS_INDEX: i32 = 9999;
const LABEL_MAX: usize = 40;
/// `PAY_CUSTODY_DEPOSIT_UNSUPPORTED_MAX` and `PAY_CUSTODY_DEPOSIT_UNSUPPORTED_CASE_MAX`.
const UNSUPPORTED_MAX: usize = 20;
const UNSUPPORTED_CASE_MAX: usize = 280;

/// What this part holds: the custody port, svc-ledger's registry, and the owner's cap and expiry window as written.
pub struct Wiring {
    pub custody: Box<dyn Custody>,
    pub registry: Box<dyn Registry>,
    pub address_cap: Option<String>,
    pub address_expiry_days: Option<String>,
}

impl Wiring {
    pub fn from_env(env: &BTreeMap<String, String>) -> Result<Wiring, String> {
        let (custody, registry) = pay::from_env(env)?;
        Ok(Wiring {
            custody,
            registry,
            address_cap: env_value(env, CAP_ENV).map(str::to_owned),
            address_expiry_days: env_value(env, EXPIRY_ENV).map(str::to_owned),
        })
    }
}

fn utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

fn asset_ok(s: &str) -> bool {
    (1..=16).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn network_ok(s: &str) -> bool {
    (1..=32).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn invalid(message: impl Into<String>) -> Refusal {
    refuse("bank.deposit_catalogue_invalid", message)
}

/// `refuseCustody`.
fn refuse_custody(what: &str) -> Refusal {
    refuse(
        "bank.deposit_custody_unset",
        format!(
            "{what}. Crypto custody is not connected (bank.deposit_custody_unset). No address, minimum, or confirmation count is invented."
        ),
    )
}

/// A port that failed outright: an opaque failure, as a throw in the TypeScript is.
fn failed(e: String) -> Refusal {
    Refusal::Other(e)
}

/// One validated network as the catalogue publishes it, in the output's field order.
struct OpenNetwork {
    id: String,
    label: String,
    minimum_deposit: String,
    confirmations_required: i64,
    estimated_arrival_minutes: i64,
    unsupported: Option<Vec<String>>,
}

struct OpenAsset {
    asset_id: String,
    networks: Vec<OpenNetwork>,
}

struct HaltedView {
    asset_id: String,
    network_id: String,
    label: String,
    halt_note: Option<String>,
    /// `blockedBy: 'registry'` with the asset's registry state (inner `None`: the registry does not publish it).
    registry: Option<Option<String>>,
}

impl HaltedView {
    fn json(&self) -> Json {
        let mut f = vec![
            ("assetId".to_owned(), Json::str(self.asset_id.clone())),
            ("networkId".to_owned(), Json::str(self.network_id.clone())),
            ("label".to_owned(), Json::str(self.label.clone())),
            ("haltNote".to_owned(), opt(self.halt_note.as_deref())),
        ];
        if let Some(state) = &self.registry {
            f.push(("blockedBy".to_owned(), Json::str("registry")));
            f.push(("assetState".to_owned(), opt(state.as_deref())));
        }
        Json::Object(f)
    }
}

fn opt(v: Option<&str>) -> Json {
    v.map_or(Json::Null, Json::str)
}

/// `optionalText`.
fn optional_text(value: Option<&str>, max: usize, label: &str) -> Result<Option<String>, Refusal> {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let trimmed = js_trim(value);
    if trimmed != value || utf16(trimmed) > max {
        return Err(invalid(format!(
            "Custody returned a {label} this service will not store"
        )));
    }
    Ok(Some(trimmed.to_owned()))
}

/// `validateUnsupported`.
fn validate_unsupported(pair: &str, cases: &[String]) -> Result<Vec<String>, Refusal> {
    let refuse_why = |why: String| invalid(format!("Unsupported cases for {pair} {why}"));
    if cases.is_empty() {
        return Err(refuse_why("are an empty list".to_owned()));
    }
    if cases.len() > UNSUPPORTED_MAX {
        return Err(refuse_why(format!("are more than {UNSUPPORTED_MAX}")));
    }
    for item in cases {
        if item.is_empty() || js_trim(item) != item || utf16(item) > UNSUPPORTED_CASE_MAX {
            return Err(refuse_why(
                "include one that is blank, padded or too long".to_owned(),
            ));
        }
    }
    let mut seen: Vec<&String> = Vec::new();
    for item in cases {
        if seen.contains(&item) {
            return Err(refuse_why("name one case twice".to_owned()));
        }
        seen.push(item);
    }
    Ok(cases.to_vec())
}

/// `validateNetwork`.
fn validate_network(
    asset_id: &str,
    n: &pay::Network,
    seen: &mut Vec<String>,
) -> Result<OpenNetwork, Refusal> {
    if !network_ok(&n.id) {
        return Err(invalid(format!(
            "Deposit network id for {asset_id} is blank or not a short token"
        )));
    }
    if seen.contains(&n.id) {
        return Err(invalid(format!(
            "Deposit catalogue lists {asset_id} network {} twice",
            n.id
        )));
    }
    seen.push(n.id.clone());
    let label = js_trim(&n.label);
    if label.is_empty() || label != n.label || utf16(label) > 64 {
        return Err(invalid(format!(
            "Deposit network label for {asset_id}/{} is missing",
            n.id
        )));
    }
    let minimum = parse_amount(&n.minimum_deposit).map_err(|_| {
        invalid(format!(
            "Deposit minimum for {asset_id}/{} is not an exact decimal",
            n.id
        ))
    })?;
    if minimum <= 0 {
        return Err(invalid(format!(
            "Deposit minimum for {asset_id}/{} must be positive",
            n.id
        )));
    }
    if n.confirmations_required < 0 {
        return Err(invalid(format!(
            "Confirmations for {asset_id}/{} are not a non-negative integer",
            n.id
        )));
    }
    if n.estimated_arrival_minutes < 0 {
        return Err(invalid(format!(
            "Arrival minutes for {asset_id}/{} are not a non-negative integer",
            n.id
        )));
    }
    let unsupported = match &n.unsupported {
        None => None,
        Some(cases) => Some(validate_unsupported(
            &format!("{asset_id}/{}", n.id),
            cases,
        )?),
    };
    Ok(OpenNetwork {
        id: n.id.clone(),
        label: label.to_owned(),
        minimum_deposit: format_amount(minimum),
        confirmations_required: n.confirmations_required,
        estimated_arrival_minutes: n.estimated_arrival_minutes,
        unsupported,
    })
}

/// `validateCatalogue`.
fn validate_catalogue(assets: &[pay::Asset]) -> Result<Vec<OpenAsset>, Refusal> {
    if assets.len() > 50 {
        return Err(invalid("Deposit catalogue has more than 50 assets"));
    }
    let mut seen: Vec<&str> = Vec::new();
    assets
        .iter()
        .map(|asset| {
            if !asset_ok(&asset.asset_id) {
                return Err(invalid(
                    "Deposit catalogue asset id is not a 1–16 character symbol",
                ));
            }
            if seen.contains(&asset.asset_id.as_str()) {
                return Err(invalid(format!(
                    "Deposit catalogue lists {} twice",
                    asset.asset_id
                )));
            }
            seen.push(&asset.asset_id);
            if asset.networks.is_empty() {
                return Err(invalid(format!(
                    "Deposit catalogue asset {} has no network",
                    asset.asset_id
                )));
            }
            let mut networks: Vec<String> = Vec::new();
            Ok(OpenAsset {
                asset_id: asset.asset_id.clone(),
                networks: asset
                    .networks
                    .iter()
                    .map(|n| validate_network(&asset.asset_id, n, &mut networks))
                    .collect::<Result<Vec<_>, _>>()?,
            })
        })
        .collect()
}

/// `validateHalted`.
fn validate_halted(
    halted: &[pay::Halted],
    assets: &[OpenAsset],
) -> Result<Vec<HaltedView>, Refusal> {
    if halted.len() > 500 {
        return Err(invalid(
            "Deposit catalogue has more than 500 switched-off pairs",
        ));
    }
    let mut seen: Vec<String> = Vec::new();
    halted
        .iter()
        .map(|row| {
            if !asset_ok(&row.asset_id) || !network_ok(&row.network_id) {
                return Err(invalid(
                    "Switched-off deposit pair asset or network is not a short token",
                ));
            }
            let key = format!("{}:{}", row.asset_id, row.network_id);
            if seen.contains(&key) {
                return Err(invalid(format!(
                    "Deposit catalogue lists {key} as switched off twice"
                )));
            }
            seen.push(key.clone());
            if assets.iter().any(|a| {
                a.asset_id == row.asset_id && a.networks.iter().any(|n| n.id == row.network_id)
            }) {
                return Err(invalid(format!(
                    "Deposit catalogue lists {key} as both open and switched off"
                )));
            }
            let label = js_trim(&row.label);
            if label.is_empty() || label != row.label || utf16(label) > 64 {
                return Err(invalid(format!(
                    "Switched-off deposit pair {key} has no label"
                )));
            }
            Ok(HaltedView {
                asset_id: row.asset_id.clone(),
                network_id: row.network_id.clone(),
                label: label.to_owned(),
                halt_note: optional_text(row.halt_note.as_deref(), 280, "switch-off note")?,
                registry: None,
            })
        })
        .collect()
}

/// `registryAllowsDeposit`.
fn registry_allows(registry: &[RegistryAsset], asset_id: &str, network_id: &str) -> bool {
    registry.iter().find(|r| r.id == asset_id).is_some_and(|a| {
        a.state == "active"
            && a.allowed_actions.iter().any(|x| x == "deposit")
            && a.networks.iter().any(|n| n == network_id)
    })
}

/// `readBoth`: the custody catalogue, then the registry. Custody's refusal is the one reported when both fail.
fn read_both(w: &Wiring) -> Result<(Catalogue, Vec<RegistryAsset>), Refusal> {
    let registry = w.registry.listed();
    let catalogue = w
        .custody
        .catalogue()
        .map_err(failed)?
        .ok_or_else(|| refuse_custody("Deposit assets are not published"))?;
    let registry = registry.map_err(|_| {
        refuse(
            "bank.asset_registry_unavailable",
            "The list of supported assets and networks could not be read. Try again shortly",
        )
    })?;
    Ok((catalogue, registry))
}

fn assets(w: &Wiring) -> Result<Json, Refusal> {
    let (catalogue, registry) = read_both(w)?;
    let assets = validate_catalogue(&catalogue.assets)?;
    let mut halted = validate_halted(&catalogue.halted, &assets)?;
    let mut blocked: Vec<HaltedView> = Vec::new();
    let mut open: Vec<Json> = Vec::new();
    for asset in assets {
        let row = registry.iter().find(|r| r.id == asset.asset_id);
        let state = row.map(|r| r.state.clone());
        let mut networks: Vec<Json> = Vec::new();
        for n in asset.networks {
            if !registry_allows(&registry, &asset.asset_id, &n.id) {
                blocked.push(HaltedView {
                    asset_id: asset.asset_id.clone(),
                    network_id: n.id.clone(),
                    label: n.label.clone(),
                    halt_note: None,
                    registry: Some(state.clone()),
                });
                continue;
            }
            let mut f = vec![
                ("id".to_owned(), Json::str(n.id)),
                ("label".to_owned(), Json::str(n.label)),
                ("minimumDeposit".to_owned(), Json::str(n.minimum_deposit)),
                (
                    "confirmationsRequired".to_owned(),
                    Json::int(n.confirmations_required),
                ),
                (
                    "estimatedArrivalMinutes".to_owned(),
                    Json::int(n.estimated_arrival_minutes),
                ),
            ];
            if let Some(cases) = n.unsupported {
                f.push((
                    "unsupported".to_owned(),
                    Json::Array(cases.into_iter().map(Json::str).collect()),
                ));
            }
            networks.push(Json::Object(f));
        }
        if networks.is_empty() {
            continue;
        }
        // An open pair is one the registry allows, so its row is there: the precision Deposit uses is the list's own.
        let precision = row.map_or(0, |r| r.precision);
        open.push(Json::obj([
            ("assetId", Json::str(asset.asset_id)),
            ("precision", Json::int(precision)),
            ("networks", Json::Array(networks)),
        ]));
    }
    halted.append(&mut blocked);
    Ok(Json::obj([
        ("assets", Json::Array(open)),
        (
            "halted",
            Json::Array(halted.iter().map(HaltedView::json).collect()),
        ),
    ]))
}

/// `openPair`: the pair as the catalogue publishes it, refused when switched off or the registry does not allow it.
fn open_pair(w: &Wiring, asset_id: &str, network_id: &str) -> Result<(String, String), Refusal> {
    let (catalogue, registry) = read_both(w)?;
    let assets = validate_catalogue(&catalogue.assets)?;
    if catalogue
        .halted
        .iter()
        .any(|r| r.asset_id == asset_id && r.network_id == network_id)
    {
        return Err(refuse(
            "bank.deposit_network_halted",
            format!("Deposits of {asset_id} on {network_id} are switched off"),
        ));
    }
    let asset = assets
        .iter()
        .find(|a| a.asset_id == asset_id)
        .ok_or_else(|| {
            refuse(
                "bank.deposit_asset_unpublished",
                format!("Asset {asset_id} is not in the published deposit catalogue"),
            )
        })?;
    let network = asset
        .networks
        .iter()
        .find(|n| n.id == network_id)
        .ok_or_else(|| {
            refuse(
                "bank.deposit_asset_unpublished",
                format!("Network {network_id} is not published for {asset_id}"),
            )
        })?;
    if !registry_allows(&registry, &asset.asset_id, &network.id) {
        return Err(refuse(
            "bank.deposit_asset_unpublished",
            format!(
                "{} on {} is not in the supported asset list for deposits",
                asset.asset_id, network.id
            ),
        ));
    }
    Ok((asset.asset_id.clone(), network.id.clone()))
}

/// `validateIssued`.
fn validate_issued(issued: &Issued) -> Result<(String, Option<String>, Option<String>), Refusal> {
    let address = js_trim(&issued.address);
    if address.is_empty()
        || address != issued.address
        || utf16(address) > 256
        || address.chars().any(is_js_whitespace)
    {
        return Err(invalid(
            "Custody returned a deposit address this service will not store",
        ));
    }
    Ok((
        address.to_owned(),
        optional_text(issued.memo.as_deref(), 128, "memo")?,
        optional_text(issued.qr_payload.as_deref(), 512, "qr payload")?,
    ))
}

const ADDRESS_COLUMNS: &str = "asset_id, network_id, address, memo, qr_payload";

fn to_address(r: &postgres::Row) -> Result<Json, StoreError> {
    let maybe = |i: usize| -> Result<Json, StoreError> {
        Ok(opt(r.try_get::<_, Option<String>>(i)?.as_deref()))
    };
    Ok(Json::obj([
        ("assetId", Json::str(r.try_get::<_, String>(0)?)),
        ("networkId", Json::str(r.try_get::<_, String>(1)?)),
        ("address", Json::str(r.try_get::<_, String>(2)?)),
        ("memo", maybe(3)?),
        ("qrPayload", maybe(4)?),
    ]))
}

fn first_address(
    c: &mut postgres::Client,
    user: &str,
    asset: &str,
    network: &str,
) -> Result<Option<Json>, StoreError> {
    c.query(
        &format!(
            "SELECT {ADDRESS_COLUMNS} FROM bank.deposit_addresses \
             WHERE user_id = $1 AND asset_id = $2 AND network_id = $3 AND address_index = 0"
        ),
        &[&user, &asset, &network],
    )?
    .first()
    .map(to_address)
    .transpose()
}

/// `address`: idempotent on (user, asset, network); the first address custody returns is the one later calls return.
fn address(d: &Deps<'_>, user: &str, asset_id: &str, network_id: &str) -> Result<Json, Refusal> {
    let w = &d.wiring.deposits;
    let (asset, network) = open_pair(w, asset_id, network_id)?;
    if let Some(existing) = db(d.store, |c| first_address(c, user, &asset, &network))? {
        return Ok(existing);
    }
    let issued = w
        .custody
        .address(&AddressRequest {
            user_id: user.to_owned(),
            asset_id: asset.clone(),
            network_id: network.clone(),
            address_index: None,
            expires_at: None,
        })
        .map_err(failed)?
        .ok_or_else(|| {
            refuse_custody(&format!(
                "Custody did not issue a deposit address for {asset} on {network}"
            ))
        })?;
    let (addr, memo, qr) = validate_issued(&issued)?;
    let inserted = db(d.store, |c| {
        c.query(
            &format!(
                "INSERT INTO bank.deposit_addresses (user_id, asset_id, network_id, address, memo, qr_payload) \
                 VALUES ($1, $2, $3, $4, $5, $6) \
                 ON CONFLICT (user_id, asset_id, network_id, address_index) DO NOTHING \
                 RETURNING {ADDRESS_COLUMNS}"
            ),
            &[&user, &asset, &network, &addr, &memo, &qr],
        )?
        .first()
        .map(to_address)
        .transpose()
    })?;
    if let Some(row) = inserted {
        return Ok(row);
    }
    db(d.store, |c| first_address(c, user, &asset, &network))?.ok_or_else(|| {
        refuse(
            "bank.deposit_custody_unset",
            "Deposit address was not stored",
        )
    })
}

/// The list item's columns, with its instants as `toISOString` writes them.
fn list_columns() -> String {
    format!(
        "asset_id, network_id, address_index, address, memo, qr_payload, label, {}, {}, \
         (expires_at IS NOT NULL AND expires_at <= now()) AS expired",
        iso("created_at"),
        iso("expires_at")
    )
}

/// `toListItem`.
fn to_list_item(r: &postgres::Row) -> Result<Json, StoreError> {
    let maybe = |i: usize| -> Result<Json, StoreError> {
        Ok(opt(r.try_get::<_, Option<String>>(i)?.as_deref()))
    };
    let expired: bool = r.try_get(9)?;
    Ok(Json::obj([
        ("assetId", Json::str(r.try_get::<_, String>(0)?)),
        ("networkId", Json::str(r.try_get::<_, String>(1)?)),
        (
            "addressIndex",
            Json::int(i64::from(r.try_get::<_, i32>(2)?)),
        ),
        ("address", Json::str(r.try_get::<_, String>(3)?)),
        ("memo", maybe(4)?),
        ("qrPayload", maybe(5)?),
        ("label", maybe(6)?),
        ("createdAt", Json::str(r.try_get::<_, String>(7)?)),
        ("expiresAt", maybe(8)?),
        (
            "state",
            Json::str(if expired { "expired" } else { "active" }),
        ),
    ]))
}

/// `parseSetting`: unset, blank, zero or not a whole number up to 9999 is `None`.
fn parse_setting(raw: Option<&str>) -> Option<i64> {
    let t = js_trim(raw.unwrap_or_default());
    let b = t.as_bytes();
    let ok = (1..=4).contains(&b.len())
        && b.first().is_some_and(|c| (b'1'..=b'9').contains(c))
        && b.iter().all(u8::is_ascii_digit);
    ok.then(|| t.parse().ok()).flatten()
}

/// `requireSetting`.
fn require_setting(raw: Option<&str>, env: &str, code: &str, what: &str) -> Result<i64, Refusal> {
    parse_setting(raw).ok_or_else(|| {
        refuse(
            code,
            format!(
                "{env} is unset or not a whole number from 1 to 9999. No extra address is made rather than inventing {what}"
            ),
        )
    })
}

/// `cleanLabel`.
fn clean_label(raw: &Value) -> Result<Option<String>, Refusal> {
    let Some(raw) = raw.as_str() else {
        return Ok(None);
    };
    let label = js_trim(raw);
    if label.is_empty() {
        return Ok(None);
    }
    if utf16(label) > LABEL_MAX || label.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
        return Err(refuse(
            "bank.deposit_address_label_invalid",
            format!("A deposit address label is 1 to {LABEL_MAX} characters"),
        ));
    }
    Ok(Some(label.to_owned()))
}

/// `addresses`: per pair the first, then the newest first; expired ones included.
fn addresses(d: &Deps<'_>, user: &str, input: &Value) -> Result<Json, Refusal> {
    let asset = input.get("assetId").as_str().filter(|s| !s.is_empty());
    let network = input.get("networkId").as_str().filter(|s| !s.is_empty());
    let items = db(d.store, |c| {
        let mut sql = format!(
            "SELECT {} FROM bank.deposit_addresses WHERE user_id = $1",
            list_columns()
        );
        let mut params: Vec<&(dyn postgres::types::ToSql + Sync)> = vec![&user];
        if let Some(a) = &asset {
            params.push(a);
            sql.push_str(&format!(" AND asset_id = {}{}", '$', params.len()));
        }
        if let Some(n) = &network {
            params.push(n);
            sql.push_str(&format!(" AND network_id = {}{}", '$', params.len()));
        }
        sql.push_str(
            " ORDER BY asset_id, network_id, (address_index = 0) DESC, address_index DESC LIMIT 1000",
        );
        c.query(&sql, &params)?
            .iter()
            .map(to_list_item)
            .collect::<Result<Vec<_>, _>>()
    })?;
    let w = &d.wiring.deposits;
    let setting = |v: &Option<String>| parse_setting(v.as_deref()).map_or(Json::Null, Json::int);
    Ok(Json::obj([
        ("items", Json::Array(items)),
        ("cap", setting(&w.address_cap)),
        ("expiryDays", setting(&w.address_expiry_days)),
    ]))
}

/// `createAddress`: one more address for this asset and network, one make at a time per person and pair. If custody
/// issued and this crashed before storing, the retry asks custody for the same number and stores the address it issued.
fn create_address(d: &Deps<'_>, user: &str, input: &Value, now: Instant) -> Result<Json, Refusal> {
    let w = &d.wiring.deposits;
    let label = clean_label(input.get("label"))?;
    let cap = require_setting(
        w.address_cap.as_deref(),
        CAP_ENV,
        "bank.deposit_address_cap_unset",
        "a limit",
    )?;
    let days = require_setting(
        w.address_expiry_days.as_deref(),
        EXPIRY_ENV,
        "bank.deposit_address_expiry_unset",
        "an expiry",
    )?;
    let (asset, network) = open_pair(
        w,
        input.get("assetId").as_str().unwrap_or_default(),
        input.get("networkId").as_str().unwrap_or_default(),
    )?;
    refusing_tx(d.store, |tx| {
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtext($1))",
            &[&format!("deposit-address:{user}:{asset}:{network}")],
        )?;
        let held = tx.query_one(
            "SELECT count(*) FILTER (WHERE expires_at IS NULL OR expires_at > now()) AS open, \
                    max(address_index) AS top, bool_or(address_index = 0) AS first \
               FROM bank.deposit_addresses \
              WHERE user_id = $1 AND asset_id = $2 AND network_id = $3",
            &[&user, &asset, &network],
        )?;
        let open_now: i64 = held.try_get(0)?;
        let top: Option<i32> = held.try_get(1)?;
        let first: Option<bool> = held.try_get(2)?;
        // The first address takes its place in the cap even before it is asked for, since that door is never capped.
        let open = open_now + if first == Some(true) { 0 } else { 1 };
        let index = top.unwrap_or(0).max(0) + 1;
        if open >= cap {
            return Ok(Err(refuse(
                "bank.deposit_address_cap_reached",
                format!(
                    "You can hold at most {cap} open deposit addresses for {asset} on {network}"
                ),
            )));
        }
        if index > MAX_ADDRESS_INDEX {
            return Ok(Err(refuse(
                "bank.deposit_address_numbers_used",
                format!(
                    "Every deposit address number for {asset} on {network} has been used; no other address can be made"
                ),
            )));
        }
        let expires_at = Instant(now.0 + days * 86_400_000).iso();
        let issued = match w.custody.address(&AddressRequest {
            user_id: user.to_owned(),
            asset_id: asset.clone(),
            network_id: network.clone(),
            address_index: Some(i64::from(index)),
            expires_at: Some(expires_at),
        }) {
            Err(e) => return Ok(Err(failed(e))),
            Ok(None) => {
                return Ok(Err(refuse_custody(&format!(
                    "Custody did not issue another deposit address for {asset} on {network}"
                ))));
            }
            Ok(Some(issued)) => issued,
        };
        let (addr, memo, qr) = match validate_issued(&issued) {
            Ok(v) => v,
            Err(r) => return Ok(Err(r)),
        };
        // Custody's stored expiry is the one that decides a late deposit, so it is the one shown.
        let Some(stored) = issued
            .expires_at
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| zod_datetime(s, false))
        else {
            return Ok(Err(invalid(
                "Custody returned an extra deposit address with no expiry",
            )));
        };
        let row = tx.query_one(
            &format!(
                "INSERT INTO bank.deposit_addresses \
                   (user_id, asset_id, network_id, address_index, address, memo, qr_payload, label, expires_at) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::timestamptz) \
                 RETURNING {}",
                list_columns()
            ),
            &[&user, &asset, &network, &index, &addr, &memo, &qr, &label, &stored.iso()],
        )?;
        Ok(Ok(to_list_item(&row)?))
    })
}

/// `labelAddress`: set or clear one address's label. The same label twice is one change.
fn label_address(d: &Deps<'_>, user: &str, input: &Value) -> Result<Json, Refusal> {
    let label = clean_label(input.get("label"))?;
    let asset = input.get("assetId").as_str().unwrap_or_default();
    let network = input.get("networkId").as_str().unwrap_or_default();
    let n = input.get("addressIndex").as_number().unwrap_or(-1.0);
    let shown = service_kit::json::js_number_string(n);
    let index = shown.parse::<i32>().unwrap_or(-1);
    let row = db(d.store, |c| {
        c.query(
            &format!(
                "UPDATE bank.deposit_addresses SET label = $1 \
                  WHERE user_id = $2 AND asset_id = $3 AND network_id = $4 AND address_index = $5 \
                 RETURNING {}",
                list_columns()
            ),
            &[&label, &user, &asset, &network, &index],
        )?
        .first()
        .map(to_list_item)
        .transpose()
    })?;
    row.ok_or_else(|| {
        refuse(
            "bank.deposit_address_not_found",
            format!("You have no deposit address number {shown} for {asset} on {network}"),
        )
    })
}

/// `validatePending`.
fn validate_pending(row: &pay::Pending) -> Result<Json, Refusal> {
    if js_trim(&row.id).is_empty() || row.id != js_trim(&row.id) || utf16(&row.id) > 128 {
        return Err(invalid("Custody pending deposit id is blank"));
    }
    if !asset_ok(&row.asset_id) || !network_ok(&row.network_id) {
        return Err(invalid(
            "Custody pending deposit asset or network is not a short token",
        ));
    }
    let amount = parse_amount(&row.amount)
        .map_err(|_| invalid("Custody pending deposit amount is not an exact decimal"))?;
    if amount <= 0 {
        return Err(invalid("Custody pending deposit amount must be positive"));
    }
    if row.confirmations < 0 {
        return Err(invalid(
            "Custody pending confirmations are not a non-negative integer",
        ));
    }
    if row.confirmations_required.is_some_and(|n| n < 0) {
        return Err(invalid(
            "Custody pending confirmation target is not a non-negative integer",
        ));
    }
    Ok(Json::obj([
        ("id", Json::str(row.id.clone())),
        ("assetId", Json::str(row.asset_id.clone())),
        ("networkId", Json::str(row.network_id.clone())),
        ("amount", Json::str(format_amount(amount))),
        ("confirmations", Json::int(row.confirmations)),
        (
            "confirmationsRequired",
            row.confirmations_required.map_or(Json::Null, Json::int),
        ),
    ]))
}

fn pending(w: &Wiring, user: &str) -> Result<Json, Refusal> {
    let rows = w
        .custody
        .pending(user)
        .map_err(failed)?
        .ok_or_else(|| refuse_custody("Incoming deposits are not published"))?;
    if rows.len() > PENDING_CAP {
        return Err(refuse(
            "bank.deposit_pending_unbounded",
            format!(
                "Custody returned {} incoming deposits; this door publishes at most {PENDING_CAP} and will not drop the rest",
                rows.len()
            ),
        ));
    }
    Ok(Json::obj([(
        "items",
        Json::Array(
            rows.iter()
                .map(validate_pending)
                .collect::<Result<_, _>>()?,
        ),
    )]))
}

fn whole(v: &Value, default: i64) -> i64 {
    v.as_number()
        .and_then(|n| service_kit::json::js_number_string(n).parse().ok())
        .unwrap_or(default)
}

/// `list`: the person's own deposit history, newest first, a page with the true total.
fn list(w: &Wiring, user: &str, input: &Value) -> Result<Json, Refusal> {
    let text = |key: &str| input.get(key).as_str().map(str::to_owned);
    let page = w
        .custody
        .records(&RecordsQuery {
            user_id: user.to_owned(),
            asset_id: text("assetId"),
            network_id: text("networkId"),
            statuses: text("status").filter(|s| !s.is_empty()).map(|s| vec![s]),
            tx_hash: text("txId"),
            address: text("address"),
            offset: whole(input.get("offset"), 0),
            limit: whole(input.get("limit"), 50),
        })
        .map_err(failed)?
        .ok_or_else(|| refuse_custody("Deposit history is not published"))?;
    Ok(Json::obj([
        ("items", Json::Array(page.items)),
        ("total", Json::int(page.total)),
    ]))
}

/// The answer of one of this part's calls, by its path; `None` for a path outside it.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let path = ctx.call.path.strip_prefix("deposits.")?;
    let principal = ctx.principal?;
    let user = principal.user_id.as_str();
    let input = &ctx.input;
    let w = &d.wiring.deposits;
    Some(match path {
        "assets" => assets(w),
        "address" => address(
            d,
            user,
            input.get("assetId").as_str().unwrap_or_default(),
            input.get("networkId").as_str().unwrap_or_default(),
        ),
        "addresses.list" => addresses(d, user, input),
        "addresses.create" => create_address(d, user, input, ctx.now),
        "addresses.label" => label_address(d, user, input),
        "pending" => pending(w, user),
        "list" => list(w, user, input),
        _ => return None,
    })
}

/// This part has no job door.
pub fn job(_d: &Deps<'_>, _path: &str, _body: &Value) -> Option<Response> {
    None
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn a_setting_is_a_whole_number_from_1_to_9999_or_unset() {
        assert_eq!(parse_setting(Some(" 5 ")), Some(5));
        assert_eq!(parse_setting(Some("9999")), Some(9999));
        assert_eq!(parse_setting(Some("10000")), None);
        assert_eq!(parse_setting(Some("0")), None);
        assert_eq!(parse_setting(Some("05")), None);
        assert_eq!(parse_setting(Some("")), None);
        assert_eq!(parse_setting(None), None);
    }

    #[test]
    fn a_label_is_trimmed_blank_clears_it_and_a_control_character_refuses() {
        assert_eq!(
            clean_label(&Value::String("  Savings ".into()))
                .unwrap()
                .as_deref(),
            Some("Savings")
        );
        assert_eq!(clean_label(&Value::String("   ".into())).unwrap(), None);
        assert_eq!(clean_label(&Value::Null).unwrap(), None);
        assert!(clean_label(&Value::String("a\u{7}b".into())).is_err());
        assert!(clean_label(&Value::String("x".repeat(41))).is_err());
    }

    #[test]
    fn a_minimum_is_written_in_its_shortest_exact_form() {
        let n = pay::Network {
            id: "ethereum".into(),
            label: "Ethereum".into(),
            minimum_deposit: "1.50".into(),
            confirmations_required: 12,
            estimated_arrival_minutes: 5,
            unsupported: None,
        };
        assert_eq!(
            validate_network("USDC", &n, &mut Vec::new())
                .unwrap()
                .minimum_deposit,
            "1.5"
        );
        let zero = pay::Network {
            minimum_deposit: "0".into(),
            ..n
        };
        assert!(validate_network("USDC", &zero, &mut Vec::new()).is_err());
    }
}
