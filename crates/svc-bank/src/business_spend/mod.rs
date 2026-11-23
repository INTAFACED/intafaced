//! The business-spend slice (`PORT.md`): what a business spends, and its books.
//!
//! - [`bills`]: supplier bills, their inbox, duplicates, vendors, Bill Pay limits, approvals and partner-held payments
//!   (J-bank-20; `business/business-bills.ts`, `router/business-bills.router.ts`, the job doors `bill-pay/*`);
//! - [`cards`]: team cards with per-purchase limits, receipts and reimbursements paid at the partner (J-bank-22;
//!   `business/business-cards.ts`, `router/business-cards.router.ts`);
//! - [`books`]: the accounting connection record, coding rules and four-format statements (J-bank-23;
//!   `business/business-books.ts`, `statement-formats.ts`, `router/business-books.router.ts`);
//! - [`router`]: the slice's calls and job doors, each answered by its part.
//!
//! The business's money is the partner bank's, in its own account at the partner (`business:<account id>`): a bill
//! payment, a captured card purchase and a paid reimbursement are each one instruction to the partner under its
//! business key, sent once. INTAFACED's ledger posts nothing for any of it. Who may do what is the business-team
//! slice's `seat`.

pub mod bills;
pub mod books;
pub mod cards;
pub mod router;

use crate::business_team::service as team;
use crate::errors::Refusal;
use crate::partner::custody::Held;
use crate::spaces::space::with;
use crate::transfers::Deps;

/// The business a seat is on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub id: String,
    pub name: String,
    pub asset_id: String,
    /// `active` or `closed`.
    pub status: String,
}

/// `BusinessTeamService.seat` as this slice reads it: the business, the partner bank that holds its money (or none),
/// and the caller's permissions on it.
pub struct Seat<'a> {
    pub account: Account,
    pub partner: Option<Held<'a>>,
    pub permissions: Vec<&'static str>,
}

impl Seat<'_> {
    /// Whether the caller holds `permission`.
    pub fn holds(&self, permission: &str) -> bool {
        self.permissions.contains(&permission)
    }
}

/// `seat`: the business first (`bank.business_not_found`), then the caller's seat on it (`bank.business_not_member`).
pub fn seat<'a>(d: &Deps<'a>, account_id: &str, user_id: &str) -> Result<Seat<'a>, Refusal> {
    let s = with(d.store, |c| team::seat(c, account_id, user_id))?;
    Ok(Seat {
        partner: team::partner_of(d, &s),
        account: Account {
            id: s.account_id,
            name: s.name,
            asset_id: s.asset_id,
            status: s.status,
        },
        permissions: s.permissions,
    })
}

/// `approverPool`: the members other than `exclude` who hold `approve`.
pub fn approver_pool(
    d: &Deps<'_>,
    account_id: &str,
    exclude: &str,
) -> Result<Vec<String>, Refusal> {
    with(d.store, |c| team::approver_pool(c, account_id, exclude))
}

/// `ruleList`: the business's approval rules, oldest first.
pub fn rule_list(d: &Deps<'_>, account_id: &str) -> Result<Vec<team::TeamRule>, Refusal> {
    with(d.store, |c| team::rule_list(c, account_id))
}
