//! One module per slice of the port; each answers the calls the door table (`door::calls::CALLS`) gives it. A call not
//! ported yet asks for the service first, as the TypeScript handler's first await does, so a store that cannot serve
//! answers as it did, then refuses as not ported.

pub mod assessment;
pub mod authoring;
pub mod certs;
pub mod community;
pub mod curriculum;
pub mod learner;
pub mod lobbies;
pub mod programme;

use service_kit::json::Json;

use crate::door::{Ctx, Slice};
use crate::errors::Refusal;
use crate::settings;

/// The call's answer: `None` is a handler that returned nothing (`{"result":{}}`).
pub type Answer = Result<Option<Json>, Refusal>;

/// Dispatches to the call's slice.
pub fn handle(ctx: &Ctx<'_>) -> Answer {
    match ctx.call.slice {
        Slice::Door => door(ctx),
        Slice::Curriculum => curriculum::handle(ctx),
        Slice::Lobbies => lobbies::handle(ctx),
        Slice::Authoring => authoring::handle(ctx),
        Slice::Learner => learner::handle(ctx),
        Slice::Assessment => assessment::handle(ctx),
        Slice::Certs => certs::handle(ctx),
        Slice::Community => community::handle(ctx),
        Slice::Programme => programme::handle(ctx),
    }
}

/// The door's own answers: `health` and the settings register.
fn door(ctx: &Ctx<'_>) -> Answer {
    match ctx.call.path {
        "health" => Ok(Some(Json::obj([
            ("ok", Json::Bool(true)),
            ("service", Json::str("svc-academy")),
        ]))),
        "admin.settingsStatus" => Ok(Some(settings::status(ctx.settings))),
        _ => not_ported(ctx),
    }
}

/// A call whose handler is not ported yet: the service is asked first, then the call refuses.
pub fn not_ported(ctx: &Ctx<'_>) -> Answer {
    ctx.service()?;
    Err(Refusal::Internal {
        message: format!("svc-academy (Rust): {} is not ported yet", ctx.call.path),
        code: None,
    })
}
