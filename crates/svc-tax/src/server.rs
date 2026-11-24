//! svc-tax's HTTP server is the kit's (`service_kit::server`), with its `Wire` as the door.

pub use service_kit::server::{Answer, Door, WORKERS, serve};

use crate::wire::Wire;

/// What the routes need: the wire, the service's name and its `/ready` body.
pub type App = service_kit::server::App<Wire>;
