//! The business's books (J-bank-23; `business/business-books.ts`, `statement-formats.ts`,
//! `router/business-books.router.ts`).
//!
//! - [`service`]: the accounting connection record, coding rules and the coded lines, and the statement checked
//!   against the partner's own;
//! - [`formats`]: the statement as CSV, MT940, CAMT.053 or QIF, byte for byte;
//! - [`router`]: the calls, the statement's step-up always required.

pub mod formats;
pub mod router;
pub mod service;
