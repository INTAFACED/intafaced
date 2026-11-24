//! The support desk's port double: the real HTTP desk port over a fetch serving the case's recorded reply.

use service_kit::json::Json;
use service_kit::s2s::CallSigner;
use svc_agents::factories::Factories;
use svc_agents::factories::support::DeskHttp;

use super::FakeFetch;

/// `createHttpSupportDeskPort({ supportUrl: 'http://support.test/', identityUrl: 'http://identity.test/', internalSecret,
/// fetchImpl })`; `identity: false` leaves the identity URL out.
pub fn ports(port: &Json) -> Factories {
    let identity =
        (port.get("identity") != Some(&Json::Bool(false))).then_some("http://identity.test/");
    Factories {
        support_desk: Some(Box::new(DeskHttp::new(
            "http://support.test/",
            identity,
            CallSigner::new(
                "svc-agents",
                "svc-identity",
                "placeholder-agents-record-factories-internal-secret",
                None,
            ),
            FakeFetch::new(port),
        ))),
        ..Factories::unwired()
    }
}
