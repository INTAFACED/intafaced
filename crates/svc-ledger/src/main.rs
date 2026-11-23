//! The svc-ledger process: `svc-ledger` serves; `svc-ledger migrate [--down]` applies (or reverses) the ledger
//! schema's migrations.
//!
//! Serving starts as `services/svc-ledger/src/index.ts` does: the pool, the chain tip, the bus, the custody boot check
//! and the startup freeze, then the outbox recovery at boot and every five seconds, then the port. The TypeScript
//! service stays the one that runs until the switch; until each slice is ported its calls answer 503
//! `ledger.not_ported`. `post` is ported (the `posting` slice), and its outbox relay runs at boot and on the timer.

use std::collections::BTreeMap;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use service_kit::http::{Fetch, UreqFetch};
use service_kit::json::Json;
use service_kit::nats::{JetStream, stream_config};
use service_kit::s2s::{CallSigner, parse_keyring, s2s_from_env, system_seconds};
use service_kit::s2s_verify::{BodyBind, ServiceVerifier};
use service_kit::server::{self, App};
use service_kit::telemetry::{Logger, Telemetry};
use service_kit::tokens::TokenConfig;

use svc_ledger::approval::{self, Approvals};
use svc_ledger::boot::{self, OUTBOX_RECOVER_MS, Relay};
use svc_ledger::clock::system_ms;
use svc_ledger::controls::sources::{self, OpenItemsSource, Signer, Sources};
use svc_ledger::db::{self, Store};
use svc_ledger::door::{DoorConfig, Keys, LedgerDoor};
use svc_ledger::env::{self, DEFAULT_PORT, LedgerEnv};
use svc_ledger::freeze::{Bus, FreezeRelay, JetStreamBus};
use svc_ledger::migrate;
use svc_ledger::posting::engine::{Conflict, EngineOptions};
use svc_ledger::posting::{Posting, TxRelay};
use svc_ledger::reconcile::{self, CustodyLayer};
use svc_ledger::reconciler::{self, DEFAULT_MAX_CONSECUTIVE_INCOMPLETE, TickOptions, TickState};

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

/// The door, built once from the environment, as `index.ts` mounts its doors.
fn door(
    env: &LedgerEnv,
    store: Store,
    bus: Arc<dyn Bus>,
    fetch: Arc<dyn Fetch>,
    log: &Logger,
) -> Result<LedgerDoor, String> {
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
    let posting = Posting::new(
        bus.clone(),
        str_of("SERVICE_NAME"),
        env.str("LEDGER_CUSTODY_LAYER") == Some("on"),
        EngineOptions {
            conflict: if env.idempotency_conflict_mode == "refuse" {
                Conflict::Refuse
            } else {
                Conflict::Detect
            },
            clock_skew_bound_ms: env.clock_skew_bound_ms,
            clock_ms: system_ms,
        },
        keys.is_some(),
        Some(log.clone()),
    );
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
        bus,
        approvals: approvals(env, &s2s, fetch.clone()),
        clock_skew_bound_ms: env.clock_skew_bound_ms,
        now_ms: system_ms,
        log: log.clone(),
        custody: CustodyLayer::from_on(env.str("LEDGER_CUSTODY_LAYER") == Some("on")),
        reconcile_statement_timeout_ms: env
            .int("LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS")
            .unwrap_or(reconcile::DEFAULT_STATEMENT_TIMEOUT_MS),
        // `handleS2sPortfolio` reads `process.env.INDEXER_URL`; nothing in `env.ts` holds it.
        indexer_url: std::env::var("INDEXER_URL").ok(),
        reconciliation_sources: reconciliation_sources(env, s2s, fetch.clone()),
        // The same wire the approvals client uses.
        fetch,
        posting,
    })
}

/// `reconciliationSourcesFrom(LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL, railStatementUrls, fetch, undefined, { urls:
/// openItemsUrls, sign })`: a blank snapshot URL leaves an outside-balance control's outside side unset; a rail with an
/// open-items URL reads svc-pay's open items too, each call signed as svc-ledger for svc-pay.
fn reconciliation_sources(
    env: &LedgerEnv,
    s2s: service_kit::s2s::S2s,
    fetch: Arc<dyn Fetch>,
) -> Arc<dyn Sources> {
    let signer = CallSigner::new(
        "svc-ledger",
        "svc-pay",
        env.str("INTERNAL_SERVICE_SECRET").unwrap_or_default(),
        s2s.signer.zip(s2s.mode),
    );
    let sign: Signer = Arc::new(move |payload: &str, url: &str| {
        let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
        let target = match parsed.query() {
            Some(q) => format!("{}?{q}", parsed.path()),
            None => parsed.path().to_owned(),
        };
        signer.sign(payload, "POST", &target, "application/json")
    });
    let pairs =
        |m: &BTreeMap<String, String>| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    Arc::new(sources::Http {
        outside_snapshot_url: env
            .str("LEDGER_RECONCILE_OUTSIDE_SNAPSHOT_URL")
            .filter(|u| !u.is_empty())
            .map(str::to_owned),
        rail_statement_urls: pairs(&env.rail_statement_urls),
        fetch,
        timeout_ms: sources::OUTSIDE_SNAPSHOT_TIMEOUT_MS,
        open_items: Some(OpenItemsSource {
            urls: pairs(&env.open_items_urls),
            sign,
        }),
    })
}

/// `env.IDENTITY_URL ? createIdentityApprovalClient(IDENTITY_URL, INTERNAL_SERVICE_SECRET, s2sKey) :
/// unwiredApprovalConsumer()`: each consume signed by svc-ledger's own key when S2S gives it one, else by the shared
/// secret (#10112).
fn approvals(
    env: &LedgerEnv,
    s2s: &service_kit::s2s::S2s,
    fetch: Arc<dyn Fetch>,
) -> Box<dyn Approvals> {
    match env.str("IDENTITY_URL").filter(|u| !u.is_empty()) {
        Some(url) => Box::new(approval::Identity::new(
            url,
            env.str("INTERNAL_SERVICE_SECRET").unwrap_or_default(),
            s2s.signer.clone().zip(s2s.mode),
            fetch,
            system_seconds,
        )),
        None => Box::new(approval::Unwired),
    }
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
    let fetch_for_approvals = fetch.clone();
    let telemetry = Telemetry::start(
        env.flag("OTEL_ENABLED"),
        &str_of("SERVICE_NAME"),
        &str_of("OTEL_EXPORTER_OTLP_ENDPOINT"),
        &str_of("APP_ENV"),
        fetch,
        log.clone(),
    );
    let out = serve(&env, &log, &telemetry, fetch_for_approvals);
    telemetry.shutdown();
    out
}

fn serve(
    env: &LedgerEnv,
    log: &Logger,
    telemetry: &Telemetry,
    fetch: Arc<dyn Fetch>,
) -> Result<(), String> {
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
    let bus = Arc::new(JetStreamBus(bus));
    let door = door(env, store, bus.clone(), fetch, log)?;
    let freeze_relay = FreezeRelay {
        bus: &*bus,
        producer: str_of("SERVICE_NAME"),
        now_ms: system_ms,
    };
    // Before the first request, never after: the custody guard, then the startup freeze (it can freeze, never thaw).
    boot::assert_custody_layer_bootable(
        door.store(),
        env.str("LEDGER_CUSTODY_LAYER") == Some("on"),
    )
    .map_err(|e| failed(&e))?;
    let freeze_at_boot = boot::apply_startup_policy(
        door.store(),
        env.flag("LEDGER_POSTING_ENABLED"),
        &freeze_relay,
    )
    .map_err(|e| failed(&e))?;

    let app = App {
        wire: door,
        service_name: str_of("SERVICE_NAME"),
        ready_body: String::new(),
    };
    // The relays the outbox recovery drives: `ledgerFreezeUpdated` and `ledgerTxPosted`.
    let tx_relay = TxRelay(app.wire.posting());
    let relays: Vec<&dyn Relay> = vec![&freeze_relay, &tx_relay];
    // Outbox recovery is not inside the startup policy: that path only freezes. Committed, unsent intents drain here,
    // then on the timer below.
    if let Err(e) = boot::recover_outbox(app.wire.store(), &relays) {
        log.error(
            vec![("err", Json::str(failed(&e)))],
            "ledger outbox recover at boot failed",
        );
    }
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

    // `RECONCILE_CRON_MINUTES` is the owner's; blank refuses the start (the env check), never an invented cadence.
    let cron_minutes = env.int("RECONCILE_CRON_MINUTES").ok_or(
        "RECONCILE_CRON_MINUTES is required: the owner publishes the reconciliation cadence",
    )?;
    let tick_options = TickOptions {
        max_stale_hours: env.int("LEDGER_RECONCILE_MAX_STALE_HOURS"),
        max_consecutive_incomplete: env
            .int("RECONCILE_MAX_CONSECUTIVE_INCOMPLETE")
            .unwrap_or(DEFAULT_MAX_CONSECUTIVE_INCOMPLETE),
        now_ms: system_ms,
    };

    let stop = Arc::new(AtomicBool::new(false));
    for signal in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        signal_hook::flag::register(signal, stop.clone()).map_err(|e| e.to_string())?;
    }
    std::thread::scope(|scope| {
        let (store, stop, relays) = (app.wire.store(), &stop, &relays);
        scope.spawn(move || outbox_timer(store, relays, stop, log));
        let (door, tick_options) = (&app.wire, &tick_options);
        scope.spawn(move || reconcile_timer(door, cron_minutes, tick_options, stop, log));
        server::serve(&server, &app, log, telemetry, stop);
    });
    drop(server);
    bus.0.close();
    app.wire.end();
    log.info(Vec::new(), "svc-ledger stopped");
    Ok(())
}

/// `setInterval(() => ledger.recoverUnpublishedOutbox(), OUTBOX_RECOVER_MS)`: a failed recovery is logged and the
/// next tick retries. One recovery at a time.
fn outbox_timer(store: &Store, relays: &[&dyn Relay], stop: &AtomicBool, log: &Logger) {
    while wait(Duration::from_millis(OUTBOX_RECOVER_MS), stop) {
        if let Err(e) = boot::recover_outbox(store, relays) {
            log.error(
                vec![("err", Json::str(failed(&e)))],
                "ledger outbox recover failed",
            );
        }
    }
}

/// Sleeps `every`, in short steps so a stop is seen; false once the process is stopping.
fn wait(every: Duration, stop: &AtomicBool) -> bool {
    let step = Duration::from_millis(200);
    let started = Instant::now();
    while started.elapsed() < every {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        std::thread::sleep(step.min(every.saturating_sub(started.elapsed())));
    }
    true
}

/// `setInterval(() => runScheduledReconciliationTick(...), RECONCILE_CRON_MINUTES * 60_000)`: one state for the life of
/// the timer, so backoff spans ticks. A tick whose due freeze did not land is logged; the next one tries again. The
/// due-controls part of the tick is the `controls` slice's.
fn reconcile_timer(
    door: &LedgerDoor,
    cron_minutes: i64,
    options: &TickOptions,
    stop: &AtomicBool,
    log: &Logger,
) {
    let every = Duration::from_secs(u64::try_from(cron_minutes.max(1)).unwrap_or(1) * 60);
    let mut state = TickState::new(system_ms());
    let ledger = door.reconciler();
    while wait(every, stop) {
        if let Err(e) = reconciler::tick(
            &|| ledger.run_scheduled_default(),
            &ledger,
            log,
            &mut state,
            options,
        ) {
            log.log(
                "fatal",
                vec![("err", Json::str(failed(&e)))],
                "LEDGER RECONCILIATION TICK FAILED — a freeze that was due did not land",
            );
        }
    }
}

/// #10112: the approvals client `door` builds signs its consume with svc-ledger's own key under `S2S_AUTH_MODE=keypair`,
/// and svc-identity's verifier, keypair only, accepts it as svc-ledger's; with no key it signs with the shared secret.
#[cfg(test)]
mod approval_keys {
    #![allow(
        clippy::unwrap_used,
        clippy::indexing_slicing,
        reason = "a test: a failure is the point"
    )]
    use std::sync::Mutex;

    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use service_kit::approvals::ConsumeInput;
    use service_kit::http::{FetchError, HttpRequest, HttpResponse};
    use service_kit::s2s::Mode;
    use service_kit::s2s_verify::{Incoming, verify_request};

    use super::*;

    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<HttpRequest>>>);

    impl Fetch for Capture {
        fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
            self.0.lock().unwrap().push(req.clone());
            Ok(HttpResponse {
                status: 500,
                body: "{}".to_owned(),
            })
        }
    }

    const SECRET: &str = "placeholder-internal-service-secret-32chars";

    fn keyring() -> (String, String) {
        let seed = [7_u8; 32];
        let x = URL_SAFE_NO_PAD.encode(
            ed25519_dalek::SigningKey::from_bytes(&seed)
                .verifying_key()
                .as_bytes(),
        );
        let mut pkcs8 = vec![
            0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22,
            0x04, 0x20,
        ];
        pkcs8.extend_from_slice(&seed);
        (
            format!(
                r#"{{"keys":[{{"kid":"svc-ledger.a","svc":"svc-ledger","use":"s2s","x":"{x}"}}]}}"#
            ),
            URL_SAFE_NO_PAD.encode(pkcs8),
        )
    }

    fn env(keypair: bool) -> LedgerEnv {
        let (ring, key) = keyring();
        let mut pairs = vec![
            ("IDENTITY_URL", Json::str("http://127.0.0.1:4000")),
            ("INTERNAL_SERVICE_SECRET", Json::str(SECRET)),
        ];
        if !keypair {
            pairs.push(("S2S_AUTH_MODE", Json::str("off")));
        }
        if keypair {
            pairs.extend([
                ("S2S_AUTH_MODE", Json::str("keypair")),
                ("S2S_KEYRING", Json::String(ring)),
                ("S2S_SIGNING_KID", Json::str("svc-ledger.a")),
                ("S2S_SIGNING_KEY", Json::String(key)),
            ]);
        }
        LedgerEnv {
            json: Json::Object(pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()),
            clock_skew_bound_ms: None,
            idempotency_conflict_mode: "detect",
            rail_statement_urls: BTreeMap::new(),
            open_items_urls: BTreeMap::new(),
        }
    }

    /// The one request the client `door` would build sends, as it went on the wire.
    fn sent(env: &LedgerEnv) -> HttpRequest {
        let s2s = s2s_from_env(
            env.str("S2S_AUTH_MODE").unwrap_or_default(),
            env.str("S2S_KEYRING"),
            env.str("S2S_SIGNING_KID"),
            env.str("S2S_SIGNING_KEY"),
            "svc-ledger",
        )
        .unwrap();
        let capture = Capture::default();
        let client = approvals(env, &s2s, Arc::new(capture.clone()));
        assert!(
            client
                .consume(&ConsumeInput {
                    approval_id: "appr-1",
                    operation_id: "op-1",
                    payload_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                    target_service: "svc-ledger",
                    target_id: "posting_freeze",
                    expected_version: "2026-01-01T00:00:00.000000Z",
                    replay: None,
                })
                .is_err(),
            "a 500 is not an approval"
        );
        let sent = capture.0.lock().unwrap();
        assert_eq!(sent.len(), 1);
        sent[0].clone()
    }

    /// svc-identity's `verifyServiceRequest` fed the request exactly as sent.
    fn judged(req: &HttpRequest, mode: Mode) -> (Option<String>, Option<&'static str>) {
        let verifier = ServiceVerifier::new(
            "svc-identity",
            &parse_keyring(&keyring().0).unwrap(),
            system_seconds,
        )
        .unwrap()
        .with_boot_second(0);
        let target = req.url.strip_prefix("http://127.0.0.1:4000").unwrap();
        let auth = verify_request(
            &Incoming {
                method: &req.method,
                url: target,
                headers: &req.headers,
                body: req.body.as_deref().map(str::as_bytes),
            },
            Some(&verifier),
            Some(SECRET),
            mode,
            BodyBind::Require,
            system_seconds(),
        );
        (auth.service, auth.scheme)
    }

    #[test]
    fn under_keypair_the_consume_is_signed_by_svc_ledgers_own_key_and_identity_accepts_it() {
        let req = sent(&env(true));
        assert_eq!(
            judged(&req, Mode::Keypair),
            (Some("svc-ledger".to_owned()), Some("keypair"))
        );
    }

    #[test]
    fn with_no_key_the_consume_is_signed_by_the_shared_secret() {
        let req = sent(&env(false));
        assert_eq!(
            judged(&req, Mode::Dual),
            (Some("svc-ledger".to_owned()), Some("shared"))
        );
        assert_eq!(judged(&req, Mode::Keypair).1, None);
    }
}
