//! The transfers slice (`PORT.md`): moves between spaces and standing orders (`schedules`), sends to another person and
//! payment requests (`personal`, `requests`), the owner's terms, fees and limit requests (`terms`, `limits`), the send
//! review (`review`), holds on received funds (`holds`), the region notice and the person's extra checks (`safety`), the
//! step-up on money out (`step_up`), when an order's occurrences fall (`calendar`), what the slice asks of svc-identity
//! and the bus (`ports`, `notices`), and the calls (`router`).
//!
//! Money moves only through svc-ledger's recipe door (`spaces::ports::Ledger::post_recipe`), never by entries assembled
//! here, or through the partner bank that holds a person's money (`partner::custody`).

pub mod calendar;
pub mod holds;
pub mod limits;
pub mod moves;
pub mod notices;
pub mod personal;
pub mod ports;
pub mod requests;
pub mod review;
pub mod router;
pub mod safety;
pub mod schedules;
pub mod step_up;
pub mod terms;

use service_kit::approvals::{
    ConsumeError, ConsumeInput, Consumed, Facts, IdentityClient, PrincipalBinding,
};

use ports::{Bus, ExtraControls, NoBus, NoIdentity, PartyHandles, RecipientState, SecurityLock};

/// The owner's values the slice reads, each as `index.ts` hands it in; blank is `None`. Each is checked at start-up by
/// `env.rs`, and parsed where it is used, so a refusal names it as the TypeScript's does.
#[derive(Debug, Clone)]
pub struct Settings {
    /// `BANK_PERSONAL_SEND_REVIEW_JSON`.
    pub send_review: Option<String>,
    /// `BANK_REQUEST_REMIND_POLICY_JSON`.
    pub remind_policy: Option<String>,
    /// `BANK_STRANGER_HOLD_DAYS`.
    pub stranger_hold_days: Option<i64>,
    /// `BANK_SCHEDULE_EDIT_CUTOFF_MINUTES`.
    pub schedule_edit_cutoff: Option<String>,
    /// `BANK_STEP_UP_MONEY_OUT` is `required`.
    pub step_up_required: bool,
    /// `BANK_BLOCKED_REGION_NOTICE`.
    pub blocked_region_notice: Option<String>,
    /// `SCHEDULED_TRANSFERS_ENABLED`: on unless the owner turns it off (`env.ts`'s default).
    pub scheduled_transfers: bool,
    /// `TRANSFER_BATCH_SIZE`.
    pub batch_size: Option<i64>,
    /// `SERVICE_NAME`: the producer each notice names.
    pub producer: String,
}

impl Default for Settings {
    /// Every value blank, and standing orders running, as `env.ts` defaults `SCHEDULED_TRANSFERS_ENABLED` to on.
    fn default() -> Settings {
        Settings {
            send_review: None,
            remind_policy: None,
            stranger_hold_days: None,
            schedule_edit_cutoff: None,
            step_up_required: false,
            blocked_region_notice: None,
            scheduled_transfers: true,
            batch_size: None,
            producer: String::new(),
        }
    }
}

/// `ActionApprovalConsumer`: svc-identity's consume of a person's own approval.
pub trait Approvals: Send + Sync {
    /// Consumes one approval, bound to the person and session when it is their own, and answers it with its kind and
    /// expiry.
    fn consume(
        &self,
        input: &ConsumeInput<'_>,
        principal: Option<PrincipalBinding<'_>>,
    ) -> Result<(Consumed, Facts), ConsumeError>;
}

impl Approvals for IdentityClient {
    fn consume(
        &self,
        input: &ConsumeInput<'_>,
        principal: Option<PrincipalBinding<'_>>,
    ) -> Result<(Consumed, Facts), ConsumeError> {
        self.consume_for(input, principal)
    }
}

/// `unwiredApprovalConsumer`: no `IDENTITY_URL`, so nothing is approved.
pub struct NoApprovals;

impl Approvals for NoApprovals {
    fn consume(
        &self,
        _input: &ConsumeInput<'_>,
        _principal: Option<PrincipalBinding<'_>>,
    ) -> Result<(Consumed, Facts), ConsumeError> {
        Err(ConsumeError::Refused(
            "IDENTITY_URL is unpublished; bank ops do not invent a second person".to_owned(),
        ))
    }
}

/// What the door holds for the slice, built once at start-up.
pub struct Wiring {
    pub recipients: Box<dyn RecipientState>,
    pub lock: Box<dyn SecurityLock>,
    /// None without `IDENTITY_URL`: a receipt names no handle and says why.
    pub handles: Option<Box<dyn PartyHandles>>,
    pub extras: Box<dyn ExtraControls>,
    pub approvals: Box<dyn Approvals>,
    pub bus: Box<dyn Bus>,
    pub settings: Settings,
    /// `onCreditPosted`: who a posted send is handed to (the income sorter); none hands it to nobody.
    pub credit_posted: Option<Box<dyn ports::CreditPosted>>,
}

impl Wiring {
    /// No identity, no bus and every owner value blank: what a door built without the environment holds.
    pub fn none() -> Wiring {
        Wiring {
            recipients: Box::new(NoIdentity),
            lock: Box::new(NoIdentity),
            handles: None,
            extras: Box::new(NoIdentity),
            approvals: Box::new(NoApprovals),
            bus: Box::new(NoBus),
            settings: Settings::default(),
            credit_posted: None,
        }
    }
}

/// What every part of the slice is handed for one call or one pass: the store, svc-ledger, whose book holds each
/// person's money, the spaces slice's and the partner slice's wiring, this slice's wiring, and the time.
pub struct Deps<'a> {
    pub store: &'a crate::db::Store,
    pub ledger: &'a dyn crate::spaces::ports::Ledger,
    pub custody: &'a crate::partner::custody::Custody<'a>,
    pub partner: &'a crate::partner::router::Wiring,
    pub spaces: &'a crate::spaces::Wiring,
    pub w: &'a Wiring,
    pub now: service_kit::time::Instant,
}

impl Deps<'_> {
    /// Where a person's money is read (`spaces::space::Money`).
    pub fn money(&self) -> crate::spaces::space::Money<'_> {
        crate::spaces::space::Money {
            ledger: self.ledger,
            custody: self.custody,
            now: self.now,
        }
    }

    /// The slice's notices, sent now.
    pub fn notices(&self) -> notices::Notices<'_> {
        notices::Notices {
            bus: self.w.bus.as_ref(),
            producer: &self.w.settings.producer,
            now: self.now,
        }
    }
}
