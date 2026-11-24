//! `GET /internal/curriculum` (`curriculum/internal-curriculum.ts`): the coach's spine, slug and title only, for the
//! services the record `ACADEMY_INTERNAL_CURRICULUM` names (svc-agents). A call is judged as `verifyServiceRequest`
//! judges it: by the caller's own key when it carries one (with `S2S_AUTH_MODE` dual or keypair), else by the shared
//! secret bound to the empty body as `INTERNAL_SERVICE_BODY_BIND` says. Any other caller is refused with the record's
//! one refusal, `academy.unauthenticated` (401).

use service_kit::s2s::{self, Mode};
use service_kit::s2s_verify::{self, BodyBind, Incoming, ServiceVerifier};
use service_kit::server::{Request, Response};

use super::links;

/// The record's path and its callers.
pub const PATH: &str = "/internal/curriculum";
pub const CALLERS: [&str; 1] = ["svc-agents"];

/// How the door judges a service's call: the shared secret, its body binding, and the per-service keys when on.
pub struct ServiceAuth {
    /// `INTERNAL_SERVICE_SECRET`.
    pub secret: String,
    /// `INTERNAL_SERVICE_BODY_BIND`.
    pub body_bind: BodyBind,
    /// The verifier `s2sFromEnv` builds and `S2S_AUTH_MODE`, when the mode is not `off`.
    pub keys: Option<(ServiceVerifier, Mode)>,
}

impl ServiceAuth {
    /// No secret and no keys: every call is refused.
    pub fn unwired() -> ServiceAuth {
        ServiceAuth {
            secret: String::new(),
            body_bind: BodyBind::AcceptBoth,
            keys: None,
        }
    }

    /// From the environment, as `index.ts` builds it: a malformed keyring or signing key refuses to start
    /// (`s2sFromEnv` throws at load).
    pub fn from_env(
        secret: &str,
        body_bind: &str,
        mode: &str,
        keyring: Option<&str>,
        kid: Option<&str>,
        key: Option<&str>,
    ) -> Result<ServiceAuth, String> {
        let parsed = s2s::s2s_from_env(mode, keyring, kid, key, "svc-academy")?;
        let keys = match (parsed.mode, keyring) {
            (Some(mode), Some(ring)) => Some((
                ServiceVerifier::new(
                    "svc-academy",
                    &s2s::parse_keyring(ring)?,
                    s2s::system_seconds,
                )?,
                mode,
            )),
            _ => None,
        };
        Ok(ServiceAuth {
            secret: secret.to_owned(),
            body_bind: if body_bind == "require" {
                BodyBind::Require
            } else {
                BodyBind::AcceptBoth
            },
            keys,
        })
    }
}

/// The route's answer, or none when the request is not `GET` (or `HEAD`) `/internal/curriculum`.
pub fn route(auth: &ServiceAuth, req: &Request<'_>) -> Option<Response> {
    let path = req.url.split_once('?').map_or(req.url, |(p, _)| p);
    if path != PATH || !matches!(req.method, "GET" | "HEAD") {
        return None;
    }
    Some(answer(auth, req, s2s::system_seconds()))
}

/// The answer at `now` (seconds).
pub fn answer(auth: &ServiceAuth, req: &Request<'_>, now: i64) -> Response {
    let incoming = Incoming {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Some(req.body.as_bytes()),
    };
    let (verifier, mode) = match &auth.keys {
        Some((v, m)) => (Some(v), *m),
        None => (None, Mode::Dual),
    };
    let caller = s2s_verify::verify_request(
        &incoming,
        verifier,
        Some(&auth.secret),
        mode,
        auth.body_bind,
        now,
    )
    .service;
    match caller {
        Some(c) if CALLERS.contains(&c.as_str()) => Response {
            status: 200,
            body: links::coach_spine_json().compact(),
        },
        _ => Response {
            status: 401,
            body: r#"{"error":"service credentials required","code":"academy.unauthenticated"}"#
                .to_owned(),
        },
    }
}
