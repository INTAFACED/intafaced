//! The spaces slice (`PORT.md`): a person's own spaces and pots (`space`), pots shared with other people (`shared`), the
//! account home and the owner's tables (`home`), the reads they make of svc-ledger and svc-identity (`ports`), and the
//! calls (`router`).

pub mod home;
pub mod ports;
pub mod router;
pub mod shared;
pub mod space;

use ports::{Directory, Ledger, Lookups, NoDirectory, NoLedger};
use shared::Terms;
use space::Rules;

/// The owner's published tables, each as `index.ts` reads it from the environment; blank is `None`.
#[derive(Debug, Clone, Default)]
pub struct Tables {
    /// `BANK_ACCOUNT_TERMS_JSON`.
    pub account_terms: Option<String>,
    /// `BANK_ACCOUNT_CURRENCIES`.
    pub currencies: Option<String>,
    /// `BANK_PLANS_JSON`.
    pub plans: Option<String>,
    /// `BANK_FEE_SCHEDULE_JSON`.
    pub fees: Option<String>,
    /// `BANK_DORMANCY_RULES_JSON`.
    pub dormancy: Option<String>,
}

/// What the door holds for the slice, built once at start-up.
pub struct Wiring {
    pub ledger: Box<dyn Ledger>,
    pub directory: Box<dyn Directory>,
    pub lookups: Lookups,
    pub rules: Rules,
    pub terms: Terms,
    pub tables: Tables,
}

impl Wiring {
    /// No ledger, no directory and every owner value blank: what a door built without the environment holds.
    pub fn none() -> Wiring {
        Wiring {
            ledger: Box::new(NoLedger),
            directory: Box::new(NoDirectory),
            lookups: Lookups::default(),
            rules: Rules::default(),
            terms: Terms::default(),
            tables: Tables::default(),
        }
    }
}
