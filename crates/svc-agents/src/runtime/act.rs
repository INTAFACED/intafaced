//! `act` for a tool whose own error is not a [`RunError`].
//!
//! The guarded call itself is the runtime's one [`super::act`]; this only carries a tool's own error back to its caller
//! after the runtime has written the failed row.

use service_kit::json::Json;

pub use super::{ActInput, ActResult};
use super::{Rt, RunError};
use crate::db::StoreError;

/// What `act` fails with: the runtime's refusal or fault, or the tool's own error, after its failure row is written.
#[derive(Debug, Clone, PartialEq)]
pub enum ActError<E> {
    Run(RunError),
    Tool(E),
}

impl<E> From<RunError> for ActError<E> {
    fn from(e: RunError) -> Self {
        ActError::Run(e)
    }
}
impl<E> From<StoreError> for ActError<E> {
    fn from(e: StoreError) -> Self {
        ActError::Run(RunError::Store(e))
    }
}
impl<E> From<postgres::Error> for ActError<E> {
    fn from(e: postgres::Error) -> Self {
        ActError::Run(RunError::from(e))
    }
}

/// `act` with the tool's own error type: the runtime's [`super::act`], the tool's error returned as it was once its
/// failed row is written; a failure to write that row replaces it, as there.
pub fn act<E>(
    x: &Rt<'_>,
    input: &ActInput<'_>,
    execute: impl FnOnce() -> Result<Json, E>,
) -> Result<ActResult, ActError<E>> {
    let mut tool_err = None;
    let ran = super::act(x, input, || {
        execute().map_err(|e| {
            tool_err = Some(e);
            RunError::Other("the tool failed".to_owned())
        })
    });
    match ran {
        Ok(r) => Ok(r),
        Err(RunError::Store(s)) => Err(ActError::Run(RunError::Store(s))),
        Err(e) => Err(match tool_err {
            Some(t) => ActError::Tool(t),
            None => ActError::Run(e),
        }),
    }
}
