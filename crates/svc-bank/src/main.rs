//! The svc-bank process: `svc-bank` serves; `svc-bank migrate [--down]` applies (or reverses) the bank schema's
//! migrations.
//!
//! Serving starts as `services/svc-bank/src/index.ts` does, as far as the ported slices reach: the pool, the schema
//! check, the bus (`ownedStreams: ['bank']`), the door, the port, then the timers. The TypeScript service stays the
//! one that runs until the switch; until each slice is ported its calls answer "not ported" (500), and a timer or
//! recovery job whose work is not ported does not run.

use std::collections::BTreeMap;
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use service_kit::edge::{EdgeKey, MIN_SECRET_LENGTH};
use service_kit::http::{Fetch, UreqFetch};
use service_kit::json::Json;
use service_kit::nats::{JetStream, stream_config};
use service_kit::s2s::{CallSigner, parse_keyring, s2s_from_env, system_seconds};
use service_kit::s2s_verify::{BodyBind, ServiceVerifier};
use service_kit::server::{self, App};
use service_kit::telemetry::{Logger, Telemetry};

use svc_bank::db::{self, Store};
use svc_bank::door::{BankDoor, DoorConfig, ServiceAuth, system_now};
use svc_bank::earn;
use svc_bank::env::{self, BankEnv, DEFAULT_PORT};
use svc_bank::loans;
use svc_bank::migrate;
use svc_bank::partner::custody::LedgerFreeze;
use svc_bank::partner::router::Wiring;
use svc_bank::partner::{TestPartner, cash_leg, pay_in};
use svc_bank::ready;
use svc_bank::recovery::{self, AdvisoryLock, RecoveryCounts};
use svc_bank::spaces;
use svc_bank::spaces::ports::{DirectoryHttp, LedgerHttp, Lookups, NoDirectory};
use svc_bank::test_age;
use svc_bank::timers::{self, Timer};
use svc_bank::transfers;
use svc_bank::transfers::ports::{IdentityHttp, JetStreamBus, NoIdentity};

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
fn jobs<'a>(door: &'a BankDoor, _env: &'a BankEnv) -> Vec<(&'static str, Job<'a>)> {
    let mut out: Vec<(&'static str, Job<'a>)> = Vec::new();
    // Slice `partner`: the TEST partner watches its TEST pay-in addresses, one pass at a time.
    let wiring = door.partner();
    if let (Some(partner), Some(rail)) = (wiring.partner.as_ref(), wiring.pay_in.as_ref()) {
        out.push((
            "TEST pay-in chain poll",
            Box::new(move || rail.poll(partner, || door.now())),
        ));
    }
    out
}

/// Slice `partner`'s wiring, in `index.ts`'s order: the TEST partner (`testPartnerFor`, the raw `APP_ENV` and
/// `NODE_ENV`), its pay-in rail, svc-ledger's posting freeze and the TEST cash leg. Each refuses to start as the
/// TypeScript does.
fn partner_wiring(env: &BankEnv) -> Result<Wiring, String> {
    let raw = |k: &str| env.raw.get(k).map(String::as_str);
    let partner = TestPartner::for_setting(
        env.str("BANK_TEST_PARTNER").unwrap_or("off"),
        raw("APP_ENV"),
        raw("NODE_ENV"),
    )?;
    let pay_in = pay_in::for_stack(
        partner.is_some(),
        env.str("BANK_TEST_PAY_IN_RPC_URL"),
        env.str("BANK_TEST_PAY_IN_CHAIN_ID"),
        env.str("BANK_TEST_PAY_IN_TOKEN"),
        Box::new(UreqFetch::new()),
    )?;
    let cash_legs = cash_leg::for_stack(
        env.str("BANK_TEST_CASH_LEG_RATES"),
        env.str("BANK_TEST_CASH_LEG_VENUE_URL"),
        partner.is_some(),
        raw("APP_ENV"),
        raw("NODE_ENV"),
        Box::new(UreqFetch::new()),
    )?;
    Ok(Wiring {
        partner,
        freeze: Box::new(LedgerFreeze {
            url: env.str("LEDGER_URL").unwrap_or_default().to_owned(),
            fetch: Box::new(UreqFetch::new()),
        }),
        custody_layer: env.str("LEDGER_CUSTODY_LAYER").unwrap_or("off").to_owned(),
        cash_legs,
        pay_in,
    })
}

/// Slice `spaces`'s wiring (`index.ts`): svc-ledger's balance and asset reads, svc-identity's business directory
/// (none without `IDENTITY_URL`, so every lookup refuses), each signed as svc-bank, and the owner's values as published.
fn spaces_wiring(env: &BankEnv) -> Result<spaces::Wiring, String> {
    let s2s = s2s_from_env(
        env.str("S2S_AUTH_MODE").unwrap_or("off"),
        env.str("S2S_KEYRING"),
        env.str("S2S_SIGNING_KID"),
        env.str("S2S_SIGNING_KEY"),
        "svc-bank",
    )?;
    let keyed = match (s2s.signer, s2s.mode) {
        (Some(signer), Some(mode)) => Some((signer, mode)),
        _ => None,
    };
    let secret = env
        .str("INTERNAL_SERVICE_SECRET")
        .unwrap_or_default()
        .to_owned();
    let signer = |audience: &str| CallSigner::new("svc-bank", audience, &secret, keyed.clone());
    let owned = |k: &str| env.raw.get(k).cloned();
    let card = ready::card_programme(env.str("BANK_CARD_ISSUER").unwrap_or("none"));
    Ok(spaces::Wiring {
        ledger: Box::new(LedgerHttp::new(
            env.str("LEDGER_URL").unwrap_or_default(),
            signer("svc-ledger"),
            Box::new(UreqFetch::new()),
        )),
        directory: match env.str("IDENTITY_URL") {
            Some(url) => Box::new(DirectoryHttp::new(
                url,
                signer("svc-identity"),
                Box::new(UreqFetch::new()),
            )),
            None => Box::new(NoDirectory),
        },
        lookups: Lookups::default(),
        rules: spaces::space::Rules {
            space_limit: owned("BANK_SPACE_LIMIT"),
            unlock_wait_hours: owned("BANK_SPACE_UNLOCK_WAIT_HOURS"),
        },
        terms: spaces::shared::Terms {
            invite_minutes: owned("BANK_SHARED_POT_INVITE_MINUTES"),
            people_cap: owned("BANK_SHARED_POT_PEOPLE_CAP"),
            card_programme: (
                match card.get("id") {
                    Some(Json::String(id)) => id.clone(),
                    _ => "none".to_owned(),
                },
                card.get("simulated") == Some(&Json::Bool(true)),
            ),
        },
        tables: spaces::Tables {
            account_terms: owned("BANK_ACCOUNT_TERMS_JSON"),
            currencies: owned("BANK_ACCOUNT_CURRENCIES"),
            plans: owned("BANK_PLANS_JSON"),
            fees: owned("BANK_FEE_SCHEDULE_JSON"),
            dormancy: owned("BANK_DORMANCY_RULES_JSON"),
        },
    })
}

/// Slice `transfers`'s wiring (`index.ts`): svc-identity's recipient state, security lock, handles and extra checks and
/// its approvals (none without `IDENTITY_URL`, so each refuses as unset), the bus for the slice's notices, and the owner's
/// values as published.
fn transfers_wiring(env: &BankEnv, bus: &Arc<JetStream>) -> Result<transfers::Wiring, String> {
    let s2s = s2s_from_env(
        env.str("S2S_AUTH_MODE").unwrap_or("off"),
        env.str("S2S_KEYRING"),
        env.str("S2S_SIGNING_KID"),
        env.str("S2S_SIGNING_KEY"),
        "svc-bank",
    )?;
    let keyed = match (s2s.signer, s2s.mode) {
        (Some(signer), Some(mode)) => Some((signer, mode)),
        _ => None,
    };
    let secret = env
        .str("INTERNAL_SERVICE_SECRET")
        .unwrap_or_default()
        .to_owned();
    let identity = |url: &str| {
        IdentityHttp::new(
            url,
            CallSigner::new("svc-bank", "svc-identity", &secret, keyed.clone()),
            Box::new(UreqFetch::new()),
        )
    };
    let owned = |k: &str| env.raw.get(k).cloned().filter(|v| !v.trim().is_empty());
    let settings = transfers::Settings {
        send_review: owned("BANK_PERSONAL_SEND_REVIEW_JSON"),
        remind_policy: owned("BANK_REQUEST_REMIND_POLICY_JSON"),
        stranger_hold_days: env
            .str("BANK_STRANGER_HOLD_DAYS")
            .and_then(|d| d.trim().parse().ok()),
        schedule_edit_cutoff: owned("BANK_SCHEDULE_EDIT_CUTOFF_MINUTES"),
        step_up_required: env.str("BANK_STEP_UP_MONEY_OUT") == Some("required"),
        blocked_region_notice: owned("BANK_BLOCKED_REGION_NOTICE"),
        scheduled_transfers: env.flag("SCHEDULED_TRANSFERS_ENABLED").unwrap_or(false),
        batch_size: env.int("TRANSFER_BATCH_SIZE"),
        producer: env.str("SERVICE_NAME").unwrap_or("svc-bank").to_owned(),
    };
    let bus: Box<dyn transfers::ports::Bus> = Box::new(JetStreamBus(bus.clone()));
    Ok(match env.str("IDENTITY_URL") {
        Some(url) => transfers::Wiring {
            recipients: Box::new(identity(url)),
            lock: Box::new(identity(url)),
            handles: Some(Box::new(identity(url))),
            extras: Box::new(identity(url)),
            approvals: Box::new(service_kit::approvals::IdentityClient::new(
                "svc-bank",
                url,
                &secret,
                Arc::new(UreqFetch::new()),
                system_seconds,
            )),
            bus,
            settings,
        },
        None => transfers::Wiring {
            recipients: Box::new(NoIdentity),
            lock: Box::new(NoIdentity),
            handles: None,
            extras: Box::new(NoIdentity),
            approvals: Box::new(transfers::NoApprovals),
            bus,
            settings,
        },
    })
}

/// A pass's rows as the timer counts them: `completed`, or `failed` when the row stays owed.
fn outcomes(rows: Vec<Result<(), String>>) -> Vec<String> {
    rows.into_iter()
        .map(|r| if r.is_ok() { "completed" } else { "failed" }.to_owned())
        .collect()
}

/// The recovery jobs whose work is ported, in `recovery::JOBS`' order. Each comes with its slice.
fn recovery_jobs<'a>(
    door: &'a BankDoor,
    _env: &'a BankEnv,
) -> Vec<(&'static str, recovery::Job<'a>)> {
    let loan_outcomes = |rows: Vec<loans::service::Resumed>| -> Vec<String> {
        rows.into_iter().map(|r| r.outcome.to_owned()).collect()
    };
    vec![
        (
            "bank.recovery.resume_pending_loans",
            Box::new(move |batch| {
                let now = door.now();
                door.loans_deps(now, |d| {
                    loans::service::resume_pending(d, Some(f64::from(batch)))
                        .map(loan_outcomes)
                        .map_err(|e| format!("{e:?}"))
                })
            }),
        ),
        (
            "bank.recovery.recover_loan_repayments",
            Box::new(move |batch| {
                let now = door.now();
                door.loans_deps(now, |d| {
                    loans::service::recover_repayments(d, Some(f64::from(batch)))
                        .map(loan_outcomes)
                        .map_err(|e| format!("{e:?}"))
                })
            }),
        ),
        (
            "bank.recovery.resume_pending_earn",
            Box::new(move |batch| {
                let now = door.now();
                door.earn_deps(now, |d| {
                    earn::service::resume_pending(d, Some(f64::from(batch)))
                        .map(|rows| rows.into_iter().map(|r| r.outcome.to_owned()).collect())
                        .map_err(|e| format!("{e:?}"))
                })
            }),
        ),
        (
            "bank.recovery.announce_posted_transfers",
            Box::new(move |batch| {
                door.transfers_deps(|d| {
                    transfers::personal::announce_unannounced(d, i64::from(batch))
                        .map(outcomes)
                        .map_err(|e| format!("{e:?}"))
                })
            }),
        ),
        (
            "bank.recovery.sweep_received_holds",
            Box::new(move |batch| {
                door.transfers_deps(|d| Ok(outcomes(transfers::holds::sweep(d, i64::from(batch)))))
            }),
        ),
    ]
}

/// The recovery timer's log lines, as `index.ts` writes them.
struct RecoveryLog<'a>(&'a Logger);

impl recovery::Hooks for RecoveryLog<'_> {
    fn result(&self, job: &str, c: RecoveryCounts) {
        let n = |v: usize| Json::int(i64::try_from(v).unwrap_or(i64::MAX));
        self.0.info(
            vec![
                ("job", Json::str(job)),
                ("scanned", n(c.scanned)),
                ("resolved", n(c.resolved)),
                ("stillUnknown", n(c.still_unknown)),
            ],
            "bank recovery job",
        );
    }

    fn error(&self, job: &str, err: &str) {
        self.0.error(
            vec![("err", Json::str(err)), ("job", Json::str(job))],
            "bank recovery job tick failed",
        );
    }

    fn skip(&self, message: &str) {
        self.0.info(Vec::new(), message);
    }
}

/// The service checks `index.ts` builds: the shared secret when it is long enough, the keys when S2S is on, and the
/// tRPC door's body binding.
fn service_auth(env: &BankEnv) -> Result<ServiceAuth, String> {
    let str_of = |k: &str| env.str(k).unwrap_or_default().to_owned();
    let keyring = env.str("S2S_KEYRING");
    let s2s = s2s_from_env(
        &str_of("S2S_AUTH_MODE"),
        keyring,
        env.str("S2S_SIGNING_KID"),
        env.str("S2S_SIGNING_KEY"),
        "svc-bank",
    )?;
    let keys = match (s2s.mode, keyring) {
        (Some(mode), Some(ring)) => Some((
            ServiceVerifier::new("svc-bank", &parse_keyring(ring)?, system_seconds)?,
            mode,
        )),
        _ => None,
    };
    let secret = str_of("INTERNAL_SERVICE_SECRET");
    Ok(ServiceAuth {
        secret: (secret.chars().count() >= MIN_SECRET_LENGTH).then_some(secret),
        keys,
        trpc_bind: if str_of("INTERNAL_SERVICE_BODY_BIND") == "accept-both" {
            BodyBind::AcceptBoth
        } else {
            BodyBind::Require
        },
    })
}

/// Slice `loans`'s wiring (`index.ts`'s `loans` options): svc-trade's ticker for marks, the platform's market maker as
/// the venue, svc-identity's affiliate legs (none without `IDENTITY_URL`), margin calls on the bus, and the owner's
/// values as published. The statement is signed with the activity cursor's secret, as the TypeScript composes it.
fn loans_wiring(env: &BankEnv) -> Result<loans::Wiring, String> {
    let s2s = s2s_from_env(
        env.str("S2S_AUTH_MODE").unwrap_or("off"),
        env.str("S2S_KEYRING"),
        env.str("S2S_SIGNING_KID"),
        env.str("S2S_SIGNING_KEY"),
        "svc-bank",
    )?;
    let keyed = match (s2s.signer, s2s.mode) {
        (Some(signer), Some(mode)) => Some((signer, mode)),
        _ => None,
    };
    let secret = env
        .str("INTERNAL_SERVICE_SECRET")
        .unwrap_or_default()
        .to_owned();
    let owned = |k: &str| env.raw.get(k).cloned();
    #[allow(clippy::cast_precision_loss, reason = "a batch size of at most 10000")]
    let sweep_batch = env.int("LOAN_SWEEP_BATCH_SIZE").map(|b| b as f64);
    Ok(loans::Wiring {
        settings: loans::ports::Settings {
            module_enabled: env.flag("BANK_LOANS_ENABLED").unwrap_or(true),
            accrual_enabled: env.flag("LOAN_ACCRUAL_ENABLED").unwrap_or(true),
            risk_sweep_enabled: env.flag("LOAN_RISK_SWEEP_ENABLED").unwrap_or(false),
            sweep_batch,
            payoff_fee: owned("BANK_LOAN_PAYOFF_FEE"),
            origination_fee_bps: owned("BANK_LOAN_ORIGINATION_FEE_BPS"),
            payoff_window_minutes: owned("BANK_LOAN_PAYOFF_WINDOW_MINUTES"),
            statement_secret: Some(secret.clone()),
            ..loans::ports::Settings::default()
        },
        prices: Box::new(loans::prices::TickerPriceSource::new(
            env.str("TRADE_URL").unwrap_or("http://localhost:4004"),
            Box::new(UreqFetch::new()),
            None,
            Box::new(system_now),
        )),
        venue: Box::new(loans::ports::MarketMaker),
        affiliates: match env.str("IDENTITY_URL") {
            Some(url) => Box::new(loans::ports::AffiliatesHttp::new(
                url,
                CallSigner::new("svc-bank", "svc-identity", &secret, keyed),
                Box::new(UreqFetch::new()),
            )),
            None => Box::new(loans::ports::NoAffiliates),
        },
        publish_margin_calls: true,
    })
}

/// Slice `earn`'s owner values (`index.ts`): the asset svc-token stakes, the staking risk wording as published, and
/// whether interest accrues.
fn earn_settings(env: &BankEnv) -> earn::Settings {
    earn::Settings {
        native_asset_id: env.str("TOKEN_ASSET_ID").unwrap_or("IFC").to_owned(),
        risk_wording: env
            .raw
            .get("BANK_EARN_RISK_WORDING_JSON")
            .cloned()
            .filter(|v| !v.trim().is_empty()),
        interest_accrual: env.flag("INTEREST_ACCRUAL_ENABLED").unwrap_or(true),
    }
}

/// The door, built once from the environment, with the store.
fn door(env: &BankEnv, store: Store, bus: &Arc<JetStream>) -> Result<BankDoor, String> {
    let str_of = |k: &str| env.str(k).unwrap_or_default().to_owned();
    let raw = |k: &str| env.raw.get(k).map(String::as_str);
    let test_age = test_age::open(raw(test_age::ENV), raw("APP_ENV"), raw("NODE_ENV"))?;
    let partner = partner_wiring(env)?;
    let spaces = spaces_wiring(env)?;
    let transfers = transfers_wiring(env, bus)?;
    let door = BankDoor::new(DoorConfig {
        edge_secret: str_of("EDGE_PRINCIPAL_SECRET"),
        services: service_auth(env)?,
        env: env.raw.clone(),
        now: system_now,
        store,
    })?
    .with_test_age(test_age)
    .with_partner(partner)
    .with_spaces(spaces)
    .with_transfers(transfers)
    .with_earn(earn_settings(env))
    .with_loans(loans_wiring(env)?);
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
        fetch,
        log.clone(),
    );
    let out = serve(&env, &log, &telemetry);
    telemetry.shutdown();
    out
}

#[expect(
    clippy::too_many_lines,
    reason = "the boot, in index.ts's order, reads best as one sequence"
)]
fn serve(env: &BankEnv, log: &Logger, telemetry: &Telemetry) -> Result<(), String> {
    let str_of = |k: &str| env.str(k).unwrap_or_default().to_owned();
    let ssl = env.flag("DATABASE_SSL").unwrap_or(false);
    let pool_max = usize::try_from(env.int("DATABASE_POOL_MAX").unwrap_or(1)).unwrap_or(1);
    let store = db::open(
        &str_of("DATABASE_URL"),
        &str_of("SERVICE_NAME"),
        pool_max,
        ssl,
    )?;
    db::check_schema(&store)?;
    // `JetStreamEventBus.connect({ ..., ownedStreams: ['bank'] })`: a bus that cannot be reached stops the start.
    let bus = JetStream::connect(
        &str_of("NATS_URL"),
        &str_of("SERVICE_NAME"),
        Duration::from_secs(5),
    )
    .and_then(|js| {
        js.ensure_stream(&stream_config("bank", &str_of("NATS_STREAM_PREFIX")))
            .map(|()| js)
    })
    .map_err(|e| e.0)?;
    let ready_body = ready::body(env);
    let bus = Arc::new(bus);
    let door = door(env, store, &bus)?;

    let app = App {
        wire: door,
        service_name: str_of("SERVICE_NAME"),
        ready_body: ready_body.compact(),
    };
    let port_number = env.int("HTTP_PORT").unwrap_or(DEFAULT_PORT);
    let port = u16::try_from(port_number)
        .map_err(|_| format!("options.port should be >= 0 and < 65536. Received {port_number}."))?;
    let server =
        tiny_http::Server::http((str_of("HTTP_HOST").as_str(), port)).map_err(|e| e.to_string())?;

    // The recovery jobs: off with a warning when a value is blank, and only the ported jobs run.
    let recovery_config = recovery::config(env);
    if let Err(warning) = recovery_config {
        log.warn(Vec::new(), warning);
    }
    let recovery = recovery_jobs(&app.wire, env);
    for (name, slice) in recovery::JOBS {
        if recovery_config.is_ok() && !recovery.iter().any(|(n, _)| *n == name) {
            log.warn(
                vec![("job", Json::str(name)), ("slice", Json::str(slice.name()))],
                "svc-bank recovery job not started: its slice is not ported",
            );
        }
    }
    let recovery_lock = match recovery_config {
        Ok(_) if !recovery.is_empty() => Some(AdvisoryLock(db::open_lock(
            &str_of("DATABASE_URL"),
            &str_of("SERVICE_NAME"),
            ssl,
        )?)),
        _ => None,
    };

    let table = timers::timers(env);
    let jobs = jobs(&app.wire, env);
    for t in table.iter().filter(|t| t.every.is_some()) {
        if !jobs.iter().any(|(name, _)| *name == t.name) {
            log.warn(
                vec![
                    ("timer", Json::str(t.name)),
                    ("slice", Json::str(t.slice.name())),
                ],
                "svc-bank timer not started: its slice is not ported",
            );
        }
    }

    if env.str("IDENTITY_URL").is_none() {
        log.warn(
            Vec::new(),
            "IDENTITY_URL is unset: svc-bank cannot check whether a recipient is frozen or closed, so every payment to ANOTHER user refuses (bank.recipient_check_unset). Moves between your own spaces still work.",
        );
    }
    if str_of("BANK_STEP_UP_MONEY_OUT") == "required" && env.str("IDENTITY_URL").is_none() {
        log.warn(
            Vec::new(),
            "BANK_STEP_UP_MONEY_OUT=required but IDENTITY_URL is unset: svc-bank cannot confirm step-up approvals, so every send to another person, business payment and card unfreeze/issue refuses (bank.step_up_unavailable).",
        );
    }
    let card = ready_body
        .get("cardProgramme")
        .cloned()
        .unwrap_or(Json::Null);
    let ramp = ready_body
        .get("rampProgramme")
        .cloned()
        .unwrap_or(Json::Null);
    let field = |j: &Json, k: &str| j.get(k).cloned().unwrap_or(Json::Null);
    log.info(
        vec![
            ("port", Json::int(i64::from(port))),
            (
                "scheduledTransfers",
                field(&ready_body, "scheduledTransfers"),
            ),
            ("interestAccrual", field(&ready_body, "interestAccrual")),
            ("autoInvest", field(&ready_body, "autoInvest")),
            (
                "stepUpMoneyOut",
                Json::str(str_of("BANK_STEP_UP_MONEY_OUT")),
            ),
            ("cardProgramme", field(&card, "id")),
            ("cardProgrammeSimulated", field(&card, "simulated")),
            ("rampProgramme", field(&ramp, "id")),
            ("rampProgrammeSimulated", field(&ramp, "simulated")),
            ("rampFiatLeg", field(&ramp, "fiatLeg")),
            ("rampFiatVia", field(&ramp, "fiatVia")),
            ("recoveryJobs", Json::Bool(recovery_lock.is_some())),
            ("statementJobs", Json::Bool(false)),
        ],
        "svc-bank ready",
    );

    let stop = Arc::new(AtomicBool::new(false));
    for signal in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        signal_hook::flag::register(signal, stop.clone()).map_err(|e| e.to_string())?;
    }
    std::thread::scope(|scope| {
        if let (Ok(config), Some(lock)) = (recovery_config, &recovery_lock) {
            let stop = &stop;
            let recovery = &recovery;
            scope.spawn(move || {
                recovery::run(config, stop, lock, recovery, &RecoveryLog(log));
            });
        }
        for (name, job) in &jobs {
            let Some(Timer {
                every: Some(period),
                ..
            }) = table.iter().find(|t| t.name == *name).cloned()
            else {
                continue;
            };
            let stop = &stop;
            scope.spawn(move || {
                timers::every(period, stop, job.as_ref(), &|e| {
                    log.warn(
                        vec![("timer", Json::str(*name)), ("err", Json::str(e))],
                        "svc-bank timer run failed; the next tick retries",
                    );
                });
            });
        }
        server::serve(&server, &app, log, telemetry, &stop);
    });
    // Draining, not dropping: in-flight requests and timer runs finish before the bus and the pools close.
    drop(server);
    bus.close();
    if let Some(AdvisoryLock(pool)) = &recovery_lock {
        pool.end();
    }
    app.wire.end();
    log.info(Vec::new(), "svc-bank stopped");
    Ok(())
}
