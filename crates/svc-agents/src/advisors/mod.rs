//! The `advisors` slice (`PORT.md`): the AI Coach (`coach.policy`, `coach.session`, `coach.runSession`), Risk &
//! Compliance's drafts (`riskCompliance.draftScreening`, `riskCompliance.refuseKycReview`), Growth (`growth.propose`),
//! the Launch agent (`launch.assess`), the Portfolio agent (`portfolio.plan`) and the marketplace install
//! (`marketplace.install`), answered as `router.ts` answers them.
//!
//! - [`text`]: the advisors' text checks, as their JavaScript patterns read text.
//! - [`grounding`]: the Coach's curriculum, its honesty board and `coach.session`'s ruling.
//! - [`coach_run`]: the metered Coach answer and its stored run (`coach_runs`).
//! - [`drafts`]: Launch, Risk & Compliance, Growth and the install: drafts and refusals, never decisions.
//! - [`portfolio`]: the plan-only rebalance over the person's own priced balances.
//! - [`slice`]: the nine calls.

pub mod coach_run;
pub mod drafts;
pub mod grounding;
pub mod portfolio;
pub mod slice;
pub mod text;

use drafts::Warehouse;
use grounding::{Curriculum, NoCurriculum};
use portfolio::{HoldingsLedger, Prices};

/// What the slice is built from, once, at start-up (`createAgentsRouter`'s `loadCoachGrounding`, `portfolioLedger`,
/// `portfolioPrices`, and the process's `AGENTS_PORTFOLIO_ENABLED`).
pub struct Advisors {
    /// `loadCoachGrounding`: svc-academy's curriculum when `ACADEMY_URL` is set, else the empty catalog.
    pub curriculum: Box<dyn Curriculum>,
    /// `AGENTS_PORTFOLIO_ENABLED` off, unset or unknown: planning is switched off.
    pub portfolio_killed: bool,
    /// The person's balances and the platform's prices: both, or the portfolio port is dark (`TRADE_URL` and
    /// `PORTFOLIO_QUOTE_ASSET` set the prices).
    pub holdings: Option<(Box<dyn HoldingsLedger>, Box<dyn Prices>)>,
    /// `envGrowthWarehouse()`: dark until a warehouse is wired.
    pub warehouse: Warehouse,
}

impl Advisors {
    /// Nothing wired: the empty curriculum, planning off, no holdings, a dark warehouse.
    pub fn unwired() -> Advisors {
        Advisors {
            curriculum: Box::new(NoCurriculum),
            portfolio_killed: true,
            holdings: None,
            warehouse: Warehouse::default(),
        }
    }
}
