//! svc-bank's refusals (`services/svc-bank/src/errors.ts`) and how the router's guard answers them (`toTrpcError` in
//! `router/errors.ts`).
//!
//! A `BankError` carries one of the codes `BANK_ERROR_STATUS` declares (`errors_table::CODES`) and an operator's
//! sentence. The guard answers with the code's tRPC code; the message is the customer's sentence for the codes
//! `user-copy.ts` lets a caller read (else the operator's), followed by ` (<code>)` for the codes
//! `publicDoorWireMessage` names, and the code rides as `cause.code`. A refusal the handler already decided passes
//! through unchanged; anything else is an opaque failure with a fresh reference, its detail only in the log.
//!
//! The ledger's, dual control's and the approvals' own errors (`InsufficientFundsError`, `DualControlError`,
//! `ActionApprovalConsumeError`, `LedgerFrozenRefusal`) map with the slice that first meets them (`PORT.md`).

use service_kit::trpc::TrpcError;

use crate::errors_table::{CODES, Row};

/// One `BankError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BankError {
    pub row: &'static Row,
    /// The operator's sentence: what an owner of the row may read, sent unless the code has the customer's copy.
    pub message: String,
}

impl BankError {
    /// A `BankError` with a code `errors.ts` declares; `None` for any other, so no code is made up.
    pub fn new(code: &str, message: impl Into<String>) -> Option<BankError> {
        Some(BankError {
            row: CODES.iter().find(|r| r.code == code)?,
            message: message.into(),
        })
    }

    /// `publicDoorWireMessage`: the sentence the answer carries.
    pub fn wire_message(&self) -> String {
        let facing = self.row.copy.unwrap_or(&self.message);
        if self.row.suffix {
            format!("{facing} ({})", self.row.code)
        } else {
            facing.to_owned()
        }
    }
}

/// What a handler can fail with, as the TypeScript's handlers throw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// A domain refusal.
    Bank(BankError),
    /// A refusal already decided (`throw new TRPCError(...)`).
    Trpc(TrpcError),
    /// Anything else: logged with a fresh reference, never shown.
    Other(String),
}

/// `toTrpcError`: the main router's guard. `reference` makes the opaque failure's reference (a fresh uuid each time).
pub fn to_trpc(r: Refusal, reference: impl FnOnce() -> String) -> TrpcError {
    match r {
        Refusal::Trpc(e) => e,
        Refusal::Bank(e) => TrpcError::caused(e.row.trpc_code(), e.wire_message(), e.row.code),
        Refusal::Other(_) => TrpcError::plain(
            "INTERNAL_SERVER_ERROR",
            format!("Bank operation failed (ref {})", reference()),
        ),
    }
}

impl Row {
    /// The tRPC code, as `TRPCError` names it (a static string the kit's renderer knows).
    pub fn trpc_code(&self) -> &'static str {
        self.trpc
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn a_code_errors_ts_does_not_declare_is_never_made() {
        assert!(BankError::new("bank.made_up", "m").is_none());
    }

    #[test]
    fn the_guard_sends_the_copy_or_the_sentence_with_the_code_as_its_cause() {
        let e = BankError::new("bank.space_archived", "Space \"Holiday\" is archived").unwrap();
        let t = to_trpc(Refusal::Bank(e), String::new);
        assert_eq!(
            (t.code, t.message.as_str(), t.cause.as_deref()),
            (
                "CONFLICT",
                "Space \"Holiday\" is archived",
                Some("bank.space_archived")
            )
        );
        let e = BankError::new("bank.mark_missing", "no mark for BTC").unwrap();
        assert_eq!(e.wire_message(), "no mark for BTC (bank.mark_missing)");
        let e = BankError::new("bank.no_card_issuer", "the operator's words").unwrap();
        assert!(!e.wire_message().contains("operator"));
        let t = to_trpc(Refusal::Other("socket hang up".to_owned()), || {
            "ref-1".to_owned()
        });
        assert_eq!(
            (t.code, t.message.as_str(), t.cause),
            (
                "INTERNAL_SERVER_ERROR",
                "Bank operation failed (ref ref-1)",
                None
            )
        );
    }

    #[test]
    fn every_code_answers_a_trpc_code_the_kit_renders() {
        for r in &CODES {
            let rendered = service_kit::trpc::codes(r.trpc).1 != 500;
            assert!(
                rendered || r.trpc == "INTERNAL_SERVER_ERROR",
                "{} answers {}",
                r.code,
                r.trpc
            );
        }
    }
}
