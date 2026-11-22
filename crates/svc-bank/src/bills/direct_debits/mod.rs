//! Part `direct_debits` of the bills slice: Direct Debit mandates and their collections (`direct-debits/`), the scheme's
//! job doors (`index.ts`: `/internal/jobs/dd-sim/mandate`, `/internal/jobs/dd-sim/collection`,
//! `/internal/jobs/run-due-direct-debits`) and the finance desk's partner read (`ops/direct-debit-mandates.ts`,
//! `ops.directDebitMandates`).
//!
//! - `scheme`: who speaks for the scheme (`scheme.ts`): unset, or the TEST stand-in.
//! - `service`: the person's reads and controls, the scheme's side and the collection run (`direct-debits.ts`).
//! - `desk`: the finance desk's view of the partner's report.
//!
//! Money moves only through svc-ledger's `bankTransfer` recipe (`transfers::moves::post_bank_transfer`, key space
//! `rail`), or as ONE partner move when the partner bank holds the money; never by entries assembled here.

pub mod desk;
pub mod scheme;
pub mod service;

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::trpc::TrpcError;

use super::Deps;
use crate::door::Ctx;
use crate::door::jobs::{job_failed, ok};
use crate::door::rest::reply;
use crate::errors::{Refusal, to_trpc};

/// `/internal/jobs/dd-sim/mandate`.
pub const DD_SIM_MANDATE: &str = "/internal/jobs/dd-sim/mandate";
/// `/internal/jobs/dd-sim/collection`.
pub const DD_SIM_COLLECTION: &str = "/internal/jobs/dd-sim/collection";
/// `/internal/jobs/run-due-direct-debits`.
pub const RUN_DUE_DIRECT_DEBITS: &str = "/internal/jobs/run-due-direct-debits";

/// What the binary hands this part.
pub struct Wiring {
    /// `directDebitSchemeFor(BANK_DD_SCHEME, BANK_DD_SIM_JSON, raw env)`.
    pub scheme: scheme::Scheme,
    /// `BANK_DD_COLLECTIONS_ENABLED` (on unless the owner turns it off, as `env.ts` defaults it).
    pub collections_enabled: bool,
}

impl Default for Wiring {
    fn default() -> Wiring {
        Wiring {
            scheme: scheme::Scheme::unset(),
            collections_enabled: true,
        }
    }
}

impl Wiring {
    /// No scheme: every control refuses `rail.bank`.
    pub fn none() -> Wiring {
        Wiring::default()
    }
}

fn principal_user<'c>(ctx: &'c Ctx<'_>) -> Result<&'c str, Refusal> {
    ctx.principal
        .map(|p| p.user_id.as_str())
        .ok_or_else(|| Refusal::Other("no principal".to_owned()))
}

fn text<'v>(input: &'v Value, key: &str) -> &'v str {
    input.get(key).as_str().unwrap_or_default()
}

/// This part's calls; `None` for any other call.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    let input = &ctx.input;
    let out = match ctx.call.path {
        "directDebits.list" => principal_user(ctx).and_then(|u| service::list(d, u)),
        "directDebits.block" => {
            principal_user(ctx).and_then(|u| service::block(d, u, text(input, "mandateId")))
        }
        "directDebits.unblock" => {
            principal_user(ctx).and_then(|u| service::unblock(d, u, text(input, "mandateId")))
        }
        "directDebits.requestRefund" => principal_user(ctx).and_then(|u| {
            let (c, created) =
                service::request_refund(d, u, text(input, "collectionId"), text(input, "reason"))?;
            Ok(Json::obj([
                ("collection", c.json()),
                ("created", Json::Bool(created)),
            ]))
        }),
        "directDebits.ops.refunds" => {
            #[allow(
                clippy::cast_possible_truncation,
                reason = "a whole number 1 to 100 the schema checked"
            )]
            let limit = input.get("limit").as_number().map(|n| n as i64);
            service::ops_refunds(d, limit).map(|rows| {
                Json::Array(
                    rows.iter()
                        .map(service::CollectionView::json_for_support)
                        .collect(),
                )
            })
        }
        "ops.directDebitMandates" => principal_user(ctx).and_then(|u| desk::read(d, u)),
        _ => return None,
    };
    Some(out.map(Some).map_err(|r| {
        to_trpc(r, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}

fn fields(body: &Value) -> Option<&[(String, Value)]> {
    match body {
        Value::Undefined | Value::Null => Some(&[]),
        Value::Object(f) => Some(f),
        _ => None,
    }
}

/// `schemeId`: `/^[A-Za-z0-9._-]{1,64}$/`, no ':' so a collection's ledger key never reads as another's.
fn scheme_id(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// `/^\d+(\.\d{1,18})?$/`.
fn amount_text(s: &str) -> bool {
    let (whole, frac) = s.split_once('.').map_or((s, None), |(w, f)| (w, Some(f)));
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && frac.is_none_or(|f| (1..=18).contains(&f.len()) && f.bytes().all(|b| b.is_ascii_digit()))
}

/// `ddSimMandateBody` (strict): the scheme's references, never generated here; the reference is trimmed.
pub fn mandate_body(body: &Value) -> Option<service::NewMandate> {
    let mut m = service::NewMandate {
        mandate_id: String::new(),
        user_id: String::new(),
        creditor_id: String::new(),
        reference: String::new(),
        asset_id: String::new(),
    };
    let mut seen = 0;
    for (k, v) in fields(body)? {
        let Value::String(s) = v else { return None };
        match k.as_str() {
            "mandateId" if scheme_id(s) => m.mandate_id.clone_from(s),
            "userId" if crate::cards::orders::is_zod_uuid(s) => m.user_id.clone_from(s),
            "creditorId" if scheme_id(s) => m.creditor_id.clone_from(s),
            "reference" => {
                let t = service_kit::money::js_trim(s);
                if !(1..=140).contains(&t.encode_utf16().count()) {
                    return None;
                }
                t.clone_into(&mut m.reference);
            }
            "assetId"
                if (2..=16).contains(&s.len())
                    && s.bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()) =>
            {
                m.asset_id.clone_from(s);
            }
            _ => return None,
        }
        seen += 1;
    }
    (seen == 5).then_some(m)
}

/// `ddSimCollectionBody` (strict).
pub struct Presented {
    pub mandate_id: String,
    pub collection_id: String,
    pub amount: String,
    pub due_at: String,
}

pub fn collection_body(body: &Value) -> Option<Presented> {
    let mut p = Presented {
        mandate_id: String::new(),
        collection_id: String::new(),
        amount: String::new(),
        due_at: String::new(),
    };
    let mut seen = 0;
    for (k, v) in fields(body)? {
        let Value::String(s) = v else { return None };
        match k.as_str() {
            "mandateId" if scheme_id(s) => p.mandate_id.clone_from(s),
            "collectionId" if scheme_id(s) => p.collection_id.clone_from(s),
            "amount" if amount_text(s) => p.amount.clone_from(s),
            "dueAt" if service_kit::time::zod_datetime(s, true).is_some() => p.due_at.clone_from(s),
            _ => return None,
        }
        seen += 1;
    }
    (seen == 4).then_some(p)
}

/// `ddRunBody` (strict): the batch is the caller's to name; an omitted one refuses, never a borrowed default.
pub fn run_body(body: &Value) -> Option<i64> {
    let mut limit = None;
    for (k, v) in fields(body)? {
        match (k.as_str(), v) {
            ("limit", Value::Number(n)) if n.fract() == 0.0 && (1.0..=1000.0).contains(n) => {
                #[allow(clippy::cast_possible_truncation, reason = "a whole number 1 to 1000")]
                let whole = *n as i64;
                limit = Some(whole);
            }
            _ => return None,
        }
    }
    limit
}

fn not_in_shape() -> Response {
    reply(400, "body not in shape", "bank.validation_failed")
}

/// This part's job doors past the signature; `None` for any other path. The two scheme doors are `jobDoor`'s shape (the
/// body, then the work, a `BankError` as 400); the run checks its switch (503) before its body.
pub fn job(d: &Deps<'_>, path: &str, body: &Value) -> Option<Response> {
    Some(match path {
        DD_SIM_MANDATE => match mandate_body(body) {
            None => not_in_shape(),
            Some(m) => match service::set_up_mandate(d, &m) {
                Ok(m) => ok(&m.json_with_user()),
                Err(r) => job_failed(r),
            },
        },
        DD_SIM_COLLECTION => match collection_body(body) {
            None => not_in_shape(),
            Some(p) => {
                match service::present(d, &p.mandate_id, &p.collection_id, &p.amount, &p.due_at) {
                    Ok(c) => ok(&c.json_with_user()),
                    Err(r) => job_failed(r),
                }
            }
        },
        RUN_DUE_DIRECT_DEBITS => {
            if !d.w.direct_debits.collections_enabled {
                return Some(reply(
                    503,
                    "the direct debit collection run is stopped",
                    "bank.dd_collections_disabled",
                ));
            }
            match run_body(body) {
                None => not_in_shape(),
                Some(limit) => match service::run_due(d, limit) {
                    Ok(report) => ok(&report.json()),
                    Err(r) => job_failed(r),
                },
            }
        }
        _ => return None,
    })
}
