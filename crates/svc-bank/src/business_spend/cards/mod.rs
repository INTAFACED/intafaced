//! Team cards and expenses (J-bank-22; `business/business-cards.ts`, `router/business-cards.router.ts`).
//!
//! - [`service`]: cards with per-purchase limits on the TEST card network, over-limit requests, the receipt rule and
//!   its one reminder, receipts as one stored ZIP, reimbursements paid as one partner move;
//! - [`router`]: the calls, and the step-up binding of `approveAndPay` on the transfers slice's gate.

pub mod router;
pub mod service;
