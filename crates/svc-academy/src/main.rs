//! The svc-academy process: `svc-academy` serves; `svc-academy migrate [--down]` applies (or reverses) the academy
//! schema's migrations.
//!
//! It is not wired into compose or the stack yet: the TypeScript service serves the Academy until the switch.

use std::collections::BTreeMap;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use service_kit::edge::EdgeKey;
use service_kit::http::{Fetch, UreqFetch};
use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::s2s::{CallSigner, s2s_from_env};
use service_kit::server::{self, App};
use service_kit::telemetry::{Logger, Telemetry};

use svc_academy::community::{Db, analytics, moderation};
use svc_academy::curriculum::{internal::ServiceAuth, spine};
use svc_academy::db::Store;
use svc_academy::door::{AcademyDoor, DoorConfig, system_now};
use svc_academy::env::{self, AcademyEnv};
use svc_academy::identity_approvals::IdentityApprovals;
use svc_academy::lobbies::clients::{HttpHostRights, HttpStake};
use svc_academy::lobbies::stream::stream_from_env;
use svc_academy::migrate;
use svc_academy::ports::{JetStreamBus, Ports};
use svc_academy::programme::ambassadors::check_laws;
use svc_academy::programme::paper::flag::TradePaperFlags;
use svc_academy::settings::Settings;
use svc_academy::slices;

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

/// The door, built once from the environment. An outside port is its stand-in until its slice wires the real one.
fn door(
    env: &AcademyEnv,
    bus: Option<JetStreamBus>,
    fetch: &Arc<dyn Fetch>,
) -> Result<AcademyDoor, String> {
    let str_of = |k: &str| env.str(k).unwrap_or_default().to_owned();
    let pool_max = usize::try_from(env.int("DATABASE_POOL_MAX").unwrap_or(1)).unwrap_or(1);
    let mut ports = Ports::unwired();
    ports.stream_configured = env.str("ACADEMY_STREAM_PROVIDER").map(str::to_owned);
    // The lobbies' outside reads and the stream (`index.ts`): signed with svc-academy's own key when S2S is on.
    let s2s = s2s_from_env(
        env.str("S2S_AUTH_MODE").unwrap_or("off"),
        env.str("S2S_KEYRING"),
        env.str("S2S_SIGNING_KID"),
        env.str("S2S_SIGNING_KEY"),
        "svc-academy",
    )?;
    let keyed = match (s2s.signer, s2s.mode) {
        (Some(signer), Some(mode)) => Some((signer, mode)),
        _ => None,
    };
    let secret = str_of("INTERNAL_SERVICE_SECRET");
    let signer = |audience: &str| CallSigner::new("svc-academy", audience, &secret, keyed.clone());
    ports.stake = Box::new(HttpStake::new(
        &str_of("TOKEN_URL"),
        signer("svc-token"),
        fetch.clone(),
    ));
    ports.host_rights = Box::new(HttpHostRights::new(
        &str_of("IDENTITY_URL"),
        signer("svc-identity"),
        fetch.clone(),
    ));
    ports.stream = stream_from_env(
        env.str("ACADEMY_STREAM_PROVIDER"),
        env.str("LIVEKIT_URL"),
        env.str("LIVEKIT_API_KEY"),
        env.str("LIVEKIT_API_SECRET"),
        env.int("LIVEKIT_TOKEN_TTL_SECONDS"),
        fetch.clone(),
    );
    if let Some(bus) = bus {
        ports.bus = Box::new(bus);
    }
    ports.services = ServiceAuth::from_env(
        &str_of("INTERNAL_SERVICE_SECRET"),
        &str_of("INTERNAL_SERVICE_BODY_BIND"),
        &str_of("S2S_AUTH_MODE"),
        env.str("S2S_KEYRING"),
        env.str("S2S_SIGNING_KID"),
        env.str("S2S_SIGNING_KEY"),
    )?;
    // As `index.ts`: identity consumes operator approvals whenever IDENTITY_URL is set (it has a default).
    if let Some(identity) = env.str("IDENTITY_URL") {
        ports.approvals = Box::new(IdentityApprovals::new(
            identity,
            &str_of("INTERNAL_SERVICE_SECRET"),
            fetch.clone(),
            service_kit::s2s::system_seconds,
        ));
    }
    // svc-trade's public paper flags, only when TRADE_URL is set; unset, a drill claiming paper refuses unverified.
    if let Some(trade) = env.str("TRADE_URL") {
        ports.paper_flags = Box::new(TradePaperFlags::new(
            trade,
            env.int("ACADEMY_PAPER_MARKETS_LIMIT"),
            fetch.clone(),
        ));
    }
    let settings = Settings(env.json.clone());
    // As `index.ts`, which parses both ambassador pay laws at load: a malformed one stops the boot.
    check_laws(&settings).map_err(|r| format!("{} [{}]", r.message, r.code))?;
    let door = AcademyDoor::new(DoorConfig {
        edge_secret: str_of("EDGE_PRINCIPAL_SECRET"),
        env: env.raw.clone(),
        store: Store::Pool(Pool::new(&str_of("DATABASE_URL"), pool_max)),
        ports,
        settings,
        now: system_now,
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

/// AC-analytics-02: the report sweep runs requested reports, one sweep at a time, every `ACADEMY_REPORT_SWEEP_SECONDS`
/// (the first after one interval, as `setInterval`), on its own connection. A blank interval runs none.
fn report_sweep(
    door: &AcademyDoor,
    log: &Logger,
    stop: &Arc<AtomicBool>,
) -> Option<std::thread::JoinHandle<()>> {
    let settings = slices::community::report_settings(door.settings());
    let seconds = u64::try_from(settings.sweep_seconds?).ok()?;
    let url = door.store().pool().ok()?.url().to_owned();
    let (log, stop) = (log.clone(), stop.clone());
    Some(std::thread::spawn(move || {
        let pool = Pool::new(&url, 1);
        let tick = std::time::Duration::from_millis(200);
        'sweeps: loop {
            let due = std::time::Instant::now() + std::time::Duration::from_secs(seconds);
            while std::time::Instant::now() < due {
                if stop.load(std::sync::atomic::Ordering::Relaxed) {
                    break 'sweeps;
                }
                std::thread::sleep(tick);
            }
            if let Err(e) = analytics::sweep(&pool, &settings, system_now()) {
                log.error(
                    vec![("err", Json::str(format!("{e:?}")))],
                    "report sweep failed; the next one retries",
                );
            }
        }
        pool.end();
    }))
}

fn run() -> Result<(), String> {
    let env = env::load(&process_env()).map_err(|e| e.message)?;
    // The embedded spine loads, or the service does not start (the TypeScript catalog throws at module load).
    spine::check()?;
    let str_of = |k: &str| env.str(k).unwrap_or_default().to_owned();
    let log = Logger::stdout(&str_of("LOG_LEVEL"));
    let fetch: Arc<dyn Fetch> = Arc::new(UreqFetch::new());
    let telemetry = Telemetry::start(
        env.flag("OTEL_ENABLED"),
        &str_of("SERVICE_NAME"),
        &str_of("OTEL_EXPORTER_OTLP_ENDPOINT"),
        &str_of("APP_ENV"),
        fetch.clone(),
        log.clone(),
    );
    // As the TypeScript: a bus that cannot be reached is reported on /ready, not fatal.
    let bus = match JetStreamBus::connect(
        &str_of("NATS_URL"),
        &str_of("SERVICE_NAME"),
        &str_of("NATS_STREAM_PREFIX"),
    ) {
        Ok(b) => Some(b),
        Err(e) => {
            log.error(
                vec![("err", Json::str(e))],
                "svc-academy could not reach the bus — certification XP will not be published",
            );
            None
        }
    };
    let door = match door(&env, bus, &fetch) {
        Ok(d) => d,
        Err(e) => {
            telemetry.shutdown();
            return Err(e);
        }
    };
    // AC-rooms-02: author notices a down bus left waiting go now. A failure leaves them waiting; the boot goes on.
    let outbox = moderation::Outbox {
        bus: door.ports().bus.as_ref(),
        producer: slices::community::producer(door.settings()),
        log: &slices::community::log_notice_error,
    };
    if let Err(e) = moderation::send_waiting(&Db(door.store()), &outbox) {
        log.error(
            vec![("err", Json::str(format!("{e:?}")))],
            "moderation notices could not be sent at boot",
        );
    }
    let stop = Arc::new(AtomicBool::new(false));
    let report_sweep = report_sweep(&door, &log, &stop);
    let ready_body = door.ready().compact();
    let app = App {
        wire: door,
        service_name: str_of("SERVICE_NAME"),
        ready_body,
    };
    let port_number = env.int("HTTP_PORT").unwrap_or(env::DEFAULT_PORT);
    let port = u16::try_from(port_number)
        .map_err(|_| format!("options.port should be >= 0 and < 65536. Received {port_number}."))?;
    let server =
        tiny_http::Server::http((str_of("HTTP_HOST").as_str(), port)).map_err(|e| e.to_string())?;
    log.info(
        vec![
            ("port", Json::int(i64::from(port))),
            ("trpc", Json::Bool(true)),
        ],
        "svc-academy ready",
    );

    for signal in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        signal_hook::flag::register(signal, stop.clone()).map_err(|e| e.to_string())?;
    }
    server::serve(&server, &app, &log, &telemetry, &stop);
    drop(server);
    if let Some(t) = report_sweep {
        let _ = t.join();
    }
    app.wire.end();
    telemetry.shutdown();
    log.info(Vec::new(), "svc-academy stopped");
    Ok(())
}
