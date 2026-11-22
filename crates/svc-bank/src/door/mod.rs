//! svc-bank's door, as the TypeScript service serves it (`services/svc-bank/src/index.ts`): tRPC over HTTP at
//! `/trpc/<path>` (`router.ts` through the Fastify adapter, with the contracts' error formatter), and the REST doors
//! `index.ts` mounts through an exported register function (`rest`).
//!
//! The order of a tRPC call's checks is the TypeScript's, middleware by middleware:
//!
//! 1. the call is found and its method checked;
//! 2. who may call:
//!    - a scoped call (`scopedProcedure`) needs a signed-in caller (`protectedProcedure`), then its guards in their
//!      order: a service on the request refused for a person's call, the scope with its interactive-only and two-factor
//!      rules, the call's own tier (`requireTier`), the region and the module's tier (`checkAccess` for the `bank`
//!      module), and the person's own session (a key or a sub-account refused with the call's own code);
//!    - `anyScopeProcedure`: the first of its scopes the caller holds and may use, else one refusal naming them all;
//!    - a job (`requireBankJobService`): a verified service that is svc-bank itself;
//!    - a service call (`serviceProcedureFor`): a verified service the call lists;
//! 3. the input, read only now and checked by the call's zod schema;
//! 4. then the call's slice answers.
//!
//! The job doors and svc-ops' reads (`jobs`) are answered after the REST doors and before tRPC, as `index.ts` mounts
//! them beside it.
//!
//! Every call is in [`calls::CALLS`], generated from the TypeScript router by running its middlewares on probe callers
//! (`scripts/record-door.mjs`). `tests/wire_replay.rs` holds the door to the TypeScript's recorded answers.

pub mod calls;
pub mod inputs;
pub mod jobs;
pub mod rest;

use std::collections::BTreeMap;

use service_kit::access::{self, Jurisdiction};
use service_kit::edge::{self, EdgeKey, MIN_SECRET_LENGTH, Principal};
use service_kit::json::Json;
use service_kit::s2s::Mode;
use service_kit::s2s_verify::{self, BodyBind, Incoming, ServiceVerifier};
use service_kit::schema::Value;
use service_kit::server::{Door, Request, RequestIds, Response};
use service_kit::time::Instant;
use service_kit::trpc::{self, TrpcError};

use crate::db::Store;

pub use calls::Slice;

/// A query answers GET, a mutation POST.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Query,
    Mutation,
}

/// The module's own tier rule (`checkAccess`'s `denied.kyc_required`): open everywhere at `min_tier`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Kyc {
    pub module: &'static str,
    pub min_tier: &'static str,
}

/// `guards.module`: the region is checked, and the module's tier where a caller past the call's own tier can miss it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Region {
    /// `None`: the call's own tier guard already asks at least what the module asks, so the module's tier never refuses.
    pub kyc: Option<Kyc>,
}

/// `scopedProcedure(scope, guards)`'s guards.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Scoped {
    pub scope: &'static str,
    /// `guards.tier`: `requireTier`.
    pub tier: Option<&'static str>,
    /// `guards.person`: a service calling with a person's principal is refused.
    pub person: bool,
    /// `guards.module`.
    pub region: Option<Region>,
    /// `guards.ownSession`: a key or a sub-account is refused with this code.
    pub own_session: Option<&'static str>,
}

/// Who may call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// `publicProcedure`: anyone.
    Public,
    /// `requireBankJobService`: svc-bank itself (the ops job twins), by its service credentials.
    Job,
    /// `serviceProcedureFor(callers)`.
    Service(&'static [&'static str]),
    /// A signed-in caller with the scope.
    Scope(Scoped),
    /// `anyScopeProcedure(scopes, { person })`: a signed-in caller holding one of them.
    AnyScope {
        scopes: &'static [&'static str],
        person: bool,
    },
}

/// One call of the router.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Call {
    pub path: &'static str,
    pub kind: Kind,
    pub access: Access,
    pub slice: Slice,
    pub has_input: bool,
}

/// The call at `path`.
pub fn call(path: &str) -> Option<&'static Call> {
    calls::CALLS.iter().find(|c| c.path == path)
}

/// Each call's path, kind and caller, sorted by path: what `procedureCallers` reports for the TypeScript router.
pub fn callers() -> Vec<(&'static str, &'static str, &'static str)> {
    let mut out: Vec<_> = calls::CALLS
        .iter()
        .map(|c| {
            let kind = match c.kind {
                Kind::Query => "query",
                Kind::Mutation => "mutation",
            };
            let caller = match c.access {
                Access::Public | Access::Job => "public",
                Access::Service(_) => "service",
                Access::Scope(_) | Access::AnyScope { .. } => "scope",
            };
            (c.path, kind, caller)
        })
        .collect();
    out.sort_unstable();
    out
}

/// What a slice's handler sees once the door's checks passed.
pub struct Ctx<'a> {
    pub call: &'static Call,
    /// The input as the call's schema returned it (defaults filled, unknown keys stripped); `Undefined` when absent.
    pub input: Value,
    /// `ctx.principal`: none for a public or a service call made without one.
    pub principal: Option<&'a Principal>,
    /// `ctx.service`: the verified calling service, if any.
    pub service: Option<&'a str>,
    pub region: &'a str,
    /// The jurisdiction check the door runs (`checkAccess`), for a handler that reports it (`safety.regionNotice`).
    pub jurisdiction: &'a Jurisdiction,
    pub now: Instant,
}

/// The answer of a call whose slice is not ported yet: the door's checks passed, and nothing past them is served.
pub fn not_ported(slice: Slice) -> TrpcError {
    TrpcError::plain(
        "INTERNAL_SERVER_ERROR",
        format!("svc-bank in Rust: the {} slice is not ported", slice.name()),
    )
}

/// How the door judges a service on the request: `verifyServiceRequest` with the shared secret
/// (`INTERNAL_SERVICE_SECRET`) and, when on, the per-service keys, binding the body as `INTERNAL_SERVICE_BODY_BIND`
/// says (the tRPC door) or always (the REST doors).
pub struct ServiceAuth {
    /// `INTERNAL_SERVICE_SECRET`; `None` when unset or empty.
    pub secret: Option<String>,
    /// The verifier `s2sFromEnv` builds and `S2S_AUTH_MODE`, when the mode is not `off`.
    pub keys: Option<(ServiceVerifier, Mode)>,
    /// `INTERNAL_SERVICE_BODY_BIND` for the tRPC door.
    pub trpc_bind: BodyBind,
}

impl ServiceAuth {
    /// No secret and no keys: no request carries a service.
    pub fn unwired() -> ServiceAuth {
        ServiceAuth {
            secret: None,
            keys: None,
            trpc_bind: BodyBind::Require,
        }
    }

    /// The service that signed one request at `now` (seconds), binding its body as `bind` says.
    pub fn service(&self, req: &Request<'_>, bind: BodyBind, now: i64) -> Option<String> {
        let incoming = Incoming {
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: Some(req.body.as_bytes()),
        };
        match &self.keys {
            Some((v, mode)) => {
                s2s_verify::verify_request(
                    &incoming,
                    Some(v),
                    self.secret.as_deref(),
                    *mode,
                    bind,
                    now,
                )
                .service
            }
            None => self
                .secret
                .as_deref()
                .filter(|s| !s.is_empty())
                .and_then(|s| s2s_verify::verify_legacy(&incoming, s, bind, now).ok()),
        }
    }
}

/// What the door is built from, once, at start-up.
pub struct DoorConfig {
    /// `EDGE_PRINCIPAL_SECRET`: at least 32 characters.
    pub edge_secret: String,
    pub services: ServiceAuth,
    /// The process environment: the jurisdiction check's switches and lists, and `NODE_ENV`.
    pub env: BTreeMap<String, String>,
    /// The clock.
    pub now: fn() -> Instant,
    /// The `bank` schema, opened once by the binary (`db::open`).
    pub store: Store,
}

pub struct BankDoor {
    secret: String,
    services: ServiceAuth,
    jurisdiction: Jurisdiction,
    /// tRPC sends a stack trace in every error outside production.
    dev: bool,
    now: fn() -> Instant,
    requests: RequestIds,
    edge_key: Option<EdgeKey>,
    store: Store,
    /// Slice `partner`'s TEST partner, freeze and stand-ins (`partner::router::Wiring`); none until handed in.
    partner: crate::partner::router::Wiring,
    /// Slice `spaces`'s ledger and directory reads and owner values (`spaces::Wiring`); none until handed in.
    spaces: crate::spaces::Wiring,
    /// Slice `transfers`'s identity reads, bus and owner values (`transfers::Wiring`); none until handed in.
    transfers: crate::transfers::Wiring,
    /// Slice `earn`'s owner values (`earn::Settings`); identity and the ledger are the slices' above.
    earn: crate::earn::Settings,
    /// Slice `cards`' issuer, rank door and owner values (`cards::Wiring`); no card programme until handed in.
    cards: crate::cards::Wiring,
    /// Slice `loans`'s marks, venue, affiliates and owner values (`loans::Wiring`).
    loans: crate::loans::Wiring,
    /// Slice `automations`' wiring, one part each (`automations::Wiring`); nothing until handed in.
    pub(crate) automations: crate::automations::Wiring,
    /// Slice `activity`'s history reads, cursor secret and owner values (`activity::Wiring`).
    activity: crate::activity::Wiring,
    /// `TEST_AGE_DOOR`: whether `POST /internal/test/age` ages a record.
    test_age_open: bool,
}

/// The system clock.
pub fn system_now() -> Instant {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    Instant(ms)
}

const SESSION_REQUIRED: &str = "A signed-in user session is required";

fn forbidden(message: &str) -> TrpcError {
    TrpcError::plain("FORBIDDEN", message)
}

fn unauthenticated_service() -> TrpcError {
    TrpcError::plain(
        "UNAUTHORIZED",
        "This procedure is callable only by another INTAFACED service with valid service credentials (§2)",
    )
}

impl BankDoor {
    /// Refuses to start without a strong edge secret or with a malformed jurisdiction list, as the TypeScript does.
    pub fn new(config: DoorConfig) -> Result<BankDoor, String> {
        if config.edge_secret.chars().count() < MIN_SECRET_LENGTH {
            return Err(format!(
                "svc-bank: EDGE_PRINCIPAL_SECRET must be at least {MIN_SECRET_LENGTH} characters to mount /trpc. \
                 Without it the principal header is caller-controlled and every scope check is decorative (§9)."
            ));
        }
        Ok(BankDoor {
            secret: config.edge_secret,
            services: config.services,
            jurisdiction: Jurisdiction::from_env(&config.env)?,
            dev: config.env.get("NODE_ENV").map(String::as_str) != Some("production"),
            now: config.now,
            requests: RequestIds::new(),
            edge_key: None,
            store: config.store,
            partner: crate::partner::router::Wiring::none(),
            spaces: crate::spaces::Wiring::none(),
            transfers: crate::transfers::Wiring::none(),
            earn: crate::earn::Settings::default(),
            cards: crate::cards::Wiring::none(),
            loans: crate::loans::Wiring::none(),
            automations: crate::automations::Wiring::none(),
            activity: crate::activity::Wiring::none(),
            test_age_open: false,
        })
    }

    /// The database every slice reads and writes through.
    pub fn store(&self) -> &Store {
        &self.store
    }

    /// `sql.end()`: closes the pool once the server has stopped.
    pub fn end(&self) {
        self.store.end();
    }

    /// The clock the door reads.
    pub fn now(&self) -> Instant {
        (self.now)()
    }

    /// `f` given slice `transfers`' dependencies, read now: what a job or a recovery pass hands the slice.
    pub fn transfers_deps<T>(&self, f: impl FnOnce(&crate::transfers::Deps<'_>) -> T) -> T {
        let custody = self.partner.custody(&self.store);
        f(&crate::transfers::Deps {
            store: &self.store,
            ledger: self.spaces.ledger.as_ref(),
            custody: &custody,
            partner: &self.partner,
            spaces: &self.spaces,
            w: &self.transfers,
            now: self.now(),
        })
    }

    /// `f` given slice `earn`'s dependencies at `now`: what a call, a job or a recovery pass hands the slice.
    pub fn earn_deps<T>(&self, now: Instant, f: impl FnOnce(&crate::earn::Deps<'_>) -> T) -> T {
        f(&crate::earn::Deps {
            store: &self.store,
            ledger: self.spaces.ledger.as_ref(),
            custody_layer: &self.partner.custody_layer,
            recipients: self.transfers.recipients.as_ref(),
            approvals: self.transfers.approvals.as_ref(),
            settings: &self.earn,
            now,
        })
    }

    /// `f` given slice `loans`'s dependencies at `now`.
    pub fn loans_deps<T>(
        &self,
        now: Instant,
        f: impl FnOnce(&crate::loans::ports::Deps<'_>) -> T,
    ) -> T {
        let bus_calls = crate::loans::ports::BusMarginCalls {
            bus: self.transfers.bus.as_ref(),
            producer: "svc-bank",
            now,
        };
        let record_only = crate::loans::ports::RecordOnly;
        f(&crate::loans::ports::Deps {
            store: &self.store,
            ledger: self.spaces.ledger.as_ref(),
            custody_layer: &self.partner.custody_layer,
            approvals: self.transfers.approvals.as_ref(),
            prices: self.loans.prices.as_ref(),
            venue: self.loans.venue.as_ref(),
            margin_calls: if self.loans.publish_margin_calls {
                &bus_calls
            } else {
                &record_only
            },
            affiliates: self.loans.affiliates.as_ref(),
            settings: &self.loans.settings,
            now,
        })
    }

    /// Slice `loans`'s wiring, built by the binary from the environment.
    pub fn with_loans(mut self, wiring: crate::loans::Wiring) -> BankDoor {
        self.loans = wiring;
        self
    }

    /// Slice `activity`'s wiring, built by the binary from the environment.
    pub fn with_activity(mut self, wiring: crate::activity::Wiring) -> BankDoor {
        self.activity = wiring;
        self
    }

    /// `f` given slice `activity`'s dependencies at `now`: what a call or the statement worker hands the slice.
    pub fn activity_deps<T>(
        &self,
        now: Instant,
        f: impl FnOnce(&crate::activity::Deps<'_>) -> T,
    ) -> T {
        f(&crate::activity::Deps {
            door: self,
            w: &self.activity,
            now,
        })
    }

    /// Slice `spaces`'s wiring.
    pub fn spaces(&self) -> &crate::spaces::Wiring {
        &self.spaces
    }

    /// Slice `transfers`'s wiring.
    pub fn transfers(&self) -> &crate::transfers::Wiring {
        &self.transfers
    }

    /// Slice `earn`'s owner values, built by the binary from the environment.
    pub fn with_earn(mut self, settings: crate::earn::Settings) -> BankDoor {
        self.earn = settings;
        self
    }

    /// Slice `cards`' wiring, built by the binary from the environment.
    pub fn with_cards(mut self, wiring: crate::cards::Wiring) -> BankDoor {
        self.cards = wiring;
        self
    }

    /// Slice `cards`' wiring.
    pub fn cards(&self) -> &crate::cards::Wiring {
        &self.cards
    }

    /// `f` given slice `cards`' dependencies at `now`: what a job door or another slice's call hands the slice.
    pub fn cards_deps<T>(&self, now: Instant, f: impl FnOnce(&crate::cards::Deps<'_>) -> T) -> T {
        let custody = self.partner.custody(&self.store);
        let t = crate::transfers::Deps {
            store: &self.store,
            ledger: self.spaces.ledger.as_ref(),
            custody: &custody,
            partner: &self.partner,
            spaces: &self.spaces,
            w: &self.transfers,
            now,
        };
        f(&crate::cards::Deps {
            t: &t,
            w: &self.cards,
        })
    }

    /// Slice `automations`' wiring, built by the binary from the environment.
    pub fn with_automations(mut self, wiring: crate::automations::Wiring) -> BankDoor {
        self.automations = wiring;
        self
    }

    /// `f` given slice `automations`' dependencies at `now`: what a call, a job door or another slice hands the slice.
    pub fn automations_deps<T>(
        &self,
        now: Instant,
        f: impl FnOnce(&crate::automations::Deps<'_>) -> T,
    ) -> T {
        let custody = self.partner.custody(&self.store);
        let t = crate::transfers::Deps {
            store: &self.store,
            ledger: self.spaces.ledger.as_ref(),
            custody: &custody,
            partner: &self.partner,
            spaces: &self.spaces,
            w: &self.transfers,
            now,
        };
        f(&crate::automations::Deps {
            t: &t,
            w: &self.automations,
        })
    }

    /// Slice `partner`'s wiring, built by the binary from the environment.
    pub fn with_partner(mut self, wiring: crate::partner::router::Wiring) -> BankDoor {
        self.partner = wiring;
        self
    }

    /// Slice `spaces`'s wiring, built by the binary from the environment.
    pub fn with_spaces(mut self, wiring: crate::spaces::Wiring) -> BankDoor {
        self.spaces = wiring;
        self
    }

    pub fn with_transfers(mut self, wiring: crate::transfers::Wiring) -> BankDoor {
        self.transfers = wiring;
        self
    }

    /// Opens the TEST age door (`TEST_AGE_DOOR=on`, refused at boot outside dev or test).
    pub fn with_test_age(mut self, open: bool) -> BankDoor {
        self.test_age_open = open;
        self
    }

    /// Slice `partner`'s wiring.
    pub fn partner(&self) -> &crate::partner::router::Wiring {
        &self.partner
    }

    /// Also believes principals the edge signed with its key (`EDGE_PRINCIPAL_PUBLIC_KEY`).
    pub fn with_edge_key(mut self, key: EdgeKey) -> BankDoor {
        self.edge_key = Some(key);
        self
    }

    /// The slices' answers: the door's own call, each ported slice's, and "not ported" for the rest.
    fn handle_call(&self, ctx: &Ctx<'_>) -> Result<Option<Json>, TrpcError> {
        match ctx.call.slice {
            Slice::Door => Ok(Some(Json::obj([
                ("ok", Json::Bool(true)),
                ("service", Json::str("svc-bank")),
            ]))),
            Slice::CreditPreviews => crate::credit_previews::answer(ctx)
                .unwrap_or_else(|| Err(not_ported(Slice::CreditPreviews))),
            Slice::Partner => crate::partner::router::answer(&self.partner, &self.store, ctx)
                .unwrap_or_else(|| Err(not_ported(Slice::Partner))),
            Slice::Spaces => {
                let freeze = |card_id: &str, user: &str| {
                    self.cards_deps(ctx.now, |d| {
                        crate::cards::core::freeze_for_holder(d, card_id, user)
                    })
                };
                crate::spaces::router::answer(
                    &self.spaces,
                    &self.partner,
                    &self.store,
                    ctx,
                    &freeze,
                )
                .unwrap_or_else(|| Err(not_ported(Slice::Spaces)))
            }
            // `transfers.list` is the activity feed narrowed to transfers (`router/transfers.router.ts`).
            Slice::Transfers if ctx.call.path == "transfers.list" => self
                .activity_deps(ctx.now, |d| crate::activity::feed::transfers_list(d, ctx))
                .map(Some),
            Slice::Transfers => crate::transfers::router::answer(
                &self.transfers,
                &self.spaces,
                &self.partner,
                &self.store,
                ctx,
            )
            .unwrap_or_else(|| Err(not_ported(Slice::Transfers))),
            Slice::OpsDesk => crate::ops_desk::answer(
                &self.transfers,
                &self.spaces,
                &self.partner,
                &self.store,
                ctx,
            )
            .unwrap_or_else(|| Err(not_ported(Slice::OpsDesk))),
            Slice::Earn => {
                let user = ctx
                    .principal
                    .map(|p| p.user_id.as_str())
                    .unwrap_or_default();
                self.earn_deps(ctx.now, |d| {
                    crate::earn::router::answer(d, user, ctx.call.path, &ctx.input)
                })
                .map(|r| {
                    r.map(Some).map_err(|e| {
                        crate::errors::to_trpc(e, || {
                            service_kit::approvals::random_uuid().unwrap_or_default()
                        })
                    })
                })
                .unwrap_or_else(|| Err(not_ported(Slice::Earn)))
            }
            Slice::Cards => crate::cards::router::answer(
                &self.cards,
                &self.transfers,
                &self.spaces,
                &self.partner,
                &self.store,
                ctx,
            )
            .unwrap_or_else(|| Err(not_ported(Slice::Cards))),
            Slice::Loans => {
                let user = ctx
                    .principal
                    .map(|p| p.user_id.as_str())
                    .unwrap_or_default();
                self.loans_deps(ctx.now, |d| {
                    crate::loans::router::answer(d, user, ctx.call.path, &ctx.input)
                })
                .map(|r| {
                    r.map(Some).map_err(|e| {
                        crate::errors::to_trpc(e, || {
                            service_kit::approvals::random_uuid().unwrap_or_default()
                        })
                    })
                })
                .unwrap_or_else(|| Err(not_ported(Slice::Loans)))
            }
            Slice::Automations => self
                .automations_deps(ctx.now, |d| crate::automations::router::answer(d, ctx))
                .unwrap_or_else(|| Err(not_ported(Slice::Automations))),
            Slice::Activity => self
                .activity_deps(ctx.now, |d| crate::activity::answer(d, ctx))
                .unwrap_or_else(|| Err(not_ported(Slice::Activity))),
            other => Err(not_ported(other)),
        }
    }

    /// Answers one request under a fresh request id.
    pub fn handle(&self, req: &Request<'_>) -> Response {
        let id = self.requests.next();
        self.handle_as(req, &id)
    }

    /// Answers one request under the id the server already gave it, from no known peer.
    pub fn handle_as(&self, req: &Request<'_>, request_id: &str) -> Response {
        self.handle_from(req, request_id, "")
    }

    /// Answers one request from the TCP peer `peer` (blank when unknown): the loopback TEST doors read it.
    pub fn handle_from(&self, req: &Request<'_>, request_id: &str, peer: &str) -> Response {
        if let Some(res) = crate::test_age::answer(self, req, self.test_age_open) {
            return res;
        }
        if let Some(partner) = self.partner.partner.as_ref() {
            let path = req.url.split_once('?').map_or(req.url, |(p, _)| p);
            let now = (self.now)();
            if let Some(res) = crate::partner::record::door(
                partner,
                req.method,
                path,
                peer,
                || rest::read_body(req),
                now,
            ) {
                return res;
            }
        }
        if let Some(res) = rest::answer(self, req) {
            return res;
        }
        if let Some(res) = jobs::answer(self, req) {
            return res;
        }
        let Some((path, query)) = trpc::route(req.url) else {
            return trpc::route_not_found(req);
        };
        if let Some(res) = rest::trpc_media(req, self.dev) {
            return res;
        }
        match self.answer(req, &path, query) {
            Ok(data) => trpc::ok(data),
            Err(e) => trpc::render(&e, &path, request_id, "svc-bank", self.dev),
        }
    }

    /// The verified service on a request, binding the body as `bind` says.
    pub(crate) fn service(&self, req: &Request<'_>, bind: BodyBind) -> Option<String> {
        self.services
            .service(req, bind, (self.now)().0.div_euclid(1000))
    }

    /// Who may call, in the middlewares' order (held call by call to the TypeScript's own middlewares by
    /// `tests/guard_grid.rs`).
    pub fn admit(
        &self,
        call: &Call,
        principal: Option<&Principal>,
        service: Option<&str>,
        region: &str,
    ) -> Result<(), TrpcError> {
        match call.access {
            Access::Public => Ok(()),
            Access::Job => match service {
                None => Err(unauthenticated_service()),
                Some("svc-bank") => Ok(()),
                Some(_) => Err(forbidden("ops job is callable only as svc-bank")),
            },
            Access::Service(listed) => match service {
                None => Err(unauthenticated_service()),
                Some(s) if listed.contains(&s) => Ok(()),
                Some(_) => Err(TrpcError::caused(
                    "FORBIDDEN",
                    "This service is not allowed to call this procedure",
                    "s2s.caller_forbidden",
                )),
            },
            Access::Scope(g) => {
                let Some(p) = principal else {
                    return Err(TrpcError::unauthenticated());
                };
                if g.person && service.is_some() {
                    return Err(forbidden(SESSION_REQUIRED));
                }
                access::require_scope(p, g.scope).map_err(TrpcError::guard)?;
                if let Some(tier) = g.tier {
                    access::require_tier(p, tier).map_err(TrpcError::guard)?;
                }
                if let Some(r) = g.region {
                    match r.kyc {
                        Some(k) => self
                            .jurisdiction
                            .check_module(region, &p.tier, k.module, k.min_tier),
                        None => self.jurisdiction.check_open(region),
                    }
                    .map_err(TrpcError::guard)?;
                }
                if let Some(code) = g.own_session
                    && (p.kid.is_some() || p.sub_account.is_some())
                {
                    return Err(forbidden(code));
                }
                Ok(())
            }
            Access::AnyScope { scopes, person } => {
                let Some(p) = principal else {
                    return Err(TrpcError::unauthenticated());
                };
                if person && service.is_some() {
                    return Err(forbidden(SESSION_REQUIRED));
                }
                let mut saw_mfa = false;
                for scope in scopes {
                    if !access::has_scope(&p.scopes, scope) {
                        continue;
                    }
                    match access::require_scope(p, scope) {
                        Ok(()) => return Ok(()),
                        Err(r) if r.code == "mfa.required" => saw_mfa = true,
                        Err(_) => {}
                    }
                }
                if saw_mfa {
                    return Err(TrpcError::plain(
                        "UNAUTHORIZED",
                        "A second factor is required",
                    ));
                }
                Err(forbidden(&format!(
                    "One of {} is required",
                    scopes.join(", ")
                )))
            }
        }
    }

    fn answer(
        &self,
        req: &Request<'_>,
        path: &str,
        query: &str,
    ) -> Result<Option<Json>, TrpcError> {
        if trpc::query_param(query, "batch").is_some() {
            return Err(TrpcError::plain(
                "BAD_REQUEST",
                "Batching is not served by svc-bank in Rust",
            ));
        }
        let Some(call) = call(path) else {
            return Err(trpc::no_procedure(path));
        };
        trpc::check_method(req.method, call.kind == Kind::Query, path)?;

        let now = (self.now)();
        let region = trpc::header(req, "x-intafaced-region").unwrap_or_else(|| "XX".to_owned());
        let principal = edge::verify_with(
            trpc::header(req, "x-intafaced-principal").as_deref(),
            trpc::header(req, "x-intafaced-principal-sig").as_deref(),
            &self.secret,
            self.edge_key.as_ref(),
            now,
            &region,
        );
        let service = self.service(req, self.services.trpc_bind);
        self.admit(call, principal.as_ref(), service.as_deref(), &region)?;

        // The input is read only now, after the middlewares, as tRPC reads it lazily.
        let raw = trpc::read_input(req, query)?;
        let input = match inputs::parse(path, raw.as_ref()) {
            Ok(Ok(v)) => v,
            Ok(Err(refused)) => return Err(TrpcError::plain("BAD_REQUEST", refused.message())),
            Err(broken) => return Err(TrpcError::plain("INTERNAL_SERVER_ERROR", broken)),
        };

        self.handle_call(&Ctx {
            call,
            input,
            principal: principal.as_ref(),
            service: service.as_deref(),
            region: &region,
            jurisdiction: &self.jurisdiction,
            now,
        })
    }
}

/// The kit's server serves the door.
impl Door for BankDoor {
    fn next_request_id(&self) -> String {
        self.requests.next()
    }

    fn handle_as(&self, req: &Request<'_>, request_id: &str) -> Response {
        BankDoor::handle_as(self, req, request_id)
    }

    fn handle_from(&self, req: &Request<'_>, request_id: &str, peer: &str) -> Response {
        BankDoor::handle_from(self, req, request_id, peer)
    }

    /// `/health` is the server's own `{ ok, service }`, as `index.ts` answers it, and `/ready` the app's fixed body,
    /// read once at boot (`ready::body`).
    fn status(&self, _req: &Request<'_>) -> Option<Response> {
        None
    }
}
