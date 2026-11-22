//! Slice `loans` (`services/svc-bank/src/loans/`): crypto-backed loans. `risk` is the pure arithmetic of LTV, daily
//! compounding interest, the liquidation ladder and the proceeds waterfall; `prices` the mark port (`PriceSource`),
//! its adapters and the guards on what a mark is good enough for; `apply` the application's calculator and fee line.
//! `model` holds the rows, `ports` the outside world, `locks` the session locks and `service` the money paths.

pub mod apply;
pub mod locks;
pub mod model;
pub mod ports;
pub mod prices;
pub mod risk;
pub mod service;
pub mod sweep;
