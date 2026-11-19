//! The certs slice: the calls the door table gives `Slice::Certs`. None is ported yet; each
//! refuses as not ported once the service is reachable.

use crate::door::Ctx;
use crate::slices::{Answer, not_ported};

pub fn handle(ctx: &Ctx<'_>) -> Answer {
    not_ported(ctx)
}
