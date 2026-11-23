//! The personal-pay refusals (`personal-pay/errors.ts`): one sentence per code naming its blocker, the tRPC code it is
//! sent with, and the outside rail it waits on, if any. The router's `guard` sends one as `<sentence> (<code>)` with the
//! code as `cause.code`, so a refusal here is already the wire's [`TrpcError`]. The table is the whole of
//! `personalPayError`, bill pay's codes included, so slice `bills` reads the same one.

use service_kit::trpc::TrpcError;

use crate::errors::Refusal;

/// `PSP_BLOCKER`: the outside rail global sends and bill pay wait on.
pub const PSP_BLOCKER: &str = "socket.psp-partners";

/// One code of `personalPayError`.
pub struct Row {
    pub code: &'static str,
    /// `PersonalPayHttp`.
    pub http: &'static str,
    pub message: &'static str,
    pub blocker: Option<&'static str>,
    /// The caller's `detail` replaces the sentence when given.
    pub detail: bool,
}

/// `personalPayError`'s cases, in its order.
pub const ROWS: &[Row] = &[
    Row {
        code: "bank.bills_directory_unset",
        http: "PRECONDITION_FAILED",
        message: "Biller search is socket.psp-partners. No directory was queried and no biller was invented.",
        blocker: Some("socket.psp-partners"),
        detail: false,
    },
    Row {
        code: "bank.bills_lookup_unset",
        http: "PRECONDITION_FAILED",
        message: "Bill lookup is socket.psp-partners. No amount due, due date or payee name is invented.",
        blocker: Some("socket.psp-partners"),
        detail: false,
    },
    Row {
        code: "bank.bills_psp_unset",
        http: "PRECONDITION_FAILED",
        message: "Bill pay is socket.psp-partners — a bank/PSP partner and money-transmission permission, not inventable code. Nothing was posted.",
        blocker: Some("socket.psp-partners"),
        detail: false,
    },
    Row {
        code: "bank.bills_rail_refused",
        http: "PRECONDITION_FAILED",
        message: "The bill-pay rail refused this payment. Nothing remains posted.",
        blocker: Some("socket.psp-partners"),
        detail: false,
    },
    Row {
        code: "bank.bills_directory_unusable",
        http: "SERVICE_UNAVAILABLE",
        message: "The bill-pay provider answered in a shape this service will not coerce into a biller, an amount due or a payment.",
        blocker: Some("socket.psp-partners"),
        detail: false,
    },
    Row {
        code: "bank.bills_lookup_unusable",
        http: "SERVICE_UNAVAILABLE",
        message: "The bill-pay provider answered in a shape this service will not coerce into a biller, an amount due or a payment.",
        blocker: Some("socket.psp-partners"),
        detail: false,
    },
    Row {
        code: "bank.bills_rail_unusable",
        http: "SERVICE_UNAVAILABLE",
        message: "The bill-pay provider answered in a shape this service will not coerce into a biller, an amount due or a payment.",
        blocker: Some("socket.psp-partners"),
        detail: false,
    },
    Row {
        code: "bank.bills_outcome_unknown",
        http: "SERVICE_UNAVAILABLE",
        message: "Bill pay did not get a definite answer from the rail. Retry the same idempotency key. Do not start a second payment.",
        blocker: Some("socket.psp-partners"),
        detail: false,
    },
    Row {
        code: "bank.bills_reference_unknown",
        http: "NOT_FOUND",
        message: "This biller does not have that reference.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.bills_conflict",
        http: "CONFLICT",
        message: "This idempotency key was already used for a different bill payment.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.bills_not_found",
        http: "NOT_FOUND",
        message: "No such bill.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.bill_recurring_not_found",
        http: "NOT_FOUND",
        message: "No such bill.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.bills_space_not_found",
        http: "NOT_FOUND",
        message: "No such space.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_space_not_found",
        http: "NOT_FOUND",
        message: "No such space.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.bills_list_limit_unset",
        http: "BAD_REQUEST",
        message: "Page size was omitted. Blank is not a default page. Pass a limit.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.bills_cursor_invalid",
        http: "BAD_REQUEST",
        message: "That bills cursor cannot be read.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.bill_recurring_inactive",
        http: "PRECONDITION_FAILED",
        message: "This recurring bill is not active.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.bills_insufficient_funds",
        http: "BAD_REQUEST",
        message: "Insufficient funds",
        blocker: None,
        detail: true,
    },
    Row {
        code: "bank.payee_controls_unset",
        http: "PRECONDITION_FAILED",
        message: "The owner has not published the payee controls, so no send can be checked against them. Nothing was posted.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.payee_blocked",
        http: "PRECONDITION_FAILED",
        message: "This payment cannot be sent to that recipient. Nothing was posted.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.exchange_allowance_unset",
        http: "PRECONDITION_FAILED",
        message: "The owner has not published the exchange payment allowance, so no send can be checked against it. Nothing was posted.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.exchange_allowance_exceeded",
        http: "PRECONDITION_FAILED",
        message: "This payment is above what can be sent to that recipient right now. Nothing was posted.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.transfer_settled",
        http: "PRECONDITION_FAILED",
        message: "This send has already left, so it can no longer be held.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.transfer_not_holdable",
        http: "PRECONDITION_FAILED",
        message: "This send is not in a state that can be held.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_send_cancelled",
        http: "PRECONDITION_FAILED",
        message: "This send was cancelled: it stayed on hold past the owner’s window, or its customer cancelled it. Nothing was posted.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_send_not_cancellable",
        http: "PRECONDITION_FAILED",
        message: "Only a send on hold, with nothing sent, can be cancelled.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.receipt_not_ready",
        http: "PRECONDITION_FAILED",
        message: "A receipt is made once the send has left the account.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.receipt_signing_unset",
        http: "PRECONDITION_FAILED",
        message: "No receipt signing key is configured, so no receipt is made.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_not_returnable",
        http: "PRECONDITION_FAILED",
        message: "Only a send that has left can be recorded as returned by the rail.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_return_conflict",
        http: "CONFLICT",
        message: "This send was already recorded as returned with a different reference, or that reference belongs to another send.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_not_returned",
        http: "PRECONDITION_FAILED",
        message: "Only a send the rail returned can be refunded.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.refund_same_operator",
        http: "FORBIDDEN",
        message: "A return must be refunded by someone other than the person who recorded it.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.refund_fee_unset",
        http: "PRECONDITION_FAILED",
        message: "The owner has not published the refund fee, so nothing is refunded. A zero fee is not assumed.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.refund_fee_unsupported",
        http: "PRECONDITION_FAILED",
        message: "A refund fee other than zero has no fee entry in this build, so nothing is refunded rather than dropping the fee.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.refund_rail_changed",
        http: "PRECONDITION_FAILED",
        message: "This send left on a payout rail that is not the one connected now, so it is not refunded from here. Nothing was posted.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.refund_already_reversed",
        http: "CONFLICT",
        message: "This send was already turned back to its sender before it was returned, so the refund is not posted or recorded again.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_not_recallable",
        http: "PRECONDITION_FAILED",
        message: "Only a send that has left, and has not come back, can be asked back.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.hold_not_found",
        http: "NOT_FOUND",
        message: "No open hold on this send.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.hold_conflict",
        http: "CONFLICT",
        message: "This send already has a hold, or this key was used for a different hold.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.release_same_operator",
        http: "FORBIDDEN",
        message: "A hold must be released by someone other than the person who placed it.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.proof_limits_unset",
        http: "PRECONDITION_FAILED",
        message: "The owner has not published which file types and sizes can be uploaded, so no upload is accepted.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.proof_type_not_allowed",
        http: "BAD_REQUEST",
        message: "That file type is not accepted.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.proof_too_large",
        http: "BAD_REQUEST",
        message: "That file is larger than the limit.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.proof_invalid",
        http: "BAD_REQUEST",
        message: "That file could not be read.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.proof_not_requested",
        http: "PRECONDITION_FAILED",
        message: "No document has been asked for on this send.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.proof_already_uploaded",
        http: "CONFLICT",
        message: "A document was already uploaded and is being reviewed.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.link_reference_conflict",
        http: "CONFLICT",
        message: "That reference is already linked to a different send.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.personal_pay_request_invalid",
        http: "BAD_REQUEST",
        message: "That bill or send request is not usable.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_corridors_unset",
        http: "PRECONDITION_FAILED",
        message: "Corridor catalogue is socket.psp-partners. No country, delivery method, limit or cut-off is invented.",
        blocker: Some("socket.psp-partners"),
        detail: false,
    },
    Row {
        code: "bank.global_corridors_unusable",
        http: "SERVICE_UNAVAILABLE",
        message: "The corridor provider answered in a shape this service will not coerce into a catalogue.",
        blocker: Some("socket.psp-partners"),
        detail: false,
    },
    Row {
        code: "bank.global_corridor_unknown",
        http: "PRECONDITION_FAILED",
        message: "That country, currency and delivery method are not in the corridor catalogue.",
        blocker: Some("socket.psp-partners"),
        detail: false,
    },
    Row {
        code: "bank.global_amount_outside_corridor",
        http: "PRECONDITION_FAILED",
        message: "That amount is outside the smallest and largest send for this destination.",
        blocker: None,
        detail: true,
    },
    Row {
        code: "bank.global_fx_unset",
        http: "PRECONDITION_FAILED",
        message: "No exchange rate is available. The rate source is socket.psp-partners, a rate counterparty. This service does not invent a rate, a fee or a receive amount.",
        blocker: Some("socket.psp-partners"),
        detail: false,
    },
    Row {
        code: "bank.global_fx_unusable",
        http: "SERVICE_UNAVAILABLE",
        message: "The global-send provider answered in a shape this service will not coerce into a rate or a payment.",
        blocker: Some("socket.psp-partners"),
        detail: false,
    },
    Row {
        code: "bank.global_payout_unusable",
        http: "SERVICE_UNAVAILABLE",
        message: "The global-send provider answered in a shape this service will not coerce into a rate or a payment.",
        blocker: Some("socket.psp-partners"),
        detail: false,
    },
    Row {
        code: "bank.global_quote_expired",
        http: "PRECONDITION_FAILED",
        message: "The rate lock ran out before this send was confirmed. Get a new quote. Nothing was posted.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_quote_required",
        http: "PRECONDITION_FAILED",
        message: "A send is paid at a locked rate: get a quote and confirm the send on it. Nothing was posted.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_quote_not_found",
        http: "NOT_FOUND",
        message: "No such quote.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_quote_mismatch",
        http: "BAD_REQUEST",
        message: "That quote was for another amount, asset or currency. Get a quote for this send. Nothing was posted.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_quote_used",
        http: "CONFLICT",
        message: "That quote already paid a send. Get a new quote for another send.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_payout_unset",
        http: "PRECONDITION_FAILED",
        message: "Global send is socket.psp-partners — a payout partner and money-transmission permission, not inventable code. Nothing was posted.",
        blocker: Some("socket.psp-partners"),
        detail: false,
    },
    Row {
        code: "bank.global_payout_uncovered",
        http: "PRECONDITION_FAILED",
        message: "No payout partner pays out to this destination: rail.bank. Nothing was posted.",
        blocker: Some("rail.bank"),
        detail: false,
    },
    Row {
        code: "bank.global_payout_refused",
        http: "PRECONDITION_FAILED",
        message: "The payout rail refused this send. Nothing remains posted.",
        blocker: Some("socket.psp-partners"),
        detail: false,
    },
    Row {
        code: "bank.global_travel_rule_undecided",
        http: "PRECONDITION_FAILED",
        message: "Travel-rule data for a global send has not been decided by Nitro/Phantom. Nothing was posted.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_travel_rule_incomplete",
        http: "PRECONDITION_FAILED",
        message: "The recorded travel-rule decision requires fields this send did not include. Nothing was posted.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.send_field_rules_unset",
        http: "PRECONDITION_FAILED",
        message: "The owner has not published what a send needs for purpose, source of funds and reference. Nothing was posted.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.reference_rules_unset",
        http: "PRECONDITION_FAILED",
        message: "The owner has not published a reference length for this rail and country. Nothing was posted.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.reference_too_long",
        http: "BAD_REQUEST",
        message: "The reference is longer than this rail allows.",
        blocker: None,
        detail: true,
    },
    Row {
        code: "bank.send_purpose_required",
        http: "BAD_REQUEST",
        message: "Sends to this currency need a purpose. Nothing was posted.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.source_of_funds_required",
        http: "BAD_REQUEST",
        message: "A send of this size needs a source of funds. Nothing was posted.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_outcome_unknown",
        http: "SERVICE_UNAVAILABLE",
        message: "Global send did not get a definite answer from the rail. Retry the same idempotency key. Do not start a second send.",
        blocker: Some("socket.psp-partners"),
        detail: false,
    },
    Row {
        code: "bank.global_conflict",
        http: "CONFLICT",
        message: "This idempotency key was already used for a different global send or recipient.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_not_found",
        http: "NOT_FOUND",
        message: "No such send.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_recipient_not_found",
        http: "NOT_FOUND",
        message: "No such recipient.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_list_limit_unset",
        http: "BAD_REQUEST",
        message: "Page size was omitted. Blank is not a default page. Pass a limit.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_cursor_invalid",
        http: "BAD_REQUEST",
        message: "That global-send cursor cannot be read.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_account_format_invalid",
        http: "BAD_REQUEST",
        message: "That account is not an IBAN, an IFSC, or a 6 to 17 digit account number. Format only — this is not a bank lookup.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_bic_format_invalid",
        http: "BAD_REQUEST",
        message: "That BIC is not 8 or 11 characters in ISO 9362 shape. This is not a directory lookup.",
        blocker: None,
        detail: false,
    },
    Row {
        code: "bank.global_insufficient_funds",
        http: "BAD_REQUEST",
        message: "Insufficient funds",
        blocker: None,
        detail: true,
    },
];

/// `personalPayError`'s `default`: a code it does not name.
const FALLBACK: (&str, &str) = ("Personal pay could not complete.", "SERVICE_UNAVAILABLE");

fn row(code: &str) -> Option<&'static Row> {
    ROWS.iter().find(|r| r.code == code)
}

/// The blocker `personalPayError(code).blocker` names, if any.
pub fn blocker(code: &str) -> Option<&'static str> {
    row(code).and_then(|r| r.blocker)
}

/// `guard(personalPayError(code, detail))`: the refusal as the router sends it.
pub fn pay(code: &str, detail: Option<&str>) -> Refusal {
    let (message, http) = match row(code) {
        Some(r) => (
            match detail {
                Some(d) if r.detail => d.to_owned(),
                _ => r.message.to_owned(),
            },
            r.http,
        ),
        None => (FALLBACK.0.to_owned(), FALLBACK.1),
    };
    Refusal::Trpc(TrpcError::caused(http, format!("{message} ({code})"), code))
}

/// [`pay`] with no detail.
pub fn refuse(code: &str) -> Refusal {
    pay(code, None)
}

/// The code a refusal carries: a personal-pay one's, or a `BankError`'s.
pub fn code_of(r: &Refusal) -> Option<&str> {
    match r {
        Refusal::Trpc(e) => e.cause.as_deref(),
        Refusal::Bank(e) => Some(e.row.code),
        Refusal::Other(_) => None,
    }
}

/// The router's `guard` over everything else a handler throws: a personal-pay refusal passes as it is; a `BankError`
/// for an archived or locked space or the step-up is `PRECONDITION_FAILED` with its own sentence and code; any other
/// is `Bank operation failed` (500), its code still the cause, and an error with no code is that with no cause.
pub fn guard(r: Refusal) -> TrpcError {
    match r {
        Refusal::Trpc(e) => e,
        Refusal::Bank(e) => {
            let code = e.row.code;
            if code == "bank.space_archived"
                || code == "bank.space_locked"
                || code.starts_with("bank.step_up_")
            {
                TrpcError::caused(
                    "PRECONDITION_FAILED",
                    format!("{} ({code})", e.message),
                    code,
                )
            } else {
                TrpcError::caused("INTERNAL_SERVER_ERROR", "Bank operation failed", code)
            }
        }
        Refusal::Other(_) => TrpcError::plain("INTERNAL_SERVER_ERROR", "Bank operation failed"),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::panic, reason = "a test")]
    use super::*;

    #[test]
    fn a_refusal_is_its_sentence_and_code_with_the_code_as_cause() {
        let Refusal::Trpc(e) = refuse("bank.global_not_found") else {
            panic!()
        };
        assert_eq!(
            (e.code, e.message.as_str()),
            ("NOT_FOUND", "No such send. (bank.global_not_found)")
        );
        assert_eq!(e.cause.as_deref(), Some("bank.global_not_found"));
        let Refusal::Trpc(e) = pay("bank.reference_too_long", Some("At most 12.")) else {
            panic!()
        };
        assert_eq!(e.message, "At most 12. (bank.reference_too_long)");
        let Refusal::Trpc(e) = pay("bank.global_not_found", Some("ignored")) else {
            panic!()
        };
        assert_eq!(e.message, "No such send. (bank.global_not_found)");
        let Refusal::Trpc(e) = refuse("bank.nope") else {
            panic!()
        };
        assert_eq!(
            (e.code, e.message.as_str()),
            (
                "SERVICE_UNAVAILABLE",
                "Personal pay could not complete. (bank.nope)"
            )
        );
        assert_eq!(blocker("bank.global_payout_uncovered"), Some("rail.bank"));
        assert_eq!(blocker("bank.global_fx_unset"), Some(PSP_BLOCKER));
        assert_eq!(blocker("bank.payee_blocked"), None);
    }
}
