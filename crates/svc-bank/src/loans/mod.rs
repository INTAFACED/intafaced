//! Slice `loans` (`services/svc-bank/src/loans/`): crypto-backed loans. `risk` is the pure arithmetic of LTV, daily
//! compounding interest, the liquidation ladder and the proceeds waterfall; `prices` the mark port (`PriceSource`),
//! its adapters and the guards on what a mark is good enough for; `apply` the application's calculator and fee line.

pub mod apply;
pub mod prices;
pub mod risk;
