//! The svc-matching process, started as `services/svc-matching/src/index.ts` starts: the journal first, the bus, the
//! engine, the scrape and `/health`, the doors, then the cold start: replay the journal, confirm every resting order's
//! ledger hold, and only then listen. Then the expiry sweep; on SIGTERM or SIGINT, the drain.
//!
//! The TypeScript service stays the one that runs until the switch; until each slice is ported its calls answer 503
//! `matching.not_ported`, and a cold start stops on a journal holding what a later slice owns.

use std::collections::BTreeMap;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant as Clock, SystemTime, UNIX_EPOCH};

use service_kit::edge::EdgeKey;
use service_kit::http::{Fetch, UreqFetch};
use service_kit::json::Json;
use service_kit::nats::{JetStream, stream_config};
use service_kit::s2s::{CallSigner, parse_keyring, s2s_from_env, system_seconds};
use service_kit::s2s_verify::{BodyBind, ServiceVerifier};
use service_kit::server::{self, App};
use service_kit::telemetry::{Logger, Telemetry};

use svc_matching::bus::{JetStreamEvents, STREAM_SERVICE};
use svc_matching::door::{DoorConfig, Keys, MatchingDoor};
use svc_matching::engine::admission::EXPIRY_SWEEP_EVERY_MS;
use svc_matching::engine::{EngineParts, MatchingEngine};
use svc_matching::env::{self, DEFAULT_PORT, MatchingEnv};
use svc_matching::holds::{
    Boot, LedgerHolds, LedgerHttp, ReplayHoldLookup, UnwiredHolds, open_after_replay,
};
use svc_matching::journal::io::FileJournal;
use svc_matching::journal::replay::MemorySnapshotSink;

fn process_env() -> BTreeMap<String, String> {
    std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect()
}

/// Milliseconds since the epoch.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<ExitCode, String> {
    // A write past `RLIMIT_FSIZE` must come back as a short write the journal refuses, as it does under Node, not end
    // the process with `SIGXFSZ` (`PORT.md`, the journal slice).
    signal_hook::flag::register(
        signal_hook::consts::SIGXFSZ,
        Arc::new(AtomicBool::new(false)),
    )
    .map_err(|e| e.to_string())?;
    let env = env::load(&process_env()).map_err(|e| e.message)?;
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
    let out = serve(&env, &log, &telemetry, fetch);
    telemetry.shutdown();
    out
}

/// The per-service keys, when `S2S_AUTH_MODE` turns them on: the signer for outgoing calls and the verifier.
struct S2sParts {
    signer: Option<(Arc<service_kit::s2s::ServiceSigner>, service_kit::s2s::Mode)>,
    keys: Option<Keys>,
}

fn s2s(env: &MatchingEnv) -> Result<S2sParts, String> {
    let keyring = env.str("S2S_KEYRING");
    let s2s = s2s_from_env(
        env.str("S2S_AUTH_MODE").unwrap_or("off"),
        keyring,
        env.str("S2S_SIGNING_KID"),
        env.str("S2S_SIGNING_KEY"),
        "svc-matching",
    )?;
    let keys = match (s2s.mode, keyring) {
        (Some(mode), Some(ring)) => Some(Keys {
            verifier: ServiceVerifier::new("svc-matching", &parse_keyring(ring)?, system_seconds)?,
            mode,
        }),
        _ => None,
    };
    Ok(S2sParts {
        signer: s2s.signer.zip(s2s.mode),
        keys,
    })
}

#[expect(
    clippy::too_many_lines,
    reason = "the boot in `index.ts`'s order, step by step"
)]
fn serve(
    env: &MatchingEnv,
    log: &Logger,
    telemetry: &Telemetry,
    fetch: Arc<dyn Fetch>,
) -> Result<ExitCode, String> {
    let str_of = |k: &str| env.str(k).unwrap_or_default().to_owned();
    let service = str_of("SERVICE_NAME");

    // The journal comes first: the books are replayed from it before anything can reach a port.
    let path = std::path::PathBuf::from(str_of("MATCHING_JOURNAL_PATH"));
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let journal = FileJournal::open(&path).map_err(|e| e.to_string())?;

    // `JetStreamEventBus.connect({ ..., ownedStreams: ['matching'] })`: a bus that cannot be reached stops the start.
    let js = JetStream::connect(&str_of("NATS_URL"), &service, Duration::from_secs(5))
        .and_then(|js| {
            js.ensure_stream(&stream_config(
                STREAM_SERVICE,
                &str_of("NATS_STREAM_PREFIX"),
            ))
            .map(|()| js)
        })
        .map_err(|e| e.0)?;
    let js = Arc::new(js);

    let engine = MatchingEngine::new(EngineParts {
        journal: Box::new(journal),
        bus: Box::new(JetStreamEvents {
            js: js.clone(),
            producer: service.clone(),
            clock: now_ms,
        }),
        clock: now_ms,
        expiry_clock: true,
        snapshot_every: u64::try_from(env.int("MATCHING_SNAPSHOT_EVERY").unwrap_or(0)).unwrap_or(0),
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: env.flag("MATCHING_ENGINE_ENABLED"),
        // `spreadFillPublisherFor(bus)`: spread fills go out on the same bus, as `matching.spread.filled`.
        spread_fills: true,
    });

    let keys = s2s(env)?;
    let edge_key = match env.str("EDGE_PRINCIPAL_PUBLIC_KEY") {
        None => None,
        Some(key) => Some(EdgeKey::from_env(
            &service,
            key,
            env.int("EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS"),
            env.int("EDGE_PRINCIPAL_CLOCK_SKEW_SECONDS"),
        )?),
    };
    let door = MatchingDoor::new(
        DoorConfig {
            internal_secret: str_of("INTERNAL_SERVICE_SECRET"),
            // Order writes are money instructions: an unbound v1 signature is refused whatever the fleet default.
            body_bind: BodyBind::Require,
            keys: keys.keys,
            edge_secret: env.str("EDGE_PRINCIPAL_SECRET").map(str::to_owned),
            edge_key,
            clock: now_ms,
            // `createIdentityApprovalClient(IDENTITY_URL, INTERNAL_SERVICE_SECRET, s2sKey)`, or the unwired consumer,
            // which refuses every spend.
            approvals: match env.str("IDENTITY_URL") {
                Some(url) => Box::new(svc_matching::approval::Identity::new(
                    url,
                    &str_of("INTERNAL_SERVICE_SECRET"),
                    keys.signer.clone(),
                    fetch.clone(),
                    || now_ms().div_euclid(1000),
                )),
                None => Box::new(svc_matching::approval::Unwired),
            },
            operator_ids: env.operator_ids(),
        },
        engine,
    )?
    .with_service_name(&service);

    let mut holds: Box<dyn ReplayHoldLookup> = match env.str("LEDGER_URL") {
        Some(url) => Box::new(LedgerHolds::new(LedgerHttp {
            base_url: url.to_owned(),
            signer: CallSigner::new(
                "svc-matching",
                "svc-ledger",
                &str_of("INTERNAL_SERVICE_SECRET"),
                keys.signer,
            ),
            fetch,
        })),
        None => Box::new(UnwiredHolds),
    };

    let port_number = env.int("HTTP_PORT").unwrap_or(DEFAULT_PORT);
    let port = u16::try_from(port_number)
        .map_err(|_| format!("options.port should be >= 0 and < 65536. Received {port_number}."))?;
    // Replay, confirm holds, then listen. A startup publish that keeps timing out exits here, before listen: not a
    // half-started engine. A hold service that cannot be asked still listens, with /ready 503 and the reason on
    // /health, and submit refuses. The book does not open.
    let mut server = None;
    let boot = {
        let mut engine = door.engine();
        open_after_replay(&mut engine, holds.as_mut(), &mut || {
            server = Some(
                tiny_http::Server::http((str_of("HTTP_HOST").as_str(), port))
                    .map_err(|e| e.to_string())?,
            );
            Ok(())
        })?
    };
    let (recovered, gate) = match boot {
        Boot::Exit { message } => {
            log.error(Vec::new(), &message);
            eprintln!("{message}");
            // The bus is why we are leaving; the journal closes with the engine.
            js.close();
            drop(door);
            return Ok(ExitCode::FAILURE);
        }
        Boot::Open { recovered, gate } => (recovered, gate),
    };
    let Some(server) = server else {
        return Err("svc-matching did not listen".to_owned());
    };
    let resting = door.engine().resting_order_count();
    let n = |v: usize| Json::int(i64::try_from(v).unwrap_or(i64::MAX));
    log.info(
        vec![
            ("port", Json::int(i64::from(port))),
            ("records", n(recovered.records)),
            ("markets", n(recovered.markets)),
            ("restingOrders", n(resting)),
            ("holdCheck", gate.to_json()),
        ],
        if gate.open {
            "svc-matching ready — books replayed from journal"
        } else {
            "svc-matching up — replay hold check failed closed, market stays closed"
        },
    );
    if !gate.open {
        log.error(
            vec![
                ("reason", Json::str(gate.reason.unwrap_or_default())),
                ("restingOrders", n(resting)),
            ],
            "replayed resting orders were not confirmed against ledger holds — market stays closed",
        );
    } else if !gate.pulled.is_empty() || !gate.halted.is_empty() {
        let j = gate.to_json();
        log.warn(
            vec![
                ("pulled", j.get("pulled").cloned().unwrap_or(Json::Null)),
                ("halted", j.get("halted").cloned().unwrap_or(Json::Null)),
            ],
            "replayed orders whose holds were missing, short, or unreadable were pulled or their markets halted",
        );
    }

    let stop = Arc::new(AtomicBool::new(false));
    for signal in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        signal_hook::flag::register(signal, stop.clone()).map_err(|e| e.to_string())?;
    }
    let app = App {
        wire: door,
        service_name: service,
        ready_body: String::new(),
    };
    std::thread::scope(|scope| {
        // GTD and GTT rests leave at their expiry even in a quiet market, one pass at a time. On a signal the engine is
        // disabled first, so nothing more is admitted or swept while the doors drain.
        let (app, stop) = (&app, &stop);
        scope.spawn(move || {
            let mut last = Clock::now();
            while !stop.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(50));
                if last.elapsed() < Duration::from_millis(EXPIRY_SWEEP_EVERY_MS) {
                    continue;
                }
                last = Clock::now();
                if let Err(e) = app.wire.engine().expiry_tick() {
                    log.error(
                        vec![("err", Json::str(e.to_string()))],
                        "expiry sweep pass failed; the next pass retries",
                    );
                }
            }
            app.wire.engine().set_enabled(false);
        });
        server::serve(&server, app, log, telemetry, stop);
    });
    // Drain rather than drop: in-flight requests finish, then the listener, the bus and the journal (its descriptor and
    // its writer lock, released with the engine) close before the process exits.
    app.wire.engine().set_enabled(false);
    drop(server);
    js.close();
    drop(app);
    log.info(Vec::new(), "svc-matching stopped");
    Ok(ExitCode::SUCCESS)
}
