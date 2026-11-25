//! `svc-bank test-seed <op>`: the local test stack's seed (`tooling/scripts/local-test-seed.mjs`) lists and opens its
//! TEST earn pools and loan products through this crate's own code, as it did through the TypeScript service's
//! `EarnService` and `LoanService`. One operation a run, its input as JSON on stdin, its answer as JSON on stdout:
//!
//! - `list-pools`: the open pools (`earn::service::list_pools`), each `{ id, name, status, assetId }`.
//! - `create-pool`: `{ poolId, assetId, kind, name, aprBps, termDays, minDeposit }` (`earn::service::create_pool`).
//! - `list-products`: the products (`loans::model::list_products`), each `{ id, name, status, debtAssetId }`.
//! - `create-product`: `{ name, debtAssetId, collateralAssetId, quoteAssetId, aprBps, maxLtvBps, minPrincipal,
//!   policy }` (`loans::model::create_product`).
//!
//! A refusal answers `{ "refused": { "code", "message" } }` and the run fails. It runs only on a TEST stack: `APP_ENV`
//! exactly `dev` or `test` and `NODE_ENV` not `production`, as every TEST door of the service.

use std::collections::BTreeMap;

use service_kit::json::{self, Json};
use service_kit::money::{js_trim, parse_amount};
use service_kit::s2s_verify::BodyBind;

use crate::db::Store;
use crate::door::{BankDoor, DoorConfig, ServiceAuth, system_now};
use crate::earn;
use crate::earn::service::NewPool;
use crate::errors::Refusal;
use crate::loans::model::{self, NewProduct};
use crate::loans::risk::LiquidationPolicy;
use crate::spaces::space::with;

/// Whether this process may seed: a TEST stack only.
pub fn allowed(env: &BTreeMap<String, String>) -> Result<(), String> {
    let app = env.get("APP_ENV").map(String::as_str);
    let node_prod = env
        .get("NODE_ENV")
        .is_some_and(|n| js_trim(n).to_lowercase() == "production");
    if matches!(app, Some("dev" | "test")) && !node_prod {
        return Ok(());
    }
    Err(format!(
        "svc-bank test-seed runs only on a TEST stack: APP_ENV must be exactly dev or test and NODE_ENV not production (got APP_ENV {}, NODE_ENV {})",
        app.unwrap_or("unset"),
        env.get("NODE_ENV").map_or("unset", String::as_str)
    ))
}

fn text(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(s)) => s.clone(),
        _ => String::new(),
    }
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "the seed's whole numbers are small; a fraction is refused by the service's own checks"
)]
fn int(v: &Json, key: &str) -> Option<i64> {
    match v.get(key) {
        Some(Json::Number(n)) if n.fract() == 0.0 => Some(*n as i64),
        _ => None,
    }
}

fn num(v: &Json, key: &str) -> Option<f64> {
    match v.get(key) {
        Some(Json::Number(n)) => Some(*n),
        _ => None,
    }
}

fn refused(r: Refusal) -> Json {
    let (code, message) = match r {
        Refusal::Bank(e) => (e.row.code.to_owned(), e.message),
        Refusal::Trpc(e) => (String::new(), e.message),
        Refusal::Other(m) => (String::new(), m),
    };
    Json::obj([(
        "refused",
        Json::obj([("code", Json::str(code)), ("message", Json::str(message))]),
    )])
}

/// One operation on `store`, its answer or its refusal.
pub fn run(
    store: Store,
    env: BTreeMap<String, String>,
    op: &str,
    input: &str,
) -> Result<Json, Json> {
    let input = if js_trim(input).is_empty() {
        Json::Null
    } else {
        json::parse(input)
            .map_err(|e| refused(Refusal::Other(format!("input is not JSON: {e:?}"))))?
    };
    let settings = earn::Settings {
        native_asset_id: env
            .get("TOKEN_ASSET_ID")
            .cloned()
            .unwrap_or_else(|| "IFC".to_owned()),
        risk_wording: None,
        interest_accrual: false,
    };
    // A door that never serves: only its store and the earn settings are read.
    let door = BankDoor::new(DoorConfig {
        edge_secret: "svc-bank test-seed: this door never serves a request".to_owned(),
        services: ServiceAuth {
            secret: None,
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now: system_now,
        store,
    })
    .map_err(|e| refused(Refusal::Other(e)))?
    .with_earn(settings);
    let pool_json = |p: &earn::Pool| {
        Json::obj([
            ("id", Json::str(p.id.clone())),
            ("name", Json::str(p.name.clone())),
            ("status", Json::str(p.status.clone())),
            ("assetId", Json::str(p.asset_id.clone())),
        ])
    };
    let product_json = |p: &model::Product| {
        Json::obj([
            ("id", Json::str(p.id.clone())),
            ("name", Json::str(p.name.clone())),
            ("status", Json::str(p.status.clone())),
            ("debtAssetId", Json::str(p.debt_asset_id.clone())),
        ])
    };
    let out = match op {
        "list-pools" => with(door.store(), |c| {
            earn::service::list_pools(c, None, num(&input, "limit"))
        })
        .map(|pools| Json::Array(pools.iter().map(pool_json).collect())),
        "create-pool" => parse_amount(&text(&input, "minDeposit"))
            .map_err(Refusal::Other)
            .and_then(|min_deposit| {
                let pool = NewPool {
                    id: text(&input, "poolId"),
                    asset_id: text(&input, "assetId"),
                    kind: text(&input, "kind"),
                    name: text(&input, "name"),
                    apr_bps: int(&input, "aprBps").unwrap_or_default(),
                    term_days: int(&input, "termDays"),
                    min_deposit,
                    unbonding_days: None,
                };
                door.earn_deps(door.now(), |d| earn::service::create_pool(d, &pool))
            })
            .map(|p| pool_json(&p)),
        "list-products" => with(door.store(), |c| {
            model::list_products(c, None, num(&input, "limit"))
        })
        .map(|products| Json::Array(products.iter().map(product_json).collect())),
        "create-product" => parse_amount(&text(&input, "minPrincipal"))
            .map_err(Refusal::Other)
            .and_then(|floor| {
                let policy = input.get("policy").unwrap_or(&Json::Null);
                let product = NewProduct {
                    name: js_trim(&text(&input, "name")).to_owned(),
                    debt_asset_id: text(&input, "debtAssetId"),
                    collateral_asset_id: text(&input, "collateralAssetId"),
                    quote_asset_id: text(&input, "quoteAssetId"),
                    apr_bps: int(&input, "aprBps").unwrap_or_default(),
                    max_ltv_bps: int(&input, "maxLtvBps").unwrap_or_default(),
                    min_principal: Some(floor),
                    policy: LiquidationPolicy {
                        margin_call_ltv_bps: int(policy, "marginCallLtvBps").unwrap_or_default(),
                        liquidation_ltv_bps: int(policy, "liquidationLtvBps").unwrap_or_default(),
                        insolvency_ltv_bps: int(policy, "insolvencyLtvBps").unwrap_or_default(),
                        target_ltv_bps: int(policy, "targetLtvBps").unwrap_or_default(),
                        penalty_bps: int(policy, "penaltyBps").unwrap_or_default(),
                        max_tranche_bps: int(policy, "maxTrancheBps").unwrap_or_default(),
                        grace_seconds: int(policy, "graceSeconds").unwrap_or_default(),
                    },
                };
                with(door.store(), |c| model::create_product(c, &product))
            })
            .map(|p| product_json(&p)),
        other => Err(Refusal::Other(format!(
            "unknown test-seed operation {other:?}: list-pools, create-pool, list-products or create-product"
        ))),
    };
    out.map_err(refused)
}
