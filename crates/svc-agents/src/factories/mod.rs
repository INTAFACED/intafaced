//! The \`factories\` slice: the four product factories' calls in \`router.ts\` (\`scanner\`, \`support\`, \`copyIntel\`,
//! \`merchant\`) and what they run on (\`scanner/\`, \`support-agent/\`, \`copy-intel/\`, \`merchant/\`).
//!
//! Each factory's pure calls answer what it would say without a session. Its \`runSession\` runs the same pure code as a
//! metered session on the runtime (\`open → act → settle → close\`): every tool fetch is the runtime's \`act\`, judged by
//! the guardrail bound at open and written to the action log, and the run settles through the meter. A refusal known
//! before any tool (a blank law, a dark plane, no live port) opens no session and bills nothing.
//!
//! The live data each \`runSession\` reads comes through its port, built once at start-up from the environment
//! (\`Factories\`); an absent port is the TypeScript's absent dependency, and its run refuses rather than invent data.
//!
//! - [\`scanner\`][]: \`scanner.*\`.
//! - [\`support\`][]: \`support.*\`.
//! - [\`copy_intel\`][]: \`copyIntel.*\`.
//! - [\`merchant\`][]: \`merchant.*\`.

pub mod copy_intel;
pub mod js;
pub mod merchant;
pub mod scanner;
pub mod support;

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount};
use service_kit::pg::Pool;
use service_kit::time::{Instant, js_date};
use service_kit::trpc::TrpcError;

use crate::db::Store;
use crate::door::Ctx;
use crate::gateway::desk::GatewaySlice;
use crate::metering::Metering;
use crate::metering::settle;
use crate::runtime::{self, Rt, RunError, Runtime, to_trpc};

/// The live ports the factories read, built once at start-up (\`index.ts\`). None is an absent dependency.
#[derive(Default)]
pub struct Factories {
    /// \`spotTickersPort\`: svc-trade's tickers (\`TRADE_URL\`).
    pub spot_tickers: Option<Box<dyn scanner::SpotTickers>>,
    /// \`supportDesk\`: svc-support's desk (\`SUPPORT_URL\`), with svc-identity's session reads (\`IDENTITY_URL\`).
    pub support_desk: Option<Box<dyn support::Desk>>,
    /// \`copyLeaderFixturesPort\`: svc-trade's copy leaders (\`TRADE_URL\`).
    pub copy_leaders: Option<Box<dyn copy_intel::LeaderFixtures>>,
    /// \`payMetricsPort\`: svc-pay's merchant metrics (\`PAY_URL\`).
    pub pay_metrics: Option<Box<dyn merchant::PayMetrics>>,
}

impl Factories {
    /// No port: every live run refuses as the TypeScript's does with its dependency left out.
    pub fn unwired() -> Factories {
        Factories::default()
    }
}

/// One call's view of the slice: the door's context, the runtime's parts and the ports.
pub struct Cx<'a> {
    pub ctx: &'a Ctx<'a>,
    pub store: &'a Store,
    pub gateway: &'a GatewaySlice,
    pub m: &'a Metering,
    pub rt: &'a Runtime,
    pub ports: &'a Factories,
}

impl<'a> Cx<'a> {
    /// The runtime over the database; a database that is down fails the call as the TypeScript's \`sql\` would.
    pub fn x(&self) -> Result<Rt<'a>, RunError> {
        let pool: &'a Pool = self.store.pool()?;
        Ok(Rt {
            rt: self.rt,
            pool,
            gateway: &self.gateway.gateway,
            m: self.m,
            now: self.ctx.now,
        })
    }

    /// \`feeAssetId\`: the asset the fleet meters in.
    pub fn fee_asset_id(&self) -> &str {
        &self.gateway.fee_asset_id
    }

    /// \`ctx.principal.userId\`.
    pub fn user(&self) -> &str {
        self.ctx.principal.map_or("", |p| p.user_id.as_str())
    }

    /// \`ctx.principal.tier\`.
    pub fn tier(&self) -> &str {
        self.ctx.principal.map_or("", |p| p.tier.as_str())
    }

    /// \`input.now === undefined ? new Date() : new Date(input.now)\`: the input's \`now\` (a zod datetime), else the
    /// clock.
    pub fn now_of(&self, key: &str) -> Instant {
        self.ctx
            .input
            .get(key)
            .as_str()
            .and_then(js_date)
            .unwrap_or(self.ctx.now)
    }
}

/// Answers one call of the slice.
pub fn handle(
    ctx: &Ctx<'_>,
    store: &Store,
    gateway: &GatewaySlice,
    m: &Metering,
    rt: &Runtime,
    ports: &Factories,
) -> Result<Option<Json>, TrpcError> {
    let cx = Cx {
        ctx,
        store,
        gateway,
        m,
        rt,
        ports,
    };
    let path = ctx.call.path;
    let answer = if let Some(call) = path.strip_prefix("scanner.") {
        scanner::handle(&cx, call)
    } else if let Some(call) = path.strip_prefix("support.") {
        support::handle(&cx, call)
    } else if let Some(call) = path.strip_prefix("copyIntel.") {
        copy_intel::handle(&cx, call)
    } else if let Some(call) = path.strip_prefix("merchant.") {
        merchant::handle(&cx, call)
    } else {
        Err(RunError::Trpc(crate::door::not_ported(ctx.call.slice)))
    };
    answer.map(Some).map_err(to_trpc)
}

/// \`unmetered\`: a run that refused before opening a session metered nothing.
pub fn unmetered(asset_id: &str) -> Json {
    Json::obj([
        ("sessionId", Json::Null),
        ("billedAmount", Json::str("0")),
        ("assetId", Json::str(asset_id)),
        ("sessionClosed", Json::Bool(false)),
        ("settlements", Json::Array(Vec::new())),
    ])
}

/// \`settleAndClose\`: every open window settled, then the session closed; the run's metering as it leaves the
/// service (\`runMeteringOutput\`). A settlement that fails is the answer, never a zero.
pub fn settle_and_close(x: &Rt<'_>, session_id: &str, asset_id: &str) -> Result<Json, RunError> {
    let results = settle::settle_session(x.m, x.pool, session_id, x.now)?;
    let closed = runtime::close_session(x, session_id)?;
    let total: Amount = results.iter().map(|r| r.amount).sum();
    Ok(Json::obj([
        ("sessionId", Json::str(session_id)),
        ("billedAmount", Json::str(format_amount(total))),
        ("assetId", Json::str(asset_id)),
        ("sessionClosed", Json::Bool(closed.status == "closed")),
        (
            "settlements",
            Json::Array(
                results
                    .iter()
                    .map(|r| {
                        Json::obj([
                            ("windowId", Json::str(r.window_id.clone())),
                            ("amount", Json::str(format_amount(r.amount))),
                            ("chargeKey", Json::str(r.charge_key.clone())),
                            ("settled", Json::Bool(r.settled)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]))
}

/// A metered run: the session opened for \`agent_id\`, \`run\` over it, and the session settled and closed on every
/// path. \`run\` answers its outcome without the metering, which is laid on as its last field; on a thrown path the
/// settle still runs, and its own failure never replaces the run's.
pub fn metered_run(
    x: &Rt<'_>,
    user_id: &str,
    agent_id: &str,
    asset_id: &str,
    run: impl FnOnce(&str) -> Result<Json, RunError>,
) -> Result<Json, RunError> {
    let session = runtime::open_session(x, user_id, agent_id)?;
    match run(&session.id) {
        Ok(answer) => {
            let metering = settle_and_close(x, &session.id, asset_id)?;
            Ok(with_field(answer, "metering", metering))
        }
        Err(e) => {
            let _ = settle_and_close(x, &session.id, asset_id);
            Err(e)
        }
    }
}

/// The object with one more field at its end.
pub fn with_field(answer: Json, key: &str, value: Json) -> Json {
    match answer {
        Json::Object(mut fields) => {
            fields.push((key.to_owned(), value));
            Json::Object(fields)
        }
        other => other,
    }
}

/// A list of strings.
pub fn strings<S: AsRef<str>>(items: &[S]) -> Json {
    Json::Array(items.iter().map(|s| Json::str(s.as_ref())).collect())
}

/// \`err instanceof RefusedError\`: the guardrail said no and its row is written.
pub fn is_refused(e: &RunError) -> bool {
    matches!(e, RunError::Refused { .. })
}

/// A JSON string's text.
pub fn json_str(v: &Json) -> Option<&str> {
    match v {
        Json::String(s) => Some(s),
        _ => None,
    }
}

/// A JSON number.
pub fn json_num(v: &Json) -> Option<f64> {
    match v {
        Json::Number(n) => Some(*n),
        _ => None,
    }
}
