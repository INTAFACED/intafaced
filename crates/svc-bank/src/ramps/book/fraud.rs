//! Placeholder for the destination fraud list (being ported on its own branch); the off-ramp codes against this shape.

use postgres::GenericClient;

use crate::errors::Refusal;
use crate::partner::refuse;

pub fn is_listed(
    _c: &mut impl GenericClient,
    _network: Option<&str>,
    _r: &str,
) -> Result<bool, Refusal> {
    Err(Refusal::Other("the fraud list is not ported".to_owned()))
}

pub fn refuse_listed() -> Refusal {
    refuse(
        "bank.destination_fraud_listed",
        "This address is on the fraud list, so it cannot be saved or sent to. Nothing was saved or sent",
    )
}
