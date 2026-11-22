//! Placeholder for the address book's store (being ported on its own branch); the off-ramp codes against this shape.

use postgres::GenericClient;
use service_kit::time::Instant;

use crate::errors::Refusal;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Destination {
    pub destination_id: String,
    pub user_id: String,
    pub kind: String,
    pub r#ref: String,
    pub network: Option<String>,
    pub updated_at: Instant,
}

pub fn persist(
    _c: &mut impl GenericClient,
    _cap_raw: Option<&str>,
    _user_id: &str,
    _kind: &str,
    _r: &str,
    _label: Option<&str>,
) -> Result<Destination, Refusal> {
    Err(Refusal::Other("the address book is not ported".to_owned()))
}

pub fn require(
    _c: &mut impl GenericClient,
    _user_id: &str,
    _kind: &str,
) -> Result<Destination, Refusal> {
    Err(Refusal::Other("the address book is not ported".to_owned()))
}
