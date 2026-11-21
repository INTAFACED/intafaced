//! The svc-agents process: `svc-agents` serves; `svc-agents migrate [--down]` applies (or reverses) the agents schema's
//! migrations.
//!
//! Serving starts as `services/svc-agents/src/index.ts` does, as far as the ported slices reach: the pool, the schema
//! check, the bus, the boot upsert of the agents' guardrails, the door, then the port, then the timers. The TypeScript
//! service stays the one that runs until the switch; until each slice is ported its calls answer "not ported" (500),
//! and a timer whose work is not ported does not run.

use std::collections::BTreeMap;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use service_kit::edge::{EdgeKey, MIN_SECRET_LENGTH};
use service_kit::http::{Fetch, UreqFetch};
use service_kit::json::Json;
use service_kit::money::parse_amount;
use service_kit::nats::{JetStream, stream_config};
use service_kit::s2s::{CallSigner, parse_keyring, s2s_from_env, system_seconds};
use service_kit::s2s_verify::ServiceVerifier;
use service_kit::server::{self, App};
use service_kit::telemetry::{Logger, Telemetry};

use svc_agents::advisors::Advisors;
use svc_agents::advisors::grounding::AcademyCurriculum;
use svc_agents::advisors::portfolio::{self, LedgerBalancesHttp, TradeTickerPrices};
use svc_agents::background;
use svc_agents::boot;
use svc_agents::db::{self, Store};
use svc_agents::door::{AgentsDoor, DoorConfig, ServiceAuth, system_now};
use svc_agents::env::{self, AgentsEnv, DEFAULT_PORT};
use svc_agents::gateway::Gateway;
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::providers::{
    MockOptions, MockProvider, Provider, UpstreamConfig, UpstreamProvider,
};
use svc_agents::gateway::readiness::{self, ReadyInput};
use svc_agents::gateway::routing::{self, RoutingTable};
use svc_agents::metering::Metering;
use svc_agents::metering::ports::{
    AffiliatesHttp, JetStreamBus, LedgerHttp, LedgerOnly, UsagePayment, UsagePaymentHttp,
};
use svc_agents::migrate;
use svc_agents::own::Own;
use svc_agents::own::catalog::parse_own_templates;
use svc_agents::own::desk::{SupportDesk, SupportDeskHttp};
use svc_agents::own::gates::parse_policy_baseline;
use svc_agents::runtime::eligibility::parse_tier_laws;
use svc_agents::runtime::funds::{BalancesHttp, PersonFunds};
use svc_agents::runtime::{Rt, Runtime};
use svc_agents::self_freeze::IdentitySelfFreezeRead;
use svc_agents::timers::{self, Timer};

fn process_env() -> BTreeMap<String, String> {
    std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let out = if args.first().map(String::as_str) == Some("migrate") {
        let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| migrate::DEFAULT_URL.to_owned());
        migrate::run(
            &url,
            args.iter().any(|a| a == "--down"),
            &mut std::io::stdout(),
        )
    } else {
        run()
    };
    match out {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

/// One timer's work, handed in by the slice that ports it.
type Job<'a> = Box<dyn Fn() -> Result<(), String> + Sync + 'a>;

/// The work each timer runs. Each comes with its slice (`timers::timers` names it); until then the timer does not run,
/// as it would not in a process without that work.
fn jobs<'a>(door: &'a AgentsDoor, _env: &'a AgentsEnv) -> Vec<(&'static str, Job<'a>)> {
    vec![
        (
            "route table sync",
            Box::new(move || {
                door.gateway()
                    .refresh(door.store())
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            }),
        ),
        // `advanceSessionRuns`, then `publishCompletedRuns` whether or not the advance failed; the timer runs only while
        // both owner values are set (`timers::timers`).
        (
            "background ticker",
            Box::new(move || {
                let pool = door.store().pool().map_err(|e| e.to_string())?;
                let m = door.metering();
                let x = Rt {
                    rt: door.runtime(),
                    pool,
                    gateway: &door.gateway().gateway,
                    m,
                    now: system_now(),
                };
                let step_ms = door.background().step_ms.unwrap_or(0);
                let advanced = background::advance(&x, step_ms, 50)
                    .map(|_| ())
                    .map_err(|e| format!("background session runs did not advance: {e:?}"));
                background::publish_completed(pool, m.bus.as_ref(), &m.producer, system_now(), 100)
                    .map_err(|e| format!("finished background runs not announced: {e:?}"))?;
                advanced
            }),
        ),
        (
            "unpublished sweep",
            Box::new(move || svc_agents::own::notices::sweep_unpublished(door)),
        ),
    ]
}

/// A record value of the environment (`AGENTS_UPSTREAM_HEADERS`, `AGENTS_UPSTREAM_MODELS`), in its order.
fn pairs(env: &AgentsEnv, key: &str) -> Vec<(String, String)> {
    match env.get(key) {
        Some(Json::Object(fields)) => fields
            .iter()
            .filter_map(|(k, v)| match v {
                Json::String(s) => Some((k.clone(), s.clone())),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// `buildPrimaryProvider`: the deterministic mock unless `AGENTS_PROVIDER=upstream`, which needs its address and key.
fn primary_provider(env: &AgentsEnv, fetch: Arc<dyn Fetch>) -> Result<Arc<dyn Provider>, String> {
    if env.str("AGENTS_PROVIDER") != Some("upstream") {
        return Ok(Arc::new(MockProvider::new(
            MockOptions {
                id: Some("primary".to_owned()),
                answer_delay_ms: env
                    .int("AGENTS_MOCK_DELAY_MS")
                    .and_then(|n| u64::try_from(n).ok())
                    .unwrap_or(0),
                hold_file: env
                    .str("AGENTS_MOCK_HOLD_FILE")
                    .map(std::path::PathBuf::from),
                ..MockOptions::default()
            },
            system_now,
        )));
    }
    let (Some(base_url), Some(api_key)) = (
        env.str("AGENTS_UPSTREAM_BASE_URL")
            .filter(|s| !s.is_empty()),
        env.str("AGENTS_UPSTREAM_API_KEY").filter(|s| !s.is_empty()),
    ) else {
        return Err(
            "AGENTS_PROVIDER=upstream requires AGENTS_UPSTREAM_BASE_URL and AGENTS_UPSTREAM_API_KEY"
                .to_owned(),
        );
    };
    Ok(Arc::new(UpstreamProvider::new(
        UpstreamConfig {
            id: "primary".to_owned(),
            base_url: base_url.to_owned(),
            api_key: api_key.to_owned(),
            auth_header: env.str("AGENTS_UPSTREAM_AUTH_HEADER").map(str::to_owned),
            auth_prefix: env.str("AGENTS_UPSTREAM_AUTH_PREFIX").map(str::to_owned),
            headers: pairs(env, "AGENTS_UPSTREAM_HEADERS"),
            completions_path: env
                .str("AGENTS_UPSTREAM_COMPLETIONS_PATH")
                .map(str::to_owned),
            embeddings_path: env
                .str("AGENTS_UPSTREAM_EMBEDDINGS_PATH")
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            models: pairs(env, "AGENTS_UPSTREAM_MODELS"),
            timeout_ms: env
                .int("AGENTS_UPSTREAM_TIMEOUT_MS")
                .and_then(|n| u64::try_from(n).ok()),
            supports_streaming: None,
        },
        fetch,
        system_now,
    )))
}

/// `buildRoutingTable`: unpublished rates stay blank, as the default table's are test placeholders.
fn routing_table(env: &AgentsEnv) -> Result<RoutingTable, String> {
    match env.str("AGENTS_ROUTING_TABLE").filter(|s| !s.is_empty()) {
        None => Ok(routing::unpriced(&routing::default_table())),
        Some(text) => routing::parse_routing_table(text),
    }
}

/// The gateway slice, from the environment: the primary provider, the configured table, the fee asset and the window.
fn gateway(env: &AgentsEnv, fetch: Arc<dyn Fetch>) -> Result<GatewaySlice, String> {
    let provider = primary_provider(env, fetch)?;
    Ok(GatewaySlice {
        gateway: Arc::new(Gateway::new(vec![provider], routing_table(env)?)),
        fee_asset_id: env
            .str("AGENTS_FEE_ASSET_ID")
            .unwrap_or_default()
            .to_owned(),
        metering_enabled: env.flag("AGENTS_METERING_ENABLED"),
        window_minutes: env.int("AGENTS_USAGE_WINDOW_MINUTES").unwrap_or(1),
    })
}

/// `createEdgeContext`'s service checks: the shared secret when it is long enough, and the keys when S2S is on.
fn service_auth(env: &AgentsEnv) -> Result<ServiceAuth, String> {
    let str_of = |k: &str| env.str(k).unwrap_or_default().to_owned();
    let keyring = env.str("S2S_KEYRING");
    let s2s = s2s_from_env(
        &str_of("S2S_AUTH_MODE"),
        keyring,
        env.str("S2S_SIGNING_KID"),
        env.str("S2S_SIGNING_KEY"),
        "svc-agents",
    )?;
    let keys = match (s2s.mode, keyring) {
        (Some(mode), Some(ring)) => Some((
            ServiceVerifier::new("svc-agents", &parse_keyring(ring)?, system_seconds)?,
            mode,
        )),
        _ => None,
    };
    let secret = str_of("INTERNAL_SERVICE_SECRET");
    Ok(ServiceAuth {
        secret: (secret.chars().count() >= MIN_SECRET_LENGTH).then_some(secret),
        keys,
    })
}

/// The meter as `index.ts` builds it: the ledger client (`LEDGER_URL` is required), how each person pays (svc-bank
/// while `BANK_URL` is set, else everyone on the ledger charge), the affiliate legs (svc-identity while `IDENTITY_URL`
/// is set, else none), and the bus; each outside call signed as svc-agents, with its own key when S2S is on.
fn metering(
    env: &AgentsEnv,
    bus: Arc<JetStream>,
    fetch: &Arc<dyn Fetch>,
) -> Result<Metering, String> {
    let str_of = |k: &str| env.str(k).unwrap_or_default().to_owned();
    let s2s = s2s_from_env(
        env.str("S2S_AUTH_MODE").unwrap_or("off"),
        env.str("S2S_KEYRING"),
        env.str("S2S_SIGNING_KID"),
        env.str("S2S_SIGNING_KEY"),
        "svc-agents",
    )?;
    let keyed = match (s2s.signer, s2s.mode) {
        (Some(signer), Some(mode)) => Some((signer, mode)),
        _ => None,
    };
    let secret = str_of("INTERNAL_SERVICE_SECRET");
    let signer = |audience: &str| CallSigner::new("svc-agents", audience, &secret, keyed.clone());
    let mut m = Metering::unwired(
        &str_of("AGENTS_FEE_ASSET_ID"),
        env.int("AGENTS_USAGE_WINDOW_MINUTES").unwrap_or(0),
    );
    m.enabled = env.flag("AGENTS_METERING_ENABLED").unwrap_or(false);
    m.producer = str_of("SERVICE_NAME");
    m.ledger = Box::new(LedgerHttp::new(
        &str_of("LEDGER_URL"),
        signer("svc-ledger"),
        fetch.clone(),
    ));
    if let Some(url) = env.str("BANK_URL").filter(|u| !u.is_empty()) {
        m.payment = Box::new(UsagePaymentHttp::new(
            url,
            signer("svc-bank"),
            fetch.clone(),
        ));
    }
    if let Some(url) = env.str("IDENTITY_URL").filter(|u| !u.is_empty()) {
        m.affiliates = Box::new(AffiliatesHttp::new(
            url,
            signer("svc-identity"),
            fetch.clone(),
        ));
    }
    m.bus = Box::new(JetStreamBus(bus));
    Ok(m)
}

/// The runtime as `index.ts` builds it: a spend gate, the funds read as `teamFunds` over `paymentMethodFunds` (how
/// each person pays from svc-bank while `BANK_URL` is set, else the ledger's balance; a wallet payment method is the
/// own-controls slice's and reads unread), the transcript's retention, the overage grace and the tier laws.
fn runtime(env: &AgentsEnv, fetch: &Arc<dyn Fetch>) -> Result<Runtime, String> {
    let str_of = |k: &str| env.str(k).unwrap_or_default().to_owned();
    let s2s = s2s_from_env(
        env.str("S2S_AUTH_MODE").unwrap_or("off"),
        env.str("S2S_KEYRING"),
        env.str("S2S_SIGNING_KID"),
        env.str("S2S_SIGNING_KEY"),
        "svc-agents",
    )?;
    let keyed = match (s2s.signer, s2s.mode) {
        (Some(signer), Some(mode)) => Some((signer, mode)),
        _ => None,
    };
    let secret = str_of("INTERNAL_SERVICE_SECRET");
    let signer = |audience: &str| CallSigner::new("svc-agents", audience, &secret, keyed.clone());
    let payment: Box<dyn UsagePayment> = match env.str("BANK_URL").filter(|u| !u.is_empty()) {
        Some(url) => Box::new(UsagePaymentHttp::new(
            url,
            signer("svc-bank"),
            fetch.clone(),
        )),
        None => Box::new(LedgerOnly),
    };
    let grace = env
        .str("AGENTS_OVERAGE_GRACE")
        .map(str::trim)
        .filter(|g| !g.is_empty())
        .map(parse_amount)
        .transpose()?;
    Ok(Runtime {
        spend: true,
        funds: Some(Box::new(PersonFunds {
            payment,
            balances: Box::new(BalancesHttp::new(
                &str_of("LEDGER_URL"),
                signer("svc-ledger"),
                fetch.clone(),
            )),
        })),
        transcript_retention_days: env.int("AGENTS_TRANSCRIPT_RETENTION_DAYS").unwrap_or(0),
        overage_grace: grace,
        tier_laws: parse_tier_laws(env.str("AGENTS_TIER_LAWS"))?,
        // `env.IDENTITY_URL ? createIdentitySelfFreezeRead(...) : null`.
        self_freeze: env
            .str("IDENTITY_URL")
            .filter(|u| !u.is_empty())
            .map(|url| {
                Box::new(IdentitySelfFreezeRead::new(
                    url,
                    signer("svc-identity"),
                    fetch.clone(),
                )) as Box<dyn svc_agents::self_freeze::SelfFreezeRead>
            }),
    })
}

/// The door, built once from the environment, with the store, the meter, the gateway and what `/ready` reports.
/// The advisors' reads (`index.ts`): svc-academy's curriculum when `ACADEMY_URL` is set; the person's balances in
/// svc-ledger and svc-trade's prices when `TRADE_URL` and `PORTFOLIO_QUOTE_ASSET` are both set; planning switched on
/// only by `AGENTS_PORTFOLIO_ENABLED`.
fn advisors(env: &AgentsEnv, fetch: &Arc<dyn Fetch>) -> Result<Advisors, String> {
    let str_of = |k: &str| env.str(k).unwrap_or_default().to_owned();
    let s2s = s2s_from_env(
        env.str("S2S_AUTH_MODE").unwrap_or("off"),
        env.str("S2S_KEYRING"),
        env.str("S2S_SIGNING_KID"),
        env.str("S2S_SIGNING_KEY"),
        "svc-agents",
    )?;
    let keyed = match (s2s.signer, s2s.mode) {
        (Some(signer), Some(mode)) => Some((signer, mode)),
        _ => None,
    };
    let secret = str_of("INTERNAL_SERVICE_SECRET");
    let signer = |audience: &str| CallSigner::new("svc-agents", audience, &secret, keyed.clone());
    let mut a = Advisors::unwired();
    if let Some(url) = env.str("ACADEMY_URL").filter(|u| !u.is_empty()) {
        a.curriculum = Box::new(AcademyCurriculum {
            base_url: url.to_owned(),
            signer: signer("svc-academy"),
            fetch: fetch.clone(),
        });
    }
    a.portfolio_killed =
        portfolio::killed(env.raw.get("AGENTS_PORTFOLIO_ENABLED").map(String::as_str));
    if let (Some(trade), Some(quote)) = (
        env.str("TRADE_URL").filter(|u| !u.is_empty()),
        env.str("PORTFOLIO_QUOTE_ASSET").filter(|q| !q.is_empty()),
    ) {
        a.holdings = Some((
            Box::new(LedgerBalancesHttp::new(
                &str_of("LEDGER_URL"),
                signer("svc-ledger"),
                fetch.clone(),
            )),
            Box::new(TradeTickerPrices {
                base_url: trade.to_owned(),
                quote_asset_id: quote.to_owned(),
                fetch: fetch.clone(),
                timeout_ms: 3_000,
            }),
        ));
    }
    Ok(a)
}

/// The own agents' templates and owner values, as `index.ts` hands them to `createAgentsRouter`: the support desk
/// when `SUPPORT_URL` is set (its account read through `IDENTITY_URL`); absent refuses as `index.ts` leaves it unwired.
/// The owner's freeze is read through the runtime's one reader.
fn own(env: &AgentsEnv, fetch: &Arc<dyn Fetch>) -> Result<Own, String> {
    let s2s = s2s_from_env(
        env.str("S2S_AUTH_MODE").unwrap_or("off"),
        env.str("S2S_KEYRING"),
        env.str("S2S_SIGNING_KID"),
        env.str("S2S_SIGNING_KEY"),
        "svc-agents",
    )?;
    let keyed = match (s2s.signer, s2s.mode) {
        (Some(signer), Some(mode)) => Some((signer, mode)),
        _ => None,
    };
    let secret = env
        .str("INTERNAL_SERVICE_SECRET")
        .unwrap_or_default()
        .to_owned();
    let signer = |audience: &str| CallSigner::new("svc-agents", audience, &secret, keyed.clone());
    let identity = env.str("IDENTITY_URL").filter(|u| !u.is_empty());
    let support_desk: Option<Box<dyn SupportDesk>> = env
        .str("SUPPORT_URL")
        .filter(|u| !u.is_empty())
        .map(|url| -> Box<dyn SupportDesk> {
            Box::new(SupportDeskHttp {
                support_url: url.to_owned(),
                identity_url: identity.map(str::to_owned),
                identity_signer: signer("svc-identity"),
                fetch: fetch.clone(),
            })
        });
    Ok(Own {
        templates: parse_own_templates(env.str("AGENTS_OWN_TEMPLATES"))?,
        assistant_model: env.str("AGENTS_OWN_ASSISTANT_MODEL").map(str::to_owned),
        baseline: parse_policy_baseline(env.str("AGENTS_POLICY_BASELINE"))?,
        reviewer_model: env.str("AGENTS_REVIEWER_MODEL").map(str::to_owned),
        approval_ttl_seconds: env.int("AGENTS_APPROVAL_TTL_SECONDS"),
        support_desk,
    })
}

#[allow(
    clippy::too_many_arguments,
    reason = "the door is built once from each part the binary made, in index.ts's order"
)]
fn door(
    env: &AgentsEnv,
    store: Store,
    metering: Metering,
    gateway: GatewaySlice,
    ready: ReadyInput,
    runtime: Runtime,
    advisors: Advisors,
    fetch: &Arc<dyn Fetch>,
) -> Result<AgentsDoor, String> {
    let str_of = |k: &str| env.str(k).unwrap_or_default().to_owned();
    let door = AgentsDoor::new(DoorConfig {
        edge_secret: str_of("EDGE_PRINCIPAL_SECRET"),
        services: service_auth(env)?,
        env: env.raw.clone(),
        now: system_now,
        store,
        metering,
        gateway,
        ready,
        runtime,
        background: background::Settings {
            max_steps: env.int("AGENTS_SESSION_RUN_MAX_STEPS"),
            step_ms: env.int("AGENTS_BACKGROUND_STEP_MS"),
        },
        advisors,
        own: own(env, fetch)?,
    })?;
    Ok(match env.str("EDGE_PRINCIPAL_PUBLIC_KEY") {
        None => door,
        Some(key) => door.with_edge_key(EdgeKey::from_env(
            &str_of("SERVICE_NAME"),
            key,
            env.int("EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS"),
            env.int("EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS"),
        )?),
    })
}

fn run() -> Result<(), String> {
    let env = env::load(&process_env()).map_err(|e| e.message)?;
    let str_of = |k: &str| env.str(k).unwrap_or_default().to_owned();
    let log = Logger::stdout(&str_of("LOG_LEVEL"));
    let fetch: Arc<dyn Fetch> = Arc::new(UreqFetch::new());
    let telemetry = Telemetry::start(
        env.flag("OTEL_ENABLED").unwrap_or(false),
        &str_of("SERVICE_NAME"),
        &str_of("OTEL_EXPORTER_OTLP_ENDPOINT"),
        &str_of("APP_ENV"),
        fetch.clone(),
        log.clone(),
    );
    let out = serve(&env, &log, &telemetry, fetch);
    telemetry.shutdown();
    out
}

fn serve(
    env: &AgentsEnv,
    log: &Logger,
    telemetry: &Telemetry,
    fetch: Arc<dyn Fetch>,
) -> Result<(), String> {
    let str_of = |k: &str| env.str(k).unwrap_or_default().to_owned();
    // The provider and the configured table come before the database, as `index.ts` builds them.
    let gateway = gateway(env, fetch.clone())?;
    let pool_max = usize::try_from(env.int("DATABASE_POOL_MAX").unwrap_or(1)).unwrap_or(1);
    let store = db::open(
        &str_of("DATABASE_URL"),
        &str_of("SERVICE_NAME"),
        pool_max,
        env.flag("DATABASE_SSL").unwrap_or(false),
    )?;
    boot::check_schema(&store)?;
    // `JetStreamEventBus.connect({ ..., ownedStreams: ['agents'] })`: a bus that cannot be reached stops the start.
    let bus = JetStream::connect(
        &str_of("NATS_URL"),
        &str_of("SERVICE_NAME"),
        Duration::from_secs(5),
    )
    .and_then(|js| {
        js.ensure_stream(&stream_config("agents", &str_of("NATS_STREAM_PREFIX")))
            .map(|()| js)
    })
    .map_err(|e| e.0)?;
    let bus = Arc::new(bus);
    // Before the listener opens: `openSession` binds from `agent_definitions`, so a process with no rows 404s every run.
    let boot_agents = boot::boot_agents()?;
    // The founders' confirmed changes over the configured table (J-agents-20), read before the port opens.
    gateway.refresh(&store).map_err(|e| e.to_string())?;
    let registered = boot::register_agents(&store, &boot_agents).map_err(|e| e.to_string())?;
    let product_agents = readiness::product_agents_registered(&registered);
    let ready = ReadyInput {
        provider_mode: str_of("AGENTS_PROVIDER"),
        metering_enabled: env.flag("AGENTS_METERING_ENABLED").unwrap_or(false),
        product_agents_registered: product_agents,
        fleet: readiness::fleet_card(&boot_agents),
        live_planes: readiness::live_planes(&env.raw),
    };
    let tasks = gateway.gateway.base().routes.len();
    let metering = metering(env, bus.clone(), &fetch)?;
    let runtime = runtime(env, &fetch)?;
    let advisors = advisors(env, &fetch)?;
    let door = door(
        env, store, metering, gateway, ready, runtime, advisors, &fetch,
    )?;

    let app = App {
        wire: door,
        service_name: str_of("SERVICE_NAME"),
        ready_body: String::new(),
    };
    let port_number = env.int("HTTP_PORT").unwrap_or(DEFAULT_PORT);
    let port = u16::try_from(port_number)
        .map_err(|_| format!("options.port should be >= 0 and < 65536. Received {port_number}."))?;
    let server =
        tiny_http::Server::http((str_of("HTTP_HOST").as_str(), port)).map_err(|e| e.to_string())?;
    log.info(
        vec![
            ("port", Json::int(i64::from(port))),
            ("provider", Json::str(str_of("AGENTS_PROVIDER"))),
            (
                "metering",
                Json::Bool(env.flag("AGENTS_METERING_ENABLED").unwrap_or(false)),
            ),
            ("tasks", Json::int(i64::try_from(tasks).unwrap_or(0))),
            (
                "productAgents",
                Json::Array(registered.into_iter().map(Json::String).collect()),
            ),
        ],
        "svc-agents ready",
    );

    let stop = Arc::new(AtomicBool::new(false));
    for signal in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        signal_hook::flag::register(signal, stop.clone()).map_err(|e| e.to_string())?;
    }
    let table = timers::timers(env);
    let jobs = jobs(&app.wire, env);
    for t in table.iter().filter(|t| t.every.is_some()) {
        if !jobs.iter().any(|(name, _)| *name == t.name) {
            log.warn(
                vec![
                    ("timer", Json::str(t.name)),
                    ("slice", Json::str(t.slice.name())),
                ],
                "svc-agents timer not started: its slice is not ported",
            );
        }
    }
    std::thread::scope(|scope| {
        for (name, job) in &jobs {
            let Some(Timer {
                every: Some(period),
                at_boot,
                ..
            }) = table.iter().find(|t| t.name == *name).cloned()
            else {
                continue;
            };
            let stop = &stop;
            scope.spawn(move || {
                timers::every(period, at_boot, stop, job.as_ref(), &|e| {
                    log.warn(
                        vec![("timer", Json::str(*name)), ("err", Json::str(e))],
                        "svc-agents timer run failed; the next tick retries",
                    );
                });
            });
        }
        server::serve(&server, &app, log, telemetry, &stop);
    });
    // Draining, not dropping: in-flight requests and timer runs finish before the bus and the pool close.
    drop(server);
    bus.close();
    app.wire.end();
    log.info(Vec::new(), "svc-agents stopped");
    Ok(())
}
