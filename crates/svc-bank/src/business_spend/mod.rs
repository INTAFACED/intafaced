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
