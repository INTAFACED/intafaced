//! Certificates: progress, grants and the XP they publish, the perk plane, issue rules and their sweep, designs and
//! the issued list, revocations, exceptions, the public check with its rate limiter and the holder's name, ported from
//! `services/svc-academy/src/certs/` and the certificate parts of `academy-service.ts` and `router.ts`.
//!
//! The calls are answered in `slices::certs`; this module holds the rules ([`catalog`], [`progress`], [`honesty`],
//! [`xp`], [`perks`]), the SQL ([`issue_rules`], [`designs`], [`enrolment`], [`service`]) and the process's own
//! certificate state ([`State`]: the verify limiter and the clock). Nothing here moves money.

pub mod catalog;
pub mod designs;
pub mod enrolment;
pub mod honesty;
pub mod issue_rules;
pub mod perks;
pub mod progress;
pub mod service;
pub mod sql;
pub mod verify_rate;
pub mod xp;

use service_kit::json::Json;
use service_kit::time::Instant;

use crate::ports::Ports;

/// What one process keeps for its certificate calls: `certVerify`'s per-address window and the clock.
pub struct State {
    pub limiter: verify_rate::Limiter,
    pub clock: fn() -> Instant,
}

impl State {
    pub fn new(clock: fn() -> Instant) -> State {
        State {
            limiter: verify_rate::Limiter::default(),
            clock,
        }
    }
}

/// The owner values the certificate calls read from the loaded environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Owner {
    /// `ACADEMY_CERT_ISSUED_ROWS`.
    pub issued_rows: Option<i64>,
    /// `ACADEMY_CERT_ISSUE_SWEEP_SECONDS`.
    pub sweep_seconds: Option<i64>,
    /// `ACADEMY_CERT_VERIFY_RATE_MAX` and `_WINDOW_SECONDS`, both or none.
    pub verify_rate: Option<verify_rate::Rate>,
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "env validation admits only whole numbers in a small range"
)]
fn int(settings: &Json, key: &str) -> Option<i64> {
    match settings.get(key) {
        Some(Json::Number(n)) if n.is_finite() => Some(*n as i64),
        _ => None,
    }
}

impl Owner {
    pub fn from_settings(settings: &Json) -> Owner {
        Owner {
            issued_rows: int(settings, "ACADEMY_CERT_ISSUED_ROWS"),
            sweep_seconds: int(settings, "ACADEMY_CERT_ISSUE_SWEEP_SECONDS"),
            verify_rate: verify_rate::Rate::from_settings(settings),
        }
    }
}

/// `SERVICE_NAME`: the XP envelope's producer.
pub fn producer(settings: &Json) -> String {
    match settings.get("SERVICE_NAME") {
        Some(Json::String(s)) => s.clone(),
        _ => "svc-academy".to_owned(),
    }
}

/// The certificate half of the service over the production catalogue, as `index.ts` builds it, for one use.
pub fn with_certs<T>(
    store: &crate::db::Store,
    ports: &Ports,
    settings: &Json,
    clock: fn() -> Instant,
    f: impl FnOnce(&service::Certs<'_>) -> T,
) -> T {
    let owner = Owner::from_settings(settings);
    let publisher = xp::BusPublisher {
        bus: &*ports.bus,
        producer: producer(settings),
        clock,
    };
    let certs = service::Certs {
        store,
        catalog: catalog::production(),
        xp: &publisher,
        host_rights: &*ports.host_rights,
        sweep_running: owner.sweep_seconds.is_some(),
        issued_rows: owner.issued_rows,
        wall: clock,
    };
    f(&certs)
}

/// One issue sweep over the production catalogue: `academy.issueDueCertificates()`.
pub fn sweep(
    store: &crate::db::Store,
    ports: &Ports,
    settings: &Json,
    clock: fn() -> Instant,
) -> Result<i64, crate::errors::Refusal> {
    with_certs(store, ports, settings, clock, |certs| {
        certs.issue_due_certificates(clock().0)
    })
}

/// `settleCertificatesNeeding(userId, requirement, now)` over the production catalogue: what a completion, an Undo or
/// an assessment result in another slice starts. A failure is logged and never refuses the call that started it.
pub fn settle_needing(
    store: &crate::db::Store,
    ports: &Ports,
    settings: &Json,
    clock: fn() -> Instant,
    user_id: &str,
    requirement: &str,
    now: i64,
) {
    with_certs(store, ports, settings, clock, |certs| {
        certs.settle_certificates_needing(user_id, requirement, now);
    });
}
