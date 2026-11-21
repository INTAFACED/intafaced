//! The merchant's port double: the real svc-pay metrics port over a fetch serving the case's recorded reply, signed
//! with the case's `secret` when it names one.

use service_kit::json::Json;
use service_kit::s2s::CallSigner;
use svc_agents::factories::Factories;
use svc_agents::factories::merchant::PayMetricsHttp;

use super::FakeFetch;

/// `createHttpPayMetricsPort({ payUrl: 'http://pay.test/', internalSecret, fetchImpl })`.
pub fn ports(port: &Json) -> Factories {
    let secret = match port.get("secret") {
        Some(Json::String(s)) => s.as_str(),
        _ => "placeholder-agents-merchant-parity-internal-secret",
    };
    Factories {
        pay_metrics: Some(Box::new(PayMetricsHttp::new(
            "http://pay.test/",
            CallSigner::new("svc-agents", "svc-pay", secret, None),
            FakeFetch::new(port),
        ))),
        ..Factories::unwired()
    }
}
