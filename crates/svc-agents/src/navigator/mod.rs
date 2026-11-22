//! The navigator slice (`PORT.md`): `router.ts`'s `navigator` router and `navigator/`. The pure Stage-1 and Stage-2
//! tools (`tools`: the declared toolset, the plane, the tier gate, tool selection, the data tools and their audit
//! row), the live reads of svc-trade and svc-identity (`ports`), the metered answer run through the runtime's `act`
//! (`run`), the on-chain session key with the orders the Navigator places through it (`onchain`), and a research
//! answer's provenance for a Navigator session's `run.complete` (`research`).

pub mod onchain;
pub mod ports;
pub mod research;
pub mod run;
pub mod slice;
pub mod tools;

/// What the navigator calls are built from, once, at start-up (`router.ts`'s navigator deps).
pub struct Navigator {
    /// `TRADE_URL`: unset coerces a caller's `live` plane to `dark` (`effectiveNavigatorTradePlane`).
    pub trade_url: Option<String>,
    /// `navigatorTradeDataPort`: svc-trade's public REST while `TRADE_URL` is set.
    pub trade_data: Option<Box<dyn ports::TradeData>>,
    /// `navigatorIdentitySessionPort`: svc-identity's session read while `IDENTITY_URL` is set.
    pub identity_session: Option<Box<dyn ports::IdentitySession>>,
    /// The on-chain key, the market and the reads the trading calls make.
    pub onchain: onchain::OnchainDeps,
    /// Research answers' provenance: `AGENTS_RESEARCH_UNCERTAINTY_SCALE` and where the market data is (`APP_ENV`).
    pub research: research::Research,
}

impl Navigator {
    /// No trade plane, no outside reads, no on-chain signer: every call refuses as the TypeScript does without them.
    pub fn unwired() -> Navigator {
        Navigator {
            trade_url: None,
            trade_data: None,
            identity_session: None,
            onchain: onchain::OnchainDeps::unwired(),
            research: research::Research::unwired(),
        }
    }
}
