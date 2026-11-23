//! The programme slice's own logic, ported from `services/svc-academy/src/ambassadors`, `tournaments` and `paper` and
//! their parts of `academy-service.ts` and `router.ts`. `slices::programme` routes each call to its area here.
//!
//! The replay's two service doubles differ, and each handler keeps the TypeScript's order against both: a refusing
//! service (`Store::Refuses`) throws from every `academy.<method>()` call, even one that never reaches SQL
//! ([`method`]); a store that is down (`Store::Down`) fails only where the method reaches the database
//! ([`crate::door::Ctx::service`]).

pub mod ambassadors;
pub mod paper;
pub mod tournaments;

use crate::db::Store;
use crate::door::Ctx;
use crate::errors::Refusal;

/// `academy.<method>(...)` was called: a refusing service throws here, whether or not the method reaches SQL.
pub fn method(ctx: &Ctx<'_>) -> Result<(), Refusal> {
    match ctx.store {
        Store::Refuses(r) => Err(r.clone()),
        Store::Pool(_) | Store::Down(_) => Ok(()),
    }
}
