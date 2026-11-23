//! The global slice (`PORT.md`): sending money abroad from a space (`personal-pay/global.ts`, `holds.ts`,
//! `global-sim.ts`, `ports.ts`, `payee-controls.ts`, `send-fields.ts`, `account-format.ts`, `post.ts`, and the
//! `createGlobalRouter` half of `personal-pay/router.ts`).
//!
//! - [`send`]: saved recipients, the rate lock (`global.quote`), the send and what it is checked against, its payout,
//!   the tracker, the receipt, a return, its refund and a recall, and the operator's reads;
//! - [`holds`]: compliance holds on a send that has not left, the document a customer is asked for, release, reference
//!   links, and the owner's auto-cancel window;
//! - [`ports`]: who answers a send (an unset port refuses by name); [`sim`]: the TEST stand-in;
//! - [`rules`]: the account shape and the owner's controls; [`refusals`]: the personal-pay refusals;
//! - [`router`]: the calls.
//!
//! Money moves only through svc-ledger's recipe door (`bankTransfer`, key space `rail`): the send's forward entry from
//! the space to the payout rail's boundary (occurrence 0) and, when the rail refuses or a return is refunded, the one
//! entry back (occurrence 1), both keyed by the send, so a retry posts nothing new. With the custodial layer off
//! (`LEDGER_CUSTODY_LAYER`, the launch decision) each refuses `bank.no_partner_bank` before svc-ledger is asked, as
//! `custodyGuardedLedger` does.

pub mod holds;
pub mod ports;
pub mod refusals;
pub mod router;
pub mod rules;
pub mod send;
pub mod sim;

use service_kit::money::js_trim;
use service_kit::time::Instant;

use crate::db::Store;
use crate::errors::Refusal;
use crate::spaces::ports::Ledger;

/// The owner's values the slice reads, each as `index.ts` hands it in; blank is `None`.
#[derive(Debug, Clone, Default)]
pub struct Settings {
    /// `BANK_SEND_FIELD_RULES_JSON`.
    pub send_field_rules: Option<String>,
    /// `BANK_PAYEE_CONTROLS_JSON`.
    pub payee_controls: Option<String>,
    /// `BANK_EXCHANGE_ALLOWANCE_JSON`.
    pub exchange_allowance: Option<String>,
    /// `BANK_PROOF_LIMITS_JSON`.
    pub proof_limits: Option<String>,
    /// `BANK_GLOBAL_HOLD_CANCEL_HOURS`.
    pub hold_cancel_hours: Option<String>,
    /// `BANK_GLOBAL_REFUND_FEE`.
    pub refund_fee: Option<String>,
    /// `INTERNAL_SERVICE_SECRET`: the secret a receipt's signing key is derived from.
    pub receipt_secret: Option<String>,
}

/// What the door holds for the slice, built once at start-up.
pub struct Wiring {
    pub ports: Box<dyn ports::GlobalPorts>,
    pub settings: Settings,
}

impl Wiring {
    /// Every port unset and every owner value blank.
    pub fn none() -> Wiring {
        Wiring {
            ports: Box::new(ports::EmptyPorts),
            settings: Settings::default(),
        }
    }
}

/// What every part of the slice is handed for one call: the store, svc-ledger, the custody switch, the wiring and the
/// time.
pub struct Deps<'a> {
    pub store: &'a Store,
    pub ledger: &'a dyn Ledger,
    /// `LEDGER_CUSTODY_LAYER`: `on`, or anything else for off.
    pub custody_layer: &'a str,
    pub w: &'a Wiring,
    pub now: Instant,
}

/// `floor(extract(epoch from <col>) * 1000)::int8`: a time column as JavaScript's `Date` reads it.
pub(crate) fn ms(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

/// `value.length` in UTF-16 units.
pub(crate) fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `requireText` / `text`: trimmed, not empty, at most `max`; else `bank.personal_pay_request_invalid`.
pub(crate) fn require_text(value: &str, max: usize) -> Result<String, Refusal> {
    let t = js_trim(value);
    if t.is_empty() || units(t) > max {
        return Err(refusals::refuse("bank.personal_pay_request_invalid"));
    }
    Ok(t.to_owned())
}

/// A fresh uuid, as `randomUUID()`.
pub(crate) fn uuid() -> Result<String, Refusal> {
    service_kit::approvals::random_uuid().map_err(Refusal::Other)
}

/// `oneLine`: control characters and line separators become one space, then trimmed.
pub(crate) fn one_line(value: Option<&str>) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in value.unwrap_or("").chars() {
        if c.is_control() || c == '\u{2028}' || c == '\u{2029}' {
            if !gap {
                out.push(' ');
            }
            gap = true;
        } else {
            out.push(c);
            gap = false;
        }
    }
    js_trim(&out).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_line_folds_controls_and_separators_into_one_space() {
        assert_eq!(one_line(Some(" a\r\n\u{2028}b\u{7}c ")), "a b c");
        assert_eq!(one_line(None), "");
        assert_eq!(one_line(Some("\u{85}x")), "x");
    }
}
