//! The scanner's port double: the real svc-trade tickers port over a fetch serving the case's recorded reply.

use service_kit::json::Json;
use svc_agents::factories::Factories;
use svc_agents::factories::scanner::SpotTickersHttp;

use super::FakeFetch;

/// `createHttpSpotTickersPort({ tradeUrl: 'http://trade.test/', fetchImpl })`.
pub fn ports(port: &Json) -> Factories {
    Factories {
        spot_tickers: Some(Box::new(SpotTickersHttp::new(
            "http://trade.test/",
            FakeFetch::new(port),
        ))),
        ..Factories::unwired()
    }
}
