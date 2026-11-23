//! Slice `business-payouts` (`PORT.md`): a business pays its team and contractors in bulk (`business/business-payouts.ts`,
//! `router/business-payouts.router.ts`; J-bank-21).
//!
//! The business's money is the partner bank's, in its own account there (`business:<account id>`). INTAFACED's ledger
//! posts nothing for any of this.
//!
//! - bulk run: a CSV ([`csv`]) imported under the run's own id; its invalid lines are its validation report and send
//!   nothing, and nothing is held at import. Confirming is the funding step (the partner's figure must cover the
//!   total); at or above the business's threshold a different approver must approve. Then one instruction to the
//!   partner carrying every line, `bank.business.bulk-pay:<run id>`, stored before it is sent and sent once; a lost
//!   answer is read back by its key, never sent again blind.
//! - contractors: their payout IBAN and wallet, their invoices, a one-use onboarding link. Paying a batch of open
//!   invoices writes the intent row first, follows the business's approval rules, then is one instruction to the
//!   partner's payout rail, `bank.business.contractor-batch:<batch id>`; with no partner the intent is kept, refused
//!   `rail.bank`.
//! - crypto payroll: the business's own wallet is connected by signing an offered message; each month's run is one
//!   message under `bank.business.crypto-payroll:<payroll>:<YYYY-MM>` signed by that wallet. Nothing is held or sent.
//!
//! [`service`] holds the moves, [`router`] the calls; the team's reads they share are [`super::seat`].

pub mod csv;
pub mod router;
pub mod service;

/// `MAX_BULK_FILE_BYTES`.
pub const MAX_BULK_FILE_BYTES: usize = 262_144;
/// `MAX_BULK_LINES`.
pub const MAX_BULK_LINES: i64 = 500;
/// `MAX_BATCH_INVOICES`.
pub const MAX_BATCH_INVOICES: usize = 50;
/// `MAX_PAYROLL_MEMBERS`.
pub const MAX_PAYROLL_MEMBERS: usize = 50;

/// `bulkPayKey`.
pub fn bulk_pay_key(run_id: &str) -> String {
    format!("bank.business.bulk-pay:{run_id}")
}

/// `contractorBatchKey`.
pub fn contractor_batch_key(batch_id: &str) -> String {
    format!("bank.business.contractor-batch:{batch_id}")
}

/// `cryptoPayrollKey`.
pub fn crypto_payroll_key(payroll_id: &str, period: &str) -> String {
    format!("bank.business.crypto-payroll:{payroll_id}:{period}")
}

/// JavaScript's `trim()`.
pub fn js_trim(s: &str) -> &str {
    service_kit::money::js_trim(s)
}

/// JavaScript's `.length`: UTF-16 code units.
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JavaScript's `.slice(0, n)`: the first `n` UTF-16 code units. A pair the cut splits leaves its lone half, which
/// becomes U+FFFD once encoded to UTF-8, as Node's encoder writes it.
pub fn js_slice(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for c in s.chars() {
        let w = c.len_utf16();
        if used + w > n {
            if used < n {
                out.push('\u{fffd}');
            }
            break;
        }
        used += w;
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_slice_counts_code_units() {
        assert_eq!(js_slice("abc", 2), "ab");
        assert_eq!(js_slice("a😀b", 2), "a\u{fffd}");
        assert_eq!(js_slice("a😀b", 3), "a😀");
        assert_eq!(js_len("a😀"), 3);
    }
}
