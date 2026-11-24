//! Slice `loans` (`services/svc-bank/src/loans/`): crypto-backed loans. `risk` is the pure arithmetic of LTV, daily
//! compounding interest, the liquidation ladder and the proceeds waterfall; `prices` the mark port (`PriceSource`),
//! its adapters and the guards on what a mark is good enough for; `apply` the application's calculator and fee line.
//! `model` holds the rows, `ports` the outside world, `locks` the session locks and `service` the money paths.

pub mod adjustments;
pub mod apply;
pub mod book;
pub mod locks;
pub mod model;
pub mod ports;
pub mod prices;
pub mod reads;
pub mod risk;
pub mod router;
pub mod service;
pub mod sweep;

/// What the binary hands the slice once, at start-up (`index.ts`'s `loans` options).
pub struct Wiring {
    pub settings: ports::Settings,
    /// `priceSource`: svc-trade's ticker in the binary; no marks at all without one.
    pub prices: Box<dyn prices::PriceSource>,
    /// `venue`: who buys seized collateral; the platform's market maker.
    pub venue: Box<dyn ports::Venue>,
    /// `affiliateAccrue` / `affiliatePayout`: svc-identity's, or none without `IDENTITY_URL`.
    pub affiliates: Box<dyn ports::Affiliates>,
    /// `eventMarginCallSink(bus)` when true; `recordOnlyMarginCallSink` otherwise.
    pub publish_margin_calls: bool,
}

impl Wiring {
    /// No marks, no affiliates, calls recorded only, every owner value at the environment's defaults.
    pub fn none() -> Wiring {
        Wiring {
            settings: ports::Settings::default(),
            prices: Box::new(prices::FixedPriceSource::empty()),
            venue: Box::new(ports::MarketMaker),
            affiliates: Box::new(ports::NoAffiliates),
            publish_margin_calls: false,
        }
    }
}
