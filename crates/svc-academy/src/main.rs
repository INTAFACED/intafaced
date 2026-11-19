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
use service_kit::server::{self, App};
use service_kit::telemetry::{Logger, Telemetry};

use svc_academy::db::Store;
use svc_academy::door::{AcademyDoor, DoorConfig, system_now};
use svc_academy::env::{self, AcademyEnv};
use svc_academy::migrate;
use svc_academy::ports::{JetStreamBus, Ports};
use svc_academy::settings::Settings;

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

/// The door, built once from the environment. Every outside port is its stand-in until its slice wires the real one.
fn door(env: &AcademyEnv, bus: Option<JetStreamBus>) -> Result<AcademyDoor, String> {
    let str_of = |k: &str| env.str(k).unwrap_or_default().to_owned();
    let pool_max = usize::try_from(env.int("DATABASE_POOL_MAX").unwrap_or(1)).unwrap_or(1);
    let mut ports = Ports::unwired();
    ports.stream_configured = env.str("ACADEMY_STREAM_PROVIDER").map(str::to_owned);
    if let Some(bus) = bus {
        ports.bus = Box::new(bus);
    }
    let door = AcademyDoor::new(DoorConfig {
        edge_secret: str_of("EDGE_PRINCIPAL_SECRET"),
        env: env.raw.clone(),
        store: Store::Pool(Pool::new(&str_of("DATABASE_URL"), pool_max)),
        ports,
        settings: Settings(env.json.clone()),
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

fn run() -> Result<(), String> {
    let env = env::load(&process_env()).map_err(|e| e.message)?;
    let str_of = |k: &str| env.str(k).unwrap_or_default().to_owned();
    let log = Logger::stdout(&str_of("LOG_LEVEL"));
    let fetch: Arc<dyn Fetch> = Arc::new(UreqFetch::new());
    let telemetry = Telemetry::start(
        env.flag("OTEL_ENABLED"),
        &str_of("SERVICE_NAME"),
        &str_of("OTEL_EXPORTER_OTLP_ENDPOINT"),
        &str_of("APP_ENV"),
        fetch,
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
    let door = match door(&env, bus) {
        Ok(d) => d,
        Err(e) => {
            telemetry.shutdown();
            return Err(e);
        }
    };
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

    let stop = Arc::new(AtomicBool::new(false));
    for signal in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        signal_hook::flag::register(signal, stop.clone()).map_err(|e| e.to_string())?;
    }
    server::serve(&server, &app, &log, &telemetry, &stop);
    drop(server);
    app.wire.end();
    telemetry.shutdown();
    log.info(Vec::new(), "svc-academy stopped");
    Ok(())
}
