//! The svc-ledger process: `svc-ledger` serves; `svc-ledger migrate [--down]` applies (or reverses) the ledger
//! schema's migrations.
//!
//! Serving starts as `services/svc-ledger/src/index.ts` does: the pool, the chain tip, the bus, the custody boot check
//! and the startup freeze, then the outbox recovery at boot and every five seconds, then the port. The TypeScript
//! service stays the one that runs until the switch; until each slice is ported its calls answer 503
//! `ledger.not_ported`.

use std::collections::BTreeMap;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use service_kit::http::{Fetch, UreqFetch};
use service_kit::json::Json;
use service_kit::nats::{JetStream, stream_config};
use service_kit::s2s::{parse_keyring, s2s_from_env, system_seconds};
use service_kit::s2s_verify::{BodyBind, ServiceVerifier};
use service_kit::server::{self, App};
use service_kit::telemetry::{Logger, Telemetry};
use service_kit::tokens::TokenConfig;

use svc_ledger::boot::{self, OUTBOX_RECOVER_MS, Relay};
use svc_ledger::db::{self, Store};
use svc_ledger::door::{DoorConfig, Keys, LedgerDoor};
use svc_ledger::env::{self, DEFAULT_PORT, LedgerEnv};
use svc_ledger::migrate;

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

/// The relays the outbox recovery drives. Each comes with its slice: `posting` (`ledgerTxPosted`) and `freeze`
/// (`ledgerFreezeUpdated`); until then an intent stays committed and unsent, as it does while the bus is down.
fn relays() -> Vec<&'static dyn Relay> {
    Vec::new()
}

/// The door, built once from the environment, as `index.ts` mounts its doors.
fn door(env: &LedgerEnv, store: Store) -> Result<LedgerDoor, String> {
    let str_of = |k: &str| env.str(k).unwrap_or_default().to_owned();
    let mode = str_of("S2S_AUTH_MODE");
    let s2s = s2s_from_env(
        &mode,
        env.str("S2S_KEYRING"),
        env.str("S2S_SIGNING_KID"),
        env.str("S2S_SIGNING_KEY"),
        "svc-ledger",
    )?;
    let keys = match s2s.mode {
        None => None,
        Some(mode) => Some(Keys {
            verifier: ServiceVerifier::new(
                "svc-ledger",
                &parse_keyring(env.str("S2S_KEYRING").unwrap_or_default())?,
                system_seconds,
            )?,
            mode,
        }),
    };
    LedgerDoor::new(DoorConfig {
        internal_secret: str_of("INTERNAL_SERVICE_SECRET"),
        // `registerS2sHttp(..., { bodyBind: 'require' })`: the live money plane always binds the body.
        body_bind: BodyBind::Require,
        keys,
        tokens: TokenConfig {
            secret: str_of("JWT_ACCESS_SECRET"),
            issuer: str_of("JWT_ISSUER"),
            audience: str_of("JWT_AUDIENCE"),
            key_id: None,
            verify_only: Vec::new(),
        },
        clock: system_seconds,
        store,
        service_name: str_of("SERVICE_NAME"),
    })
}

fn failed(e: &db::StoreError) -> String {
    match &e.code {
        Some(code) => format!("{} [{code}]", e.message),
        None => e.message.clone(),
    }
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
    let out = serve(&env, &log, &telemetry);
    telemetry.shutdown();
    out
}

fn serve(env: &LedgerEnv, log: &Logger, telemetry: &Telemetry) -> Result<(), String> {
    let str_of = |k: &str| env.str(k).unwrap_or_default().to_owned();
    let pool_max = usize::try_from(env.int("DATABASE_POOL_MAX").unwrap_or(1)).unwrap_or(1);
    let store = db::open(
        &str_of("DATABASE_URL"),
        &str_of("SERVICE_NAME"),
        pool_max,
        env.flag("DATABASE_SSL"),
    )?;
    let tip = boot::chain_tip(&store).map_err(|e| failed(&e))?;
    // `JetStreamEventBus.connect({ ..., ownedStreams: ['ledger'] })`: a bus that cannot be reached stops the start.
    let bus = JetStream::connect(
        &str_of("NATS_URL"),
        &str_of("SERVICE_NAME"),
        Duration::from_secs(5),
    )
    .and_then(|js| {
        js.ensure_stream(&stream_config("ledger", &str_of("NATS_STREAM_PREFIX")))
            .map(|()| js)
    })
    .map_err(|e| e.0)?;
    let door = door(env, store)?;
    // Before the first request, never after: the custody guard, then the startup freeze (it can freeze, never thaw).
    boot::assert_custody_layer_bootable(
        door.store(),
        env.str("LEDGER_CUSTODY_LAYER") == Some("on"),
    )
    .map_err(|e| failed(&e))?;
    let freeze_at_boot =
        boot::apply_startup_policy(door.store(), env.flag("LEDGER_POSTING_ENABLED"))
            .map_err(|e| failed(&e))?;

    let relays = relays();
    // Outbox recovery is not inside the startup policy: that path only freezes. Committed, unsent intents drain here,
    // then on the timer below.
    if let Err(e) = boot::recover_outbox(door.store(), &relays) {
        log.error(
            vec![("err", Json::str(failed(&e)))],
            "ledger outbox recover at boot failed",
        );
    }

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
            ("chainSeq", Json::str(tip)),
            ("s2sTrpcPaths", Json::Bool(true)),
            ("frozen", Json::Bool(freeze_at_boot.frozen)),
            (
                "frozenBy",
                freeze_at_boot
                    .actor
                    .clone()
                    .map_or(Json::Null, Json::String),
            ),
        ],
        "svc-ledger ready",
    );
    // Loud, because a process that came up frozen looks like a healthy one in every graph but the one nobody watches.
    if freeze_at_boot.frozen {
        log.error(
            vec![
                (
                    "reason",
                    freeze_at_boot
                        .reason
                        .clone()
                        .map_or(Json::Null, Json::String),
                ),
                (
                    "actor",
                    freeze_at_boot
                        .actor
                        .clone()
                        .map_or(Json::Null, Json::String),
                ),
            ],
            "LEDGER POSTING IS FROZEN — no value can move",
        );
    }

    let stop = Arc::new(AtomicBool::new(false));
    for signal in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        signal_hook::flag::register(signal, stop.clone()).map_err(|e| e.to_string())?;
    }
    std::thread::scope(|scope| {
        let (store, stop, relays) = (app.wire.store(), &stop, &relays);
        scope.spawn(move || outbox_timer(store, relays, stop, log));
        server::serve(&server, &app, log, telemetry, stop);
    });
    drop(server);
    bus.close();
    app.wire.end();
    log.info(Vec::new(), "svc-ledger stopped");
    Ok(())
}

/// `setInterval(() => ledger.recoverUnpublishedOutbox(), OUTBOX_RECOVER_MS)`: a failed recovery is logged and the
/// next tick retries. One recovery at a time.
fn outbox_timer(store: &Store, relays: &[&dyn Relay], stop: &AtomicBool, log: &Logger) {
    let every = Duration::from_millis(OUTBOX_RECOVER_MS);
    let step = Duration::from_millis(200);
    loop {
        let started = Instant::now();
        while started.elapsed() < every {
            if stop.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(step.min(every.saturating_sub(started.elapsed())));
        }
        if let Err(e) = boot::recover_outbox(store, relays) {
            log.error(
                vec![("err", Json::str(failed(&e)))],
                "ledger outbox recover failed",
            );
        }
    }
}
