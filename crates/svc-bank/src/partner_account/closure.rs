//! `POST /internal/closure-check` past its door checks (`closure/closure-check.ts` `runBankClosureCheck`): svc-identity
//! asks whether svc-bank still holds anything for an account it would close. Read-only: the bank answers for its own
//! rows and for svc-ledger's balances; identity never reads the book.
//!
//! A failed read is 503. An empty blocker list means this service successfully saw nothing open; it does not mean the
//! other services are clear.

use std::collections::BTreeMap;

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount};
use service_kit::schema::Value;
use service_kit::server::Response;

use super::Deps;
use super::recovery::ledger::Ledger;
use crate::db::{StoreError, with_client};
use crate::door::Ctx;
use crate::errors::Refusal;

/// What this part holds: svc-ledger's balance reads (`index.ts` hands `registerClosureCheck` its `ledger`).
pub struct Wiring {
    pub ledger: Box<dyn Ledger>,
}

impl Wiring {
    pub fn from_env(env: &BTreeMap<String, String>) -> Result<Wiring, String> {
        Ok(Wiring {
            ledger: super::recovery::ledger_from_env(env)?,
        })
    }
}

/// This part answers no tRPC call.
pub fn answer(_d: &Deps<'_>, _ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    None
}

/// `ClosureCheckBody`, as `parseClosureCheckBody` returns it (the door already held the body to it).
struct Check {
    user_id: String,
    sub_account_ids: Vec<String>,
    sub_accounts_only: bool,
}

fn parse(body: &Value) -> Check {
    let mut sub_account_ids: Vec<String> = Vec::new();
    for id in body.get("subAccountIds").as_array().unwrap_or_default() {
        let lower = id.as_str().unwrap_or_default().to_lowercase();
        if !sub_account_ids.contains(&lower) {
            sub_account_ids.push(lower);
        }
    }
    Check {
        user_id: body
            .get("userId")
            .as_str()
            .unwrap_or_default()
            .to_lowercase(),
        sub_account_ids,
        sub_accounts_only: body.get("scope").as_str() == Some("sub_accounts"),
    }
}

/// The bank's open rows that block a closure, in `runBankClosureCheck`'s order: each table and the statuses that count.
const COUNTS: [(&str, &[&str]); 7] = [
    (
        "loans",
        &["pending", "active", "margin_call", "liquidating"],
    ),
    ("cards", &["active", "frozen"]),
    ("scheduled_transfers", &["active", "paused"]),
    ("ramp_onramps", &["pending"]),
    ("ramp_offramps", &["pending"]),
    ("customer_onramps", &["pending_payment"]),
    ("earn_positions", &["pending", "active"]),
];

/// `runBankClosureCheck`: the balances left across the accounts asked about, and the blockers.
fn run(d: &Deps<'_>, check: &Check) -> Result<Json, String> {
    let subs: Vec<&String> = check
        .sub_account_ids
        .iter()
        .filter(|id| **id != check.user_id)
        .collect();
    let mut owners: Vec<(&str, &str)> = Vec::new();
    if !check.sub_accounts_only {
        owners.push(("user", &check.user_id));
    }
    owners.extend(subs.iter().map(|id| ("subaccount", id.as_str())));
    let ledger = d.wiring.closure.ledger.as_ref();
    let mut totals: BTreeMap<String, Amount> = BTreeMap::new();
    for (owner_type, owner_id) in owners {
        for row in ledger.balances(owner_type, owner_id)? {
            if row.amount.is_zero() {
                continue;
            }
            let total = totals.entry(row.account.asset_id).or_insert(Amount::ZERO);
            *total = total
                .checked_add(row.amount)
                .ok_or_else(|| "a total does not fit".to_owned())?;
        }
    }
    let balances: Vec<Json> = totals
        .iter()
        .filter(|(_, amount)| !amount.is_zero())
        .map(|(asset, amount)| {
            Json::obj([
                ("assetId", Json::str(asset.clone())),
                ("amount", Json::str(format_amount(*amount))),
            ])
        })
        .collect();

    // user_id values whose rows count: the main account unless the question is about sub-accounts only.
    let mut ids: Vec<String> = Vec::new();
    if !check.sub_accounts_only {
        ids.push(check.user_id.clone());
    }
    ids.extend(subs.iter().map(|s| (*s).clone()));
    let pool = d.store.pool().map_err(|e| e.message)?;
    let counts = with_client(pool, |c| {
        COUNTS
            .iter()
            .map(|(table, statuses)| {
                // `status IN ${sql(statuses)}`: the statuses are this file's own constants, written as literals so a
                // status column of an enum type compares as the TypeScript's untyped parameters do.
                let statuses: Vec<String> = statuses.iter().map(|s| format!("'{s}'")).collect();
                let sql = format!(
                    "SELECT count(*)::int AS n FROM \"bank\".\"{table}\" WHERE status IN ({}) AND user_id = ANY($1::text[])",
                    statuses.join(", ")
                );
                let n: i32 = c.query_one(&sql, &[&ids])?.try_get(0)?;
                Ok::<_, StoreError>(i64::from(n))
            })
            .collect::<Result<Vec<i64>, StoreError>>()
    })
    .map_err(|e| e.message)?;
    let n = |i: usize| counts.get(i).copied().unwrap_or(0);
    let mut blockers: Vec<Json> = Vec::new();
    let mut push = |code: &str, count: i64| {
        if count > 0 {
            blockers.push(Json::obj([
                ("code", Json::str(code)),
                ("count", Json::int(count)),
            ]));
        }
    };
    push(
        "balance_remaining",
        i64::try_from(balances.len()).unwrap_or(i64::MAX),
    );
    push("open_loan", n(0));
    push("active_card", n(1));
    push("active_schedule", n(2));
    push(
        "pending_ramp",
        n(3).saturating_add(n(4)).saturating_add(n(5)),
    );
    push("earn_position", n(6));
    Ok(Json::obj([
        ("asOf", Json::str(d.now.iso())),
        ("blockers", Json::Array(blockers)),
        ("balances", Json::Array(balances)),
    ]))
}

/// The closure check's answer past its door checks: 200 with what is open, or 503 when anything could not be read.
pub fn job(d: &Deps<'_>, path: &str, body: &Value) -> Option<Response> {
    if path != "/internal/closure-check" {
        return None;
    }
    Some(match run(d, &parse(body)) {
        Ok(answer) => Response {
            status: 200,
            body: answer.compact(),
        },
        Err(_) => Response {
            status: 503,
            body: Json::obj([
                ("error", Json::str("closure check unavailable")),
                ("code", Json::str("bank.closure_check_unavailable")),
            ])
            .compact(),
        },
    })
}
